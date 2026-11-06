// 链上直读利率引擎（v0.2 核心）——两个通用引擎：
//
// ① ERC-4626 金库：convertToAssets(1e18) 在 [当前块, ~24h前块] 差分 → 过去24h实现 APY。
//    这是「真·余额差」口径（比任何利率快照都诚实），通吃 Lista Lorenzo / sUSDf / 各类计息金库。
// ② Morpho Blue fork（Lista Moolah 等）：idToMarketParams + market + IRM.borrowRateView
//    标准三件套算借款/存款利率。市场候选来自 Lista API allMarkets 的精确资产对，
//    再用链上 market params 与钱包 position 验证；禁止把全市场目录直接塞进 RPC batch。
//
// 需要历史状态的调用依赖归档节点：publicnode 一般保留近期状态；用户可在设置里换 Alchemy。

import { fnSelector } from '../keccak';
import { fetchWithTimeout } from '../http';
import { getTtlLru, setTtlLru } from '../cache';
import { pickRpc } from '../settings';
import { SharedAbortableLoad } from '../shared-load';
import { rpcBatch } from '../uniswap';
import { DEFAULT_RPC } from '../rpc';
import { chainIdFromName } from '../chains';
import type { RewardState } from './types';

const SEL = {
  convertToAssets: fnSelector('convertToAssets(uint256)'),
  idToMarketParams: fnSelector('idToMarketParams(bytes32)'),
  market: fnSelector('market(bytes32)'),
  position: fnSelector('position(bytes32,address)'),
  borrowRateView: fnSelector(
    'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
  ),
};

const pad64 = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (d: string, i: number): string => d.slice(2 + i * 64, 2 + (i + 1) * 64);
const toAddr = (w: string): string => '0x' + w.slice(24);
const toUint = (w: string): bigint => BigInt('0x' + w);

export async function rpcJson(
  chainId: number,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  const url = (await pickRpc(chainId)) ?? DEFAULT_RPC[chainId];
  if (!url) throw new Error(`no rpc for chain ${chainId}`);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120));
  return j.result;
}

export const blockTs = async (chainId: number, n: number, signal?: AbortSignal): Promise<number> => {
  const b = (await rpcJson(chainId, 'eth_getBlockByNumber', ['0x' + n.toString(16), false], signal)) as {
    timestamp?: string;
  } | null;
  if (!b?.timestamp) throw new Error('no block');
  return parseInt(b.timestamp, 16);
};

// ─── ① 汇率差分引擎：任意"份额→资产汇率"调用在 24h 两端差分 → 实现 APY ──
// 覆盖 ERC-4626(convertToAssets) 与 wstETH(stEthPerToken) 等变体。需要归档 RPC。
const diffCache = new Map<string, { at: number; apy: number | null }>();
const DIFF_TTL = 30 * 60 * 1000;

/** Compound an observed one-day growth rate into an effective annual APY. */
export const annualizeDailyGrowth = (daily: number): number | null => {
  if (!Number.isFinite(daily) || daily <= -1) return null;
  const apy = Math.expm1(Math.log1p(daily) * 365);
  return apy > -0.5 && apy < 10 ? apy : null;
};

export async function rateDiffApy(
  chainId: number,
  contract: string,
  callData: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const ck = `${chainId}:${contract.toLowerCase()}:${callData.slice(0, 10)}`;
  const hit = getTtlLru(diffCache, ck, () => DIFF_TTL);
  if (hit) return hit.apy;

  let apy: number | null = null;
  try {
    const latest = parseInt((await rpcJson(chainId, 'eth_blockNumber', [], signal)) as string, 16);
    // 用近 20000 块的平均块时估算 24h 前块高（各链块时不同且会升级，实测比查表稳）
    const [tsNow, tsOld] = [await blockTs(chainId, latest, signal), await blockTs(chainId, latest - 20000, signal)];
    const avg = (tsNow - tsOld) / 20000;
    const prevBlock = latest - Math.round(86400 / avg);
    const call = async (tag: string) =>
      (await rpcJson(chainId, 'eth_call', [{ to: contract, data: callData }, tag], signal)) as string;
    const [nowHex, prevHex] = [await call('latest'), await call('0x' + prevBlock.toString(16))];
    const now = Number(toUint(word(nowHex, 0)));
    const prev = Number(toUint(word(prevHex, 0)));
    if (now > 0 && prev > 0) {
      const daily = now / prev - 1;
      apy = annualizeDailyGrowth(daily); // 24h 实现增长率复利年化
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[APY Lens] rateDiffApy failed:', contract, e);
  }
  setTtlLru(diffCache, ck, { at: Date.now(), apy }, 256, () => DIFF_TTL);
  return apy;
}

export const erc4626Apy = (chainId: number, vault: string, signal?: AbortSignal): Promise<number | null> =>
  rateDiffApy(chainId, vault, SEL.convertToAssets + pad64((10n ** 18n).toString(16)), signal);

// ─── ①b 生息资产内生收益（抵押/借出的是生息资产时计入其底层收益）──
// 只收录地址 100% 确定的；kind 决定汇率调用方式。借出生息资产=债务随汇率涨=成本加成。
const SEL_WSTETH = fnSelector('stEthPerToken()');
const YIELD_BEARING: Record<number, Record<string, { kind: 'erc4626' | 'wsteth'; label: string }>> = {
  1: {
    '0x9d39a5de30e57443bff2a8307a4256c8797a3497': { kind: 'erc4626', label: 'sUSDe' },
    '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd': { kind: 'erc4626', label: 'sUSDS' },
    '0x83f20f44975d03b1b09e64809b757c47f942beea': { kind: 'erc4626', label: 'sDAI' },
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { kind: 'wsteth', label: 'wstETH' },
    '0xc8cf6d7991f15525488b2a83df53468d682ba4b0': { kind: 'erc4626', label: 'sUSDf' },
  },
};

export async function intrinsicApy(
  chainId: number,
  tokenAddress: string,
  signal?: AbortSignal,
): Promise<{ apy: number; label: string } | null> {
  const spec = YIELD_BEARING[chainId]?.[tokenAddress.toLowerCase()];
  if (!spec) return null;
  const data =
    spec.kind === 'wsteth' ? SEL_WSTETH : SEL.convertToAssets + pad64((10n ** 18n).toString(16));
  const apy = await rateDiffApy(chainId, tokenAddress, data, signal);
  return apy !== null && apy > 0 ? { apy, label: spec.label } : null;
}

// ─── ② Lista Moolah（Morpho Blue fork）─────────────────────────
// vault/list 给 vault 的官方 apy/emissionApy（erc4626 引擎的降级数据源）并提供市场 id 清单；
// 精确 market detail 另给借款 APY、数字 emission 零证明与 points/multiplier。
export interface ListaVaultInfo {
  apy: number | null;
  emissionApy: number | null;
  emissionState: 'numeric-known' | 'confirmed-zero' | 'unknown';
}
interface ListaSnapshot {
  at: number;
  vaults: Map<string, ListaVaultInfo>;
}
interface ListaMarketIdentity {
  id: string;
  loanToken: string;
  collateralToken: string;
  chain: string;
}
interface ListaMarketSnapshot {
  at: number;
  markets: ListaMarketIdentity[];
}
let listaCache: ListaSnapshot | null = null;
let listaMarketCache: ListaMarketSnapshot | null = null;
const LISTA_TTL = 30 * 60 * 1000;
const LISTA_ERROR_TTL = 30 * 1000;
let listaErrorAt = 0;
let listaMarketErrorAt = 0;
const listaLoad = new SharedAbortableLoad<ListaSnapshot>();
const listaMarketLoad = new SharedAbortableLoad<ListaMarketSnapshot>();
const LISTA_MARKET_LIMIT = 1_024;

async function listaData(signal?: AbortSignal): Promise<ListaSnapshot> {
  if (listaCache && Date.now() - listaCache.at < LISTA_TTL) return listaCache;
  if (listaErrorAt > 0 && Date.now() - listaErrorAt < LISTA_ERROR_TTL) {
    return listaCache ?? { at: listaErrorAt, vaults: new Map() };
  }
  return listaLoad.run(async (loadSignal) => {
    try {
      const res = await fetchWithTimeout('https://api.lista.org/api/moolah/vault/list?pageSize=50', {
        signal: loadSignal,
      });
      if (!res.ok) throw new Error(`lista vault/list http ${res.status}`);
      const j = (await res.json()) as {
        data?: { list?: { address?: string; apy?: string; emissionApy?: string }[] };
      };
      if (!Array.isArray(j?.data?.list)) throw new Error('lista vault/list malformed');
      const vaults = new Map<string, ListaVaultInfo>();
      for (const vault of j.data.list) {
        if (typeof vault.address === 'string') {
          const apy = vault.apy === undefined ? null : Number(vault.apy);
          const emissionApy = vault.emissionApy === undefined ? null : Number(vault.emissionApy);
          const normalizedEmission =
            emissionApy !== null && Number.isFinite(emissionApy) && emissionApy >= 0
              ? emissionApy
              : null;
          vaults.set(vault.address.toLowerCase(), {
            apy: apy !== null && Number.isFinite(apy) ? apy : null,
            emissionApy: normalizedEmission,
            emissionState:
              normalizedEmission === null
                ? 'unknown'
                : normalizedEmission > 0
                  ? 'numeric-known'
                  : 'confirmed-zero',
          });
        }
      }
      listaCache = { at: Date.now(), vaults };
      listaErrorAt = 0;
      return listaCache;
    } catch (error) {
      if (loadSignal.aborted) throw error;
      listaErrorAt = Date.now();
      console.warn('[APY Lens] lista vault/list failed:', error);
      // A transient refresh failure never destroys the last complete snapshot.
      return listaCache ?? { at: listaErrorAt, vaults: new Map() };
    }
  }, signal);
}

export const listaVaultInfo = async (vault: string, signal?: AbortSignal): Promise<ListaVaultInfo | undefined> =>
  (await listaData(signal)).vaults.get(vault.toLowerCase());

async function listaMarketData(signal?: AbortSignal): Promise<ListaMarketSnapshot> {
  if (listaMarketCache && Date.now() - listaMarketCache.at < LISTA_TTL) return listaMarketCache;
  if (listaMarketErrorAt > 0 && Date.now() - listaMarketErrorAt < LISTA_ERROR_TTL) {
    return listaMarketCache ?? { at: listaMarketErrorAt, markets: [] };
  }
  return listaMarketLoad.run(async (loadSignal) => {
    try {
      const res = await fetchWithTimeout('https://api.lista.org/api/moolah/allMarkets', {
        signal: loadSignal,
      });
      if (!res.ok) throw new Error(`lista allMarkets http ${res.status}`);
      const payload = (await res.json()) as { data?: unknown };
      if (!Array.isArray(payload?.data) || payload.data.length > LISTA_MARKET_LIMIT) {
        throw new Error('lista allMarkets malformed');
      }
      const markets: ListaMarketIdentity[] = [];
      const seen = new Map<string, ListaMarketIdentity>();
      for (const entry of payload.data) {
        const row = entry as Record<string, unknown> | null;
        const id = typeof row?.id === 'string' ? row.id.toLowerCase() : '';
        const loanToken = typeof row?.loanToken === 'string' ? row.loanToken.toLowerCase() : '';
        const collateralToken = typeof row?.collateralToken === 'string' ? row.collateralToken.toLowerCase() : '';
        const chain = typeof row?.chain === 'string' ? row.chain.toLowerCase() : '';
        if (
          !/^0x[0-9a-f]{64}$/.test(id) ||
          !/^0x[0-9a-f]{40}$/.test(loanToken) ||
          !/^0x[0-9a-f]{40}$/.test(collateralToken) ||
          !/^[a-z0-9_-]{1,32}$/.test(chain)
        ) {
          throw new Error('lista allMarkets row malformed');
        }
        const normalized = { id, loanToken, collateralToken, chain };
        const key = `${chain}:${id}`;
        const previous = seen.get(key);
        if (previous) {
          if (
            previous.loanToken !== loanToken ||
            previous.collateralToken !== collateralToken
          ) {
            throw new Error('lista allMarkets duplicate conflict');
          }
          continue;
        }
        seen.set(key, normalized);
        markets.push(normalized);
      }
      listaMarketCache = { at: Date.now(), markets };
      listaMarketErrorAt = 0;
      return listaMarketCache;
    } catch (error) {
      if (loadSignal.aborted) throw error;
      listaMarketErrorAt = Date.now();
      console.warn('[APY Lens] lista allMarkets failed:', error);
      return listaMarketCache ?? { at: listaMarketErrorAt, markets: [] };
    }
  }, signal);
}

async function listaMarketIdsForPair(
  chainId: number,
  loanToken: string,
  collateralToken: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const snapshot = await listaMarketData(signal);
  return snapshot.markets
    .filter((market) =>
      chainIdFromName(market.chain) === chainId &&
      market.loanToken === loanToken.toLowerCase() &&
      (!collateralToken || market.collateralToken === collateralToken.toLowerCase()))
    .map((market) => market.id);
}

export function __resetListaCacheForTests(): void {
  listaCache = null;
  listaMarketCache = null;
  listaErrorAt = 0;
  listaMarketErrorAt = 0;
  listaLoad.reset();
  listaMarketLoad.reset();
  moolahCache.clear();
  moolahMarketCache.clear();
}

export interface MoolahRates {
  supplyApy: number;
  borrowApy: number;
  marketId: string;
  borrowRewardApy: number | null;
  borrowRewardState: RewardState;
  collateralRewardState: RewardState;
  points: { name: string; multiplier: string }[];
}

const moolahCache = new Map<string, { at: number; rates: MoolahRates | null }>();
const MOOLAH_TTL = 5 * 60 * 1000;

interface MoolahMarketInfo {
  borrowApy: number | null;
  borrowRewardApy: number | null;
  borrowRewardState: RewardState;
  collateralRewardState: RewardState;
  points: { name: string; multiplier: string }[];
}

const moolahMarketCache = new Map<string, { at: number; info: MoolahMarketInfo | null }>();

const nonNegativeFinite = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

async function moolahMarketInfo(marketId: string, signal?: AbortSignal): Promise<MoolahMarketInfo | null> {
  const hit = getTtlLru(moolahMarketCache, marketId, () => MOOLAH_TTL);
  if (hit) return hit.info;
  let info: MoolahMarketInfo | null = null;
  try {
    const res = await fetchWithTimeout(`https://api.lista.org/api/moolah/market/${marketId}`, { signal });
    if (!res.ok) throw new Error(`lista market http ${res.status}`);
    const payload = (await res.json()) as { data?: Record<string, unknown> };
    const data = payload?.data;
    if (!data || typeof data !== 'object') throw new Error('lista market malformed');
    const borrowApy = nonNegativeFinite(data.borrowRate);
    const borrowEmissionApy = nonNegativeFinite(data.borrowEmissionApy);
    const holderBorrowEmissionApy = nonNegativeFinite(data.holderBorrowEmissionApy);
    if (
      borrowApy === null ||
      borrowEmissionApy === null ||
      holderBorrowEmissionApy === null ||
      !Array.isArray(data.borrowEmissionDetail) ||
      !Array.isArray(data.emissionDetail) ||
      !Array.isArray(data.rewards)
    ) {
      throw new Error('lista market coverage malformed');
    }
    const points = data.rewards.flatMap((entry) => {
      const row = entry as Record<string, unknown> | null;
      return typeof row?.name === 'string' && typeof row?.points === 'string'
        ? [{ name: row.name, multiplier: row.points }]
        : [];
    });
    if (points.length !== data.rewards.length) throw new Error('lista market points malformed');
    const borrowRewardApy = borrowEmissionApy + holderBorrowEmissionApy;
    const borrowRewardState: RewardState = borrowRewardApy > 0
      ? 'numeric-known'
      : data.borrowEmissionDetail.length === 0
        ? 'confirmed-zero'
        : 'unknown';
    info = {
      borrowApy,
      borrowRewardApy: borrowRewardState === 'unknown' ? null : borrowRewardApy,
      borrowRewardState,
      // Moolah collateral does not earn the loan-market supply APY. Current
      // official market rewards are disclosed separately as points/multipliers.
      collateralRewardState: data.emissionDetail.length === 0 ? 'confirmed-zero' : 'unknown',
      points,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn('[APY Lens] lista market detail failed:', marketId, error);
  }
  setTtlLru(moolahMarketCache, marketId, { at: Date.now(), info }, 256, () => MOOLAH_TTL);
  return info;
}

/** A token pair can map to several markets; only a unique non-zero wallet position is exact. */
export function selectMoolahMarketIdByPosition(
  ids: readonly string[],
  positionResults: readonly (string | null)[],
): string | null {
  const active = ids.filter((_, index) => {
    const result = positionResults[index];
    if (!result || result.length < 2 + 3 * 64) return false;
    try {
      return [0, 1, 2].some((wordIndex) => toUint(word(result, wordIndex)) > 0n);
    } catch {
      return false;
    }
  });
  return active.length === 1 ? active[0] : null;
}

/** 按资产对定位市场；多市场时以 wallet position 唯一非零 market id 消歧并计算利率。 */
export async function moolahRates(
  chainId: number,
  moolah: string,
  loanToken: string,
  collateralToken: string | undefined,
  userAddress?: string,
  signal?: AbortSignal,
): Promise<MoolahRates | null> {
  const ck = `${chainId}:${moolah}:${loanToken}:${collateralToken ?? ''}:${userAddress ?? ''}`;
  const hit = getTtlLru(moolahCache, ck, () => MOOLAH_TTL);
  if (hit) return hit.rates;

  let rates: MoolahRates | null = null;
  try {
    const ids = await listaMarketIdsForPair(chainId, loanToken, collateralToken, signal);
    if (ids.length === 0) throw new Error('no market ids');

    // allMarkets 先按 chain + 精确资产对缩小候选，再以链上 params 复核。
    // 这既保留 exact-market 身份，也避免市场目录增长后击穿 RPC batch 上限。
    const paramsRes = await rpcBatch(chainId, ids.map((id) => ({ to: moolah, data: SEL.idToMarketParams + id.slice(2) })), signal);
    const candidates: { id: string; params: string[]; irm: string }[] = [];
    paramsRes.forEach((d, i) => {
      if (!d || d.length < 2 + 5 * 64) return;
      const loan = toAddr(word(d, 0));
      const coll = toAddr(word(d, 1));
      if (loan !== loanToken.toLowerCase()) return;
      if (collateralToken && coll !== collateralToken.toLowerCase()) return;
      candidates.push({ id: ids[i], params: [0, 1, 2, 3, 4].map((k) => word(d, k)), irm: toAddr(word(d, 3)) });
    });
    if (candidates.length === 0) throw new Error('no matching market');
    if (candidates.length > 1) {
      if (!userAddress || !/^0x[0-9a-f]{40}$/i.test(userAddress)) {
        throw new Error('ambiguous matching markets without wallet identity');
      }
      const userWord = pad64(userAddress.slice(2));
      const positionResults = await rpcBatch(
        chainId,
        candidates.map((candidate) => ({
          to: moolah,
          data: SEL.position + candidate.id.slice(2) + userWord,
        })),
        signal,
      );
      const selectedId = selectMoolahMarketIdByPosition(
        candidates.map((candidate) => candidate.id),
        positionResults,
      );
      if (!selectedId) throw new Error('wallet market identity is not unique');
      const selected = candidates.find((candidate) => candidate.id === selectedId);
      if (!selected) throw new Error('selected wallet market disappeared');
      candidates.splice(0, candidates.length, selected);
    }

    // 只有精确 market id 才允许继续；禁止按全市场借款规模猜用户仓位。
    const mktRes = await rpcBatch(chainId, candidates.map((c) => ({ to: moolah, data: SEL.market + c.id.slice(2) })), signal);
    let best: { c: (typeof candidates)[0]; mkt: string; borrow: bigint } | null = null;
    mktRes.forEach((d, i) => {
      if (!d || d.length < 2 + 6 * 64) return;
      const borrow = toUint(word(d, 2));
      if (!best || borrow > best.borrow) best = { c: candidates[i], mkt: d, borrow };
    });
    if (!best) throw new Error('no market state');
    const b = best as { c: (typeof candidates)[0]; mkt: string; borrow: bigint };

    // IRM.borrowRateView(marketParams, market) → 每秒利率(1e18)
    const mktWords = [0, 1, 2, 3, 4, 5].map((k) => word(b.mkt, k));
    const rateData = SEL.borrowRateView + b.c.params.join('') + mktWords.join('');
    const rateRes = await rpcBatch(chainId, [{ to: b.c.irm, data: rateData }], signal);
    if (!rateRes[0]) throw new Error('borrowRateView failed');
    const perSec = Number(toUint(word(rateRes[0], 0))) / 1e18;
    const borrowApy = Math.expm1(perSec * 31536000); // 连续复利
    const totalSupply = Number(toUint(word(b.mkt, 0)));
    const totalBorrow = Number(toUint(word(b.mkt, 2)));
    const fee = Number(toUint(word(b.mkt, 5))) / 1e18;
    const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const marketInfo = await moolahMarketInfo(b.c.id, signal);
    rates = {
      marketId: b.c.id,
      borrowApy: marketInfo?.borrowApy ?? borrowApy,
      supplyApy: borrowApy * util * (1 - fee),
      borrowRewardApy: marketInfo?.borrowRewardApy ?? null,
      borrowRewardState: marketInfo?.borrowRewardState ?? 'unknown',
      collateralRewardState: marketInfo?.collateralRewardState ?? 'unknown',
      points: marketInfo?.points ?? [],
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[APY Lens] moolahRates failed:', e);
  }
  setTtlLru(moolahCache, ck, { at: Date.now(), rates }, 256, () => MOOLAH_TTL);
  return rates;
}
