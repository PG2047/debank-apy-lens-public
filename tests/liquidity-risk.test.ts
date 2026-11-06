import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessLiquidityRisk } from '../utils/liquidity-risk.ts';

test('available liquidity exactly at 110% is red', () => {
  assert.deepEqual(
    assessLiquidityRisk(
      { usd: 100, tokens: 100 },
      { total: 2_000, available: 110, unit: 'usd', source: 'fixture' },
    ),
    { level: 'red', sharePct: 0.05, availableRatio: 1.1 },
  );
});

test('zero pool total fails open', () => {
  assert.deepEqual(
    assessLiquidityRisk(
      { usd: 100, tokens: 100 },
      { total: 0, available: 0, unit: 'usd', source: 'fixture' },
    ),
    { level: null, sharePct: null, availableRatio: null },
  );
});

test('token pools compare token amounts instead of USD values', () => {
  assert.deepEqual(
    assessLiquidityRisk(
      { usd: 1_000_000, tokens: 100 },
      { total: 2_000, available: 300, unit: 'token', source: 'fixture' },
    ),
    { level: null, sharePct: 0.05, availableRatio: 3 },
  );
});

test('red takes priority when red and yellow thresholds both match', () => {
  assert.deepEqual(
    assessLiquidityRisk(
      { usd: 100, tokens: 100 },
      { total: 500, available: 100, unit: 'usd', source: 'fixture' },
    ),
    { level: 'red', sharePct: 0.2, availableRatio: 1 },
  );
});

test('missing pool stats fail open', () => {
  assert.deepEqual(assessLiquidityRisk({ usd: 100, tokens: 100 }), {
    level: null,
    sharePct: null,
    availableRatio: null,
  });
});
