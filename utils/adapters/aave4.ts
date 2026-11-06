// Aave V4 官方 GraphQL 适配器（api.v4.aave.com，keyless）。
// V4 是 hub-and-spoke 架构，与 v3 的 Market/aToken 模型完全不同，端点独立（v3 端点查不到 V4）。
// Schema: aave/aave-v4-sdk; all current mainnets checked on 2026-11-06.
//   - reserves(request:{query:{chainIds:[1]},filter:ALL})；PercentNumber.value 为小数（1.0=100%）
//   - Use userState.borrowApy and user-effective Merkl reward APY.
//   - A spoke can list one token through multiple hubs; active reserve IDs select the user leg.
//   - Query/cache by chain and wallet. No Ethereum-only whitelist.

import type { LegQuery, LegRates, ProtocolAdapter, RewardState } from './types';
import { fetchWithTimeout } from '../http';
import { SharedAbortableLoad } from '../shared-load';
import { getTtlLru, setTtlLru } from '../cache';
import { aaveNativeAliases, aaveRequestKey } from './aave-identity';

const ENDPOINT = 'https://api.v4.aave.com/graphql';
const TTL_MS = 5 * 60 * 1000;
export const AAVE_V4_SOURCE_TIMEOUT_MS = 8_000;

interface V4Rates {
  reserveId: string;
  s: number | null; // 存款基础 APY（小数）
  b: number | null; // 借款基础 APY（小数）
  sr: number | null; // Merkl supply reward APY, after user netting.
  br: number | null; // Merkl borrow discount APY, after user netting.
  ss: RewardState;
  bs: RewardState;
  poolStat?: NonNullable<LegRates['poolStat']>;
}

type V4Snapshot = {
  at: number;
  bySpoke: Map<string, V4Rates[]>;
  supplied: Set<string>;
  borrowed: Set<string>;
};

const cache = new Map<string, V4Snapshot>();
const coldLoads = new Map<string, SharedAbortableLoad<V4Snapshot>>();

const RESERVES_QUERY = `reserves(request: { query: { chainIds: $chainIds }, user: $user, filter: ALL }) {
  id
  spoke {
    name address
    chain {
      chainId
      nativeAsset {
        __typename
        ... on WrappedNativeAsset { wrappedNativeTokenAddress }
        ... on SharedBalanceNativeAsset { erc20Address }
      }
    }
  }
  userState { borrowApy { value } }
  asset {
    underlying { address }
    summary {
      supplied { amount { value } }
      availableLiquidity { amount { value } }
    }
  }
  summary {
    supplyApy { value }
    borrowApy { value }
    rewards {
      __typename
      ... on MerklSupplyReward { userEligible userEffectiveExtraApy { value } }
      ... on MerklBorrowReward { userEligible userEffectiveDiscountApy { value } }
    }
  }
}`;

export const AAVE_V4_RESERVES_QUERY = `query Reserves($chainIds: [Int!]!, $user: EvmAddress) { ${RESERVES_QUERY} }`;
export const AAVE_V4_USER_RESERVES_QUERY = `query UserReserves($chainIds: [Int!]!, $user: EvmAddress!) {
  ${RESERVES_QUERY}
  userSupplies(request: { query: { userChains: { user: $user, chainIds: $chainIds } } }) { reserve { id } }
  userBorrows(request: { query: { userChains: { user: $user, chainIds: $chainIds } } }) { reserve { id } }
}`;

const frac = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  // 10 = 1000% 年化，超出视为脏数据
  return Number.isFinite(n) && n >= 0 && n < 10 ? n : null;
};

const amount = (v: unknown): number | null => {
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

async function fetchV4(chainId: number, user: string | undefined, signal: AbortSignal): Promise<V4Snapshot> {
  const res = await fetchWithTimeout(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: user ? AAVE_V4_USER_RESERVES_QUERY : AAVE_V4_RESERVES_QUERY, variables: { chainIds: [chainId], user: user?.toLowerCase() ?? null } }),
    signal,
  }, AAVE_V4_SOURCE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`aave v4 http ${res.status}`);
  const body = (await res.json()) as { errors?: unknown[]; data?: {
    reserves?: Record<string, any>[];
    userSupplies?: { reserve: { id: string } }[];
    userBorrows?: { reserve: { id: string } }[];
  } };
  if (body.errors?.length) throw new Error(`aave v4 gql: ${JSON.stringify(body.errors).slice(0, 300)}`);

  const bySpoke = new Map<string, V4Rates[]>();
  const add = (key: string, row: V4Rates) => bySpoke.set(key, [...(bySpoke.get(key) ?? []), row]);
  for (const r of body.data?.reserves ?? []) {
    if (r?.spoke?.chain?.chainId !== chainId) continue;
    const spoke: unknown = r?.spoke?.address;
    const under: unknown = r?.asset?.underlying?.address;
    if (typeof spoke !== 'string' || typeof under !== 'string') continue;
    const sum = r?.summary ?? {};
    const rewards = Array.isArray(sum.rewards) ? sum.rewards : null;
    let sr: number | null = rewards ? 0 : null;
    let br: number | null = rewards ? 0 : null;
    let supplyNumericSeen = false;
    let borrowNumericSeen = false;
    let supplyNonAnnualizable = false;
    let borrowNonAnnualizable = false;
    for (const rw of rewards ?? []) {
      if (rw?.__typename === 'MerklSupplyReward') {
        if (user && rw.userEligible === false) continue;
        const value = user && rw.userEligible === true ? frac(rw?.userEffectiveExtraApy?.value) : null;
        if (value !== null) supplyNumericSeen = true;
        sr = value === null || sr === null ? null : sr + value;
      } else if (rw?.__typename === 'MerklBorrowReward') {
        if (user && rw.userEligible === false) continue;
        const value = user && rw.userEligible === true ? frac(rw?.userEffectiveDiscountApy?.value) : null;
        if (value !== null) borrowNumericSeen = true;
        br = value === null || br === null ? null : br + value;
      } else {
        // Points/倍数类奖励不能可靠年化；按 typename 尽量限定腿，未知 union 保守影响两侧。
        const type = String(rw?.__typename ?? '').toLowerCase();
        if (type.includes('supply')) supplyNonAnnualizable = true;
        else if (type.includes('borrow')) borrowNonAnnualizable = true;
        else {
          supplyNonAnnualizable = true;
          borrowNonAnnualizable = true;
        }
      }
    }
    const ss: RewardState = supplyNonAnnualizable
      ? 'non-annualizable'
      : sr === null
        ? 'unknown'
        : sr === 0
          ? 'confirmed-zero'
          : 'numeric-known';
    const bs: RewardState = borrowNonAnnualizable
      ? 'non-annualizable'
      : br === null
        ? 'unknown'
        : br === 0
          ? 'confirmed-zero'
          : 'numeric-known';
    if (ss === 'non-annualizable' && !supplyNumericSeen) sr = null;
    if (bs === 'non-annualizable' && !borrowNumericSeen) br = null;
    // 流动性必须取 Hub 级(reserve.asset 即 HubAsset):V4 流动性由 Hub 统一持有、跨 Spoke 共享,
    // spoke 级 supplied−borrowed 会高/低估真实可提量(codex-review 2026-07-11 高危 finding;
    // 实测 USDG:spoke 差值 33.6M vs Hub availableLiquidity 19.36M,差近一倍)。
    // 禁止自行相减:availableLiquidity 缺失时 available=null(fail-open)。
    const hubSummary = (r?.asset as Record<string, any> | undefined)?.summary ?? {};
    const hubSupplied = amount(hubSummary.supplied?.amount?.value);
    const hubAvailable = amount(hubSummary.availableLiquidity?.amount?.value);
    const row: V4Rates = {
      reserveId: r.id,
      s: frac(sum.supplyApy?.value),
      // A market quote omits the position's risk premium. A user request must use userState.
      b: frac(user ? r?.userState?.borrowApy?.value : sum.borrowApy?.value),
      sr,
      br,
      ss,
      bs,
      poolStat: hubSupplied === null
        ? undefined
        : {
            total: hubSupplied,
            available: hubAvailable,
            unit: 'token',
            source: 'aave-v4-api',
          },
    };
    add(`${chainId}:${spoke.toLowerCase()}:${under.toLowerCase()}`, row);
    const native = r.spoke.chain.nativeAsset;
    const nativeAddress = native?.__typename === 'SharedBalanceNativeAsset'
      ? native.erc20Address : native?.wrappedNativeTokenAddress;
    if (under.toLowerCase() === nativeAddress?.toLowerCase()) {
      for (const alias of aaveNativeAliases(chainId)) {
        add(`${chainId}:${spoke.toLowerCase()}:${alias}`, row);
      }
    }
  }
  if (bySpoke.size === 0) throw new Error('aave v4 returned no reserves');
  const snapshot: V4Snapshot = {
    at: Date.now(), bySpoke,
    supplied: new Set(body.data?.userSupplies?.map((item) => item.reserve.id)),
    borrowed: new Set(body.data?.userBorrows?.map((item) => item.reserve.id)),
  };
  setTtlLru(cache, aaveRequestKey(chainId, user), snapshot, 64, () => TTL_MS);
  return snapshot;
}

async function loadV4(chainId: number, user?: string, signal?: AbortSignal): Promise<V4Snapshot> {
  const key = aaveRequestKey(chainId, user);
  const hit = getTtlLru(cache, key, () => TTL_MS);
  if (hit) return hit;
  let load = coldLoads.get(key);
  if (!load) {
    load = new SharedAbortableLoad<V4Snapshot>();
    coldLoads.set(key, load);
  }
  try {
    return await load.run((loadSignal) => fetchV4(chainId, user, loadSignal), signal);
  } finally {
    if (!load.isActive() && coldLoads.get(key) === load) coldLoads.delete(key);
  }
}

export function __resetAave4CacheForTests(): void {
  cache.clear();
  for (const load of coldLoads.values()) load.reset();
  coldLoads.clear();
}

export const aave4Adapter: ProtocolAdapter = {
  name: 'aave-v4',
  matches: (id) => /^([a-z0-9]+_)?aave4$/.test(id),
  async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
    const snapshots = new Map<string, V4Snapshot | null>();
    const groups = new Map(queries.map((q) => [aaveRequestKey(q.chainId, q.userAddress), q]));
    await Promise.all([...groups].map(async ([key, { chainId, userAddress }]) => {
      const snapshot = await loadV4(chainId, userAddress, signal).catch((e) => {
        if (signal?.aborted) throw e;
        console.warn('[APY Lens] aave v4 failed:', e);
        return null;
      });
      snapshots.set(key, snapshot);
    }));
    return queries.map((q) => {
      const c = snapshots.get(aaveRequestKey(q.chainId, q.userAddress));
      if (!c) return null;
      const identity = `${q.itemPoolId ?? ''} ${q.positionKey ?? ''}`.toLowerCase();
      const spoke = identity.match(/0x[0-9a-f]{40}/)?.[0];
      if (!spoke) return null;
      const candidates = c.bySpoke.get(`${q.chainId}:${spoke}:${q.address.toLowerCase()}`) ?? [];
      const active = q.leg === 'supply' ? c.supplied : c.borrowed;
      const matched = candidates.length > 1 ? candidates.filter((row) => active.has(row.reserveId)) : candidates;
      if (matched.length !== 1) return null;
      const r = matched[0];
      if (q.leg === 'supply') {
        return {
          baseApy: r.s,
          rewardApr: r.sr,
          rewardState: r.ss,
          rewardComponents:
            r.sr !== null && r.sr > 0
              ? [{ id: `aave-v4:${q.chainId}:${spoke}:${q.address}:supply`, value: r.sr, rateKind: 'apy', source: 'aave-v4官方', basis: 'supply', observedAt: Date.now() }]
              : [],
          ...(r.poolStat ? { poolStat: r.poolStat } : {}),
          source: 'aave-v4官方',
        };
      }
      return {
        baseApy: r.b,
        rewardApr: r.br,
        rewardState: r.bs,
        rewardComponents:
          r.br !== null && r.br > 0
            ? [{ id: `aave-v4:${q.chainId}:${spoke}:${q.address}:borrow`, value: r.br, rateKind: 'apy', source: 'aave-v4官方', basis: 'borrow', observedAt: Date.now() }]
            : [],
        source: 'aave-v4官方',
      };
    });
  },
};
