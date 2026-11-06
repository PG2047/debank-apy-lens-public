import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeProtocolYield,
  enforceChildCoverage,
  knownAnnualUsd,
  type AssetYield,
} from '../utils/apy.ts';
import type { RewardState } from '../utils/adapters/types.ts';
import type { TokenLeg } from '../utils/debank.ts';

function token(symbol: string, usd: number): TokenLeg {
  return {
    address: symbol.toLowerCase(),
    chain: 'eth',
    symbol,
    amount: usd,
    priceUsd: 1,
    usd,
  };
}

function asset(
  leg: AssetYield['leg'],
  symbol: string,
  usd: number,
  baseApy: number | null,
  rewardApr: number | null = 0,
  rewardState: RewardState = 'confirmed-zero',
): AssetYield {
  return {
    leg,
    token: token(symbol, usd),
    baseApy,
    rewardApr,
    rewardState,
    source: 'test',
  };
}

function assertClose(actual: number | null, expected: number, epsilon = 1e-12): void {
  assert.ok(actual !== null, 'expected a numeric value');
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

test('normal looping position computes net APY and leverage', () => {
  const result = computeProtocolYield([
    asset('supply', 'USDC', 330_000, 0.05, 0.02, 'numeric-known'),
    asset('borrow', 'USDT', 230_000, 0.03, 0),
  ]);

  assertClose(result.netApy, 0.162);
  assertClose(result.leverage, 3.3);
  assert.equal(result.flags.length, 0);
});

test('non-positive equity returns null net APY and flags the position', () => {
  const result = computeProtocolYield([
    asset('supply', 'USDC', 100_000, 0.05, 0),
    asset('borrow', 'USDT', 100_000, 0.03, 0),
  ]);

  assert.equal(result.netApy, null);
  assert.equal(result.leverage, null);
  assert.ok(result.flags.length > 0);
});

test('near-full leverage returns null net APY and a warning flag', () => {
  const result = computeProtocolYield([
    asset('supply', 'USDC', 100_000, 0.05, 0),
    asset('borrow', 'USDT', 99_500, 0.03, 0),
  ]);

  assert.equal(result.netApy, null);
  assert.ok(result.flags.some((flag) => flag.includes('近满杠杆')));
});

test('dust unmatched leg is ignored without blocking net APY', () => {
  const result = computeProtocolYield([
    asset('supply', 'USDC', 330_000, 0.05, 0.02, 'numeric-known'),
    asset('borrow', 'USDT', 270_000, 0.03, 0),
    asset('supply', 'DUST', 50, null, null, 'unknown'),
  ]);

  assertClose(result.netApy, 15_000 / 60_050);
  assert.ok(result.flags.some((flag) => flag.includes('已忽略')));
});

test('material unmatched leg blocks net APY', () => {
  const result = computeProtocolYield([
    asset('supply', 'USDC', 100_000, 0.05, 0),
    asset('supply', 'DUST', 2_000, null, null, 'unknown'),
  ]);

  assert.equal(result.netApy, null);
  assert.ok(result.knownNetApy !== null);
  assert.ok(result.flags.some((flag) => flag.includes('部分资产利率未匹配')));
});

test('material unknown reward preserves known subtotal but withholds complete net APY', () => {
  const position = asset('supply', 'USDC', 100_000, 0.05, null, 'unknown');

  const result = computeProtocolYield([position]) as ReturnType<typeof computeProtocolYield> & {
    knownNetApy: number | null;
    knownEstDailyUsd: number | null;
    rewardCoverageComplete: boolean;
  };

  assert.equal(result.netApy, null);
  assertClose(result.knownNetApy, 0.05);
  assertClose(result.knownEstDailyUsd, (100_000 * 0.05) / 365);
  assert.equal(result.rewardCoverageComplete, false);
  assert.ok(result.flags.some((flag) => flag.includes('奖励覆盖不完整')));
});

test('confirmed-zero reward remains a complete calculable position', () => {
  const position = asset('supply', 'USDC', 100_000, 0.05, 0, 'confirmed-zero');

  const result = computeProtocolYield([position]) as ReturnType<typeof computeProtocolYield> & {
    knownNetApy: number | null;
    rewardCoverageComplete: boolean;
  };

  assertClose(result.netApy, 0.05);
  assertClose(result.knownNetApy, 0.05);
  assert.equal(result.rewardCoverageComplete, true);
});

test('aggregate unknown rewards below one percent are disclosed as dust', () => {
  const known = asset('supply', 'USDC', 100_000, 0.05, 0, 'confirmed-zero');
  const dust = asset('supply', 'DUST', 500, 0.01, null, 'unknown');

  const result = computeProtocolYield([known, dust]) as ReturnType<typeof computeProtocolYield> & {
    rewardCoverageComplete: boolean;
  };

  assert.ok(result.netApy !== null);
  assert.equal(result.rewardCoverageComplete, true);
  assert.ok(result.flags.some((flag) => flag.includes('奖励未知尘埃')));
});

test('reward components preserve rate kind and deduplicate campaign identity', () => {
  const position: AssetYield = {
    ...asset('supply', 'USDC', 100_000, 0.05, 0.02, 'numeric-known'),
    rewardState: 'numeric-known',
    rewardComponents: [
      { id: 'campaign-a', value: 0.02, rateKind: 'apr', source: 'test', basis: 'supply' },
      { id: 'campaign-a', value: 0.02, rateKind: 'apr', source: 'test', basis: 'supply' },
      { id: 'rebate-usd', value: 1_000, rateKind: 'annual-usd', source: 'test', basis: 'position' },
    ],
  };

  const result = computeProtocolYield([position]);

  assertClose(result.netApy, 0.08);
  assertClose(result.knownEstDailyUsd, 8_000 / 365);
});

test('a large covered item cannot dilute another item with unknown rewards', () => {
  const covered = computeProtocolYield([asset('supply', 'USDC', 100_000, 0.05, 0)]);
  const unknownAsset: AssetYield = {
    ...asset('supply', 'DUST', 500, 0.01, null, 'unknown'),
    rewardState: 'unknown',
  };
  const incomplete = computeProtocolYield([unknownAsset]);
  const naiveParent = computeProtocolYield([...covered.assets, ...incomplete.assets]);

  assert.equal(naiveParent.rewardCoverageComplete, true);
  const result = enforceChildCoverage(naiveParent, [covered, incomplete]);
  assert.equal(result.rewardCoverageComplete, false);
  assert.equal(result.netApy, null);
  assert.ok(result.knownNetApy !== null);
});

test('an uncalculable child with complete rewards does not poison parent reward coverage', () => {
  const normal = computeProtocolYield([asset('supply', 'USDC', 100_000, 0.05, 0)]);
  const tiny = computeProtocolYield([asset('supply', 'TINY', 20, 0.01, 0)]);
  const parent = computeProtocolYield([...normal.assets, ...tiny.assets]);

  assert.equal(tiny.netApy, null);
  assert.equal(tiny.rewardCoverageComplete, true);
  const result = enforceChildCoverage(parent, [normal, tiny]);
  assert.equal(result.rewardCoverageComplete, true);
  assert.ok(result.netApy !== null);
});

test('a large covered item cannot dilute another item with an unknown base rate', () => {
  const covered = computeProtocolYield([asset('supply', 'USDC', 100_000, 0.05, 0)]);
  const uncovered = computeProtocolYield([asset('supply', 'UNKNOWN', 500, null, 0)]);
  const naiveParent = computeProtocolYield([...covered.assets, ...uncovered.assets]);

  assert.equal(naiveParent.rateCoverageComplete, true);
  assert.equal(uncovered.rateCoverageComplete, false);
  const result = enforceChildCoverage(naiveParent, [covered, uncovered]);
  assert.equal(result.rateCoverageComplete, false);
  assert.equal(result.netApy, null);
  assert.ok(result.knownNetApy !== null);
});

test('a known reward survives when the same leg has an unknown base rate', () => {
  const rewarded: AssetYield = {
    ...asset('supply', 'USDC', 100_000, null, 0.02, 'numeric-known'),
    rewardState: 'numeric-known',
  };

  assertClose(knownAnnualUsd(rewarded), 2_000);
  const result = computeProtocolYield([rewarded]);
  assert.equal(result.netApy, null);
  assertClose(result.knownEstDailyUsd, 2_000 / 365);
});
