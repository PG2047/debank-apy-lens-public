// DeFiLlama yields 通用适配器 —— 供 Spark / Sky 等没有干净官方利率 API 的协议使用。
// 实测核实（2026-07-07）：
//   - /pools：project / chain / symbol / apyBase / apyReward（百分数）/ poolMeta / underlyingTokens / pool(UUID)
//   - /lendBorrow：无 project 字段，靠 pool UUID 与 /pools 连接；apyBaseBorrow/apyRewardBorrow 百分数；
//     borrowable=false 表示不可借
//   - poolMeta != null 的池是 CDP 金库 / 特殊农场（如 "SPK Farming Pool"、"ETH-A"），一律排除
//   - 同一 (project, chain, underlying) 出现多个池 → 该 key 标记歧义，丢弃（宁缺毋滥）
// 全量约 11MB，进程内缓存 30 分钟，只留声明过的 project 子集。

import { chainIdFromName } from '../chains';
import { fetchWithTimeout } from '../http';
import { SharedAbortableLoad } from '../shared-load';
import { classifyLendingProduct } from './product';
import type { LegQuery, LegRates, ProtocolAdapter, RewardState } from './types';

const POOLS_URL = 'https://yields.llama.fi/pools';
const BORROW_URL = 'https://yields.llama.fi/lendBorrow';
const TTL_MS = 30 * 60 * 1000;
// /pools is currently ~11 MiB; 16 MiB is the only intentionally enlarged shared HTTP budget.
const LLAMA_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;


interface PoolRates {
  supplyBase: number;
  supplyReward: number | null;
  supplyRewardState: RewardState;
  borrowBase: number | null;
  borrowReward: number | null;
  borrowRewardState: RewardState;
  project: string;
  pool: string;
}

// key: `${project}|${chainId}|${addr小写}`；value null = 同 key 多池歧义
type LlamaMap = Map<string, PoolRates | null>;

const trackedProjects = new Set<string>();
const rawByProject = new Map<string, Record<string, any>[]>();
let cache: { at: number; map: LlamaMap; nProj: number } | null = null;
const sharedLoad = new SharedAbortableLoad<LlamaMap>();

/** 某 project 的原始池行（未过滤，含纯奖励农场池）；供需要自定义池分类的 adapter 使用 */
export async function llamaProjectPools(project: string, signal?: AbortSignal): Promise<Record<string, any>[]> {
  trackedProjects.add(project);
  await load(signal);
  return rawByProject.get(project) ?? [];
}

function pct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000 ? v / 100 : null;
}

async function load(signal?: AbortSignal): Promise<LlamaMap> {
  // 缓存命中还要求 trackedProjects 没有新增：sky 等专用 adapter 在 resolve 期才注册 project，
  // 沿用旧缓存会拿不到该 project 的原始池行（rawByProject 只在真正拉取时重建）——
  // 这是「B 地址 GROVE 农场显示 --」的根因之一（2026-07-10）
  if (cache && Date.now() - cache.at < TTL_MS && cache.nProj === trackedProjects.size) return cache.map;
  return sharedLoad.run(async (loadSignal) => {
    const poolsPromise = fetchWithTimeout(POOLS_URL, { signal: loadSignal }, undefined, LLAMA_MAX_RESPONSE_BYTES);
    // lendBorrow is optional enrichment. Its transport failure cannot erase valid /pools supply data.
    const borrowPromise = fetchWithTimeout(BORROW_URL, { signal: loadSignal }, undefined, LLAMA_MAX_RESPONSE_BYTES).catch(() => null);
    const [poolsRes, borrowRes] = await Promise.all([poolsPromise, borrowPromise]);
    if (!poolsRes.ok) throw new Error(`llama pools http ${poolsRes.status}`);
    const poolsBody = (await poolsRes.json()) as { data?: unknown[] };
    const pools = Array.isArray(poolsBody?.data) ? poolsBody.data : [];

    // lendBorrow 失败不致命：借款侧全部视为未知
    let borrowByUuid = new Map<string, Record<string, any>>();
    if (borrowRes?.ok) {
      try {
        const b = (await borrowRes.json()) as unknown;
        const arr = Array.isArray(b) ? b : Array.isArray((b as any)?.data) ? (b as any).data : [];
        borrowByUuid = new Map(
          arr
            .filter((x: any) => typeof x?.pool === 'string')
            .map((x: any) => [x.pool, x as Record<string, any>]),
        );
      } catch {
        // A malformed optional response is equivalent to unavailable borrow enrichment.
      }
    }

    const map: LlamaMap = new Map();
    rawByProject.clear();
    for (const raw of pools) {
      const p = raw as Record<string, any>;
      if (!trackedProjects.has(p?.project)) continue;
      // 原始行留档（过滤前）——sky 等需要自行处理纯奖励池（apyBase=null 的农场）的 adapter 用
      const rawList = rawByProject.get(p.project) ?? [];
      rawList.push(p);
      rawByProject.set(p.project, rawList);
      if (p?.poolMeta != null) continue;
      const chainId = chainIdFromName(p?.chain);
      const u: unknown[] = Array.isArray(p?.underlyingTokens) ? p.underlyingTokens : [];
      if (!chainId || u.length !== 1 || typeof u[0] !== 'string') continue;
      const supplyBase = pct(p?.apyBase);
      if (supplyBase === null) continue; // 无供给基础利率的池（CDP 抵押物等）不可用

      const b = borrowByUuid.get(p?.pool);
      const borrowable = b?.borrowable !== false;
      const supplyRewardValue = pct(p?.apyReward);
      const borrowRewardValue = b && borrowable ? pct(b.apyRewardBorrow) : null;
      const rates: PoolRates = {
        supplyBase,
        supplyReward:
          supplyRewardValue !== null && supplyRewardValue > 0 ? supplyRewardValue : null,
        supplyRewardState:
          supplyRewardValue !== null && supplyRewardValue > 0 ? 'numeric-known' : 'unknown',
        borrowBase: b && borrowable ? pct(b.apyBaseBorrow) : null,
        borrowReward:
          borrowRewardValue !== null && borrowRewardValue > 0 ? borrowRewardValue : null,
        borrowRewardState:
          borrowRewardValue !== null && borrowRewardValue > 0 ? 'numeric-known' : 'unknown',
        project: p.project,
        pool: typeof p?.pool === 'string' ? p.pool : '',
      };
      const key = `${p.project}|${chainId}|${(u[0] as string).toLowerCase()}`;
      map.set(key, map.has(key) ? null : rates);
    }
    loadSignal.throwIfAborted();
    cache = { at: Date.now(), map, nProj: trackedProjects.size };
    return map;
  }, signal);
}

export function __resetLlamaCacheForTests(): void {
  cache = null;
  rawByProject.clear();
  sharedLoad.reset();
}

export function makeLlamaAdapter(opts: {
  name: string;
  idPattern: RegExp;
  lendProjects: string[];
  savingsProjects: string[];
}): ProtocolAdapter {
  for (const p of [...opts.lendProjects, ...opts.savingsProjects]) trackedProjects.add(p);
  return {
    name: opts.name,
    matches: (id) => opts.idPattern.test(id),
    async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
      const map = await load(signal);
      return queries.map((q) => {
        let projects: string[];
        if (opts.lendProjects.length > 0 && opts.savingsProjects.length > 0) {
          const product = classifyLendingProduct(q);
          if (!product) return null;
          projects = product === 'lending' ? opts.lendProjects : opts.savingsProjects;
        } else {
          projects = opts.lendProjects.length > 0 ? opts.lendProjects : opts.savingsProjects;
        }
        const hits = projects
          .map((proj) => map.get(`${proj}|${q.chainId}|${q.address}`))
          .filter((r) => r !== undefined) as (PoolRates | null)[];
        if (hits.length !== 1 || hits[0] === null) return null;
        const first = hits[0] as PoolRates;
        if (q.leg === 'supply') {
          const rewardApr = first.supplyReward;
          return {
            baseApy: first.supplyBase,
            rewardApr,
            // Llama 是已知来源的补充视图；0/缺字段不能证明生态中没有奖励。
            rewardState: first.supplyRewardState,
            rewardComponents:
              rewardApr === null
                ? []
                : [
                    {
                      id: `defillama:${first.project}:${first.pool}:supply`,
                      value: rewardApr,
                      rateKind: 'apy',
                      source: `defillama:${opts.name}`,
                      basis: 'supply',
                      observedAt: Date.now(),
                    },
                  ],
            source: `defillama:${opts.name}`,
          };
        }
        const rewardApr = first.borrowReward;
        return {
          baseApy: first.borrowBase,
          rewardApr,
          rewardState: first.borrowRewardState,
          rewardComponents:
            rewardApr === null
              ? []
              : [
                  {
                    id: `defillama:${first.project}:${first.pool}:borrow`,
                    value: rewardApr,
                    rateKind: 'apy',
                    source: `defillama:${opts.name}`,
                    basis: 'borrow',
                    observedAt: Date.now(),
                  },
                ],
          source: `defillama:${opts.name}`,
        };
      });
    },
  };
}
