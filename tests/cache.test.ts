import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTtlLru, setTtlLru } from '../utils/cache.ts';

test('TTL/LRU cache prunes every expired wallet and evicts the least recently used key', () => {
  const cache = new Map<string, { at: number; value: string }>();
  const ttl = () => 100;

  setTtlLru(cache, 'expired-a', { at: 0, value: 'a' }, 3, ttl, 0);
  setTtlLru(cache, 'expired-b', { at: 1, value: 'b' }, 3, ttl, 1);
  setTtlLru(cache, 'wallet-1', { at: 150, value: '1' }, 3, ttl, 150);
  setTtlLru(cache, 'wallet-2', { at: 151, value: '2' }, 3, ttl, 151);
  setTtlLru(cache, 'wallet-3', { at: 152, value: '3' }, 3, ttl, 152);

  assert.equal(getTtlLru(cache, 'wallet-1', ttl, 160)?.value, '1');
  setTtlLru(cache, 'wallet-4', { at: 161, value: '4' }, 3, ttl, 161);

  assert.deepEqual([...cache.keys()], ['wallet-3', 'wallet-1', 'wallet-4']);
  assert.equal(cache.has('expired-a'), false);
  assert.equal(cache.has('expired-b'), false);
  assert.equal(cache.has('wallet-2'), false);
});

test('entry-specific TTL removes unknown results earlier than complete results', () => {
  type Entry = { at: number; coverage: 'complete' | 'unknown' };
  const cache = new Map<string, Entry>([
    ['complete', { at: 0, coverage: 'complete' }],
    ['unknown', { at: 0, coverage: 'unknown' }],
  ]);
  const ttl = (entry: Entry) => entry.coverage === 'complete' ? 1_000 : 100;

  assert.equal(getTtlLru(cache, 'complete', ttl, 200)?.coverage, 'complete');
  assert.equal(cache.has('unknown'), false);
});
