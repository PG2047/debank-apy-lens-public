// 协议官方 API 适配层（2026-07-09 七路并行调研定案，见 docs/DATA_SOURCES.md）。
// 设计：官方源为主，llama 为兜底（withFallback 组合子）——官方缺资产/宕机时该腿自动回落。
// 各家口径千差万别，逐一在 loader 里归一为小数 APY/APR——数值举证见调研记录：
//   Spark BA:  supply_apy="0.036983"(小数)      Dolomite: supplyInterestRate=0.044624(小数APR)
//   Compound:  supply_apr="0.0316..."(小数APR)   Venus:   supplyApy=2.3778(百分数)
//   Fluid:     supplyRate="583"(百分数×100 整数) Ethena:  stakingYield.value=3.754(百分数,周更)
//   Falcon:    sUSDf_7d_apy="0.0486"(小数,7日均)

import { fetchWithTimeout } from '../http';
import { getTtlLru, setTtlLru } from '../cache';
import { fnSelector } from '../keccak';
import { rpcBatch } from '../uniswap';
import {
  normalizeRewardCoverage,
  type LegQuery,
  type LegRates,
  type ProtocolAdapter,
  type RewardState,
} from './types';
import { classifyLendingProduct } from './product';

// ─── 通用件 ──────────────────────────────────────────────────
/** 主源优先；主源解析为 null 的腿逐条回落次源 */
export function withFallback(primary: ProtocolAdapter, fallback: ProtocolAdapter): ProtocolAdapter {
  return {
    name: primary.name,
    matches: (id) => primary.matches(id) || fallback.matches(id),
    async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
      const a = await primary.resolve(queries, signal).catch((error) => {
        if (signal?.aborted) throw error;
        return queries.map(() => null);
      });
      const missIdx = queries
        .map((_, i) => i)
        .filter((i) => a[i] === null || a[i]?.baseApy === null || normalizedRewardState(a[i]) === 'unknown');
      if (missIdx.length === 0) return a;
      const b = await fallback.resolve(missIdx.map((i) => queries[i]), signal).catch((error) => {
        if (signal?.aborted) throw error;
        return missIdx.map(() => null);
      });
      missIdx.forEach((qi, k) => {
        a[qi] = mergeLegRates(a[qi], b[k]);
      });
      return a;
    },
  };
}

const normalizedRewardState = (r: LegRates | null | undefined): RewardState =>
  r ? normalizeRewardCoverage(r).rewardState : 'unknown';

/** Primary source owns each known component; fallback may fill only a missing component. */
export function mergeLegRates(primary: LegRates | null, fallback: LegRates | null): LegRates | null {
  if (!primary) return fallback ? { ...fallback, ...normalizeRewardCoverage(fallback) } : null;
  if (!fallback) return { ...primary, ...normalizeRewardCoverage(primary) };

  const normalizedPrimary = normalizeRewardCoverage(primary);
  const normalizedFallback = normalizeRewardCoverage(fallback);

  const useFallbackBase = primary.baseApy === null && fallback.baseApy !== null;
  const primaryRewardState = normalizedPrimary.rewardState;
  const fallbackRewardState = normalizedFallback.rewardState;
  const useFallbackReward = primaryRewardState === 'unknown' && fallbackRewardState !== 'unknown';
  if (!useFallbackBase && !useFallbackReward) {
    return { ...primary, ...normalizedPrimary };
  }

  return {
    baseApy: useFallbackBase ? fallback.baseApy : primary.baseApy,
    includesIntrinsicYield: useFallbackBase
      ? fallback.includesIntrinsicYield
      : primary.includesIntrinsicYield,
    rewardApr: useFallbackReward ? normalizedFallback.rewardApr : normalizedPrimary.rewardApr,
    rewardState: useFallbackReward ? fallbackRewardState : primaryRewardState,
    rewardComponents: useFallbackReward
      ? normalizedFallback.rewardComponents
      : normalizedPrimary.rewardComponents,
    source: `${primary.source} + ${fallback.source}`,
  };
}

const MAX_JSON_CACHE_ENTRIES = 128;
const jsonCache = new Map<string, { at: number; ttlMs: number; v: unknown }>();
async function getJson(
  url: string,
  ttlMs = 120_000,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<any> {
  signal?.throwIfAborted();
  const hit = getTtlLru(jsonCache, url, (entry) => entry.ttlMs);
  if (hit) return hit.v;
  const res = await fetchWithTimeout(url, { ...init, signal });
  if (!res.ok) throw new Error(`http ${res.status} ${url.slice(0, 60)}`);
  const v = (await res.json()) as unknown;
  signal?.throwIfAborted();
  setTtlLru(jsonCache, url, { at: Date.now(), ttlMs, v }, MAX_JSON_CACHE_ENTRIES, (entry) => entry.ttlMs);
  return v;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Convert a continuously accrued annual APR into an effective one-year APY. */
export const aprToApy = (apr: number | null): number | null =>
  apr === null || apr <= -1 ? null : Math.expm1(apr);

const exactAddress = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
};

interface RateRow {
  s: number | null; // 存款基础（小数）
  b: number | null; // 借款基础（小数）
  si?: boolean; // supply base 已含 share-token/native yield
  bi?: boolean; // borrow base 已含 share-token/native yield
  sr: number | null; // 存款奖励 APR（小数）；null=覆盖未知
  br: number | null; // 借款奖励 APR（小数）；null=覆盖未知
  ss: RewardState;
  bs: RewardState;
  sc?: NonNullable<LegRates['rewardComponents']>;
  bc?: NonNullable<LegRates['rewardComponents']>;
}
type RateMap = Map<string, RateRow | null>; // null = 同资产多容器且无法精确消歧

const positionAddresses = (q: LegQuery): string[] =>
  [...(q.itemPoolId ?? '').matchAll(/0x[0-9a-f]{40}/gi), ...(q.positionKey ?? '').matchAll(/0x[0-9a-f]{40}/gi)]
    .map((m) => m[0].toLowerCase());

const exactKey = (key: string, container: string): string => `${key}@${container.toLowerCase()}`;

/** Add a container-specific row and expose an asset-only row only when it remains unique. */
function putContainerRate(map: RateMap, key: string, row: RateRow, containers: string[]): void {
  if (!map.has(key)) map.set(key, row);
  else map.set(key, null);
  for (const container of containers.filter((v) => /^0x[0-9a-f]{40}$/i.test(v))) {
    const k = exactKey(key, container);
    if (!map.has(k)) map.set(k, row);
    else map.set(k, null);
  }
}

function rewardResult(
  name: string,
  q: LegQuery,
  rewardApr: number | null,
  state: RewardState,
  components?: NonNullable<LegRates['rewardComponents']>,
): Pick<LegRates, 'rewardApr' | 'rewardState' | 'rewardComponents'> {
  const value = rewardApr !== null && rewardApr > 0 ? rewardApr : null;
  return normalizeRewardCoverage({
    rewardApr: value ?? (state === 'confirmed-zero' ? 0 : null),
    rewardState: state,
    rewardComponents:
      components ?? (value !== null && value > 0
        ? [
            {
              id: `${name}:${q.chainId}:${q.positionKey ?? q.itemPoolId ?? q.address}:${q.leg}`,
              value,
              rateKind: 'apr',
              source: `${name}官方`,
              basis: q.leg,
              observedAt: Date.now(),
            },
          ]
        : []),
  });
}

/** 标准 adapter 骨架：loader 拉 RateMap（第三参数是历史遗留的 llama project 槽位，已不再使用） */
function mkOfficial(
  name: string,
  idPattern: RegExp,
  _llamaProject: string | null,
  loader: (chainIds: number[], signal?: AbortSignal) => Promise<RateMap>,
): ProtocolAdapter {
  return {
    name,
    matches: (id) => idPattern.test(id),
    async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
      const map = await loader([...new Set(queries.map((q) => q.chainId))], signal).catch((e) => {
        if (signal?.aborted) throw e;
        console.warn(`[APY Lens] ${name} official api failed:`, e);
        return new Map() as RateMap;
      });
      return queries.map((q) => {
        const key = `${q.chainId}:${q.address}`;
        const identities = positionAddresses(q);
        const containerAware = [...map.keys()].some((candidate) => candidate.startsWith(`${key}@`));
        let r: RateRow | null | undefined;
        for (const id of identities) {
          const k = exactKey(key, id);
          if (map.has(k)) {
            r = map.get(k);
            break;
          }
          const wildcard = exactKey(`${q.chainId}:*`, id);
          if (map.has(wildcard)) {
            r = map.get(wildcard);
            break;
          }
        }
        // Once an asset has container-specific rows, token-only attribution is forbidden.
        if (containerAware && r === undefined) return null;
        if (r === undefined) r = map.get(key);
        if (!r) return null;
        if (q.leg === 'supply') {
          return {
            baseApy: r.s,
            includesIntrinsicYield: r.si,
            ...rewardResult(name, q, r.sr, r.ss, r.sc),
            source: `${name}官方`,
          };
        }
        return {
          baseApy: r.b,
          includesIntrinsicYield: r.bi,
          ...rewardResult(name, q, r.br, r.bs, r.bc),
          source: `${name}官方`,
        };
      });
    },
  };
}

// ─── Spark（SparkLend；Block Analitica 官方镜像，30s 缓存，链上逐位一致）───
const SPARK_CHAIN: Record<number, string> = { 1: 'ethereum', 100: 'gnosis' };
const sparkMarketsOfficial = mkOfficial(
  'spark',
  /^([a-z0-9]+_)?spark$/,
  'sparklend',
  async (chainIds, signal) => {
    const map: RateMap = new Map();
    await Promise.all(
      chainIds.filter((c) => SPARK_CHAIN[c]).map(async (cid) => {
        const arr = await getJson(`https://spark-api.blockanalitica.com/v1/${SPARK_CHAIN[cid]}/markets/`, undefined, undefined, signal);
        for (const m of Array.isArray(arr) ? arr : []) {
          const addr = typeof m?.underlying_address === 'string' ? m.underlying_address.toLowerCase() : null;
          if (!addr) continue;
          map.set(`${cid}:${addr}`, {
            s: num(m?.supply_apy),
            b: num(m?.borrow_variable_apy),
            // Markets 端点只证明基础利率，不枚举全部奖励活动。
            sr: null,
            br: null,
            ss: 'unknown',
            bs: 'unknown',
          });
        }
      }),
    );
    return map;
  },
);

export const sparkOfficial: ProtocolAdapter = {
  ...sparkMarketsOfficial,
  async resolve(queries, signal) {
    const rates = await sparkMarketsOfficial.resolve(queries, signal);
    return rates.map((rate, index) =>
      classifyLendingProduct(queries[index]) === 'lending' ? rate : null,
    );
  },
};

// ─── Dolomite（api.dolomite.io；小数 APR；奖励在 outsideSupplyInterestRateParts）───
export const dolomiteOfficial = mkOfficial(
  'dolomite',
  /^([a-z0-9]+_)?dolomite$/,
  'dolomite',
  async (chainIds, signal) => {
    const map: RateMap = new Map();
    await Promise.all(
      chainIds.map(async (cid) => {
        const j = await getJson(`https://api.dolomite.io/tokens/${cid}/interest-rates`, undefined, undefined, signal).catch(() => null);
        for (const r of j?.interestRates ?? []) {
          const addr = typeof r?.token?.tokenAddress === 'string' ? r.token.tokenAddress.toLowerCase() : null;
          if (!addr) continue;
          const parseParts = (parts: unknown): {
            apr: number | null;
            state: RewardState;
            nativeApr: number | null;
          } => {
            if (!Array.isArray(parts)) return { apr: null, state: 'unknown', nativeApr: null };
            let apr = 0;
            let nativeApr = 0;
            let hasPoints = false;
            let malformed = false;
            let nativeMalformed = false;
            for (const part of parts) {
              const category = part?.category;
              if (category === 'nativeYield') {
                const value = num(part?.interestRate);
                if (value === null || value < 0) nativeMalformed = true;
                else nativeApr += value;
                continue;
              }
              if (category === 'points') {
                hasPoints = true;
                continue;
              }
              if (category !== 'rewards') {
                malformed = true;
                continue;
              }
              const value = num(part?.interestRate);
              if (value === null || value < 0) malformed = true;
              else apr += value;
            }
            return {
              apr: apr > 0 ? apr : hasPoints || malformed ? null : 0,
              state: hasPoints
                ? 'non-annualizable'
                : malformed
                  ? 'unknown'
                  : apr > 0
                    ? 'numeric-known'
                    : 'confirmed-zero',
              nativeApr: nativeMalformed ? null : nativeApr,
            };
          };
          const supplyReward = parseParts(r?.outsideSupplyInterestRateParts);
          const borrowReward = parseParts(r?.outsideBorrowInterestRateParts);
          const supplyBase = num(r?.supplyInterestRate);
          const borrowBase = num(r?.borrowInterestRate);
          const supplyBaseApr =
            supplyBase === null || supplyReward.nativeApr === null
              ? null
              : supplyBase + supplyReward.nativeApr;
          const borrowBaseApr =
            borrowBase === null || borrowReward.nativeApr === null
              ? null
              : borrowBase + borrowReward.nativeApr;
          map.set(`${cid}:${addr}`, {
            s: aprToApy(supplyBaseApr),
            b: aprToApy(borrowBaseApr),
            si: (supplyReward.nativeApr ?? 0) > 0,
            bi: (borrowReward.nativeApr ?? 0) > 0,
            sr: supplyReward.apr,
            br: borrowReward.apr,
            ss: supplyReward.state,
            bs: borrowReward.state,
          });
        }
      }),
    );
    return map;
  },
);

// ─── Compound V3（v3-api.compound.finance；全网一次拉全；小数 APR）───
export const compoundOfficial = mkOfficial(
  'compound-v3',
  /^([a-z0-9]+_)?compound3$/,
  'compound-v3',
  async (chainIds, signal) => {
    const map: RateMap = new Map();
    const summary = await getJson('https://v3-api.compound.finance/market/all-networks/all-contracts/summary', undefined, undefined, signal);
    // Reward transport is optional: exact summary base rates must survive its absence.
    const rewards = await getJson(
      'https://v3-api.compound.finance/market/all-networks/all-contracts/rewards/dapp-data',
      undefined,
      undefined,
      signal,
    ).catch(() => null);
    const wantedChains = new Set(chainIds);
    const summaries = (Array.isArray(summary) ? summary : [])
      .filter((market) => wantedChains.has(Number(market?.chain_id)))
      .slice(0, 200);
    const rewardByComet = new Map<string, any | null>();
    for (const reward of Array.isArray(rewards) ? rewards : []) {
      const comet = exactAddress(reward?.comet?.address);
      const chainId = Number(reward?.chain_id);
      if (!comet || !wantedChains.has(chainId)) continue;
      const key = `${chainId}:${comet}`;
      rewardByComet.set(key, rewardByComet.has(key) ? null : reward);
    }

    const baseFromSummary = (market: any): string | null =>
      exactAddress(market?.base_asset?.address) ??
      exactAddress(market?.baseAsset?.address) ??
      exactAddress(market?.base_token?.address) ??
      exactAddress(market?.baseToken?.address) ??
      exactAddress(market?.base_asset_address) ??
      exactAddress(market?.baseAssetAddress);
    const resolvedBases = new Map<string, string>();
    const missingByChain = new Map<number, string[]>();
    for (const market of summaries) {
      const chainId = Number(market?.chain_id);
      const comet = exactAddress(market?.comet?.address);
      if (!comet) continue;
      const key = `${chainId}:${comet}`;
      const rewardBase = exactAddress(rewardByComet.get(key)?.base_asset?.address);
      const summaryBase = baseFromSummary(market);
      const base = summaryBase ?? rewardBase;
      if (base) resolvedBases.set(key, base);
      else missingByChain.set(chainId, [...(missingByChain.get(chainId) ?? []), comet]);
    }
    const baseTokenSelector = fnSelector('baseToken()');
    await Promise.all([...missingByChain].map(async ([chainId, comets]) => {
      const results = await rpcBatch(
        chainId,
        comets.slice(0, 200).map((comet) => ({ to: comet, data: baseTokenSelector })),
        signal,
      ).catch(() => comets.map(() => null));
      comets.forEach((comet, index) => {
        const data = results[index];
        const base = typeof data === 'string' && data.length >= 66
          ? exactAddress(`0x${data.slice(-40)}`)
          : null;
        if (base && base !== '0x0000000000000000000000000000000000000000') {
          resolvedBases.set(`${chainId}:${comet}`, base);
        }
      });
    }));

    for (const market of summaries) {
      const chainId = Number(market?.chain_id);
      const comet = exactAddress(market?.comet?.address);
      if (!comet) continue;
      const key = `${chainId}:${comet}`;
      const base = resolvedBases.get(key);
      if (!base) continue;
      const reward = rewardByComet.get(key);
      const rewardBase = exactAddress(reward?.base_asset?.address);
      const exactReward = reward && rewardBase === base ? reward : null;
      const supplyRewardApr = exactReward ? num(exactReward?.earn_rewards_apr) : null;
      const borrowRewardApr = exactReward ? num(exactReward?.borrow_rewards_apr) : null;
      const row: RateRow = {
        s: aprToApy(num(market?.supply_apr)),
        b: aprToApy(num(market?.borrow_apr)),
        sr: supplyRewardApr,
        br: borrowRewardApr,
        ss: supplyRewardApr === null
          ? 'unknown'
          : supplyRewardApr > 0
            ? 'numeric-known'
            : 'confirmed-zero',
        bs: borrowRewardApr === null
          ? 'unknown'
          : borrowRewardApr > 0
            ? 'numeric-known'
            : 'confirmed-zero',
      };
      putContainerRate(map, `${chainId}:${base}`, row, [comet]);
      map.set(exactKey(`${chainId}:*`, comet), {
        s: 0,
        b: null,
        sr: null,
        br: null,
        ss: 'not-applicable',
        bs: 'not-applicable',
      });
    }
    return map;
  },
);

// ─── Venus（api.venus.io；百分数 APY；同资产多池必须去重取规模最大=核心池）───
export const venusOfficial = mkOfficial(
  'venus',
  /^([a-z0-9]+_)?venus$/,
  'venus-core-pool',
  async (chainIds, signal) => {
    const map: RateMap = new Map();
    await Promise.all(
      chainIds.map(async (cid) => {
        const j = await getJson(`https://api.venus.io/markets?chainId=${cid}&limit=100`, 120_000, {
          headers: { 'accept-version': 'next' },
        }, signal).catch(() => null);
        // 同资产可存在多个隔离池；只保留 vToken/comptroller 精确键，资产键仅在唯一时可用。
        for (const m of j?.result ?? []) {
          if (m?.isListed === false) continue;
          const addr = typeof m?.underlyingAddress === 'string' ? m.underlyingAddress.toLowerCase() : null;
          if (!addr || addr.startsWith('0xbbbb')) continue; // vBNB 原生占位
          const key = `${cid}:${addr}`;
          const vToken = typeof m?.address === 'string' ? m.address.toLowerCase() : '';
          const supplyDec = num(m?.supplyApyDecimal);
          const borrowDec = num(m?.borrowApyDecimal) ??
            (num(m?.borrowApy) !== null ? (num(m.borrowApy) as number) / 100 : null);
          const distributors = Array.isArray(m?.rewardsDistributors)
            ? m.rewardsDistributors.filter((reward: any) => reward?.isActive === true)
            : null;
          const points = Array.isArray(m?.pointsDistributions) ? m.pointsDistributions : null;
          const forLeg = (leg: 'supply' | 'borrow') => {
            const speedField = leg === 'supply' ? 'supplySpeed' : 'borrowSpeed';
            const deadlineField = leg === 'supply'
              ? 'lastRewardingSupplyBlockOrTimestamp'
              : 'lastRewardingBorrowBlockOrTimestamp';
            const active = (distributors ?? []).filter((reward: any) => {
              if ((num(reward?.[speedField]) ?? 0) <= 0) return false;
              const deadline = num(reward?.[deadlineField]);
              return deadline === null || deadline === 0 || deadline < 1_000_000_000 || deadline * 1000 > Date.now();
            });
            const hasPoints = (points ?? []).some((point: any) => point?.action === leg);
            const explicitApr = num(leg === 'supply' ? m?.supplyXvsApr : m?.borrowXvsApr);
            const components: NonNullable<LegRates['rewardComponents']> = [];
            let baseAddon = 0;
            let baseMalformed = false;
            let rewardMalformed = distributors === null || points === null;

            if (explicitApr !== null && explicitApr > 0) {
              components.push({
                id: `venus:${cid}:${vToken}:${leg}:venus`,
                value: explicitApr,
                rateKind: 'apr',
                source: 'venus官方',
                basis: leg,
                observedAt: Date.now(),
              });
            }
            for (const reward of active) {
              const type = reward?.rewardType;
              const details = reward?.rewardDetails ?? {};
              if (type === 'venus') {
                if (explicitApr === null) rewardMalformed = true;
                continue;
              }
              if (type === 'intrinsic' || type === 'yield-to-maturity') {
                const apy = num(details?.apy);
                if (apy === null || apy < 0 || apy >= 10) baseMalformed = true;
                else baseAddon += apy;
                continue;
              }
              if (type === 'merkl') {
                const aprPercent = num(details?.apr);
                if (aprPercent === null || aprPercent < 0 || aprPercent >= 1000) {
                  rewardMalformed = true;
                  continue;
                }
                const externalId = String(
                  details?.merklCampaignIdentifier ?? details?.merklCampaignId ?? reward?.id ?? 'unknown',
                ).slice(0, 256);
                components.push({
                  id: `venus:${cid}:${vToken}:${leg}:merkl:${externalId}`,
                  value: aprPercent / 100,
                  rateKind: 'apr',
                  source: 'venus官方:merkl',
                  basis: leg,
                  observedAt: Date.now(),
                });
                continue;
              }
              rewardMalformed = true;
            }
            const rewardApr = components.reduce((sum, component) => sum + component.value, 0);
            const state: RewardState = hasPoints
              ? 'non-annualizable'
              : rewardMalformed
                ? 'unknown'
                : components.length > 0
                  ? 'numeric-known'
                  : 'confirmed-zero';
            return {
              baseAddon: baseMalformed ? null : baseAddon,
              rewardApr: components.length > 0 ? rewardApr : state === 'confirmed-zero' ? 0 : null,
              state,
              components,
            };
          };
          const supply = forLeg('supply');
          const borrow = forLeg('borrow');
          const row: RateRow = {
            s:
              supply.baseAddon === null
                ? null
                : (supplyDec ?? (num(m?.supplyApy) !== null ? (num(m.supplyApy) as number) / 100 : null)) !== null
                  ? (supplyDec ?? (num(m.supplyApy) as number) / 100) + supply.baseAddon
                  : null,
            b: borrow.baseAddon === null || borrowDec === null ? null : borrowDec + borrow.baseAddon,
            si: (supply.baseAddon ?? 0) > 0,
            bi: (borrow.baseAddon ?? 0) > 0,
            sr: supply.rewardApr,
            br: borrow.rewardApr,
            ss: supply.state,
            bs: borrow.state,
            sc: supply.components,
            bc: borrow.components,
          };
          const sane = (value: number | null) => value === null || (value >= 0 && value < 3);
          // Each side is independent: one malformed side must not discard the other exact side.
          if (!sane(row.s)) row.s = null;
          if (!sane(row.b)) row.b = null;
          if (row.s === null && row.b === null && row.sr === null && row.br === null) continue;
          const comptroller =
            typeof m?.poolComptrollerAddress === 'string' ? m.poolComptrollerAddress.toLowerCase() : '';
          putContainerRate(map, key, row, [vToken, comptroller]);
        }
      }),
    );
    return map;
  },
);

// ─── Fluid（api.fluid.instadapp.io；整数字符串=百分数×100；三端点）───
const fluidPctInt = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n / 10000; // "583" → 5.83% → 0.0583
};

export interface ParsedFluidRewards {
  complete: boolean;
  rates: Map<string, { supply: number; borrow: number }>;
  /** Exact keys whose rows were only partially parseable. */
  incompleteKeys: Set<string>;
}

/** Accept both the live object map and documented array wrappers without silently treating malformed data as empty. */
export function parseFluidRewards(raw: unknown, now = Date.now()): ParsedFluidRewards {
  let entries: Array<[string, unknown]> | null = null;
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const wrapped = obj?.data;
  if (Array.isArray(raw)) {
    entries = raw.map((entry: any) => [
      String(entry?.key ?? entry?.fToken ?? entry?.address ?? ''),
      entry?.value ?? entry?.rewards,
    ]);
  } else if (Array.isArray(wrapped)) {
    entries = wrapped.map((entry: any) => [
      String(entry?.key ?? entry?.fToken ?? entry?.address ?? ''),
      entry?.value ?? entry?.rewards,
    ]);
  } else if (wrapped && typeof wrapped === 'object') {
    entries = Object.entries(wrapped as Record<string, unknown>);
  } else if (obj && !('data' in obj)) {
    entries = Object.entries(obj);
  }
  if (!entries) return { complete: false, rates: new Map(), incompleteKeys: new Set() };

  let complete = true;
  const rates = new Map<string, { supply: number; borrow: number }>();
  const incompleteKeys = new Set<string>();
  for (const [rawKey, list] of entries) {
    const key = rawKey.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(key) || !Array.isArray(list)) {
      complete = false;
      if (/^0x[0-9a-f]{40}$/.test(key)) incompleteKeys.add(key);
      continue;
    }
    const sums = { supply: 0, borrow: 0 };
    let keyComplete = true;
    for (const item of list) {
      const rate = fluidPctInt((item as any)?.rate);
      const rawType = (item as any)?.type;
      const type: 'supply' | 'borrow' | null = rawType === 'supply' || rawType === 'borrow' ? rawType : null;
      if (rate === null || type === null) {
        complete = false;
        keyComplete = false;
        continue;
      }
      const rawEnd = num((item as any)?.endTime);
      const end = rawEnd === null ? Infinity : rawEnd < 1e12 ? rawEnd * 1000 : rawEnd;
      if (end <= now) continue;
      sums[type] += rate;
    }
    rates.set(key, sums);
    if (!keyComplete) incompleteKeys.add(key);
  }
  return { complete, rates, incompleteKeys };
}

function fluidRewardFor(
  parsed: ParsedFluidRewards,
  key: string | null,
  leg: 'supply' | 'borrow',
): { value: number | null; state: RewardState } {
  if (!key) return { value: null, state: 'unknown' };
  const sums = parsed.rates.get(key);
  if (!sums) {
    return parsed.complete
      ? { value: 0, state: 'confirmed-zero' }
      : { value: null, state: 'unknown' };
  }
  const value = sums[leg];
  if (parsed.incompleteKeys.has(key)) return { value, state: 'unknown' };
  return { value, state: value === 0 ? 'confirmed-zero' : 'numeric-known' };
}

function fluidVaultReward(
  parsed: ParsedFluidRewards,
  vault: string,
  leg: 'supply' | 'borrow',
  tradingApy: number | null,
  tradingApplies: boolean,
): Partial<Pick<RateRow, 'sr' | 'br' | 'ss' | 'bs' | 'sc' | 'bc'>> {
  const external = fluidRewardFor(parsed, vault, leg);
  const trading = tradingApplies ? tradingApy : 0;
  const incomplete = external.state === 'unknown' || (tradingApplies && trading === null);
  const components: NonNullable<LegRates['rewardComponents']> = [];
  if (external.value !== null && external.value > 0) {
    components.push({
      id: `fluid-reward:${vault}:${leg}`,
      value: external.value,
      rateKind: 'apr',
      source: 'fluid-rewards-api',
      basis: leg,
      observedAt: Date.now(),
    });
  }
  if (trading !== null && trading > 0) {
    components.push({
      id: `fluid-dex:${vault}:${leg}`,
      value: trading,
      rateKind: 'apy',
      source: 'fluid-vault-dex-trading',
      basis: leg,
      observedAt: Date.now(),
    });
  }
  const known = (external.value ?? 0) + (trading ?? 0);
  const state: RewardState = incomplete
    ? 'unknown'
    : external.state === 'non-annualizable'
      ? 'non-annualizable'
      : known > 0
        ? 'numeric-known'
        : 'confirmed-zero';
  const value = known > 0 ? known : state === 'confirmed-zero' ? 0 : null;
  return leg === 'supply'
    ? { sr: value, ss: state, sc: components }
    : { br: value, bs: state, bc: components };
}

export const fluidOfficial = mkOfficial(
  'fluid',
  /^([a-z0-9]+_)?fluid$/,
  'fluid-lending',
  async (chainIds, signal) => {
    const map: RateMap = new Map();
    await Promise.all(
      chainIds.map(async (cid) => {
        const [tokens, rewards, vaults] = await Promise.all([
          getJson(`https://api.fluid.instadapp.io/v2/lending/${cid}/tokens`, undefined, undefined, signal).catch(() => null),
          getJson(`https://api.fluid.instadapp.io/v2/lending/${cid}/rewards`, undefined, undefined, signal).catch(() => null),
          getJson(`https://api.fluid.instadapp.io/v2/${cid}/vaults`, undefined, undefined, signal).catch(() => null),
        ]);
        const parsedRewards = parseFluidRewards(rewards);
        const vaultArr = Array.isArray(vaults) ? vaults : Array.isArray(vaults?.data) ? vaults.data : [];
        const tokenArr = Array.isArray(tokens) ? tokens : Array.isArray(tokens?.data) ? tokens.data : [];
        for (const t of tokenArr) {
          const asset = typeof t?.asset?.address === 'string' ? t.asset.address.toLowerCase() : null;
          const fToken = typeof t?.address === 'string' ? t.address.toLowerCase() : null;
          if (!asset) continue;
          const supplyReward = fluidRewardFor(parsedRewards, fToken, 'supply');
          const row: RateRow = {
            s: fluidPctInt(t?.supplyRate),
            b: null,
            sr: supplyReward.value,
            ss: supplyReward.state,
            // lending/rewards 以 fToken 为键，只穷尽 fToken 存款奖励，不能证明 vault 借款为零。
            br: null,
            bs: 'unknown',
          };
          const key = `${cid}:${asset}`;
          putContainerRate(map, key, row, fToken ? [fToken] : []);
        }

        // Vault 的基础率和奖励都绑定 vault address + side；不能复用 fToken 或任一 vault 的首条数据。
        for (const v of vaultArr) {
          const vault = typeof v?.address === 'string' ? v.address.toLowerCase() : null;
          if (!vault || !/^0x[0-9a-f]{40}$/.test(vault)) continue;
          const parsedVaultRewards = parseFluidRewards({ [vault]: v?.rewards });
          const vaultType = Number(v?.type);
          for (const index of [0, 1] as const) {
            for (const leg of ['supply', 'borrow'] as const) {
              const token = v?.[`${leg}Token`]?.[`token${index}`];
              const asset = typeof token?.address === 'string' ? token.address.toLowerCase() : null;
              if (!asset || !/^0x[0-9a-f]{40}$/.test(asset) || /^0x0{40}$/.test(asset)) continue;
              const smartSide =
                (leg === 'supply' && (vaultType === 2 || vaultType === 4)) ||
                (leg === 'borrow' && (vaultType === 3 || vaultType === 4));
              const rate = smartSide
                ? fluidPctInt(v?.[`${leg}Rate`]?.liquidity?.[`token${index}`])
                : (index === 0 ? fluidPctInt(v?.[`${leg}Rate`]?.vault?.rate) : null) ??
                  fluidPctInt(v?.[`${leg}Rate`]?.liquidity?.[`token${index}`]);
              const key = exactKey(`${cid}:${asset}`, vault);
              const previous = map.get(key);
              const reward = fluidVaultReward(
                parsedVaultRewards,
                vault,
                leg,
                fluidPctInt(v?.[`${leg}Rate`]?.dex?.trading),
                smartSide,
              );
              const next: RateRow = {
                s: leg === 'supply' ? rate : previous?.s ?? null,
                b: leg === 'borrow' ? rate : previous?.b ?? null,
                sr: leg === 'supply' ? reward.sr ?? null : previous?.sr ?? null,
                br: leg === 'borrow' ? reward.br ?? null : previous?.br ?? null,
                ss: leg === 'supply' ? reward.ss ?? 'unknown' : previous?.ss ?? 'unknown',
                bs: leg === 'borrow' ? reward.bs ?? 'unknown' : previous?.bs ?? 'unknown',
                sc: leg === 'supply' ? reward.sc : previous?.sc,
                bc: leg === 'borrow' ? reward.bc : previous?.bc,
              };
              map.set(key, next);
            }
          }
        }
      }),
    );
    return map;
  },
);

// ─── Ethena（仅保留官方数字收益；积分与资格元数据按产品策略排除）───
// Per-chain canonical tokens include bridged sUSDe with the same underlying share yield.
import { SUSDE_BY_CHAIN, SUSDF_BY_CHAIN } from '../token-deployments';
const ENA = '0x57e114b691db790c35207b2e685d4a43181e6061';
export const ethenaOfficial: ProtocolAdapter = {
  name: 'ethena',
  matches: (id) => /^([a-z0-9]+_)?ethena$/.test(id),
  async resolve(queries, signal) {
    let staking: number | null = null;
    if (queries.some((q) => q.leg === 'supply' && q.address === SUSDE_BY_CHAIN[q.chainId])) {
      try {
        const j = await getJson('https://ethena.fi/api/yields/protocol-and-staking-yield', 60 * 60 * 1000, undefined, signal);
        const v = num(j?.stakingYield?.value);
        staking = v !== null ? v / 100 : null; // 百分数 → 小数
      } catch {
        /* fallthrough */
      }
    }
    return queries.map((q) => {
      if (q.leg !== 'supply') return null;
      if (q.address === SUSDE_BY_CHAIN[q.chainId] && staking !== null) {
        return {
          baseApy: staking,
          includesIntrinsicYield: true,
          rewardApr: null,
          rewardState: 'not-applicable',
          rewardComponents: [],
          source: 'ethena官方(周更)',
        };
      }
      const product = q.itemName?.replace(/\s+/g, '').toLowerCase();
      if (q.chainId === 1 && q.address === ENA && product === 'sena' && !q.itemHasBorrows) {
        return {
          baseApy: 0,
          includesIntrinsicYield: true,
          rewardApr: null,
          rewardState: 'not-applicable' as const,
          rewardComponents: [],
          source: 'ethena:sENA',
        };
      }
      return null; // USDe 本体或非 exact-sENA 的 ENA 不猜测
    });
  },
};

// ─── Falcon（api.falcon.finance；sUSDf 全局单值 7日均 APY；分钟级更新）───
export const falconOfficial: ProtocolAdapter = {
  name: 'falcon',
  matches: (id) => /^([a-z0-9]+_)?falcon(finance)?$/.test(id),
  async resolve(queries, signal) {
    let apy: number | null = null;
    try {
      const j = await getJson('https://api.falcon.finance/api/v1/statistics', 10 * 60 * 1000, undefined, signal);
      apy = num(j?.sUSDf_7d_apy) ?? num(j?.['7d_apy']); // 小数
    } catch {
      /* fallthrough */
    }
    return queries.map((q) => {
      if (q.leg !== 'supply' || apy === null) return null;
      if (q.address === SUSDF_BY_CHAIN[q.chainId]) {
        return {
          baseApy: apy,
          includesIntrinsicYield: true,
          rewardApr: null,
          rewardState: 'non-annualizable',
          rewardComponents: [],
          source: 'falcon官方(7日均)',
        };
      }
      return null;
    });
  },
};
