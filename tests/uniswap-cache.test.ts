import assert from 'node:assert/strict';
import test from 'node:test';

import type { PositionItem } from '../utils/debank.ts';
import {
  __resetUniswapCacheForTests,
  __uniswapCacheKeysForTests,
  uniswapRanges,
} from '../utils/uniswap.ts';

const UNSUPPORTED_CHAIN = 999;
const key = (positionIndex: string): string => `uniswapv3:${UNSUPPORTED_CHAIN}:${positionIndex}`;
const position = (positionIndex: string): PositionItem => ({
  itemName: 'LP',
  supplies: [],
  borrows: [],
  rewards: [],
  netUsd: 0,
  principalInputCoverageComplete: true,
  rewardInputCoverageComplete: true,
  positionIndex,
});

test('Uniswap cache hit prunes expired entries while retaining a fresh exact key', async () => {
  __resetUniswapCacheForTests();
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await uniswapRanges(UNSUPPORTED_CHAIN, [position('1')]);
    now = 60_000;
    await uniswapRanges(UNSUPPORTED_CHAIN, [position('2')]);
    assert.deepEqual(__uniswapCacheKeysForTests(), [key('1'), key('2')]);

    now = 120_001;
    await uniswapRanges(UNSUPPORTED_CHAIN, [position('2')]);
    assert.deepEqual(__uniswapCacheKeysForTests(), [key('2')]);
  } finally {
    Date.now = originalNow;
    __resetUniswapCacheForTests();
  }
});

test('Uniswap cache stays at 128 entries and evicts the least recently used exact key', async () => {
  __resetUniswapCacheForTests();
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    for (let index = 1; index <= 128; index += 1) {
      now += 1;
      await uniswapRanges(UNSUPPORTED_CHAIN, [position(String(index))]);
    }

    now += 1;
    await uniswapRanges(UNSUPPORTED_CHAIN, [position('1')]);
    now += 1;
    await uniswapRanges(UNSUPPORTED_CHAIN, [position('129')]);

    const keys = __uniswapCacheKeysForTests();
    assert.equal(keys.length, 128);
    assert.equal(keys.includes(key('1')), true);
    assert.equal(keys.includes(key('2')), false);
    assert.equal(keys.at(-1), key('129'));
  } finally {
    Date.now = originalNow;
    __resetUniswapCacheForTests();
  }
});
