// Sky / MakerDAO 专用适配器。
//
// 同一个 USDS 底层对应多种产品，不能按 token 或 TVL 猜池：
// - sUSDS / stUSDS：对 exact share-token 合约读取 ssr()/str()，得到基础 APY。
// - Ecosystem Rewards farms：优先使用 DeBank pool.id；缺失时从 Sky Chainlog 发现 farm，
//   再以 stakingToken + rewardsToken + wallet balance/amount 唯一归属。
// - farm 数字：链上身份与活动期为真相，Sky 前端同源 BA exact-farm APR 为主；
//   链上 emission × price / totalSupply 次之。Llama UUID 无法证明 farm 合约身份，不用于农场数字。

import { chainIdFromName } from '../chains';
import { getTtlLru, setTtlLru } from '../cache';
import { fetchWithTimeout, withDeadline } from '../http';
import { DEBANK_INPUT_LIMITS } from '../input-limits';
import { fnSelector } from '../keccak';
import { SharedAbortableLoad } from '../shared-load';
import { rpcBatch } from '../uniswap';
import { llamaProjectPools } from './defillama';
import type { LegQuery, LegRates, ProtocolAdapter } from './types';

const CHAINLOG_URL: Record<number, string> = {
  1: 'https://chainlog.skyeco.com/api/mainnet/active.json',
};
const BA_FARM_URL = 'https://info-sky.blockanalitica.com/api/v1/farms';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const RAY = 10n ** 27n;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const SUCCESS_TTL_MS = 5 * 60 * 1_000;
const ERROR_TTL_MS = 30 * 1_000;
const OPTIONAL_FARM_API_TIMEOUT_MS = 1_500;
const MAX_FARMS = DEBANK_INPUT_LIMITS.skyInventoryFarmsPerChain;

const SELECTORS = {
  stakingToken: fnSelector('stakingToken()'),
  rewardsToken: fnSelector('rewardsToken()'),
  rewardRate: fnSelector('rewardRate()'),
  periodFinish: fnSelector('periodFinish()'),
  totalSupply: fnSelector('totalSupply()'),
  balanceOf: fnSelector('balanceOf(address)'),
  decimals: fnSelector('decimals()'),
  symbol: fnSelector('symbol()'),
  asset: fnSelector('asset()'),
  ssr: fnSelector('ssr()'),
  str: fnSelector('str()'),
};

const padAddress = (address: string): string => address.slice(2).toLowerCase().padStart(64, '0');
const poolAddress = (poolId: string | undefined): string | null => {
  return poolId && /^0x[0-9a-f]{40}$/i.test(poolId) ? poolId.toLowerCase() : null;
};
const decodeAddress = (value: string | null): string | null =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
    ? `0x${value.slice(-40).toLowerCase()}`
    : null;
const decodeUint = (value: string | null): bigint | null => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};
const decodeTokenSymbol = (value: string | null): string | null => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const hex = value.slice(2);
  let bytesHex = '';
  if (hex.length === 64) {
    bytesHex = hex;
  } else if (hex.length >= 128) {
    const offset = Number.parseInt(hex.slice(0, 64), 16);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > hex.length / 2) return null;
    const lengthOffset = offset * 2;
    const length = Number.parseInt(hex.slice(lengthOffset, lengthOffset + 64), 16);
    if (!Number.isSafeInteger(length) || length < 1 || length > 32) return null;
    const start = lengthOffset + 64;
    if (start + length * 2 > hex.length) return null;
    bytesHex = hex.slice(start, start + length * 2);
  } else {
    return null;
  }
  const bytes = Uint8Array.from(bytesHex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const symbol = new TextDecoder().decode(bytes).replace(/\0+$/g, '').trim();
  return /^[\x20-\x7e]{1,32}$/.test(symbol) ? symbol : null;
};
const llamaPct = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1_000
    ? value / 100
    : null;

export interface SkyFarmState {
  farm: string;
  stakingToken: string;
  rewardsToken: string;
  rewardRate: bigint;
  periodFinish: number;
  totalSupply: bigint;
  stakingDecimals: number;
  rewardDecimals: number;
  rewardSymbol: string | null;
}

interface SkySavingsState {
  asset: string;
  kind: 'ssr' | 'str';
  apy: number;
}

interface LlamaSkySnapshot {
  savings: Map<string, { base: number; pool: string } | null>;
}

const farmCache = new Map<string, { at: number; state: SkyFarmState | null }>();
const inventoryCache = new Map<number, { at: number; farms: string[] | null }>();
const baAprCache = new Map<string, { at: number; apr: number | null }>();
const savingsCache = new Map<string, { at: number; state: SkySavingsState | null }>();
const farmLoads = new Map<string, SharedAbortableLoad<SkyFarmState | null>>();
const inventoryLoads = new Map<string, SharedAbortableLoad<string[] | null>>();
const inventoryStateLoads = new Map<string, SharedAbortableLoad<SkyFarmState[]>>();
const balanceLoads = new Map<string, SharedAbortableLoad<Map<string, bigint>>>();
const baAprLoads = new Map<string, SharedAbortableLoad<number | null>>();
const savingsLoads = new Map<string, SharedAbortableLoad<SkySavingsState | null>>();

function runShared<T>(
  loads: Map<string, SharedAbortableLoad<T>>,
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let shared = loads.get(key);
  if (!shared) {
    shared = new SharedAbortableLoad<T>();
    loads.set(key, shared);
  }
  const active = shared;
  return active.run(loader, signal).finally(() => {
    // A cancelled generation may be immediately replaced on the same shared
    // object. Delete the key only when no newer generation is active.
    if (loads.get(key) === active && !active.isActive()) loads.delete(key);
  });
}

export function calculatePerSecondRayApy(rate: bigint): number | null {
  if (rate < RAY) return null;
  const perSecond = Number(rate - RAY) / 1e27;
  if (!Number.isFinite(perSecond) || perSecond < 0 || perSecond > 0.001) return null;
  const apy = Math.expm1(Math.log1p(perSecond) * YEAR_SECONDS);
  return Number.isFinite(apy) && apy >= 0 && apy < 10 ? apy : null;
}

export function calculateSkyFarmApr(
  state: SkyFarmState,
  stakingPriceUsd: number,
  rewardPriceUsd: number,
  nowSeconds = Date.now() / 1_000,
): number | null {
  if (state.periodFinish <= nowSeconds || state.rewardRate === 0n) return 0;
  if (
    !Number.isFinite(stakingPriceUsd) || stakingPriceUsd <= 0 ||
    !Number.isFinite(rewardPriceUsd) || rewardPriceUsd <= 0 ||
    state.totalSupply <= 0n
  ) return null;
  const staked = Number(state.totalSupply) / 10 ** state.stakingDecimals;
  const emittedPerSecond = Number(state.rewardRate) / 10 ** state.rewardDecimals;
  const apr = emittedPerSecond * YEAR_SECONDS * rewardPriceUsd / (staked * stakingPriceUsd);
  return Number.isFinite(apr) && apr >= 0 && apr < 10 ? apr : null;
}

async function loadFarmInventory(chainId: number, signal?: AbortSignal): Promise<string[] | null> {
  const cached = getTtlLru(
    inventoryCache,
    chainId,
    (entry) => entry.farms ? SUCCESS_TTL_MS : ERROR_TTL_MS,
  );
  if (cached) return cached.farms;
  return runShared(inventoryLoads, String(chainId), async (loadSignal) => {
    const secondHit = getTtlLru(
      inventoryCache,
      chainId,
      (entry) => entry.farms ? SUCCESS_TTL_MS : ERROR_TTL_MS,
    );
    if (secondHit) return secondHit.farms;
    const url = CHAINLOG_URL[chainId];
    let farms: string[] | null = null;
    if (url) {
      try {
        const response = await fetchWithTimeout(url, { signal: loadSignal });
        if (!response.ok) throw new Error(`sky chainlog http ${response.status}`);
        const body = await response.json() as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('sky chainlog malformed');
        }
        const entries = Object.entries(body as Record<string, unknown>);
        if (entries.length > 2_048) throw new Error('sky chainlog too large');
        const found = entries
          .filter(([key, value]) =>
            key.startsWith('REWARDS_') &&
            !key.startsWith('REWARDS_DIST_') &&
            typeof value === 'string' &&
            /^0x[0-9a-f]{40}$/i.test(value))
          .map(([, value]) => String(value).toLowerCase());
        farms = [...new Set(found)].slice(0, MAX_FARMS);
      } catch (error) {
        if (loadSignal.aborted) throw error;
      }
    }
    loadSignal.throwIfAborted();
    const current = inventoryCache.get(chainId);
    const preserve = Boolean(
      farms === null && current?.farms && Date.now() - current.at < SUCCESS_TTL_MS,
    );
    if (!preserve) {
      setTtlLru(
        inventoryCache,
        chainId,
        { at: Date.now(), farms },
        8,
        (entry) => entry.farms ? SUCCESS_TTL_MS : ERROR_TTL_MS,
      );
    }
    return farms ?? (preserve ? current?.farms ?? null : null);
  }, signal);
}

async function loadFarmState(
  chainId: number,
  farm: string,
  signal?: AbortSignal,
): Promise<SkyFarmState | null> {
  const cacheKey = `${chainId}:${farm}`;
  const cached = getTtlLru(
    farmCache,
    cacheKey,
    (entry) => entry.state ? SUCCESS_TTL_MS : ERROR_TTL_MS,
  );
  if (cached) return cached.state;
  return runShared(farmLoads, cacheKey, async (loadSignal) => {
    const secondHit = getTtlLru(
      farmCache,
      cacheKey,
      (entry) => entry.state ? SUCCESS_TTL_MS : ERROR_TTL_MS,
    );
    if (secondHit) return secondHit.state;
    let state: SkyFarmState | null = null;
    try {
      const core = await rpcBatch(chainId, [
        { to: farm, data: SELECTORS.stakingToken },
        { to: farm, data: SELECTORS.rewardsToken },
        { to: farm, data: SELECTORS.rewardRate },
        { to: farm, data: SELECTORS.periodFinish },
        { to: farm, data: SELECTORS.totalSupply },
      ], loadSignal);
      const stakingToken = decodeAddress(core[0]);
      const rewardsToken = decodeAddress(core[1]);
      const rewardRate = decodeUint(core[2]);
      const periodFinishRaw = decodeUint(core[3]);
      const totalSupply = decodeUint(core[4]);
      if (
        !stakingToken || !rewardsToken || rewardRate === null ||
        periodFinishRaw === null || totalSupply === null
      ) throw new Error('sky farm malformed');

      const metadataCalls = [{ to: stakingToken, data: SELECTORS.decimals }];
      if (rewardsToken !== ZERO_ADDRESS) {
        metadataCalls.push(
          { to: rewardsToken, data: SELECTORS.decimals },
          { to: rewardsToken, data: SELECTORS.symbol },
        );
      }
      const metadataResults = await rpcBatch(chainId, metadataCalls, loadSignal);
      const stakingDecimalsRaw = decodeUint(metadataResults[0]);
      const rewardDecimalsRaw = rewardsToken === ZERO_ADDRESS
        ? 18n
        : decodeUint(metadataResults[1]);
      const periodFinish = Number(periodFinishRaw);
      const stakingDecimals = Number(stakingDecimalsRaw);
      const rewardDecimals = Number(rewardDecimalsRaw);
      if (
        !Number.isSafeInteger(periodFinish) ||
        !Number.isSafeInteger(stakingDecimals) || stakingDecimals < 0 || stakingDecimals > 36 ||
        !Number.isSafeInteger(rewardDecimals) || rewardDecimals < 0 || rewardDecimals > 36
      ) throw new Error('sky farm numeric boundary');
      state = {
        farm,
        stakingToken,
        rewardsToken,
        rewardRate,
        periodFinish,
        totalSupply,
        stakingDecimals,
        rewardDecimals,
        rewardSymbol: rewardsToken === ZERO_ADDRESS ? null : decodeTokenSymbol(metadataResults[2]),
      };
    } catch (error) {
      if (loadSignal.aborted) throw error;
    }
    loadSignal.throwIfAborted();
    const current = farmCache.get(cacheKey);
    const preserve = Boolean(state === null && current?.state && Date.now() - current.at < SUCCESS_TTL_MS);
    if (!preserve) {
      setTtlLru(
        farmCache,
        cacheKey,
        { at: Date.now(), state },
        MAX_FARMS * 2,
        (entry) => entry.state ? SUCCESS_TTL_MS : ERROR_TTL_MS,
      );
    }
    return state ?? (preserve ? current?.state ?? null : null);
  }, signal);
}

async function farmBalances(
  chainId: number,
  states: SkyFarmState[],
  wallet: string,
  signal?: AbortSignal,
): Promise<Map<string, bigint>> {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || states.length === 0) return new Map();
  const results = await rpcBatch(
    chainId,
    states.map((state) => ({
      to: state.farm,
      data: SELECTORS.balanceOf + padAddress(wallet),
    })),
    signal,
  );
  return new Map(states.flatMap((state, index) => {
    const balance = decodeUint(results[index]);
    return balance === null ? [] : [[state.farm, balance] as const];
  }));
}

async function loadInventoryStates(
  chainId: number,
  signal?: AbortSignal,
): Promise<SkyFarmState[]> {
  return runShared(inventoryStateLoads, String(chainId), async (loadSignal) => {
    const inventory = await loadFarmInventory(chainId, loadSignal);
    if (!inventory) return [];
    const states: SkyFarmState[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, inventory.length) }, async () => {
      while (cursor < inventory.length) {
        loadSignal.throwIfAborted();
        const farm = inventory[cursor++];
        const state = await loadFarmState(chainId, farm, loadSignal);
        if (state) states.push(state);
      }
    });
    await Promise.all(workers);
    return states;
  }, signal);
}

async function inventoryBalances(
  chainId: number,
  wallet: string,
  states: SkyFarmState[],
  signal?: AbortSignal,
): Promise<Map<string, bigint>> {
  const stateKey = states.map((state) => state.farm).sort().join(',');
  const key = `${chainId}:${wallet.toLowerCase()}:${stateKey}`;
  return runShared(
    balanceLoads,
    key,
    (loadSignal) => farmBalances(chainId, states, wallet, loadSignal),
    signal,
  );
}

function stateMatchesQuery(state: SkyFarmState, query: LegQuery): boolean {
  if (state.stakingToken !== query.address.toLowerCase()) return false;
  const rewardTokens = new Set((query.itemRewardTokens ?? []).map((token) => token.toLowerCase()));
  if (rewardTokens.size === 0) return true;
  return state.rewardsToken !== ZERO_ADDRESS && rewardTokens.has(state.rewardsToken);
}

async function resolveFarmIdentity(
  query: LegQuery,
  allowedExactPools: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<SkyFarmState | null> {
  const exactPool = poolAddress(query.itemPoolId);
  if (exactPool) {
    if (!allowedExactPools.has(`${query.chainId}:${exactPool}`)) return null;
    const exact = await loadFarmState(query.chainId, exactPool, signal);
    return exact && stateMatchesQuery(exact, query) ? exact : null;
  }

  if (!query.userAddress) return null;
  const inventoryStates = await loadInventoryStates(query.chainId, signal);
  const states = inventoryStates.filter((state) => stateMatchesQuery(state, query));
  if (states.length === 0) return null;
  const balances = await inventoryBalances(
    query.chainId,
    query.userAddress,
    inventoryStates,
    signal,
  );
  const positive = states.filter((state) => (balances.get(state.farm) ?? 0n) > 0n);
  if (positive.length === 1) return positive[0];

  const itemAmount = query.itemSupplies?.find((item) => item.address === query.address)?.amount;
  if (!itemAmount || itemAmount <= 0) return null;
  const amountMatches = positive.filter((state) => {
    const balance = balances.get(state.farm);
    if (balance === undefined) return false;
    const amount = Number(balance) / 10 ** state.stakingDecimals;
    return Number.isFinite(amount) && Math.abs(amount - itemAmount) <= Math.max(1e-6, itemAmount * 1e-6);
  });
  return amountMatches.length === 1 ? amountMatches[0] : null;
}

async function loadOfficialFarmApr(
  chainId: number,
  farm: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (chainId !== 1) return null;
  const cacheKey = `${chainId}:${farm}`;
  const cached = getTtlLru(
    baAprCache,
    cacheKey,
    (entry) => entry.apr !== null ? SUCCESS_TTL_MS : ERROR_TTL_MS,
  );
  if (cached) return cached.apr;
  return runShared(baAprLoads, cacheKey, async (loadSignal) => {
    const secondHit = getTtlLru(
      baAprCache,
      cacheKey,
      (entry) => entry.apr !== null ? SUCCESS_TTL_MS : ERROR_TTL_MS,
    );
    if (secondHit) return secondHit.apr;
    let apr: number | null = null;
    try {
      const response = await fetchWithTimeout(
        `${BA_FARM_URL}/${farm}/historic/?p_size=1`,
        { signal: loadSignal },
      );
      if (!response.ok) throw new Error(`sky farm api http ${response.status}`);
      const body = await response.json() as { results?: unknown[] };
      const first = Array.isArray(body?.results) ? body.results[0] as Record<string, unknown> | undefined : undefined;
      const value = first?.apr;
      const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && value.length <= 32
          ? Number(value)
          : Number.NaN;
      if (Number.isFinite(numeric) && numeric >= 0 && numeric < 10) apr = numeric;
    } catch (error) {
      if (loadSignal.aborted) throw error;
    }
    loadSignal.throwIfAborted();
    const current = baAprCache.get(cacheKey);
    const preserve = apr === null && current?.apr !== null &&
      current?.apr !== undefined && Date.now() - current.at < SUCCESS_TTL_MS;
    if (!preserve) {
      setTtlLru(
        baAprCache,
        cacheKey,
        { at: Date.now(), apr },
        MAX_FARMS * 2,
        (entry) => entry.apr !== null ? SUCCESS_TTL_MS : ERROR_TTL_MS,
      );
    }
    return apr ?? (preserve ? current?.apr ?? null : null);
  }, signal);
}

async function loadSavingsState(
  chainId: number,
  token: string,
  signal?: AbortSignal,
): Promise<SkySavingsState | null> {
  const cacheKey = `${chainId}:${token}`;
  const cached = getTtlLru(
    savingsCache,
    cacheKey,
    (entry) => entry.state ? SUCCESS_TTL_MS : ERROR_TTL_MS,
  );
  if (cached) return cached.state;
  return runShared(savingsLoads, cacheKey, async (loadSignal) => {
    const secondHit = getTtlLru(
      savingsCache,
      cacheKey,
      (entry) => entry.state ? SUCCESS_TTL_MS : ERROR_TTL_MS,
    );
    if (secondHit) return secondHit.state;
    let state: SkySavingsState | null = null;
    try {
      const result = await rpcBatch(chainId, [
        { to: token, data: SELECTORS.asset },
        { to: token, data: SELECTORS.ssr },
        { to: token, data: SELECTORS.str },
      ], loadSignal);
      const asset = decodeAddress(result[0]);
      const ssr = decodeUint(result[1]);
      const str = decodeUint(result[2]);
      const candidates = [
        ssr === null ? null : { kind: 'ssr' as const, apy: calculatePerSecondRayApy(ssr) },
        str === null ? null : { kind: 'str' as const, apy: calculatePerSecondRayApy(str) },
      ].filter((candidate): candidate is { kind: 'ssr' | 'str'; apy: number } =>
        candidate !== null && candidate.apy !== null);
      if (asset && candidates.length === 1) state = { asset, ...candidates[0] };
    } catch (error) {
      if (loadSignal.aborted) throw error;
    }
    loadSignal.throwIfAborted();
    const current = savingsCache.get(cacheKey);
    const preserve = Boolean(state === null && current?.state && Date.now() - current.at < SUCCESS_TTL_MS);
    if (!preserve) {
      setTtlLru(
        savingsCache,
        cacheKey,
        { at: Date.now(), state },
        64,
        (entry) => entry.state ? SUCCESS_TTL_MS : ERROR_TTL_MS,
      );
    }
    return state ?? (preserve ? current?.state ?? null : null);
  }, signal);
}

async function loadLlamaSky(signal?: AbortSignal): Promise<LlamaSkySnapshot | null> {
  const pools = await llamaProjectPools('sky-lending', signal).catch((error) => {
    if (signal?.aborted) throw error;
    return null;
  });
  if (pools === null) return null;
  const savings = new Map<string, { base: number; pool: string } | null>();
  for (const pool of pools) {
    const chainId = chainIdFromName(pool?.chain);
    const underlying: unknown[] = Array.isArray(pool?.underlyingTokens) ? pool.underlyingTokens : [];
    if (!chainId || underlying.length !== 1 || typeof underlying[0] !== 'string') continue;
    const key = `${chainId}:${underlying[0].toLowerCase()}`;
    const base = llamaPct(pool?.apyBase);
    if (base !== null && pool?.poolMeta == null) {
      const row = { base, pool: typeof pool?.pool === 'string' ? pool.pool : '' };
      savings.set(key, savings.has(key) ? null : row);
    }
  }
  return { savings };
}

async function resolveFarm(
  query: LegQuery,
  allowedExactPools: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<LegRates> {
  const state = await resolveFarmIdentity(query, allowedExactPools, signal);
  if (!state) {
    return {
      baseApy: 0,
      rewardApr: null,
      rewardState: 'unknown',
      rewardComponents: [],
      source: 'sky农场(身份未知)',
    };
  }
  if (state.rewardsToken === ZERO_ADDRESS) {
    return {
      baseApy: 0,
      rewardApr: null,
      rewardState: 'non-annualizable',
      rewardComponents: [],
      source: `sky农场积分:${state.farm}`,
    };
  }
  const reward = query.itemRewards?.find((item) => item.address === state.rewardsToken);
  if (state.periodFinish <= Date.now() / 1_000 || state.rewardRate === 0n) {
    return {
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero',
      rewardComponents: [],
      source: `sky农场链上:${state.farm}`,
    };
  }

  const officialApr = await withDeadline(
    (apiSignal) => loadOfficialFarmApr(query.chainId, state.farm, apiSignal),
    OPTIONAL_FARM_API_TIMEOUT_MS,
    `sky farm api:${state.farm}`,
    signal,
  ).catch((error) => {
    if (signal?.aborted) throw error;
    return null;
  });
  const staking = query.itemSupplies?.find((item) => item.address === state.stakingToken);
  const stakingPrice = staking && staking.priceUsd > 0
    ? staking.priceUsd
    : staking && staking.amount > 0 ? staking.usd / staking.amount : 0;
  const rewardPrice = reward && reward.priceUsd > 0
    ? reward.priceUsd
    : reward && reward.amount > 0 ? reward.usd / reward.amount : 0;
  let apr = officialApr !== null && officialApr > 0
    ? officialApr
    : calculateSkyFarmApr(state, stakingPrice, rewardPrice);
  let source = officialApr !== null && officialApr > 0
    ? 'sky:official-farm-api + onchain-identity'
    : 'sky:onchain-farm';

  if (apr === null || apr <= 0) {
    return {
      baseApy: 0,
      rewardApr: null,
      rewardState: 'unknown',
      rewardComponents: [],
      source: `sky农场利率未知:${state.farm}`,
    };
  }
  return {
    baseApy: 0,
    rewardApr: apr,
    rewardState: 'numeric-known',
    rewardComponents: [{
      id: `sky:${state.farm}:${state.rewardsToken}`,
      value: apr,
      rateKind: 'apr',
      source,
      basis: 'supply',
      label: reward?.symbol || state.rewardSymbol || `${state.rewardsToken.slice(0, 6)}…`,
      observedAt: Date.now(),
    }],
    source,
  };
}

async function resolveSavings(
  query: LegQuery,
  llama: () => Promise<LlamaSkySnapshot | null>,
  signal?: AbortSignal,
): Promise<LegRates | null> {
  const exact = await loadSavingsState(query.chainId, query.address, signal);
  if (exact) {
    return {
      baseApy: exact.apy,
      rewardApr: null,
      rewardState: 'not-applicable',
      rewardComponents: [],
      includesIntrinsicYield: true,
      source: `sky:${exact.kind}:onchain:${query.address}`,
    };
  }
  const fallback = await llama();
  const row = fallback?.savings.get(`${query.chainId}:${query.address}`);
  if (!row) return null;
  return {
    baseApy: row.base,
    rewardApr: null,
    rewardState: 'not-applicable',
    rewardComponents: [],
    source: `defillama:sky-lending:${row.pool}`,
  };
}

export const skyAdapter: ProtocolAdapter = {
  name: 'sky',
  matches: (id) => /^([a-z0-9]+_)?(sky|makerdao)$/.test(id),
  async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
    let llamaPromise: Promise<LlamaSkySnapshot | null> | undefined;
    const llama = () => llamaPromise ??= loadLlamaSky(signal);
    const allowedExactPools = new Set<string>();
    for (const query of queries) {
      if (!/staked|farm|reward/i.test(query.itemAdapterId ?? '')) continue;
      const exact = poolAddress(query.itemPoolId);
      if (!exact) continue;
      const key = `${query.chainId}:${exact}`;
      if (
        allowedExactPools.has(key) ||
        allowedExactPools.size < DEBANK_INPUT_LIMITS.skyExactFarmsPerEnrichment
      ) allowedExactPools.add(key);
    }
    return Promise.all(queries.map(async (query) => {
      if (query.leg !== 'supply') return null;
      const isFarm = /staked|farm|reward/i.test(query.itemAdapterId ?? '');
      try {
        return isFarm
          ? await resolveFarm(query, allowedExactPools, signal)
          : await resolveSavings(query, llama, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          baseApy: isFarm ? 0 : null,
          rewardApr: null,
          rewardState: 'unknown',
          rewardComponents: [],
          source: isFarm ? 'sky农场查询失败' : 'sky储蓄查询失败',
        };
      }
    }));
  },
};

export function __resetSkyFarmCacheForTests(): void {
  farmCache.clear();
  inventoryCache.clear();
  baAprCache.clear();
  savingsCache.clear();
  for (const loads of [
    farmLoads,
    inventoryLoads,
    inventoryStateLoads,
    balanceLoads,
    baAprLoads,
    savingsLoads,
  ]) {
    for (const shared of loads.values()) shared.reset();
    loads.clear();
  }
}
