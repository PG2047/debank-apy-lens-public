export interface TimedCacheEntry {
  at: number;
}

type TtlFor<Entry> = (entry: Entry) => number;

function pruneExpired<Key, Entry extends TimedCacheEntry>(
  cache: Map<Key, Entry>,
  ttlFor: TtlFor<Entry>,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttlFor(entry)) cache.delete(key);
  }
}

/** Read-through TTL check that also refreshes Map insertion order for LRU eviction. */
export function getTtlLru<Key, Entry extends TimedCacheEntry>(
  cache: Map<Key, Entry>,
  key: Key,
  ttlFor: TtlFor<Entry>,
  now = Date.now(),
): Entry | undefined {
  pruneExpired(cache, ttlFor, now);
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/** Insert one value, prune all expired entries, then evict least-recently-used keys. */
export function setTtlLru<Key, Entry extends TimedCacheEntry>(
  cache: Map<Key, Entry>,
  key: Key,
  entry: Entry,
  maxEntries: number,
  ttlFor: TtlFor<Entry>,
  now = Date.now(),
): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new RangeError('Invalid cache limit');
  pruneExpired(cache, ttlFor, now);
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as Key | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
