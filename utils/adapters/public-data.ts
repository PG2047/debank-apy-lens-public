import { fetchWithTimeout } from '../http';
import { getTtlLru, setTtlLru } from '../cache';
import { SharedAbortableLoad } from '../shared-load';
import type { LegQuery, LegRates } from './types';

const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
const pending = new Map<string, SharedAbortableLoad<unknown>>();

/** Shared public catalogs. Cancellation of one page must not cancel another page. */
export async function publicJson<T>(url: string, signal?: AbortSignal, maxBytes?: number): Promise<T> {
  signal?.throwIfAborted();
  const hit = getTtlLru(cache, url, () => TTL);
  if (hit) return hit.value as T;
  let load = pending.get(url);
  if (!load) { load = new SharedAbortableLoad(); pending.set(url, load); }
  try {
    return await load.run(async (sharedSignal) => {
      const res = await fetchWithTimeout(url, { signal: sharedSignal }, undefined, maxBytes);
      if (!res.ok) throw new Error(`protocol API http ${res.status}`);
      const value: unknown = await res.json();
      sharedSignal.throwIfAborted();
      setTtlLru(cache, url, { at: Date.now(), value }, 64, () => TTL);
      return value;
    }, signal) as T;
  } finally { if (!load.isActive() && pending.get(url) === load) pending.delete(url); }
}

export function __resetPublicDataForTests(): void {
  cache.clear();
  for (const load of pending.values()) load.reset();
  pending.clear();
}

export const address = (value: unknown): string | null =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;

export const poolAddress = (q: LegQuery): string | null => address(q.itemPoolId?.split(':')[0]);

export const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const rate = (value: unknown): number | null => {
  const number = numeric(value);
  return number !== null && number > -1 && number < 10 ? number : null;
};

export function baseRate(baseApy: number | null, source: string): LegRates {
  return { baseApy, includesIntrinsicYield: true, rewardApr: null, rewardState: 'unknown', source };
}

/** A failure on one chain leaves results on other chains available. */
export async function byChain<T>(
  queries: LegQuery[], load: (chainId: number) => Promise<T>, signal?: AbortSignal,
): Promise<Map<number, T>> {
  const chains = [...new Set(queries.map((q) => q.chainId))];
  const results = await Promise.allSettled(chains.map(load));
  signal?.throwIfAborted();
  return new Map(results.flatMap((result, i) => result.status === 'fulfilled' ? [[chains[i], result.value] as const] : []));
}
