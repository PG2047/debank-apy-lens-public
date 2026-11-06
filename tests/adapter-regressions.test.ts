import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aprToApy,
  compoundOfficial,
  dolomiteOfficial,
  ethenaOfficial,
  falconOfficial,
  venusOfficial,
} from '../utils/adapters/official.ts';
import { classifyLendingProduct } from '../utils/adapters/product.ts';
import type { LegQuery } from '../utils/adapters/types.ts';

const ASSET = '0x00000000000000000000000000000000000000a1';
const ASSET_2 = '0x00000000000000000000000000000000000000a2';
const COLLATERAL = '0x00000000000000000000000000000000000000c1';
const CONTAINER = '0x00000000000000000000000000000000000000d1';

function query(overrides: Partial<LegQuery> = {}): LegQuery {
  return {
    chainId: 1,
    address: ASSET,
    leg: 'supply',
    itemHasBorrows: false,
    ...overrides,
  };
}

test('Spark product routing never infers savings from a pure-supply shape', () => {
  assert.equal(classifyLendingProduct(query()), null);
  assert.equal(classifyLendingProduct(query({ itemHasBorrows: true })), 'lending');
  assert.equal(classifyLendingProduct(query({ itemAdapterId: 'aave_v3_lending' })), 'lending');
  assert.equal(
    classifyLendingProduct(query({ itemAdapterId: 'redeemable_tokenized_vault_yield' })),
    'savings',
  );
});

test('Dolomite preserves native yield and numeric rewards while points keep coverage incomplete', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      interestRates: [{
        token: { tokenAddress: ASSET },
        supplyInterestRate: '0.01',
        borrowInterestRate: '0.04',
        outsideSupplyInterestRateParts: [
          { category: 'nativeYield', interestRate: '0.03' },
          { category: 'rewards', interestRate: '0.02' },
          { category: 'points', interestRate: null, label: '5x points' },
        ],
        outsideBorrowInterestRateParts: [],
      }, {
        token: { tokenAddress: ASSET_2 },
        supplyInterestRate: null,
        borrowInterestRate: null,
        outsideSupplyInterestRateParts: [
          { category: 'rewards', interestRate: '0.02' },
        ],
        outsideBorrowInterestRateParts: [],
      }],
    }))) as typeof fetch;
  try {
    const [result, rewardOnly] = await dolomiteOfficial.resolve([
      query({ chainId: 991 }),
      query({ chainId: 991, address: ASSET_2 }),
    ]);
    assert.equal(result?.baseApy, aprToApy(0.04));
    assert.equal(result?.includesIntrinsicYield, true);
    assert.equal(result?.rewardApr, 0.02);
    assert.equal(result?.rewardState, 'non-annualizable');
    assert.equal(result?.rewardComponents?.[0]?.rateKind, 'apr');
    assert.equal(rewardOnly?.baseApy, null);
    assert.equal(rewardOnly?.rewardApr, 0.02);
    assert.equal(rewardOnly?.rewardState, 'numeric-known');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Venus uses explicit distributors instead of total-minus-base inference', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      result: [
        {
          isListed: true,
          address: CONTAINER,
          underlyingAddress: ASSET,
          poolComptrollerAddress: '0x00000000000000000000000000000000000000e1',
          supplyApyDecimal: '0.01',
          totalSupplyApyDecimal: '99',
          supplyXvsApr: '0.02',
          borrowApyDecimal: '0.04',
          borrowXvsApr: '0',
          rewardsDistributors: [
            {
              id: 'intrinsic',
              isActive: true,
              rewardType: 'intrinsic',
              supplySpeed: '1',
              borrowSpeed: '0',
              lastRewardingSupplyBlockOrTimestamp: '0',
              rewardDetails: { apy: '0.03' },
            },
            {
              id: 'merkl',
              isActive: true,
              rewardType: 'merkl',
              supplySpeed: '1',
              borrowSpeed: '0',
              lastRewardingSupplyBlockOrTimestamp: '0',
              rewardDetails: { apr: 4.5, merklCampaignIdentifier: 'campaign-a' },
            },
          ],
          pointsDistributions: [{ action: 'supply', title: 'Points' }],
        },
        {
          isListed: true,
          address: '0x00000000000000000000000000000000000000d2',
          underlyingAddress: ASSET_2,
          poolComptrollerAddress: '0x00000000000000000000000000000000000000e2',
          supplyApyDecimal: '0',
          supplyXvsApr: '0',
          borrowApyDecimal: '0',
          borrowXvsApr: '0',
          rewardsDistributors: [{
            id: 'ytm',
            isActive: true,
            rewardType: 'yield-to-maturity',
            supplySpeed: '1',
            borrowSpeed: '0',
            lastRewardingSupplyBlockOrTimestamp: '0',
            rewardDetails: { apy: '0.063' },
          }],
          pointsDistributions: [],
        },
        {
          isListed: true,
          address: '0x00000000000000000000000000000000000000d3',
          underlyingAddress: COLLATERAL,
          poolComptrollerAddress: '0x00000000000000000000000000000000000000e3',
          supplyApyDecimal: '0.02',
          supplyXvsApr: '0',
          borrowApyDecimal: '99',
          borrowXvsApr: '0',
          rewardsDistributors: [],
          pointsDistributions: [],
        },
      ],
    }))) as typeof fetch;
  try {
    const [mixed, maturity, validSupply, invalidBorrow] = await venusOfficial.resolve([
      query({ chainId: 992, itemPoolId: CONTAINER }),
      query({ chainId: 992, address: ASSET_2, itemPoolId: '0x00000000000000000000000000000000000000d2' }),
      query({ chainId: 992, address: COLLATERAL, itemPoolId: '0x00000000000000000000000000000000000000d3' }),
      query({
        chainId: 992,
        address: COLLATERAL,
        leg: 'borrow',
        itemHasBorrows: true,
        itemPoolId: '0x00000000000000000000000000000000000000d3',
      }),
    ]);
    assert.equal(mixed?.baseApy, 0.04);
    assert.equal(mixed?.includesIntrinsicYield, true);
    assert.equal(mixed?.rewardApr, 0.065);
    assert.equal(mixed?.rewardState, 'non-annualizable');
    assert.deepEqual(mixed?.rewardComponents?.map((component) => component.rateKind), ['apr', 'apr']);
    assert.equal(maturity?.baseApy, 0.063);
    assert.equal(maturity?.includesIntrinsicYield, true);
    assert.equal(maturity?.rewardApr, 0);
    assert.equal(maturity?.rewardState, 'confirmed-zero');
    assert.equal(validSupply?.baseApy, 0.02);
    assert.equal(validSupply?.rewardState, 'confirmed-zero');
    assert.equal(invalidBorrow?.baseApy, null);
    assert.equal(invalidBorrow?.rewardState, 'confirmed-zero');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Compound collateral resolves only through an exact Comet and is not treated as a deposit', async () => {
  const missingComet = '0x00000000000000000000000000000000000000d2';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/summary')) {
      return new Response(JSON.stringify([
        {
          chain_id: 993,
          comet: { address: CONTAINER },
          supply_apr: '0.03',
          borrow_apr: '0.05',
        },
        {
          chain_id: 993,
          comet: { address: missingComet },
          base_asset: { address: ASSET_2 },
          supply_apr: '0.0497',
          borrow_apr: '0.06',
        },
      ]));
    }
    return new Response(JSON.stringify([{
      chain_id: 993,
      comet: { address: CONTAINER },
      base_asset: { address: ASSET },
      earn_rewards_apr: '0.01',
      borrow_rewards_apr: '0.02',
    }]));
  }) as typeof fetch;
  try {
    const [base, collateral, ambiguous, summaryOnlyBase, baseWithoutIdentity] = await compoundOfficial.resolve([
      query({ chainId: 993, itemPoolId: CONTAINER }),
      query({ chainId: 993, address: COLLATERAL, itemPoolId: CONTAINER }),
      query({ chainId: 993, address: COLLATERAL }),
      query({ chainId: 993, address: ASSET_2, itemPoolId: missingComet }),
      query({ chainId: 993, address: ASSET }),
    ]);
    assert.equal(base?.baseApy, aprToApy(0.03));
    assert.equal(collateral?.baseApy, 0);
    assert.equal(collateral?.rewardApr, null);
    assert.equal(collateral?.rewardState, 'not-applicable');
    assert.equal(ambiguous, null);
    assert.equal(summaryOnlyBase?.baseApy, aprToApy(0.0497));
    assert.equal(summaryOnlyBase?.rewardApr, null);
    assert.equal(summaryOnlyBase?.rewardState, 'unknown');
    assert.equal(baseWithoutIdentity, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('share-token adapters declare intrinsic yield already included', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) =>
    String(input).includes('ethena.fi')
      ? new Response(JSON.stringify({ stakingYield: { value: 4 } }))
      : new Response(JSON.stringify({ sUSDf_7d_apy: '0.05' }))) as typeof fetch;
  try {
    const [ethena] = await ethenaOfficial.resolve([
      query({ address: '0x9d39a5de30e57443bff2a8307a4256c8797a3497' }),
    ]);
    const [falcon] = await falconOfficial.resolve([
      query({ address: '0xc8cf6d7991f15525488b2a83df53468d682ba4b0' }),
    ]);
    assert.equal(ethena?.includesIntrinsicYield, true);
    assert.equal(ethena?.rewardState, 'not-applicable');
    assert.deepEqual(ethena?.rewardEntitlements ?? [], []);
    assert.equal(falcon?.includesIntrinsicYield, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ethena recognizes exact sENA locked ENA as zero protocol APY without points or eligibility metadata', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('sENA classification must not need the sUSDe yield endpoint');
  }) as typeof fetch;
  try {
    const [sena, plainEna] = await ethenaOfficial.resolve([
      query({
        address: '0x57e114b691db790c35207b2e685d4a43181e6061',
        itemName: 'sENA',
      }),
      query({
        address: '0x57e114b691db790c35207b2e685d4a43181e6061',
        itemName: 'Wallet',
      }),
    ]);
    assert.equal(fetches, 0);
    assert.equal(sena?.baseApy, 0);
    assert.equal(sena?.rewardState, 'not-applicable');
    assert.deepEqual(sena?.rewardEntitlements ?? [], []);
    assert.equal(plainEna, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
