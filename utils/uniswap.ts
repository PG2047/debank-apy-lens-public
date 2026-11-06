// Uniswap V3 / V4 LP 区间信息 —— 直接读链上（publicnode 公共 RPC，批量 eth_call，无需 key）。
//
// V3 路径：DeBank position_index = NFT tokenId
//   → NonfungiblePositionManager.positions(tokenId) 拿 token0/token1/fee/tick 区间
//   → 池子地址（DeBank pool.id 是地址就直接用，否则 factory.getPool）→ slot0() 拿当前 tick
// V4 路径（单例架构，池子不是独立合约）：
//   → PositionManager.positionInfo(tokenId) 解包（200bit 截断 poolId | 24bit tickUpper | 24bit tickLower | 8bit flag）
//   → poolKeys(bytes25) 拿 PoolKey{currency0,currency1,fee,tickSpacing,hooks}
//   → poolId32 = keccak256(abi.encode(PoolKey))，并用截断 poolId25 交叉校验（不符=布局假设破坏→放弃）
//   → StateView.getSlot0(poolId32) 拿当前 tick 与实际 lpFee（动态费率池也正确）
//
// 价格换算：price(token1/token0) = 1.0001^tick × 10^(dec0−dec1)；
// 报价方向按 QUOTE_PRIORITY（稳定币/主流币优先作计价单位）。
// 每链 ≤3 个批量 HTTP 请求；结果缓存 120s（现价会动，不宜久缓）。

import { keccak256, hexToBytes } from './keccak';
import { getTtlLru, setTtlLru } from './cache';
import { fetchWithTimeout } from './http';
import { DEBANK_INPUT_LIMITS, InputLimitError } from './input-limits';
import { pickRpc } from './settings';
import type { PositionItem } from './debank';
import type { RewardState } from './adapters/types';

export interface LpRange {
  positionIndex: string;
  inRange: boolean;
  /** tick 接近 ±MAX_TICK 的全区间仓位（上下界价格无意义，显示「全区间」） */
  fullRange: boolean;
  /** 池合约费率档，不是用户实际手续费 APY。0.003 = 0.30%。 */
  feePct: number;
  /** 需要个人成交量、区间流动性和时间窗口才能证明；当前链上快照无法计算。 */
  feeApy: number | null;
  /** 可证明的个人 LP 激励；机会元数据不足以证明个人年化时保持 null。 */
  incentiveApr: number | null;
  incentiveState: RewardState;
  lowerPrice: number; // quote per base
  upperPrice: number;
  currentPrice: number;
  /** 当前 tick 在区间内的位置 0..1（tick 线性，同 Uniswap 官方 UI 口径） */
  pct: number;
  baseSymbol: string;
  quoteSymbol: string;
}

// Defaults, permissions and deployments share the same reviewed inventories.
import { DEFAULT_RPC } from './rpc';
import { CHAIN_BY_ID } from './chains';
import { UNISWAP_V3, UNISWAP_V4, PANCAKE_V3 } from './lp-deployments';
export type DexFamily = 'uniswap' | 'pancake';

const ZERO_ADDR = '0x' + '0'.repeat(40);

// 计价单位优先级：命中越靠前越优先作 quote（与人的读价直觉一致）
const QUOTE_PRIORITY = ['USDT', 'USDC', 'USDS', 'DAI', 'FDUSD', 'BUSD', 'WETH', 'ETH', 'WBNB', 'BNB', 'WBTC', 'BTCB'];

// 函数选择器（由 utils/keccak fnSelector 计算并经测试向量验证后固化）
const SEL = {
  positionsV3: '0x99fbab88', // positions(uint256)
  slot0V3: '0x3850c7bd', // slot0()
  getPoolV3: '0x1698ee82', // getPool(address,address,uint24)
  positionInfoV4: '0x89097a6a', // positionInfo(uint256)
  poolKeysV4: '0x86b6be7d', // poolKeys(bytes25)
  getSlot0V4: '0xc815641c', // getSlot0(bytes32)
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
};

// ─── 最小 ABI 编解码 ─────────────────────────────────────────
const pad64 = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (data: string, i: number): string => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const toAddr = (w: string): string => '0x' + w.slice(24);
const toUint = (w: string): bigint => BigInt('0x' + w);
function toInt(w: string): number {
  let v = BigInt('0x' + w);
  if (v >= 2n ** 255n) v -= 2n ** 256n;
  return Number(v);
}
const s24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

export interface Call {
  to: string;
  data: string;
}

export async function rpcBatch(
  chainId: number,
  calls: Call[],
  signal?: AbortSignal,
): Promise<(string | null)[]> {
  if (calls.length > DEBANK_INPUT_LIMITS.rpcCallsPerBatch) {
    throw new InputLimitError('rpc batch calls', DEBANK_INPUT_LIMITS.rpcCallsPerBatch);
  }
  const url = (await pickRpc(chainId)) ?? DEFAULT_RPC[chainId];
  if (!url || calls.length === 0) return calls.map(() => null);
  const body = calls.map((c, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: c.to, data: c.data }, 'latest'],
  }));
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const arr = (await res.json()) as unknown;
  const rows = Array.isArray(arr) ? arr : [arr];
  if (rows.length > calls.length) throw new Error('rpc response row limit exceeded');
  const out: (string | null)[] = calls.map(() => null);
  const seenIds = new Set<number>();
  for (const r of rows) {
    const rec = r as Record<string, unknown>;
    const id = rec?.id;
    if (
      !Number.isSafeInteger(id) || (id as number) < 0 || (id as number) >= calls.length ||
      seenIds.has(id as number)
    ) throw new Error('rpc response id invalid');
    seenIds.add(id as number);
    if (
      typeof rec?.result === 'string' &&
      /^0x(?:[0-9a-f]{2})+$/i.test(rec.result)
    ) out[id as number] = rec.result;
  }
  return out;
}

// ─── 主流程 ──────────────────────────────────────────────────
interface RawPos {
  item: PositionItem;
  tokenId: bigint;
  token0?: string;
  token1?: string;
  feePct?: number;
  tickLower?: number;
  tickUpper?: number;
  poolRef?: string; // v3=池子地址；v4=poolId32
  tick?: number;
}

interface TokenMeta {
  symbol: string;
  decimals: number;
}

const cache = new Map<string, { at: number; ranges: Map<string, LpRange> }>();
const TTL_MS = 120 * 1000;
const CACHE_MAX_ENTRIES = 128;
const cacheTtl = (): number => TTL_MS;

export function __resetUniswapCacheForTests(): void {
  cache.clear();
}

export function __uniswapCacheKeysForTests(): string[] {
  return [...cache.keys()];
}

export async function uniswapRanges(
  chainId: number,
  items: PositionItem[],
  version: 3 | 4 = 3,
  family: DexFamily = 'uniswap',
  signal?: AbortSignal,
): Promise<Map<string, LpRange>> {
  if (items.length > DEBANK_INPUT_LIMITS.lpPositionsPerCard) {
    throw new InputLimitError('LP positions per card', DEBANK_INPUT_LIMITS.lpPositionsPerCard);
  }
  const withId = items.filter((item) => {
    if (!item.positionIndex) return false;
    if (
      item.positionIndex.length > DEBANK_INPUT_LIMITS.uint256DecimalChars ||
      !/^\d+$/.test(item.positionIndex)
    ) {
      throw new InputLimitError('LP position identifier', DEBANK_INPUT_LIMITS.uint256DecimalChars);
    }
    if (BigInt(item.positionIndex) >= 2n ** 256n) {
      throw new InputLimitError('LP uint256 position identifier', DEBANK_INPUT_LIMITS.uint256DecimalChars);
    }
    return true;
  });
  if (withId.length === 0) return new Map();

  const cacheKey = `${family}v${version}:${chainId}:${withId.map((i) => i.positionIndex).join(',')}`;
  const hit = getTtlLru(cache, cacheKey, cacheTtl);
  if (hit) return hit.ranges;

  const positions: RawPos[] = withId.map((item) => ({ item, tokenId: BigInt(item.positionIndex!) }));

  // DeBank 已带的 token 元数据
  const meta = new Map<string, TokenMeta>();
  for (const it of items) {
    for (const t of [...it.supplies, ...it.rewards]) {
      if (typeof t.decimals === 'number') meta.set(t.address, { symbol: t.symbol, decimals: t.decimals });
    }
  }
  const native = CHAIN_BY_ID.get(chainId);
  if (native) meta.set(ZERO_ADDR, { symbol: native.nativeSymbol, decimals: native.nativeDecimals });

  if (version === 3) await resolveV3(chainId, positions, meta, family, signal);
  else await resolveV4(chainId, positions, meta, signal); // v4 目前仅 Uniswap

  // ── 组装 + 价格换算（v3/v4 共用） ──
  const ranges = new Map<string, LpRange>();
  for (const p of positions) {
    const t0 = p.token0 && meta.get(p.token0);
    const t1 = p.token1 && meta.get(p.token1);
    if (!t0 || !t1 || p.tick === undefined || p.tickLower === undefined || p.tickUpper === undefined || p.feePct === undefined) continue;

    const priceAt = (tk: number) => Math.pow(1.0001, tk) * Math.pow(10, t0.decimals - t1.decimals);
    let lower = priceAt(p.tickLower);
    let upper = priceAt(p.tickUpper);
    let current = priceAt(p.tick);
    let base = t0.symbol;
    let quote = t1.symbol;
    let pct = (p.tick - p.tickLower) / (p.tickUpper - p.tickLower);

    // 若 token0 才是计价单位（稳定币/主流币优先），整体取倒数并交换上下界
    const pri = (s: string) => {
      const i = QUOTE_PRIORITY.indexOf(s.toUpperCase());
      return i === -1 ? Infinity : i;
    };
    if (pri(t0.symbol) < pri(t1.symbol)) {
      [lower, upper] = [1 / upper, 1 / lower];
      current = 1 / current;
      base = t1.symbol;
      quote = t0.symbol;
      pct = 1 - pct;
    }

    ranges.set(p.item.positionIndex!, {
      positionIndex: p.item.positionIndex!,
      inRange: p.tick >= p.tickLower && p.tick < p.tickUpper,
      fullRange: p.tickLower <= -887000 && p.tickUpper >= 887000, // MIN/MAX_TICK = ±887272
      feePct: p.feePct,
      feeApy: null,
      incentiveApr: null,
      incentiveState: 'unknown',
      lowerPrice: lower,
      upperPrice: upper,
      currentPrice: current,
      pct: Math.min(1, Math.max(0, pct)),
      baseSymbol: base,
      quoteSymbol: quote,
    });
  }

  signal?.throwIfAborted();
  setTtlLru(cache, cacheKey, { at: Date.now(), ranges }, CACHE_MAX_ENTRIES, cacheTtl);
  return ranges;
}

// 未知 token 元数据的批量 calls（decimals + symbol 成对）
function metaCalls(positions: RawPos[], meta: Map<string, TokenMeta>): { tokens: string[]; calls: Call[] } {
  const tokens = [
    ...new Set(
      positions
        .flatMap((p) => [p.token0, p.token1])
        .filter((a): a is string => !!a && a !== ZERO_ADDR && !meta.has(a)),
    ),
  ];
  return {
    tokens,
    calls: tokens.flatMap((t) => [
      { to: t, data: SEL.decimals },
      { to: t, data: SEL.symbol },
    ]),
  };
}

function fillMeta(
  tokens: string[],
  results: (string | null)[],
  offset: number,
  meta: Map<string, TokenMeta>,
): void {
  tokens.forEach((t, i) => {
    const dRes = results[offset + i * 2];
    const sRes = results[offset + i * 2 + 1];
    if (!dRes) return;
    meta.set(t, { decimals: Number(toUint(word(dRes, 0))), symbol: decodeSymbol(sRes) ?? t.slice(0, 6) });
  });
}

// ─── V3 ──────────────────────────────────────────────────────
async function resolveV3(
  chainId: number,
  positions: RawPos[],
  meta: Map<string, TokenMeta>,
  family: DexFamily = 'uniswap',
  signal?: AbortSignal,
): Promise<void> {
  const deployment = (family === 'pancake' ? PANCAKE_V3 : UNISWAP_V3)[chainId];
  const npm = deployment?.positionManager;
  const factory = deployment?.factory;
  if (!npm) return;

  // ① positions(tokenId)
  const posResults = await rpcBatch(
    chainId,
    positions.map((p) => ({ to: npm, data: SEL.positionsV3 + pad64(p.tokenId.toString(16)) })),
    signal,
  );
  for (const [i, data] of posResults.entries()) {
    if (!data || data.length < 2 + 12 * 64) continue;
    const p = positions[i];
    p.token0 = toAddr(word(data, 2));
    p.token1 = toAddr(word(data, 3));
    p.feePct = Number(toUint(word(data, 4))) / 1_000_000;
    p.tickLower = toInt(word(data, 5));
    p.tickUpper = toInt(word(data, 6));
  }

  // ② 池子地址（DeBank pool.id 优先，否则 factory.getPool）+ 未知 token 元数据
  const needPool: RawPos[] = [];
  for (const p of positions) {
    if (!p.token0) continue;
    const m = (p.item.poolId?.toLowerCase() ?? '').match(/(0x[0-9a-f]{40})/);
    if (m) p.poolRef = m[1];
    else needPool.push(p);
  }
  const { tokens, calls } = metaCalls(positions, meta);
  const res2 = await rpcBatch(chainId, [
    ...needPool.map((p) => ({
      to: factory,
      data: SEL.getPoolV3 + pad64(p.token0!) + pad64(p.token1!) + pad64(Math.round(p.feePct! * 1_000_000).toString(16)),
    })),
    ...calls,
  ], signal);
  needPool.forEach((p, i) => {
    const d = res2[i];
    if (d && toUint(word(d, 0)) !== 0n) p.poolRef = toAddr(word(d, 0));
  });
  fillMeta(tokens, res2, needPool.length, meta);

  // ③ slot0()（同池去重）
  const pools = [...new Set(positions.map((p) => p.poolRef).filter((x): x is string => !!x))];
  const slotResults = await rpcBatch(chainId, pools.map((pl) => ({ to: pl, data: SEL.slot0V3 })), signal);
  const tickByPool = new Map<string, number>();
  pools.forEach((pl, i) => {
    const d = slotResults[i];
    if (d && d.length >= 2 + 2 * 64) tickByPool.set(pl, toInt(word(d, 1)));
  });
  for (const p of positions) {
    if (p.poolRef) p.tick = tickByPool.get(p.poolRef);
  }
}

// ─── V4 ──────────────────────────────────────────────────────
async function resolveV4(
  chainId: number,
  positions: RawPos[],
  meta: Map<string, TokenMeta>,
  signal?: AbortSignal,
): Promise<void> {
  const posm = UNISWAP_V4[chainId]?.positionManager;
  const stateView = UNISWAP_V4[chainId]?.stateView;
  if (!posm || !stateView) return;

  // ① positionInfo(tokenId) —— PositionInfoLibrary 打包布局：
  //    poolId截断(200bit) | tickUpper(24bit) | tickLower(24bit) | hasSubscriber(8bit)
  const infoRes = await rpcBatch(
    chainId,
    positions.map((p) => ({ to: posm, data: SEL.positionInfoV4 + pad64(p.tokenId.toString(16)) })),
    signal,
  );
  const byPool25 = new Map<string, RawPos[]>();
  infoRes.forEach((d, i) => {
    if (!d) return;
    const info = toUint(word(d, 0));
    if (info === 0n) return; // 空/已销毁仓位
    const p = positions[i];
    p.tickLower = s24(Number((info >> 8n) & 0xffffffn));
    p.tickUpper = s24(Number((info >> 32n) & 0xffffffn));
    const pool25 = (info >> 56n).toString(16).padStart(50, '0');
    byPool25.set(pool25, [...(byPool25.get(pool25) ?? []), p]);
  });
  if (byPool25.size === 0) return;

  // ② poolKeys(bytes25) → PoolKey；poolId32 = keccak256(abi.encode(PoolKey))，用截断 id 交叉校验
  const pool25s = [...byPool25.keys()];
  const keyRes = await rpcBatch(
    chainId,
    // bytes25 在 ABI 中左对齐：50 个 hex 后右侧补零
    pool25s.map((id25) => ({ to: posm, data: SEL.poolKeysV4 + id25 + '0'.repeat(14) })),
    signal,
  );
  const dynamicFeePools = new Set<string>();
  keyRes.forEach((d, i) => {
    if (!d || d.length < 2 + 5 * 64) return;
    const fee = Number(toUint(word(d, 2)));
    const encodedKey = word(d, 0) + word(d, 1) + word(d, 2) + word(d, 3) + word(d, 4);
    const id32 = keccak256(hexToBytes(encodedKey));
    if (!id32.startsWith(pool25s[i])) return; // 解码假设被破坏 → 宁缺毋滥
    for (const p of byPool25.get(pool25s[i]) ?? []) {
      p.token0 = toAddr(word(d, 0));
      p.token1 = toAddr(word(d, 1));
      p.poolRef = id32;
      if (fee === 0x800000) dynamicFeePools.add(id32); // 动态费率池 → 用 slot0 的 lpFee
      else p.feePct = fee / 1_000_000;
    }
  });

  // ③ StateView.getSlot0(poolId32) + 未知 token 元数据
  const pool32s = [...new Set(positions.map((p) => p.poolRef).filter((x): x is string => !!x))];
  const { tokens, calls } = metaCalls(positions, meta);
  const res3 = await rpcBatch(chainId, [
    ...pool32s.map((id32) => ({ to: stateView, data: SEL.getSlot0V4 + id32 })),
    ...calls,
  ], signal);
  const tickByPool = new Map<string, number>();
  const lpFeeByPool = new Map<string, number>();
  pool32s.forEach((id32, i) => {
    const d = res3[i];
    if (d && d.length >= 2 + 4 * 64 && toUint(word(d, 0)) !== 0n) {
      tickByPool.set(id32, toInt(word(d, 1)));
      lpFeeByPool.set(id32, Number(toUint(word(d, 3))));
    }
  });
  fillMeta(tokens, res3, pool32s.length, meta);

  for (const p of positions) {
    if (!p.poolRef) continue;
    p.tick = tickByPool.get(p.poolRef);
    if (p.feePct === undefined && dynamicFeePools.has(p.poolRef)) {
      const lf = lpFeeByPool.get(p.poolRef);
      if (lf !== undefined) p.feePct = lf / 1_000_000;
    }
  }
}

// symbol() 返回 string ABI 或古董合约的 bytes32
function decodeSymbol(data: string | null): string | null {
  if (!data || data.length < 2 + 64) return null;
  try {
    if (data.length >= 2 + 2 * 64 && toUint(word(data, 0)) === 32n) {
      const len = Number(toUint(word(data, 1)));
      const hex = data.slice(2 + 2 * 64, 2 + 2 * 64 + len * 2);
      return decodeAscii(hex);
    }
    return decodeAscii(word(data, 0).replace(/(00)+$/, ''));
  } catch {
    return null;
  }
}

function decodeAscii(hex: string): string | null {
  let s = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c === 0) break;
    if (c < 32 || c > 126) return null;
    s += String.fromCharCode(c);
  }
  return s || null;
}

export const fmtPrice = (v: number): string =>
  !Number.isFinite(v) ? '--' : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toPrecision(4);
