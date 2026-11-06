import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aaveAdapter } from '../utils/adapters/aave.ts';
import type { LegQuery } from '../utils/adapters/types.ts';

const ASSET = '0x00000000000000000000000000000000000000a1';
const MARKET_A = '0x0000000000000000000000000000000000000011';
const MARKET_B = '0x0000000000000000000000000000000000000022';
const MARKET_C = '0x0000000000000000000000000000000000000033';

function query(overrides: Partial<LegQuery> = {}): LegQuery {
  return {
    chainId: 1,
    address: ASSET,
    leg: 'supply',
    itemHasBorrows: true,
    userAddress: '0x00000000000000000000000000000000000000ff',
    itemSupplyAddresses: [ASSET],
    itemBorrowAddresses: ['0x00000000000000000000000000000000000000b1'],
    ...overrides,
  };
}

test('Aave V3 binds official incentives to the exact market and preserves points state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { variables?: { user?: string } };
    assert.equal(request.variables?.user, '0x00000000000000000000000000000000000000ff');
    return new Response(
      JSON.stringify({
        data: {
          markets: [
            {
              name: 'Market A',
              address: MARKET_A,
              chain: { chainId: 1 },
              reserves: [
                {
                  underlyingToken: { address: ASSET },
                  supplyInfo: { apy: { value: '0.03' }, total: { value: 2_000 } },
                  borrowInfo: { apy: { value: '0.04' }, availableLiquidity: { usd: 110, usdPerToken: 1 } },
                  incentives: [
                    {
                      __typename: 'MerklSupplyIncentive',
                      id: 'campaign-a',
                      extraSupplyApr: { value: '0.02' },
                      payoutToken: { address: '0xreward', symbol: 'RWD' },
                      userEligible: true,
                    },
                    {
                      __typename: 'SupplyPointsIncentive',
                      id: 'points-a',
                      name: 'Points',
                      multiplier: 5,
                      userEligible: true,
                    },
                    {
                      __typename: 'AaveBorrowIncentive',
                      borrowAprDiscount: { value: '0.01' },
                      rewardTokenAddress: '0xborrowreward',
                      rewardTokenSymbol: 'BRWD',
                    },
                  ],
                },
              ],
            },
            {
              name: 'Market B',
              address: MARKET_B,
              chain: { chainId: 1 },
              reserves: [
                {
                  underlyingToken: { address: ASSET },
                  supplyInfo: { apy: { value: '0.09' }, total: { value: 4_000 } },
                  borrowInfo: { apy: { value: '0.10' }, availableLiquidity: { usd: 3_000, usdPerToken: 1 } },
                  incentives: [],
                },
              ],
            },
            {
              name: 'Market C',
              address: MARKET_C,
              chain: { chainId: 1 },
              reserves: [
                {
                  underlyingToken: { address: ASSET },
                  supplyInfo: { apy: { value: null }, total: { value: 500 } },
                  borrowInfo: null,
                  incentives: [
                    {
                      __typename: 'MeritSupplyIncentive',
                      actionKey: 'market-c',
                      extraSupplyApr: { value: '0.015' },
                      selfApr: { value: '0.005' },
                      rewardTokenAddress: '0xreward',
                      rewardTokenSymbol: 'RWD',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
  };

  try {
    const [ambiguous, supply, borrow, zero, rewardOnly] = await aaveAdapter.resolve([
      query(),
      query({ itemPoolId: `${MARKET_A}:lending` }),
      query({ itemPoolId: MARKET_A, leg: 'borrow' }),
      query({ itemPoolId: MARKET_B }),
      query({ itemPoolId: MARKET_C }),
    ]);
    assert.equal(ambiguous, null);
    assert.equal(supply?.baseApy, 0.03);
    assert.equal(supply?.rewardApr, 0.02);
    assert.equal(supply?.rewardState, 'non-annualizable');
    assert.deepEqual(supply?.poolStat, {
      total: 2_000,
      available: 110,
      unit: 'usd',
      source: 'aave-api',
    });
    assert.deepEqual(supply?.rewardComponents?.map((component) => component.id), ['aave-v3:campaign-a']);
    assert.equal(borrow?.baseApy, 0.04);
    assert.equal(borrow?.rewardApr, 0.01);
    assert.equal(borrow?.rewardState, 'numeric-known');
    assert.equal(borrow?.poolStat, undefined);
    assert.equal(zero?.baseApy, 0.09);
    assert.equal(zero?.rewardApr, 0);
    assert.equal(zero?.rewardState, 'confirmed-zero');
    assert.equal(rewardOnly?.baseApy, null);
    assert.equal(rewardOnly?.rewardApr, 0.015);
    assert.equal(rewardOnly?.rewardState, 'non-annualizable');
    assert.deepEqual(rewardOnly?.poolStat, {
      total: 500,
      available: null,
      unit: 'token', // 无 borrowInfo → 无 usdPerToken 可换算,降级 token 口径(实测语义 2026-07-11)
      source: 'aave-api',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
