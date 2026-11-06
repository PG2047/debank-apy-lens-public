import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AssetYield, ProtocolYield } from '../utils/apy.ts';
import type { TokenLeg } from '../utils/debank.ts';
import {
  assetRateCompact,
  assetRateLines,
  assetRatePresentation,
  liquidityRiskPresentation,
  portfolioDailyHeadline,
  rangeText,
  yieldHeadline,
} from '../utils/overlay.ts';
import type { LpRange } from '../utils/uniswap.ts';

function token(): TokenLeg {
  return {
    address: '0xusde',
    chain: 'base',
    symbol: 'USDe',
    amount: 100,
    priceUsd: 1,
    usd: 100,
  };
}

function position(overrides: Partial<ProtocolYield> = {}): ProtocolYield {
  return {
    equityUsd: 100,
    leverage: 1,
    netApy: 0.05,
    estDailyUsd: 0.0137,
    knownNetApy: 0.05,
    knownEstDailyUsd: 0.0137,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: [],
    ...overrides,
  };
}

function asset(overrides: Partial<AssetYield> = {}): AssetYield {
  return {
    leg: 'supply',
    token: token(),
    baseApy: 0,
    rewardApr: null,
    rewardState: 'unknown',
    source: 'test',
    ...overrides,
  };
}

const range: LpRange = {
  positionIndex: '42',
  inRange: true,
  fullRange: false,
  feePct: 0.003,
  feeApy: null,
  incentiveApr: null,
  incentiveState: 'unknown',
  lowerPrice: 0.9,
  upperPrice: 1.1,
  currentPrice: 1,
  pct: 0.5,
  baseSymbol: 'ETH',
  quoteSymbol: 'USDC',
};

test('incomplete rewards label a known subtotal instead of a complete net APY', () => {
  const label = yieldHeadline(
    position({ netApy: null, estDailyUsd: null, rewardCoverageComplete: false }),
  );

  assert.equal(label, '小计 5%');
  assert.doesNotMatch(label, /净APY/);
});

test('complete coverage retains the net APY label', () => {
  assert.equal(yieldHeadline(position()), '净APY 5%');
});

test('portfolio summary labels material uncovered value as a known subtotal', () => {
  assert.deepEqual(
    portfolioDailyHeadline({
      estDailyUsd: 5,
      knownEstDailyUsd: 5,
      rewardCoverageComplete: true,
      rateCoverageComplete: true,
      coveredUsd: 100_000,
      uncoveredUsd: 10_000,
      lpTotal: 1,
      lpOutOfRange: 0,
      claimableUsd: 0,
      claimableState: 'complete',
      claimTop: [],
    }),
    { complete: false, label: '今日小计', value: 5 },
  );
});

test('asset rate details show base and every known reward component', () => {
  const lines = assetRateLines(
    asset({
      rewardApr: 0.055,
      rewardState: 'numeric-known',
      rewardComponents: [
        { id: 'merkl:1', value: 0.045, rateKind: 'apr', source: 'Merkl', basis: 'collateral', label: 'USDe' },
        { id: 'native:2', value: 0.01, rateKind: 'apy', source: 'Native', basis: 'supply', label: 'Bonus' },
      ],
    }),
  );

  assert.deepEqual(lines, [
    '基础 APY 0%',
    '奖励 USDe 4.5% APR',
    '奖励 Bonus 1% APY',
  ]);
  assert.equal(assetRateCompact(
    asset({
      rewardApr: 0.055,
      rewardState: 'numeric-known',
      rewardComponents: [
        { id: 'merkl:1', value: 0.045, rateKind: 'apr', source: 'Merkl', basis: 'collateral' },
        { id: 'native:2', value: 0.01, rateKind: 'apy', source: 'Native', basis: 'supply' },
      ],
    }),
  ), 'APY 0% + 5.5%');
});

test('reward coverage states remain visibly distinct', () => {
  assert.deepEqual(assetRateLines(asset({ rewardApr: 0, rewardState: 'confirmed-zero' })), [
    '基础 APY 0%',
    '奖励 0%',
  ]);
  assert.deepEqual(assetRateLines(asset({ rewardState: 'unknown' })), [
    '基础 APY 0%',
    '奖励 未知',
  ]);
  assert.deepEqual(assetRateLines(asset({ rewardState: 'non-annualizable' })), [
    '基础 APY 0%',
    '奖励存在，无法年化',
  ]);
  assert.deepEqual(assetRateLines(asset({ rewardState: 'not-applicable' })), [
    '基础 APY 0%',
    '奖励 不适用',
  ]);
});

test('compact asset APY is terse while details preserve supply and borrow semantics', () => {
  const supplied = assetRatePresentation(asset({
    rewardApr: 0.045,
    rewardState: 'numeric-known',
    rewardComponents: [
      { id: 'merkl', value: 0.045, rateKind: 'apr', source: 'Merkl', basis: 'collateral', label: 'USDe' },
    ],
  }));
  assert.equal(supplied.compact, 'APY 0% + 4.5%');
  assert.deepEqual(supplied.details, ['基础 APY 0%', '奖励 USDe 4.5% APR']);

  const borrowed = assetRatePresentation(asset({
    leg: 'borrow',
    baseApy: 0.0269,
    rewardApr: 0,
    rewardState: 'confirmed-zero',
  }));
  assert.equal(borrowed.compact, 'APY -2.69% + 0%');
  assert.deepEqual(borrowed.details, ['借款成本 -2.69%', '奖励 0%']);
  assert.doesNotMatch(`${borrowed.compact} ${borrowed.details.join(' ')}`, /已确认|确认/);
});

test('compact asset APY keeps incomplete and annual-dollar rewards explicit', () => {
  assert.equal(assetRateCompact(asset({ rewardState: 'unknown' })), 'APY 0% + --');
  assert.equal(assetRateCompact(asset({
    rewardState: 'numeric-known',
    rewardComponents: [
      { id: 'cash', value: 365, rateKind: 'annual-usd', source: 'fixture', basis: 'supply' },
    ],
  })), 'APY 0% + $365.00/年 + --');
});

test('known reward components remain visible alongside incomplete coverage', () => {
  assert.deepEqual(
    assetRateLines(
      asset({
        rewardState: 'unknown',
        rewardComponents: [
          { id: 'known', value: 0.045, rateKind: 'apr', source: 'Merkl', basis: 'collateral' },
        ],
      }),
    ),
    ['基础 APY 0%', '奖励 4.5% APR', '其他奖励 未知'],
  );
});

test('non-Ethena points multipliers remain explicit but never enter APY', () => {
  const presentation = assetRatePresentation(asset({
    rewardApr: 0.045,
    rewardState: 'numeric-known',
    rewardComponents: [
      { id: 'known', value: 0.045, rateKind: 'apr', source: 'Merkl', basis: 'collateral' },
    ],
    rewardEntitlements: [{
      id: 'lista-points',
      label: 'Lista Points',
      display: '5x Points',
      source: 'official-rule',
      basis: 'collateral',
      verification: 'rule-confirmed',
    }],
  }));

  assert.equal(presentation.compact, 'APY 0% + 4.5% · 5x Points');
  assert.match(presentation.details.join(' '), /不可折算 APY/);
  assert.match(presentation.details.join(' '), /资格状态：当前规则已核实/);
  assert.equal(presentation.details[3], '资格状态：当前规则已核实');
  assert.equal(presentation.details[4], '计算口径：不可折算 APY，不计入净APY或今日收益');
  assert.equal(presentation.incomplete, false);
});

test('ecosystem reward entitlements are not mislabeled as points', () => {
  const presentation = assetRatePresentation(asset({
    rewardState: 'not-applicable',
    rewardEntitlements: [{
      id: 'partner-reward',
      label: 'Partner Reward',
      display: '生态奖励资格',
      source: 'https://lista.org/',
      basis: 'supply',
      verification: 'rule-confirmed',
      category: 'ecosystem-reward',
    }],
  }));
  assert.equal(presentation.compact, 'APY 0% · 生态奖励资格');
  assert.match(presentation.details.join(' '), /生态奖励 Partner Reward/);
  assert.doesNotMatch(presentation.details.join(' '), /积分 Partner Reward|奖励 不适用/);
});

test('DEX range text omits pair, value, fee APY, and external incentive APY', () => {
  const text = rangeText(range);
  assert.equal(text, '区间内 0.9000 ⟨1.000⟩ 1.100');
  assert.doesNotMatch(text, /USDC|ETH|费率档|手续费|激励|APY/);
});

test('LP fee tier, personal fee APY, and incentives remain separate model fields outside the range label', () => {
  assert.equal(range.feePct, 0.003);
  assert.equal(range.feeApy, null);
  assert.equal(range.incentiveState, 'unknown');
  assert.doesNotMatch(rangeText(range), /费率档|手续费APY|激励/);
});

test('liquidity risk presentation keeps USD and token pool units explicit', () => {
  const red = liquidityRiskPresentation(asset({
    poolStat: { total: 1_000, available: 110, unit: 'usd', source: 'fixture-usd' },
  }));
  assert.equal(red?.compact, '⚠流动性紧张');
  assert.deepEqual(red?.details, [
    '我仓位 $100.00 · 占池子 10%',
    '池子总规模 $1.0k · 当前可提 $110.00',
    '规则：当前可提≤我仓位×110% 为红；占池子≥10% 为黄（红优先）',
    '流动性数据源：fixture-usd',
  ]);

  const yellow = liquidityRiskPresentation(asset({
    poolStat: { total: 1_000, available: 200, unit: 'token', source: 'fixture-token' },
  }));
  assert.equal(yellow?.compact, '占比 10%');
  assert.match(yellow?.details.join(' ') ?? '', /100 USDe.*token 口径/);
  assert.match(yellow?.details.join(' ') ?? '', /1\.0k USDe.*当前可提 200 USDe/);
});
