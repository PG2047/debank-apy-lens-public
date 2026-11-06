import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeProtocolYield, type AssetYield } from '../utils/apy.ts';
import { normalizeRewardCoverage } from '../utils/adapters/types.ts';
import { assetRateLines } from '../utils/overlay.ts';

const component = {
  id: 'campaign:known',
  value: 0.045,
  rateKind: 'apr' as const,
  source: 'fixture',
  basis: 'supply' as const,
};

function asset(
  rewardApr: number | null,
  rewardState: AssetYield['rewardState'],
  rewardComponents: AssetYield['rewardComponents'] = [],
): AssetYield {
  return {
    leg: 'supply',
    token: {
      address: '0xusde',
      chain: 'base',
      symbol: 'USDe',
      amount: 100_000,
      priceUsd: 1,
      usd: 100_000,
    },
    baseApy: 0,
    rewardApr,
    rewardState,
    rewardComponents,
    source: 'fixture',
  };
}

test('scalar zero cannot promote explicit unknown coverage to confirmed zero', () => {
  const normalized = normalizeRewardCoverage({
    rewardApr: 0,
    rewardState: 'unknown',
  });

  assert.deepEqual(normalized, {
    rewardApr: 0,
    rewardState: 'unknown',
    rewardComponents: [],
  });
  const result = computeProtocolYield([asset(0, 'unknown')]);
  assert.equal(result.rewardCoverageComplete, false);
  assert.equal(result.netApy, null);
});

test('contradictory confirmed zero fails closed and retains valid known components', () => {
  const normalized = normalizeRewardCoverage({
    rewardApr: 0,
    rewardState: 'confirmed-zero',
    rewardComponents: [component],
  });

  assert.equal(normalized.rewardState, 'unknown');
  assert.equal(normalized.rewardApr, 0.045);
  assert.deepEqual(normalized.rewardComponents, [component]);

  const result = computeProtocolYield([asset(0, 'confirmed-zero', [component])]);
  assert.equal(result.rewardCoverageComplete, false);
  assert.equal(result.netApy, null);
  assert.equal(result.knownNetApy, 0.045);
  assert.deepEqual(assetRateLines(result.assets[0]), [
    '基础 APY 0%',
    '奖励 4.5% APR',
    '其他奖励 未知',
  ]);
});

test('numeric-known zero fails closed instead of manufacturing zero proof', () => {
  assert.deepEqual(
    normalizeRewardCoverage({ rewardApr: 0, rewardState: 'numeric-known' }),
    { rewardApr: null, rewardState: 'unknown', rewardComponents: [] },
  );
});

test('non-annualizable scalar without components is discarded fail closed', () => {
  assert.deepEqual(
    normalizeRewardCoverage({ rewardApr: 0.02, rewardState: 'non-annualizable' }),
    { rewardApr: null, rewardState: 'unknown', rewardComponents: [] },
  );

  const result = computeProtocolYield([asset(0.02, 'non-annualizable')]);
  assert.equal(result.knownNetApy, 0);
  assert.equal(result.netApy, null);
});

test('component truth overrides a contradictory numeric-known scalar', () => {
  const normalized = normalizeRewardCoverage({
    rewardApr: 0.99,
    rewardState: 'numeric-known',
    rewardComponents: [component],
  });

  assert.equal(normalized.rewardState, 'unknown');
  assert.equal(normalized.rewardApr, 0.045);
  assert.deepEqual(normalized.rewardComponents, [component]);
});

test('conflicting duplicate campaign is discarded while independent evidence survives', () => {
  const normalized = normalizeRewardCoverage({
    rewardApr: 0.1,
    rewardState: 'numeric-known',
    rewardComponents: [
      component,
      { ...component, value: 0.055 },
      { ...component, id: 'campaign:independent', value: 0.01 },
    ],
  });

  assert.equal(normalized.rewardState, 'unknown');
  assert.equal(normalized.rewardApr, 0.01);
  assert.deepEqual(normalized.rewardComponents, [
    { ...component, id: 'campaign:independent', value: 0.01 },
  ]);
});
