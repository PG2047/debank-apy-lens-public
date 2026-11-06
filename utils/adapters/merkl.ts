// Merkl v4 reward discovery.
//
// The generic API below deliberately requires an exact protocol + chain + opportunity
// type + action + container match. Asset addresses are only an additional guard; they
// are never accepted as a position identity. A complete no-match is still `unknown`
// unless the caller explicitly owns an exhaustive zero-proof policy for that role.

import { fetchWithTimeout } from '../http';
import { getTtlLru, setTtlLru } from '../cache';
import { SharedAbortableLoad } from '../shared-load';
import type { RewardBasis, RewardComponent, RewardState } from './types';

const ENDPOINT = 'https://api.merkl.xyz/v4/opportunities';
const SUCCESS_TTL_MS = 5 * 60 * 1_000;
const ERROR_TTL_MS = 30 * 1_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_ITEMS = PAGE_SIZE * MAX_PAGES;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_APR_PERCENT = 10_000;
const MAX_DISCOVERY_CACHE_ENTRIES = 128;
const MAX_WALLET_CACHE_ENTRIES = 128;

const TYPE_BASIS: Readonly<Record<string, RewardBasis | 'action'>> = {
  AAVE_NET_BORROWING: 'borrow',
  AAVE_NET_LENDING: 'net-supply',
  AAVE_SUPPLY: 'supply',
  AAVE_V4_HUB_SUPPLY: 'supply',
  AAVE_V4_SPOKE_SUPPLY: 'supply',
  DOLOMITE_NET_LENDING: 'net-supply',
  MORPHOBORROW: 'borrow',
  MORPHOCOLLATERAL: 'collateral',
  MORPHOSUPPLY: 'supply',
  MORPHOVAULT: 'vault',
  MULTILOG_DUTCH: 'action',
  PROJECT_X: 'liquidity',
  UNISWAP_V3: 'liquidity',
  UNISWAP_V4: 'liquidity',
};

const ACTIONS = new Set(['LEND', 'BORROW', 'POOL', 'HOLD']);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MARKET_ID = /^0x[0-9a-f]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

function uint256(value: unknown): bigint | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= UINT256_MAX ? parsed : null;
  } catch {
    return null;
  }
}

export interface NormalizedMerklOpportunity {
  id: string;
  chainId: number;
  protocolId: string;
  opportunityType: string;
  action: string;
  containerId: string;
  assetAddresses: string[];
  basis: RewardBasis;
  apr: number; // decimal APR
  components: RewardComponent[];
  observedAt: number;
}

export type MerklDiscovery =
  | {
      state: 'complete';
      opportunities: NormalizedMerklOpportunity[];
      observedAt: number;
    }
  | {
      state: 'unknown';
      opportunities: [];
      observedAt: number;
      reason: string;
    };

export interface MerklRewardQuery {
  chainId: number;
  protocolId: string;
  opportunityType: string | readonly string[];
  action: string | readonly string[];
  /** Canonical exact container, e.g. `market:0x…64` or `vault:0x…40`. */
  containerId: string;
  assetAddress?: string;
  basis: RewardBasis;
  /** Set only when this endpoint is documented as exhaustive for this exact role. */
  zeroProof?: boolean;
}

export interface MerklRewardResult {
  rewardApr: number | null;
  rewardState: RewardState;
  rewardComponents: RewardComponent[];
  source: string;
}

const discoveryCache = new Map<string, { at: number; value: MerklDiscovery }>();
const discoveryLoads = new Map<string, SharedAbortableLoad<MerklDiscovery>>();

function runDiscoveryShared(
  key: string,
  loader: (signal: AbortSignal) => Promise<MerklDiscovery>,
  signal?: AbortSignal,
): Promise<MerklDiscovery> {
  let shared = discoveryLoads.get(key);
  if (!shared) {
    shared = new SharedAbortableLoad<MerklDiscovery>();
    discoveryLoads.set(key, shared);
  }
  const active = shared;
  return active.run(loader, signal).finally(() => {
    if (discoveryLoads.get(key) === active && !active.isActive()) discoveryLoads.delete(key);
  });
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function lowerAddress(value: unknown): string | null {
  const valueString = boundedString(value, 42)?.toLowerCase();
  return valueString && ADDRESS.test(valueString) ? valueString : null;
}

function unixSeconds(value: unknown): number | null {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeHttpsUrl(value: unknown): URL | null {
  const raw = boundedString(value, 2_048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function extractUnderlying(url: URL): string | null {
  return lowerAddress(url.searchParams.get('underlyingAsset'));
}

function firstAddress(value: unknown): string | null {
  const raw = boundedString(value, 256);
  if (!raw) return null;
  const match = raw.match(/0x[0-9a-fA-F]{40}/);
  return lowerAddress(match?.[0]);
}

function exactMarketId(url: URL): string | null {
  const match = decodeURIComponent(url.pathname).match(/\/market\/(0x[0-9a-fA-F]{64})(?:\/|$)/);
  const id = match?.[1]?.toLowerCase();
  return id && MARKET_ID.test(id) ? id : null;
}

function exactVaultAddress(raw: Record<string, any>, url: URL): string | null {
  const pathMatch = decodeURIComponent(url.pathname).match(/\/vault\/(0x[0-9a-fA-F]{40})(?:\/|$)/);
  return (
    lowerAddress(pathMatch?.[1]) ??
    lowerAddress(url.searchParams.get('vaultId')) ??
    lowerAddress(raw.explorerAddress) ??
    firstAddress(raw.identifier)
  );
}

function containerFor(raw: Record<string, any>, opportunityType: string, url: URL): string | null {
  if (opportunityType === 'MORPHOCOLLATERAL' || opportunityType === 'MORPHOSUPPLY' || opportunityType === 'MORPHOBORROW') {
    const id = exactMarketId(url);
    return id ? `market:${id}` : null;
  }
  if (opportunityType === 'MORPHOVAULT') {
    const address = exactVaultAddress(raw, url);
    return address ? `vault:${address}` : null;
  }
  const address = lowerAddress(raw.explorerAddress) ?? firstAddress(raw.identifier);
  return address ? `contract:${address}` : null;
}

function basisFor(type: string, action: string): RewardBasis | null {
  const mapped = TYPE_BASIS[type];
  if (!mapped) return null;
  if (mapped !== 'action') return mapped;
  if (action === 'BORROW') return 'borrow';
  if (action === 'LEND') return 'supply';
  if (action === 'POOL') return 'liquidity';
  return 'position';
}

function isGated(raw: Record<string, any>): boolean {
  const identifier = String(raw.identifier ?? '').toUpperCase();
  if (identifier.includes('WHITELIST') || identifier.includes('PRIVATE')) return true;
  const tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 32).map((tag: unknown) => String(tag).toUpperCase()) : [];
  if (tags.some((tag: string) => tag.includes('WHITELIST') || tag.includes('PRIVATE') || tag.includes('POINT'))) return true;
  const description = String(raw.description ?? '').slice(0, 1_000);
  return /whitelist|allowlist|only .* eligible|private campaign|points? only/i.test(description);
}

function rewardTokenLabels(raw: Record<string, any>): {
  addresses: Set<string>;
  labels: string[];
  labelsByCampaign: Map<string, string[]>;
} {
  const addresses = new Set<string>();
  const labels: string[] = [];
  const labelsByCampaign = new Map<string, string[]>();
  const breakdowns = Array.isArray(raw?.rewardsRecord?.breakdowns)
    ? raw.rewardsRecord.breakdowns.slice(0, 64)
    : [];
  for (const breakdown of breakdowns) {
    const reward = breakdown as Record<string, any>;
    const token = reward?.token ?? {};
    const address = lowerAddress(token.address);
    if (!address) continue;
    addresses.add(address);
    const symbol = boundedString(token.symbol, 32);
    if (symbol && !labels.includes(symbol)) labels.push(symbol);
    for (const campaignValue of [reward.onChainCampaignId, reward.campaignId]) {
      const campaign = boundedString(campaignValue, 256)?.toLowerCase();
      if (!campaign) continue;
      const campaignLabels = labelsByCampaign.get(campaign) ?? [];
      if (symbol && !campaignLabels.includes(symbol)) campaignLabels.push(symbol);
      labelsByCampaign.set(campaign, campaignLabels);
    }
  }
  return { addresses, labels, labelsByCampaign };
}

/** Strictly normalizes one untrusted Merkl row. Invalid or ambiguous rows are rejected. */
export function normalizeMerklOpportunity(
  value: unknown,
  expectedChainId: number,
  expectedProtocolId: string,
  nowMs = Date.now(),
): NormalizedMerklOpportunity | null {
  const raw = value as Record<string, any> | null;
  if (!raw || typeof raw !== 'object') return null;
  const id = boundedString(raw.id, 256);
  const protocolId = boundedString(raw?.protocol?.id, 64)?.toLowerCase();
  const opportunityType = boundedString(raw.type, 64)?.toUpperCase();
  const action = boundedString(raw.action, 16)?.toUpperCase();
  if (
    !id ||
    raw.chainId !== expectedChainId ||
    protocolId !== expectedProtocolId.toLowerCase() ||
    !opportunityType ||
    !action ||
    !ACTIONS.has(action) ||
    raw.status !== 'LIVE' ||
    isGated(raw)
  ) return null;

  const basis = basisFor(opportunityType, action);
  if (!basis || !finite(raw.apr) || raw.apr < 0 || raw.apr > MAX_APR_PERCENT) return null;

  const now = Math.floor(nowMs / 1_000);
  const startsAt = unixSeconds(raw.earliestCampaignStart);
  const endsAt = unixSeconds(raw.latestCampaignEnd);
  if ((startsAt !== null && startsAt > now) || (endsAt !== null && endsAt <= now)) return null;

  const url = safeHttpsUrl(raw.depositUrl);
  if (!url) return null;
  const containerId = containerFor(raw, opportunityType, url);
  if (!containerId) return null;

  const tokenRows = Array.isArray(raw.tokens) ? raw.tokens.slice(0, 16) : [];
  if (Array.isArray(raw.tokens) && raw.tokens.length > 16) return null;
  const assets = new Set<string>();
  for (const token of tokenRows) {
    const address = lowerAddress((token as Record<string, unknown>)?.address);
    if (address) assets.add(address);
  }
  const underlying = extractUnderlying(url);
  if (underlying) assets.add(underlying);
  if (assets.size === 0) return null;

  // Numeric APR must be backed by at least one real reward token; points-only rows
  // therefore never become annualized numeric rewards.
  const rewards = rewardTokenLabels(raw);
  if (rewards.addresses.size === 0) return null;

  const observedSeconds = unixSeconds(raw?.aprRecord?.timestamp);
  const observedAt = observedSeconds === null ? nowMs : observedSeconds * 1_000;
  const breakdowns = Array.isArray(raw?.aprRecord?.breakdowns)
    ? raw.aprRecord.breakdowns.slice(0, 64)
    : [];
  if (Array.isArray(raw?.aprRecord?.breakdowns) && raw.aprRecord.breakdowns.length > 64) return null;

  const components: RewardComponent[] = [];
  if (breakdowns.length > 0) {
    for (const breakdownValue of breakdowns) {
      const breakdown = breakdownValue as Record<string, unknown>;
      const campaignId = boundedString(breakdown.identifier, 256)?.toLowerCase();
      const valuePercent = breakdown.value;
      if (
        !campaignId ||
        breakdown.type !== 'CAMPAIGN' ||
        !finite(valuePercent) ||
        valuePercent < 0 ||
        valuePercent > MAX_APR_PERCENT
      ) return null;
      const campaignLabels = rewards.labelsByCampaign.get(campaignId);
      // With multiple APR components, every component must trace to a real-token
      // reward campaign. This prevents a mixed points+token row from annualizing
      // the points component merely because another component has a payout token.
      if (!campaignLabels && breakdowns.length > 1) return null;
      components.push({
        id: `merkl:${expectedChainId}:${campaignId}`,
        value: valuePercent / 100,
        rateKind: 'apr',
        source: 'merkl',
        sourceUrl: `https://app.merkl.xyz/opportunities/${encodeURIComponent(id)}`,
        basis,
        label: (campaignLabels ?? rewards.labels).slice(0, 3).join('+') || undefined,
        observedAt,
      });
    }
  } else {
    components.push({
      id: `merkl:${expectedChainId}:opportunity:${id.toLowerCase()}`,
      value: raw.apr / 100,
      rateKind: 'apr',
      source: 'merkl',
      sourceUrl: `https://app.merkl.xyz/opportunities/${encodeURIComponent(id)}`,
      basis,
      label: rewards.labels.slice(0, 3).join('+') || undefined,
      observedAt,
    });
  }

  const componentApr = components.reduce((sum, component) => sum + component.value, 0);
  if (!Number.isFinite(componentApr) || componentApr > MAX_APR_PERCENT / 100) return null;

  return {
    id,
    chainId: expectedChainId,
    protocolId,
    opportunityType,
    action,
    containerId,
    assetAddresses: [...assets],
    basis,
    apr: componentApr,
    components,
    observedAt,
  };
}

function unknown(reason: string): MerklDiscovery {
  return { state: 'unknown', opportunities: [], observedAt: Date.now(), reason: reason.slice(0, 160) };
}

async function fetchPage(
  url: string,
  timeoutMs: number,
  remainingBytes: number,
  signal?: AbortSignal,
): Promise<{ rows: unknown[]; bytes: number }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { signal }, timeoutMs, remainingBytes);
  } catch (error) {
    if (error instanceof RangeError) throw new Error('discovery byte budget exceeded', { cause: error });
    throw error;
  }
  if (!response.ok) throw new Error(`http ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(length) && length > remainingBytes) throw new Error('discovery byte budget exceeded');
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > remainingBytes) throw new Error('discovery byte budget exceeded');
  const body = JSON.parse(text) as unknown;
  if (!Array.isArray(body) || body.length > PAGE_SIZE) throw new Error('unexpected page shape');
  return { rows: body, bytes };
}

/** Loads a complete, bounded opportunity snapshot. Any partial/error result is unknown. */
export async function discoverMerklOpportunities(
  chainId: number,
  protocolId: string,
  signal?: AbortSignal,
): Promise<MerklDiscovery> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^[a-z0-9_-]{1,64}$/i.test(protocolId)) {
    return unknown('invalid query');
  }
  const normalizedProtocol = protocolId.toLowerCase();
  const cacheKey = `${chainId}:${normalizedProtocol}`;
  const discoveryTtl = (entry: { value: MerklDiscovery }) =>
    entry.value.state === 'complete' ? SUCCESS_TTL_MS : ERROR_TTL_MS;
  const hit = getTtlLru(discoveryCache, cacheKey, discoveryTtl);
  if (hit) return hit.value;

  return runDiscoveryShared(cacheKey, async (sharedSignal) => {
  const secondHit = getTtlLru(discoveryCache, cacheKey, discoveryTtl);
  if (secondHit) return secondHit.value;

  const startedAt = Date.now();
  const opportunities: NormalizedMerklOpportunity[] = [];
  let remainingBytes = MAX_DISCOVERY_BYTES;
  let complete = false;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      sharedSignal.throwIfAborted();
      const remaining = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) throw new Error('overall timeout');
      const params = new URLSearchParams({
        mainProtocolId: normalizedProtocol,
        status: 'LIVE',
        chainId: String(chainId),
        items: String(PAGE_SIZE),
        page: String(page),
      });
      const pageResult = await fetchPage(
        `${ENDPOINT}?${params}`,
        Math.min(PAGE_TIMEOUT_MS, remaining),
        remainingBytes,
        sharedSignal,
      );
      const { rows } = pageResult;
      remainingBytes -= pageResult.bytes;
      for (const row of rows) {
        const normalized = normalizeMerklOpportunity(row, chainId, normalizedProtocol);
        if (normalized) opportunities.push(normalized);
      }
      if (opportunities.length > MAX_ITEMS) throw new Error('item budget exceeded');
      if (rows.length < PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error('page budget exhausted');
    const value: MerklDiscovery = { state: 'complete', opportunities, observedAt: Date.now() };
    setTtlLru(
      discoveryCache,
      cacheKey,
      { at: Date.now(), value },
      MAX_DISCOVERY_CACHE_ENTRIES,
      discoveryTtl,
    );
    return value;
  } catch (error) {
    if (sharedSignal.aborted) throw signalReason(sharedSignal);
    const value = unknown(error instanceof Error ? error.message : 'unknown error');
    const current = discoveryCache.get(cacheKey);
    if (
      current?.value.state === 'complete' &&
      Date.now() - current.at < SUCCESS_TTL_MS
    ) return current.value;
    setTtlLru(
      discoveryCache,
      cacheKey,
      { at: Date.now(), value },
      MAX_DISCOVERY_CACHE_ENTRIES,
      discoveryTtl,
    );
    return value;
  }
  }, signal);
}

const asSet = (value: string | readonly string[]): Set<string> =>
  new Set((Array.isArray(value) ? value : [value]).map((entry) => entry.toUpperCase()));

/** Pure exact-scope matcher; duplicate campaign IDs count once. */
export function matchMerklRewards(discovery: MerklDiscovery, query: MerklRewardQuery): MerklRewardResult {
  if (discovery.state !== 'complete') {
    return { rewardApr: null, rewardState: 'unknown', rewardComponents: [], source: 'merkl:unknown' };
  }
  const types = asSet(query.opportunityType);
  const actions = asSet(query.action);
  const assetAddress = query.assetAddress?.toLowerCase();
  const matches = discovery.opportunities.filter((opportunity) =>
    opportunity.chainId === query.chainId &&
    opportunity.protocolId === query.protocolId.toLowerCase() &&
    types.has(opportunity.opportunityType) &&
    actions.has(opportunity.action) &&
    opportunity.containerId === query.containerId.toLowerCase() &&
    opportunity.basis === query.basis &&
    (!assetAddress || opportunity.assetAddresses.includes(assetAddress)),
  );

  const byId = new Map<string, RewardComponent>();
  for (const opportunity of matches) {
    for (const component of opportunity.components) {
      const previous = byId.get(component.id);
      if (previous && Math.abs(previous.value - component.value) > 1e-12) {
        return { rewardApr: null, rewardState: 'unknown', rewardComponents: [], source: 'merkl:conflict' };
      }
      if (!previous) byId.set(component.id, { ...component, basis: query.basis });
    }
  }

  const rewardComponents = [...byId.values()];
  if (rewardComponents.length === 0) {
    if (query.zeroProof) {
      return { rewardApr: 0, rewardState: 'confirmed-zero', rewardComponents: [], source: 'merkl:complete' };
    }
    return { rewardApr: null, rewardState: 'unknown', rewardComponents: [], source: 'merkl:no-exhaustive-match' };
  }
  const rewardApr = rewardComponents.reduce((sum, component) => sum + component.value, 0);
  if (!Number.isFinite(rewardApr)) {
    return { rewardApr: null, rewardState: 'unknown', rewardComponents: [], source: 'merkl:invalid-total' };
  }
  return {
    rewardApr,
    // A non-empty normalized component set is positive by construction.
    rewardState: 'numeric-known',
    rewardComponents,
    source: `merkl:${[...types].sort().join('+').toLowerCase()}`,
  };
}

/** Batch API for protocol adapters. Discovery is shared per chain/protocol and capped at four concurrent loads. */
export async function resolveMerklRewards(
  queries: readonly MerklRewardQuery[],
  signal?: AbortSignal,
): Promise<MerklRewardResult[]> {
  const keys = [...new Set(queries.map((query) => `${query.chainId}:${query.protocolId.toLowerCase()}`))];
  const discoveries = new Map<string, MerklDiscovery>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (cursor < keys.length) {
      signal?.throwIfAborted();
      const key = keys[cursor++];
      const split = key.indexOf(':');
      const chainId = Number(key.slice(0, split));
      const protocolId = key.slice(split + 1);
      discoveries.set(key, await discoverMerklOpportunities(chainId, protocolId, signal));
    }
  });
  await Promise.all(workers);
  return queries.map((query) =>
    matchMerklRewards(
      discoveries.get(`${query.chainId}:${query.protocolId.toLowerCase()}`) ?? unknown('missing discovery'),
      query,
    ),
  );
}

// ─── Claimable reward summary (wallet-scoped, separate from opportunity cache) ───
export interface ClaimableSummary {
  totalUsd: number;
  top: { symbol: string; usd: number }[];
  coverage: 'complete' | 'partial' | 'unknown';
  failedChains: number[];
  failures: ClaimableFailure[];
}

export type ClaimableFailureReason =
  | 'http'
  | 'timeout'
  | 'response-too-large'
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-reward'
  | 'network';

export interface ClaimableFailure {
  chainId: number;
  reason: ClaimableFailureReason;
  status?: number;
}

const claimCache = new Map<string, { at: number; v: ClaimableSummary }>();
const claimLoads = new Map<string, SharedAbortableLoad<ClaimableSummary>>();
const CLAIM_TTL = 10 * 60 * 1_000;
const CLAIM_TOTAL_TIMEOUT_MS = 9_000;
const CLAIM_CHAIN_TIMEOUT_MS = 4_000;
const CLAIM_MAX_CONCURRENCY = 2;
const MAX_TOKEN_PRICE_USD = 1e12;
const MAX_CLAIMABLE_ROW_USD = 1e15;
const MAX_CLAIMABLE_TOTAL_USD = 1e16;

let activeClaimFetches = 0;
const claimFetchWaiters: Array<() => boolean> = [];

function signalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function acquireClaimFetchSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signalReason(signal);
  if (activeClaimFetches < CLAIM_MAX_CONCURRENCY) {
    activeClaimFetches += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) {
        reject(signalReason(signal));
        return false;
      }
      activeClaimFetches += 1;
      resolve();
      return true;
    };
    const aborted = () => {
      const index = claimFetchWaiters.indexOf(ready);
      if (index >= 0) claimFetchWaiters.splice(index, 1);
      reject(signalReason(signal));
    };
    claimFetchWaiters.push(ready);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function releaseClaimFetchSlot(): void {
  activeClaimFetches -= 1;
  while (claimFetchWaiters.length > 0) {
    if (claimFetchWaiters.shift()?.()) break;
  }
}

async function withClaimFetchSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  await acquireClaimFetchSlot(signal);
  try {
    return await work();
  } finally {
    releaseClaimFetchSlot();
  }
}

function runClaimShared(
  key: string,
  loader: (signal: AbortSignal) => Promise<ClaimableSummary>,
  signal?: AbortSignal,
): Promise<ClaimableSummary> {
  let shared = claimLoads.get(key);
  if (!shared) {
    shared = new SharedAbortableLoad<ClaimableSummary>();
    claimLoads.set(key, shared);
  }
  const active = shared;
  return active.run(loader, signal).finally(() => {
    if (claimLoads.get(key) === active && !active.isActive()) claimLoads.delete(key);
  });
}

function claimableFailure(chainId: number, error: unknown): ClaimableFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  if (name === 'TimeoutError') return { chainId, reason: 'timeout' };
  if (error instanceof RangeError) return { chainId, reason: 'response-too-large' };
  return { chainId, reason: 'network' };
}

export async function merklClaimable(
  address: string,
  chainIds: number[],
  signal?: AbortSignal,
  totalTimeoutMs = CLAIM_TOTAL_TIMEOUT_MS,
): Promise<ClaimableSummary> {
  signal?.throwIfAborted();
  const wallet = lowerAddress(address);
  if (!wallet) throw new Error('invalid Merkl claimable address');
  const chains = [...new Set(chainIds)]
    .filter((chainId) => Number.isSafeInteger(chainId) && chainId > 0)
    .sort((a, b) => a - b);
  const ck = `${wallet}:${chains.join(',')}`;
  const claimTtl = (entry: { v: ClaimableSummary }) =>
    entry.v.coverage === 'complete' ? CLAIM_TTL : ERROR_TTL_MS;
  const hit = getTtlLru(claimCache, ck, claimTtl);
  if (hit) return hit.v;

  const boundedTotalTimeout = Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0
    ? totalTimeoutMs
    : CLAIM_TOTAL_TIMEOUT_MS;
  const loadKey = `${ck}:${boundedTotalTimeout}`;
  return runClaimShared(loadKey, async (sharedSignal) => {
    const secondHit = getTtlLru(claimCache, ck, claimTtl);
    if (secondHit) return secondHit.v;

  const workController = new AbortController();
  const forwardAbort = () => workController.abort(
    signalReason(sharedSignal),
  );
  if (sharedSignal.aborted) forwardAbort();
  else sharedSignal.addEventListener('abort', forwardAbort, { once: true });
  let totalTimedOut = false;
  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    workController.abort(new DOMException('Merkl claimable total budget expired', 'TimeoutError'));
  }, boundedTotalTimeout);
  const workSignal = workController.signal;

  const items: { symbol: string; usd: number }[] = [];
  let totalUsd = 0;
  const succeeded = new Set<number>();
  const partiallyParsed = new Set<number>();
  const failures = new Map<number, ClaimableFailure>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CLAIM_MAX_CONCURRENCY, chains.length) }, async () => {
    while (cursor < chains.length) {
      sharedSignal.throwIfAborted();
      if (workSignal.aborted) break;
      const cid = chains[cursor++];
      try {
        const res = await withClaimFetchSlot(
          workSignal,
          () => fetchWithTimeout(
            `https://api.merkl.xyz/v4/users/${wallet}/rewards?chainId=${cid}`,
            { signal: workSignal },
            CLAIM_CHAIN_TIMEOUT_MS,
            MAX_DISCOVERY_BYTES,
          ),
        );
        if (!res.ok) {
          failures.set(cid, { chainId: cid, reason: 'http', status: res.status });
          continue;
        }
        const text = await res.text();
        if (new TextEncoder().encode(text).byteLength > MAX_DISCOVERY_BYTES) {
          failures.set(cid, { chainId: cid, reason: 'response-too-large' });
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          failures.set(cid, { chainId: cid, reason: 'invalid-json' });
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length > 1) {
          failures.set(cid, { chainId: cid, reason: 'invalid-shape' });
          continue;
        }
        const arr = parsed as { chain?: { id?: unknown }; rewards?: Record<string, any>[] }[];
        let chainComplete = true;
        let chainKnown = false;
        let chainFailureReason: ClaimableFailureReason = 'invalid-reward';
        const rewardIds = new Set<string>();
        for (const chain of arr) {
          if (
            !chain || typeof chain !== 'object' ||
            !Number.isSafeInteger(chain.chain?.id) || chain.chain?.id !== cid ||
            !Array.isArray(chain.rewards) || chain.rewards.length > 500
          ) {
            chainComplete = false;
            chainFailureReason = 'invalid-shape';
            continue;
          }
          const rewards = chain.rewards;
          for (const r of rewards) {
            const tok = r?.token ?? {};
            const recipient = lowerAddress(r?.recipient);
            const distributionChainId = r?.distributionChainId;
            const root = typeof r?.root === 'string' && MARKET_ID.test(r.root.toLowerCase())
              ? r.root.toLowerCase()
              : null;
            const tokenAddress = lowerAddress(tok.address);
            const rewardId = root && tokenAddress ? `${root}:${tokenAddress}` : null;
            const dec = finite(tok.decimals) && Number.isInteger(tok.decimals) ? tok.decimals : null;
            const price = finite(tok.price) && tok.price >= 0 && tok.price <= MAX_TOKEN_PRICE_USD
              ? tok.price
              : null;
            const amount = uint256(r?.amount);
            const claimed = uint256(r?.claimed);
            if (
              recipient !== wallet || !Number.isSafeInteger(distributionChainId) ||
              distributionChainId !== cid || rewardId === null || rewardIds.has(rewardId) ||
              dec === null || price === null || dec < 0 || dec > 255 ||
              amount === null || claimed === null || claimed > amount
            ) {
              chainComplete = false;
              continue;
            }
            rewardIds.add(rewardId);
            const usd = (Number(amount - claimed) / 10 ** dec) * price;
            const nextTotalUsd = totalUsd + usd;
            if (
              !Number.isFinite(usd) || usd < 0 || usd > MAX_CLAIMABLE_ROW_USD ||
              !Number.isFinite(nextTotalUsd) || nextTotalUsd > MAX_CLAIMABLE_TOTAL_USD
            ) {
              chainComplete = false;
              continue;
            }
            chainKnown = true;
            if (usd > 0) {
              totalUsd = nextTotalUsd;
              if (usd > 0.5) items.push({ symbol: String(tok.symbol ?? '?').slice(0, 32), usd });
            }
          }
        }
        if (chainComplete) {
          succeeded.add(cid);
          failures.delete(cid);
        } else {
          if (chainKnown) partiallyParsed.add(cid);
          failures.set(cid, { chainId: cid, reason: chainFailureReason });
        }
      } catch (error) {
        if (sharedSignal.aborted) throw signalReason(sharedSignal);
        if (totalTimedOut) {
          failures.set(cid, { chainId: cid, reason: 'timeout' });
          break;
        }
        failures.set(cid, claimableFailure(cid, error));
      }
    }
  });
  try {
    await Promise.all(workers);
    sharedSignal.throwIfAborted();
  } finally {
    clearTimeout(totalTimer);
    sharedSignal.removeEventListener('abort', forwardAbort);
  }
  if (totalTimedOut) {
    for (const chainId of chains) {
      if (!succeeded.has(chainId) && !failures.has(chainId)) {
        failures.set(chainId, { chainId, reason: 'timeout' });
      }
    }
  }
  const failedChains = chains.filter((chainId) => !succeeded.has(chainId));
  const coverage: ClaimableSummary['coverage'] =
    succeeded.size === chains.length && chains.length > 0
      ? 'complete'
      : succeeded.size > 0 || partiallyParsed.size > 0
        ? 'partial'
        : 'unknown';
  const v: ClaimableSummary = {
    totalUsd,
    top: items.sort((a, b) => b.usd - a.usd).slice(0, 3),
    coverage,
    failedChains,
    failures: failedChains.map((chainId) =>
      failures.get(chainId) ?? { chainId, reason: 'network' as const },
    ),
  };
  const current = claimCache.get(ck);
  if (
    v.coverage !== 'complete' && current?.v.coverage === 'complete' &&
    Date.now() - current.at < CLAIM_TTL
  ) return current.v;
  setTtlLru(claimCache, ck, { at: Date.now(), v }, MAX_WALLET_CACHE_ENTRIES, claimTtl);
  return v;
  }, signal);
}

export function __resetMerklCachesForTests(): void {
  discoveryCache.clear();
  for (const shared of discoveryLoads.values()) shared.reset();
  discoveryLoads.clear();
  claimCache.clear();
  for (const shared of claimLoads.values()) shared.reset();
  claimLoads.clear();
  activeClaimFetches = 0;
  claimFetchWaiters.splice(0);
}
