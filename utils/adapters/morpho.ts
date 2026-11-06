// Morpho adapter — official Blue API rates keyed by the user's exact market/vault
// position. Market supply, borrow, collateral, Vault V1 and Vault V2 remain distinct.
// Merkl is used only for the native API's missing collateral reward role.

import { fetchWithTimeout } from '../http';
import { getTtlLru, setTtlLru } from '../cache';
import { resolveMerklRewards, type MerklRewardResult } from './merkl';
import type {
  LegQuery,
  LegRates,
  ProtocolAdapter,
  RewardBasis,
  RewardComponent,
  RewardState,
} from './types';

const API = 'https://blue-api.morpho.org/graphql';
const MIDNIGHT_API = 'https://api.morpho.org/v0/midnight';
const TTL_MS = 5 * 60 * 1_000;
const MIDNIGHT_TTL_MS = 60 * 1_000;
const SOURCE_TIMEOUT_MS = 5_000;
const MAX_WALLET_CACHE_ENTRIES = 64;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MARKET_ID = /^0x[0-9a-f]{64}$/;

interface MarketPosition {
  marketId: string;
  loanAsset: string;
  collateralAsset: string | null;
  supplyApy: number | null;
  borrowApy: number | null;
  rewards: unknown[] | null;
  supplyUsd: number;
  borrowUsd: number;
  collateralUsd: number;
  poolStat?: NonNullable<LegRates['poolStat']>;
}

interface VaultPosition {
  generation: 1 | 2;
  address: string;
  asset: string;
  baseApy: number | null;
  rewards: unknown[] | null;
  assetsUsd: number;
  poolStat?: NonNullable<LegRates['poolStat']>;
}

interface UserPositions {
  markets: MarketPosition[];
  vaults: VaultPosition[];
}

interface MidnightPosition {
  marketId: string;
  loanAsset: string;
  maturity: number;
  baseApy: number | null;
}

interface DepositMarketIdentity {
  owner: string;
  marketId: string;
}

type ResolvedPosition =
  | { kind: 'market'; role: 'supply' | 'borrow' | 'collateral'; position: MarketPosition }
  | { kind: 'vault'; position: VaultPosition };

interface NativeRewardResult {
  rewardApr: number | null;
  rewardState: RewardState;
  rewardComponents: RewardComponent[];
}

const cache = new Map<string, { at: number; positions: UserPositions }>();
const midnightCache = new Map<string, { at: number; positions: MidnightPosition[] }>();

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function address(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return ADDRESS.test(normalized) ? normalized : null;
}

function marketId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return MARKET_ID.test(normalized) ? normalized : null;
}

function usdValue(value: unknown): number {
  return finite(value) && value >= 0 ? value : 0;
}

function rate(value: unknown): number | null {
  return finite(value) && Math.abs(value) <= 100 ? value : null;
}

function wadRate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?\d{1,40}$/.test(value)) return null;
  return rate(Number(BigInt(value)) / 1e18);
}

async function gql(query: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const res = await fetchWithTimeout(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  }, SOURCE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`morpho api http ${res.status}`);
  const body = (await res.json()) as { errors?: unknown[]; data?: Record<string, any> };
  if (body.errors?.length) throw new Error(`morpho gql: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data ?? {};
}

async function loadUser(chainId: number, user: string, signal?: AbortSignal): Promise<UserPositions> {
  const normalizedUser = address(user);
  if (!normalizedUser || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('invalid Morpho user query');
  }
  const cacheKey = `${chainId}:${normalizedUser}`;
  const hit = getTtlLru(cache, cacheKey, () => TTL_MS);
  if (hit) return hit.positions;

  const data = await gql(`query { userByAddress(chainId: ${chainId}, address: "${normalizedUser}") {
    marketPositions {
      market {
        marketId
        loanAsset { address }
        collateralAsset { address }
        state {
          supplyApy
          borrowApy
          supplyAssetsUsd
          borrowAssetsUsd
          liquidityAssetsUsd
          rewards { id asset { address } supplyApr borrowApr }
        }
      }
      state { supplyAssetsUsd borrowAssetsUsd collateralUsd }
    }
    vaultPositions {
      vault {
        address
        asset { address }
        state {
          apy
          netApy
          netApyExcludingRewards
          totalAssetsUsd
          allRewards { asset { address } supplyApr }
        }
        liquidity { usd }
      }
      state { assetsUsd }
    }
    vaultV2Positions {
      vault {
        address
        asset { address }
        apy
        netApy
        netApyExcludingRewards
        totalAssetsUsd
        rewards { asset { address } supplyApr }
      }
      assetsUsd
    }
  } }`, signal);

  const userData = data.userByAddress ?? {};
  const markets: MarketPosition[] = [];
  for (const raw of Array.isArray(userData.marketPositions) ? userData.marketPositions.slice(0, 500) : []) {
    const id = marketId(raw?.market?.marketId);
    const loanAsset = address(raw?.market?.loanAsset?.address);
    const collateralAsset = address(raw?.market?.collateralAsset?.address);
    const supplyUsd = usdValue(raw?.state?.supplyAssetsUsd);
    const borrowUsd = usdValue(raw?.state?.borrowAssetsUsd);
    const collateralUsd = usdValue(raw?.state?.collateralUsd);
    const poolTotal = finite(raw?.market?.state?.supplyAssetsUsd) && raw.market.state.supplyAssetsUsd >= 0
      ? raw.market.state.supplyAssetsUsd
      : null;
    const poolAvailable = finite(raw?.market?.state?.liquidityAssetsUsd) && raw.market.state.liquidityAssetsUsd >= 0
      ? raw.market.state.liquidityAssetsUsd
      : null;
    if (!id || !loanAsset || supplyUsd + borrowUsd + collateralUsd < 1) continue;
    markets.push({
      marketId: id,
      loanAsset,
      collateralAsset,
      supplyApy: rate(raw?.market?.state?.supplyApy),
      borrowApy: rate(raw?.market?.state?.borrowApy),
      rewards: Array.isArray(raw?.market?.state?.rewards) ? raw.market.state.rewards.slice(0, 64) : null,
      supplyUsd,
      borrowUsd,
      collateralUsd,
      poolStat: poolTotal === null
        ? undefined
        : { total: poolTotal, available: poolAvailable, unit: 'usd', source: 'morpho-api' },
    });
  }

  const vaults: VaultPosition[] = [];
  for (const raw of Array.isArray(userData.vaultPositions) ? userData.vaultPositions.slice(0, 500) : []) {
    const vaultAddress = address(raw?.vault?.address);
    const asset = address(raw?.vault?.asset?.address);
    const assetsUsd = usdValue(raw?.state?.assetsUsd);
    if (!vaultAddress || !asset || assetsUsd < 1) continue;
    const state = raw?.vault?.state ?? {};
    vaults.push({
      generation: 1,
      address: vaultAddress,
      asset,
      baseApy: rate(state.netApyExcludingRewards) ?? rate(state.apy),
      rewards: Array.isArray(state.allRewards) ? state.allRewards.slice(0, 64) : null,
      assetsUsd,
      poolStat: finite(state.totalAssetsUsd) && state.totalAssetsUsd >= 0
        ? {
            total: state.totalAssetsUsd,
            available: finite(raw?.vault?.liquidity?.usd) && raw.vault.liquidity.usd >= 0
              ? raw.vault.liquidity.usd
              : null,
            unit: 'usd',
            source: 'morpho-api',
          }
        : undefined,
    });
  }

  for (const raw of Array.isArray(userData.vaultV2Positions) ? userData.vaultV2Positions.slice(0, 500) : []) {
    const vaultAddress = address(raw?.vault?.address);
    const asset = address(raw?.vault?.asset?.address);
    const assetsUsd = usdValue(raw?.assetsUsd);
    if (!vaultAddress || !asset || assetsUsd < 1) continue;
    const vault = raw?.vault ?? {};
    vaults.push({
      generation: 2,
      address: vaultAddress,
      asset,
      baseApy: rate(vault.netApyExcludingRewards) ?? rate(vault.apy),
      rewards: Array.isArray(vault.rewards) ? vault.rewards.slice(0, 64) : null,
      assetsUsd,
      // ⚠️ VaultV2 与 V1 结构不同:无 state 子对象,liquidity 是标量 BigInt(2026-07-12 服务端
      // 400 实证——此前误把 V1 的 state{totalAssetsUsd}+liquidity{usd} 套到 V2,整个 userByAddress
      // 查询被拒,两条链的 Morpho 全腿未匹配)。总规模用平铺 totalAssetsUsd;即时可提未知(fail-open)。
      poolStat: finite(vault?.totalAssetsUsd) && vault.totalAssetsUsd >= 0
        ? {
            total: vault.totalAssetsUsd,
            available: null,
            unit: 'usd',
            source: 'morpho-api',
          }
        : undefined,
    });
  }

  const positions = { markets, vaults };
  setTtlLru(cache, cacheKey, { at: Date.now(), positions }, MAX_WALLET_CACHE_ENTRIES, () => TTL_MS);
  return positions;
}

async function loadMidnight(chainId: number, user: string, signal?: AbortSignal): Promise<MidnightPosition[]> {
  const normalizedUser = address(user);
  if (!normalizedUser || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('invalid Morpho Midnight user query');
  }
  const cacheKey = `${chainId}:${normalizedUser}`;
  const hit = getTtlLru(midnightCache, cacheKey, () => MIDNIGHT_TTL_MS);
  if (hit) return hit.positions;

  const positions: MidnightPosition[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`${MIDNIGHT_API}/users/${normalizedUser}/positions`);
    url.searchParams.set('chain_ids', String(chainId));
    url.searchParams.set('types', 'lend');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetchWithTimeout(url.toString(), { signal }, SOURCE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`morpho midnight api http ${res.status}`);
    const body = (await res.json()) as Record<string, any>;
    if (!body || !Array.isArray(body.data) ||
        (body.cursor !== null &&
          (typeof body.cursor !== 'string' || body.cursor.length === 0 || body.cursor.length > 4_096))) {
      throw new Error('invalid Morpho Midnight positions response');
    }
    for (const raw of body.data) {
      if (raw?.chain_id !== chainId || address(raw?.user_address) !== normalizedUser ||
          raw?.type !== 'lend' || typeof raw?.credit !== 'string' ||
          !/^\d{1,78}$/.test(raw.credit) || BigInt(raw.credit) === 0n) continue;
      const id = marketId(raw?.market_id);
      const loanAsset = address(raw?.loan_token);
      const maturity = raw?.maturity;
      if (!id || !loanAsset || !Number.isSafeInteger(maturity) || maturity <= 0) continue;
      positions.push({
        marketId: id,
        loanAsset,
        maturity,
        baseApy: wadRate(raw?.effective_rate_wad),
      });
    }
    if (body.cursor === null) {
      setTtlLru(midnightCache, cacheKey, { at: Date.now(), positions }, MAX_WALLET_CACHE_ENTRIES, () => MIDNIGHT_TTL_MS);
      return positions;
    }
    cursor = body.cursor;
  }
  throw new Error('Morpho Midnight positions pagination exceeded limit');
}

export function parseMorphoNativeRewards(
  rawRewards: unknown[] | null,
  containerKey: string,
  basis: Extract<RewardBasis, 'supply' | 'borrow' | 'vault'>,
  field: 'supplyApr' | 'borrowApr',
): NativeRewardResult {
  if (!rawRewards) return { rewardApr: null, rewardState: 'unknown', rewardComponents: [] };
  const byId = new Map<string, RewardComponent>();
  let incomplete = false;
  for (let index = 0; index < rawRewards.length; index += 1) {
    const reward = rawRewards[index] as Record<string, any> | null;
    if (!reward || typeof reward !== 'object') {
      incomplete = true;
      continue;
    }
    const rawValue = reward[field];
    if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) {
      incomplete = true;
      continue;
    }
    // A reward row can be supply-only or borrow-only. A missing opposite-side field
    // is an explicit zero only when the other side is present; both fields missing is schema drift.
    const oppositeField = field === 'supplyApr' ? 'borrowApr' : 'supplyApr';
    if (!finite(rawValue) && !finite(reward[oppositeField])) {
      incomplete = true;
      continue;
    }
    const value = finite(rawValue) ? rawValue : 0;
    if (value < 0 || value > 100) {
      incomplete = true;
      continue;
    }
    if (value === 0) continue;
    const token = address(reward?.asset?.address);
    const nativeId = typeof reward.id === 'string' && reward.id.length <= 256
      ? reward.id.toLowerCase()
      : token ?? `row-${index}`;
    const component: RewardComponent = {
      id: `morpho-native:${containerKey}:${basis}:${nativeId}`,
      value,
      rateKind: 'apr',
      source: 'morpho-api',
      basis,
      label: token ?? undefined,
    };
    const previous = byId.get(component.id);
    if (previous && Math.abs(previous.value - component.value) > 1e-12) {
      incomplete = true;
      continue;
    }
    if (!previous) byId.set(component.id, component);
  }
  const rewardComponents = [...byId.values()];
  const rewardApr = rewardComponents.reduce((sum, component) => sum + component.value, 0);
  if (incomplete) {
    return {
      rewardApr: rewardComponents.length > 0 ? rewardApr : null,
      rewardState: 'unknown',
      rewardComponents,
    };
  }
  if (rewardComponents.length === 0) {
    return { rewardApr: 0, rewardState: 'confirmed-zero', rewardComponents: [] };
  }
  return {
    rewardApr,
    rewardState: 'numeric-known',
    rewardComponents,
  };
}

function exactMarketFromPool(poolId: string | undefined): string | null {
  if (!poolId || poolId.length > 256) return null;
  const match = poolId.toLowerCase().match(/0x[0-9a-f]{64}/);
  return marketId(match?.[0]);
}

function exactAddressFromPool(poolId: string | undefined): string | null {
  if (!poolId || poolId.length > 256) return null;
  const match = poolId.toLowerCase().match(/^(0x[0-9a-f]{40})(?::[^:]*)?$/);
  return address(match?.[1]);
}

function depositMarketIdentity(query: LegQuery): DepositMarketIdentity | null {
  if (query.itemAdapterId?.toLowerCase() !== 'morpho_blue_deposit' ||
      query.leg !== 'supply' || query.itemHasBorrows ||
      !query.itemPoolId || !/^0x[0-9a-f]{40}:deposit$/i.test(query.itemPoolId) ||
      !query.positionIndex || query.positionIndex.length > 256) return null;
  // Direct Blue deposits expose only the market ID; their position owner is the
  // DeBank wallet. Blue Deposit Proxy positions encode a different owner before it.
  const directMarket = marketId(query.positionIndex);
  const wallet = address(query.userAddress);
  if (directMarket && wallet) return { owner: wallet, marketId: directMarket };
  const match = query.positionIndex.toLowerCase().match(/^(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/);
  const proxy = address(match?.[1]);
  const id = marketId(match?.[2]);
  return proxy && id ? { owner: proxy, marketId: id } : null;
}

function midnightMarketId(query: LegQuery): string | null {
  if (query.itemAdapterId?.toLowerCase() !== 'morpho_midnight_yield' ||
      query.leg !== 'supply' || query.itemHasBorrows ||
      !query.itemPoolId || !/^0x[0-9a-f]{40}:yield$/i.test(query.itemPoolId)) return null;
  return marketId(query.positionIndex);
}

function queryAddressSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => address(value)).filter((value): value is string => value !== null));
}

function queryLegAddresses(query: LegQuery): { supplies: Set<string>; borrows: Set<string> } {
  const supplies = queryAddressSet(query.itemSupplyAddresses);
  const borrows = queryAddressSet(query.itemBorrowAddresses);
  const queryAddress = address(query.address);
  if (supplies.size === 0 && queryAddress && query.leg === 'supply') supplies.add(queryAddress);
  if (borrows.size === 0 && queryAddress && query.leg === 'borrow') borrows.add(queryAddress);
  return { supplies, borrows };
}

function marketRole(query: LegQuery, position: MarketPosition): 'supply' | 'borrow' | 'collateral' | null {
  const asset = address(query.address);
  if (!asset) return null;
  if (query.leg === 'borrow' && asset === position.loanAsset && position.borrowUsd >= 1) return 'borrow';
  if (query.leg === 'supply' && asset === position.collateralAsset && position.collateralUsd >= 1) return 'collateral';
  if (query.leg === 'supply' && asset === position.loanAsset && position.supplyUsd >= 1) return 'supply';
  return null;
}

function resolveMarket(query: LegQuery, positions: UserPositions): ResolvedPosition | null {
  const exactId = exactMarketFromPool(query.itemPoolId);
  if (exactId) {
    const exact = positions.markets.find((position) => position.marketId === exactId);
    const role = exact ? marketRole(query, exact) : null;
    return exact && role ? { kind: 'market', role, position: exact } : null;
  }

  const { supplies, borrows } = queryLegAddresses(query);
  if (supplies.size === 0) return null;
  const candidates = positions.markets.filter((position) => {
    const role = marketRole(query, position);
    if (!role) return false;
    if (borrows.size > 0) {
      return (
        borrows.has(position.loanAsset) &&
        position.collateralAsset !== null &&
        supplies.has(position.collateralAsset)
      );
    }
    return role === 'supply' && supplies.has(position.loanAsset);
  });
  if (candidates.length !== 1) return null;
  const role = marketRole(query, candidates[0]);
  return role ? { kind: 'market', role, position: candidates[0] } : null;
}

function resolveVault(query: LegQuery, positions: UserPositions): ResolvedPosition | null {
  if (query.leg !== 'supply') return null;
  const poolAddress = exactAddressFromPool(query.itemPoolId);
  if (!poolAddress) return null;
  let candidates = positions.vaults.filter(
    (position) => position.address === poolAddress && position.asset === address(query.address),
  );
  const adapter = query.itemAdapterId?.toLowerCase() ?? '';
  if (/v2/.test(adapter)) candidates = candidates.filter((position) => position.generation === 2);
  else if (/v1/.test(adapter)) candidates = candidates.filter((position) => position.generation === 1);
  if (candidates.length !== 1) return null;
  return { kind: 'vault', position: candidates[0] };
}

function resolvePosition(query: LegQuery, positions: UserPositions): ResolvedPosition | null {
  const adapter = query.itemAdapterId?.toLowerCase() ?? '';
  if (adapter === 'morpho_blue_deposit') {
    const identity = depositMarketIdentity(query);
    if (!identity) return null;
    const exact = positions.markets.find((position) => position.marketId === identity.marketId);
    return exact && marketRole(query, exact) === 'supply'
      ? { kind: 'market', role: 'supply', position: exact }
      : null;
  }
  const looksLikeVault = /vault|erc4626|redeemable|earn/.test(adapter);
  if (looksLikeVault) return resolveVault(query, positions);
  const exactPoolAddress = exactAddressFromPool(query.itemPoolId);
  if (exactPoolAddress && positions.vaults.some((position) => position.address === exactPoolAddress)) {
    return resolveVault(query, positions);
  }
  return resolveMarket(query, positions);
}

function resolveMidnight(query: LegQuery, positions: MidnightPosition[]): LegRates | null {
  const id = midnightMarketId(query);
  const asset = address(query.address);
  if (!id || !asset) return null;
  const matching = positions.filter((position) => position.marketId === id && position.loanAsset === asset);
  if (matching.length !== 1) return null;
  const position = matching[0];
  return {
    baseApy: position.maturity <= Date.now() / 1_000 ? 0 : position.baseApy,
    includesIntrinsicYield: true,
    rewardApr: null,
    rewardState: 'not-applicable',
    rewardComponents: [],
    source: 'morpho-midnight-api:effective-rate（固定期限年化等值；今日收益为估算）',
  };
}

async function loadGroups(keys: string[], signal?: AbortSignal): Promise<Map<string, UserPositions>> {
  const out = new Map<string, UserPositions>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const split = key.indexOf(':');
      const chainId = Number(key.slice(0, split));
      const user = key.slice(split + 1);
      try {
        out.set(key, await loadUser(chainId, user, signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn('[APY Lens] morpho loadUser failed:', error);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadMidnightGroups(keys: string[], signal?: AbortSignal): Promise<Map<string, MidnightPosition[]>> {
  const out = new Map<string, MidnightPosition[]>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const split = key.indexOf(':');
      try {
        out.set(key, await loadMidnight(Number(key.slice(0, split)), key.slice(split + 1), signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn('[APY Lens] morpho loadMidnight failed:', error);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function blueUser(query: LegQuery): string | null {
  const owner = address(query.userAddress);
  if (!owner || query.itemAdapterId?.toLowerCase() === 'morpho_midnight_yield') return null;
  return query.itemAdapterId?.toLowerCase() === 'morpho_blue_deposit'
    ? depositMarketIdentity(query)?.owner ?? null
    : owner;
}

function nativeLeg(
  baseApy: number | null,
  rewards: unknown[] | null,
  containerKey: string,
  basis: 'supply' | 'borrow' | 'vault',
  field: 'supplyApr' | 'borrowApr',
  source: string,
  poolStat?: LegRates['poolStat'],
): LegRates {
  return {
    baseApy,
    ...parseMorphoNativeRewards(rewards, containerKey, basis, field),
    ...(poolStat ? { poolStat } : {}),
    source,
  };
}

export const morphoAdapter: ProtocolAdapter = {
  name: 'morpho',
  matches: (id) => /^([a-z0-9]+_)?(morpho(blue)?|morpho-blue)$/.test(id),
  async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
    const keys = [...new Set(queries.flatMap((query) => {
      const user = blueUser(query);
      return user ? [`${query.chainId}:${user}`] : [];
    }))];
    const midnightKeys = [...new Set(queries.flatMap((query) => {
      const user = address(query.userAddress);
      return user && midnightMarketId(query) ? [`${query.chainId}:${user}`] : [];
    }))];
    const [groups, midnightGroups] = await Promise.all([
      loadGroups(keys, signal),
      loadMidnightGroups(midnightKeys, signal),
    ]);
    const resolved = queries.map((query) => {
      const user = blueUser(query);
      if (!user) return null;
      const positions = groups.get(`${query.chainId}:${user}`);
      return positions ? resolvePosition(query, positions) : null;
    });

    const collateralIndexes: number[] = [];
    const merklQueries = resolved.flatMap((position, index) => {
      if (!position || position.kind !== 'market' || position.role !== 'collateral') return [];
      collateralIndexes.push(index);
      return [{
        chainId: queries[index].chainId,
        protocolId: 'morpho',
        opportunityType: 'MORPHOCOLLATERAL',
        action: ['LEND', 'BORROW'],
        containerId: `market:${position.position.marketId}`,
        assetAddress: position.position.collateralAsset ?? undefined,
        basis: 'collateral' as const,
        // For Morpho collateral, the official market state supplies the exact market
        // identity while Merkl's complete LIVE snapshot is the tracked incentive set.
        // A complete exact-market no-match is therefore a tracked-source zero, not unknown.
        zeroProof: true,
      }];
    });
    const merklResults = await resolveMerklRewards(merklQueries, signal);
    const collateralRewards = new Map<number, MerklRewardResult>();
    collateralIndexes.forEach((queryIndex, resultIndex) => {
      collateralRewards.set(queryIndex, merklResults[resultIndex]);
    });

    return resolved.map((position, index) => {
      if (queries[index].itemAdapterId?.toLowerCase() === 'morpho_midnight_yield') {
        const user = address(queries[index].userAddress);
        const positions = user ? midnightGroups.get(`${queries[index].chainId}:${user}`) : null;
        return positions ? resolveMidnight(queries[index], positions) : null;
      }
      if (!position) return null;
      if (position.kind === 'vault') {
        const vault = position.position;
        return nativeLeg(
          vault.baseApy,
          vault.rewards,
          `vault-v${vault.generation}:${vault.address}`,
          'vault',
          'supplyApr',
          `morpho-api:vault-v${vault.generation}`,
          vault.poolStat,
        );
      }

      const market = position.position;
      if (position.role === 'collateral') {
        const reward = collateralRewards.get(index) ?? {
          rewardApr: null,
          rewardState: 'unknown' as const,
          rewardComponents: [],
          source: 'merkl:unknown',
        };
        return {
          baseApy: 0,
          rewardApr: reward.rewardApr,
          rewardState: reward.rewardState,
          rewardComponents: reward.rewardComponents,
          source: `morpho-api:collateral + ${reward.source}`,
        };
      }
      if (position.role === 'supply') {
        return nativeLeg(
          market.supplyApy,
          market.rewards,
          `market:${market.marketId}`,
          'supply',
          'supplyApr',
          'morpho-api:market',
          market.poolStat,
        );
      }
      return nativeLeg(
        market.borrowApy,
        market.rewards,
        `market:${market.marketId}`,
        'borrow',
        'borrowApr',
        'morpho-api:market',
      );
    });
  },
};

export function __resetMorphoCacheForTests(): void {
  cache.clear();
  midnightCache.clear();
}
