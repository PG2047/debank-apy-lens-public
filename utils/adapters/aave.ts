// Aave V3 官方 AaveKit GraphQL 适配器。
// 基础利率与奖励都来自同一份 market/reserve 响应，并以 market address + reserve + leg 精确归属。
// Points 与需要组合仓位公式的条件奖励只披露为 non-annualizable，不伪造 APR。

import type {
  LegQuery,
  LegRates,
  ProtocolAdapter,
  RewardComponent,
  RewardState,
} from './types';
import { fetchWithTimeout } from '../http';
import { getTtlLru, setTtlLru } from '../cache';
import { SharedAbortableLoad } from '../shared-load';
import { aaveMarketAddress, aaveNativeAliases, aaveRequestKey } from './aave-identity';

const ENDPOINT = 'https://api.v3.aave.com/graphql';
const TTL_MS = 5 * 60 * 1000;
const MAX_WALLET_CACHE_ENTRIES = 64;
const SOURCE_TIMEOUT_MS = 8_000;

interface ReserveRates {
  supplyApy: number | null;
  borrowApy: number | null;
  incentives: Record<string, any>[] | null;
  marketAddress: string;
  assetAddress: string;
  poolStat?: NonNullable<LegRates['poolStat']>;
}

/** key: `${chainId}:${market address}:${underlying}` */
type AaveRateMap = Map<string, ReserveRates>;

const cache = new Map<string, { at: number; rates: AaveRateMap }>();
const coldLoads = new Map<string, SharedAbortableLoad<AaveRateMap>>();

export const AAVE_V3_MARKETS_QUERY = `
  query Markets($chainIds: [Int!]!, $user: EvmAddress) {
    markets(request: { chainIds: $chainIds, user: $user }) {
      name
      address
      chain { chainId nativeWrappedToken }
      reserves {
        underlyingToken { address }
        supplyInfo { apy { value } total { value } }
        borrowInfo { apy { value } availableLiquidity { usd usdPerToken } }
        incentives {
          __typename
          ... on AaveSupplyIncentive {
            extraSupplyApr { value }
            rewardTokenAddress
            rewardTokenSymbol
          }
          ... on AaveBorrowIncentive {
            borrowAprDiscount { value }
            rewardTokenAddress
            rewardTokenSymbol
          }
          ... on MerklSupplyIncentive {
            id
            extraSupplyApr { value }
            payoutToken { address symbol }
            userEligible
          }
          ... on MerklBorrowIncentive {
            id
            borrowAprDiscount { value }
            payoutToken { address symbol }
            userEligible
          }
          ... on MeritSupplyIncentive {
            extraSupplyApr { value }
            selfApr { value }
            actionKey
            rewardTokenAddress
            rewardTokenSymbol
          }
          ... on MeritBorrowIncentive {
            borrowAprDiscount { value }
            selfApr { value }
            actionKey
            rewardTokenAddress
            rewardTokenSymbol
          }
          ... on MeritBorrowAndSupplyIncentiveCondition {
            extraApr { value }
            selfApr { value }
            supplyToken { address }
            borrowToken { address }
            actionKey
            rewardTokenAddress
            rewardTokenSymbol
          }
          ... on SupplyPointsIncentive {
            id
            name
            multiplier
            userEligible
          }
          ... on BorrowPointsIncentive {
            id
            name
            multiplier
            userEligible
          }
        }
      }
    }
  }
`;

function fraction(value: unknown): number | null {
  const raw = (value as Record<string, unknown> | null)?.value ?? value;
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 10 ? n : null;
}

function nonNegative(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function aaveRates(
  chainId: number,
  userAddress?: string,
  signal?: AbortSignal,
): Promise<AaveRateMap> {
  const key = aaveRequestKey(chainId, userAddress);

  const res = await fetchWithTimeout(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: AAVE_V3_MARKETS_QUERY,
      variables: { chainIds: [chainId], user: userAddress?.toLowerCase() ?? null },
    }),
    signal,
  }, SOURCE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`aave graphql http ${res.status}`);
  const body = (await res.json()) as {
    errors?: unknown[];
    data?: { markets?: Array<Record<string, any>> };
  };
  if (body.errors?.length) {
    throw new Error(`aave graphql errors: ${JSON.stringify(body.errors).slice(0, 400)}`);
  }
  if (!Array.isArray(body.data?.markets)) throw new Error('aave graphql missing markets');

  const rates: AaveRateMap = new Map();
  for (const market of body.data.markets) {
    if (market?.chain?.chainId !== chainId) continue;
    const marketAddress = typeof market?.address === 'string' ? market.address.toLowerCase() : null;
    if (!marketAddress) continue;
    for (const raw of Array.isArray(market.reserves) ? market.reserves : []) {
      const asset = typeof raw?.underlyingToken?.address === 'string'
        ? raw.underlyingToken.address.toLowerCase()
        : null;
      if (!asset) continue;
      // 实测类型(2026-07-11):supplyInfo.total 是 DecimalValue(token 数),
      // availableLiquidity 是 TokenAmount(带 usd/usdPerToken)。总规模 USD = total.value × usdPerToken;
      // 不可借资产 borrowInfo 为 null → 无价格可换算,降级 token 口径且 available 未知。
      const totalTokens = nonNegative(raw?.supplyInfo?.total?.value);
      const usdPerToken = nonNegative(raw?.borrowInfo?.availableLiquidity?.usdPerToken);
      const availableUsd = nonNegative(raw?.borrowInfo?.availableLiquidity?.usd);
      const poolStat: ReserveRates['poolStat'] = totalTokens === null
        ? undefined
        : usdPerToken !== null
          ? { total: totalTokens * usdPerToken, available: availableUsd, unit: 'usd', source: 'aave-api' }
          : { total: totalTokens, available: null, unit: 'token', source: 'aave-api' };
      const row: ReserveRates = {
        supplyApy: fraction(raw?.supplyInfo?.apy),
        borrowApy: fraction(raw?.borrowInfo?.apy),
        incentives: Array.isArray(raw?.incentives) ? raw.incentives : null,
        marketAddress,
        assetAddress: asset,
        poolStat,
      };
      rates.set(`${chainId}:${marketAddress}:${asset}`, row);
      if (asset === market.chain.nativeWrappedToken?.toLowerCase()) {
        for (const alias of aaveNativeAliases(chainId)) {
          rates.set(`${chainId}:${marketAddress}:${alias}`, row);
        }
      }
    }
  }
  if (rates.size === 0) throw new Error('aave graphql returned no usable reserves');
  setTtlLru(cache, key, { at: Date.now(), rates }, MAX_WALLET_CACHE_ENTRIES, () => TTL_MS);
  return rates;
}

async function loadV3(chainId: number, user?: string, signal?: AbortSignal): Promise<AaveRateMap> {
  const key = aaveRequestKey(chainId, user);
  const hit = getTtlLru(cache, key, () => TTL_MS);
  if (hit) return hit.rates;
  let load = coldLoads.get(key);
  if (!load) {
    load = new SharedAbortableLoad<AaveRateMap>();
    coldLoads.set(key, load);
  }
  try {
    return await load.run((loadSignal) => aaveRates(chainId, user, loadSignal), signal);
  } finally {
    if (!load.isActive() && coldLoads.get(key) === load) coldLoads.delete(key);
  }
}

export function __resetAaveCacheForTests(): void {
  cache.clear();
  for (const load of coldLoads.values()) load.reset();
  coldLoads.clear();
}

function eligible(incentive: Record<string, any>, hasUser: boolean): boolean | null {
  if (!('userEligible' in incentive)) return true;
  if (!hasUser) return null;
  return incentive.userEligible === true;
}

function rewardToken(incentive: Record<string, any>): { address: string; symbol?: string } {
  const nested = incentive?.payoutToken;
  const rawAddress = nested?.address ?? incentive?.rewardTokenAddress ?? '';
  const rawSymbol = nested?.symbol ?? incentive?.rewardTokenSymbol;
  return {
    address: typeof rawAddress === 'string' ? rawAddress.toLowerCase() : '',
    symbol: typeof rawSymbol === 'string' ? rawSymbol.slice(0, 40) : undefined,
  };
}

function incentiveId(
  incentive: Record<string, any>,
  row: ReserveRates,
  leg: 'supply' | 'borrow',
): string {
  const token = rewardToken(incentive).address || 'unknown-token';
  const external = typeof incentive.id === 'string'
    ? incentive.id
    : typeof incentive.actionKey === 'string'
      ? incentive.actionKey
      : `${row.marketAddress}:${row.assetAddress}:${leg}:${token}`;
  return `aave-v3:${external}`;
}

function resolveRewards(row: ReserveRates, query: LegQuery): {
  rewardApr: number | null;
  rewardState: RewardState;
  rewardComponents?: RewardComponent[];
} {
  if (!row.incentives) return { rewardApr: null, rewardState: 'unknown' };

  const components = new Map<string, RewardComponent>();
  let incomplete = false;
  let nonAnnualizable = false;
  const supplySet = new Set(query.itemSupplyAddresses ?? []);
  const borrowSet = new Set(query.itemBorrowAddresses ?? []);
  const knownTypes = new Set([
    'AaveSupplyIncentive',
    'AaveBorrowIncentive',
    'MerklSupplyIncentive',
    'MerklBorrowIncentive',
    'MeritSupplyIncentive',
    'MeritBorrowIncentive',
    'MeritBorrowAndSupplyIncentiveCondition',
    'SupplyPointsIncentive',
    'BorrowPointsIncentive',
  ]);

  for (const incentive of row.incentives) {
    const type = typeof incentive?.__typename === 'string' ? incentive.__typename : '';
    if (!knownTypes.has(type)) {
      incomplete = true;
      continue;
    }
    const role = type.includes('Supply') ? 'supply' : type.includes('Borrow') ? 'borrow' : null;
    const eligibility = eligible(incentive, Boolean(query.userAddress));
    if (eligibility === false) continue;
    if (eligibility === null) {
      incomplete = true;
      continue;
    }

    if (type === 'MeritBorrowAndSupplyIncentiveCondition') {
      const supply = String(incentive?.supplyToken?.address ?? '').toLowerCase();
      const borrow = String(incentive?.borrowToken?.address ?? '').toLowerCase();
      if (supplySet.has(supply) && borrowSet.has(borrow)) nonAnnualizable = true;
      continue;
    }
    if (type === 'SupplyPointsIncentive' && query.leg === 'supply') {
      nonAnnualizable = true;
      continue;
    }
    if (type === 'BorrowPointsIncentive' && query.leg === 'borrow') {
      nonAnnualizable = true;
      continue;
    }
    if (role !== query.leg) continue;

    // A parallel Merit self campaign has a distinct eligibility/notional contract
    // (for example sGHO/Safety Module lock), so disclose it without multiplying it
    // by the current reserve balance.
    if (type.startsWith('Merit') && (fraction(incentive?.selfApr) ?? 0) > 0) {
      nonAnnualizable = true;
    }

    const rate = query.leg === 'supply'
      ? fraction(incentive?.extraSupplyApr)
      : fraction(incentive?.borrowAprDiscount);
    if (rate === null) {
      incomplete = true;
      continue;
    }
    const token = rewardToken(incentive);
    const id = incentiveId(incentive, row, query.leg);
    components.set(id, {
      id,
      value: rate,
      rateKind: 'apr',
      source: 'aave-v3官方',
      basis: query.leg,
      label: token.symbol,
      observedAt: Date.now(),
    });
  }

  const list = [...components.values()];
  const rewardApr = list.reduce((sum, component) => sum + component.value, 0);
  const rewardState: RewardState = nonAnnualizable
    ? 'non-annualizable'
    : incomplete
      ? 'unknown'
      : list.length > 0
        ? 'numeric-known'
        : 'confirmed-zero';
  return {
    rewardApr: list.length > 0 ? rewardApr : rewardState === 'confirmed-zero' ? 0 : null,
    rewardState,
    rewardComponents: list.length > 0 ? list : undefined,
  };
}

export const aaveAdapter: ProtocolAdapter = {
  name: 'aave-v3',
  matches: (id) => /^([a-z0-9]+_)?aave3$/.test(id),
  async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
    const groups = new Map<string, LegQuery[]>();
    for (const query of queries) {
      const key = aaveRequestKey(query.chainId, query.userAddress);
      groups.set(key, [...(groups.get(key) ?? []), query]);
    }
    const maps = new Map<string, AaveRateMap | null>();
    await Promise.all(
      [...groups].map(async ([key, group]) => {
        const { chainId, userAddress } = group[0];
        const rates = await loadV3(chainId, userAddress, signal).catch((error) => {
          if (signal?.aborted) throw error;
          console.warn('[APY Lens] aave rates failed:', error);
          return null;
        });
        maps.set(key, rates);
      }),
    );

    return queries.map((query) => {
      const market = aaveMarketAddress(query.itemPoolId);
      if (!market) return null;
      const rates = maps.get(aaveRequestKey(query.chainId, query.userAddress));
      const reserveKey = (address: string) => `${query.chainId}:${market}:${address.toLowerCase()}`;
      const row = rates?.get(reserveKey(query.address));
      if (!row) return null;
      const canonicalAsset = (address: string) => rates?.get(reserveKey(address))?.assetAddress ?? address.toLowerCase();
      const baseApy = query.leg === 'supply' ? row.supplyApy : row.borrowApy;
      return {
        baseApy,
        ...resolveRewards(row, {
          ...query,
          itemSupplyAddresses: query.itemSupplyAddresses?.map(canonicalAsset),
          itemBorrowAddresses: query.itemBorrowAddresses?.map(canonicalAsset),
        }),
        ...(query.leg === 'supply' && row.poolStat ? { poolStat: row.poolStat } : {}),
        source: 'aave-v3官方',
      };
    });
  },
};
