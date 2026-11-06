// Aave V4 官方 GraphQL 适配器（api.v4.aave.com，keyless）。
// V4 是 hub-and-spoke 架构，与 v3 的 Market/aToken 模型完全不同，端点独立（v3 端点查不到 V4）。
// schema 来源：aave/aave-v4-sdk repo（生产端 introspection 关闭），关键字段已实测（2026-07-10）：
//   - reserves(request:{query:{chainIds:[1]},filter:ALL})；PercentNumber.value 为小数（1.0=100%）
//   - 奖励内联在 summary.rewards：MerklSupplyReward.extraApy（存款侧）/ MerklBorrowReward.discountApy（借款补贴）
//   - 同一资产可出现在多个 spoke（风险配置不同）；DeBank item 的 pool.id 即 spoke 地址 → 优先精确匹配
//   - 按请求链分别查询、缓存与合并；新部署无需修改 Ethereum 白名单。

import type { LegQuery, LegRates, ProtocolAdapter, RewardState } from './types';
import { fetchWithTimeout } from '../http';
import { SharedAbortableLoad } from '../shared-load';
import { getTtlLru, setTtlLru } from '../cache';

const ENDPOINT = 'https://api.v4.aave.com/graphql';
const TTL_MS = 5 * 60 * 1000;
export const AAVE_V4_SOURCE_TIMEOUT_MS = 8_000;

interface V4Rates {
  s: number | null; // 存款基础 APY（小数）
  b: number | null; // 借款基础 APY（小数）
  sr: number | null; // 存款侧 Merkl 奖励 APR（小数）
  br: number | null; // 借款侧 Merkl 补贴 APR（小数）
  ss: RewardState;
  bs: RewardState;
  poolStat?: NonNullable<LegRates['poolStat']>;
}

type V4Snapshot = { at: number; bySpoke: Map<string, V4Rates> };

const cache = new Map<number, V4Snapshot>();
const coldLoads = new Map<number, SharedAbortableLoad<V4Snapshot>>();

const QUERY = `query Reserves($chainIds: [Int!]!) { reserves(request: { query: { chainIds: $chainIds }, filter: ALL }) {
  spoke { address }
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
      ... on MerklSupplyReward { extraApy { value } }
      ... on MerklBorrowReward { discountApy { value } }
    }
  }
} }`;

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

async function fetchV4(chainId: number, signal: AbortSignal): Promise<V4Snapshot> {
  const res = await fetchWithTimeout(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { chainIds: [chainId] } }),
    signal,
  }, AAVE_V4_SOURCE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`aave v4 http ${res.status}`);
  const body = (await res.json()) as { errors?: unknown[]; data?: { reserves?: Record<string, any>[] } };
  if (body.errors?.length) throw new Error(`aave v4 gql: ${JSON.stringify(body.errors).slice(0, 300)}`);

  const bySpoke = new Map<string, V4Rates>();
  for (const r of body.data?.reserves ?? []) {
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
        const value = frac(rw?.extraApy?.value);
        if (value !== null) supplyNumericSeen = true;
        sr = value === null || sr === null ? null : sr + value;
      } else if (rw?.__typename === 'MerklBorrowReward') {
        const value = frac(rw?.discountApy?.value);
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
      s: frac(sum.supplyApy?.value),
      b: frac(sum.borrowApy?.value),
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
    bySpoke.set(`${chainId}:${spoke.toLowerCase()}:${under.toLowerCase()}`, row);
  }
  if (bySpoke.size === 0) throw new Error('aave v4 returned no reserves');
  const snapshot = { at: Date.now(), bySpoke };
  setTtlLru(cache, chainId, snapshot, 128, () => TTL_MS);
  return snapshot;
}

async function loadV4(chainId: number, signal?: AbortSignal): Promise<V4Snapshot> {
  const hit = getTtlLru(cache, chainId, () => TTL_MS);
  if (hit) return hit;
  let load = coldLoads.get(chainId);
  if (!load) {
    load = new SharedAbortableLoad<V4Snapshot>();
    coldLoads.set(chainId, load);
  }
  try {
    return await load.run((loadSignal) => fetchV4(chainId, loadSignal), signal);
  } finally {
    if (!load.isActive() && coldLoads.get(chainId) === load) coldLoads.delete(chainId);
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
    const snapshots = new Map<number, V4Snapshot | null>();
    const chainIds = [...new Set(queries.map((q) => q.chainId))];
    await Promise.all(chainIds.map(async (chainId) => {
      if (!Number.isSafeInteger(chainId) || chainId <= 0) return;
      const snapshot = await loadV4(chainId, signal).catch((e) => {
        if (signal?.aborted) throw e;
        console.warn('[APY Lens] aave v4 failed:', e);
        return null;
      });
      snapshots.set(chainId, snapshot);
    }));
    return queries.map((q) => {
      const c = snapshots.get(q.chainId);
      if (!c) return null;
      const identity = `${q.itemPoolId ?? ''} ${q.positionKey ?? ''}`.toLowerCase();
      const spoke = identity.match(/0x[0-9a-f]{40}/)?.[0];
      if (!spoke) return null;
      const r = c.bySpoke.get(`${q.chainId}:${spoke}:${q.address}`);
      if (!r) return null;
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
