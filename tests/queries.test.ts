import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProtocolPosition, TokenLeg } from '../utils/debank.ts';
import { buildLegQueries } from '../utils/queries.ts';

function token(address: string, amount: number): TokenLeg {
  return { address, chain: 'base', symbol: address, amount, priceUsd: 1, usd: amount };
}

test('query builder preserves the complete item identity on every leg', () => {
  const position: ProtocolPosition = {
    protocolId: 'base_example',
    chain: 'base',
    name: 'Example',
    items: [
      {
        itemName: 'Lending',
        supplies: [token('0xs1', 10), token('0xs2', 20)],
        borrows: [token('0xb1', 3), token('0xb2', 4)],
        rewards: [token('0xr1', 1)],
        principalInputCoverageComplete: true,
        rewardInputCoverageComplete: true,
        netUsd: 23,
        adapterId: 'market_adapter',
        poolId: '0xmarket',
        positionIndex: '7',
      },
    ],
  };

  const { queries, legs } = buildLegQueries(position, 8453, '0xwallet');

  assert.equal(queries.length, 4);
  assert.equal(legs.length, 4);
  assert.deepEqual(queries[0].itemSupplyAddresses, ['0xs1', '0xs2']);
  assert.deepEqual(queries[0].itemBorrowAddresses, ['0xb1', '0xb2']);
  assert.deepEqual(queries[0].itemSupplies, [
    { address: '0xs1', amount: 10, usd: 10, priceUsd: 1, decimals: undefined },
    { address: '0xs2', amount: 20, usd: 20, priceUsd: 1, decimals: undefined },
  ]);
  assert.deepEqual(queries[0].itemBorrows, [
    { address: '0xb1', amount: 3, usd: 3, priceUsd: 1, decimals: undefined },
    { address: '0xb2', amount: 4, usd: 4, priceUsd: 1, decimals: undefined },
  ]);
  assert.deepEqual(queries[0].itemRewards, [
    {
      address: '0xr1',
      symbol: '0xr1',
      amount: 1,
      usd: 1,
      priceUsd: 1,
      decimals: undefined,
    },
  ]);
  assert.ok(queries.every((query) => query.positionKey === queries[0].positionKey));
  assert.ok(queries.every((query) => query.itemPoolId === '0xmarket'));
  assert.ok(queries.every((query) => !('itemPairAddress' in query)));
});
