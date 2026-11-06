import assert from 'node:assert/strict';
import test from 'node:test';
import inventory from '../utils/aave-markets.json';
import { CHAINS } from '../utils/chains.ts';
import { aaveAdapter, __resetAaveCacheForTests } from '../utils/adapters/aave.ts';
import { aave4Adapter, __resetAave4CacheForTests } from '../utils/adapters/aave4.ts';
import { findAdapter } from '../utils/adapters/registry.ts';
import { enrichPayload } from '../utils/enrich.ts';
import type { LegQuery } from '../utils/adapters/types.ts';

const ASSET = '0x00000000000000000000000000000000000000a1';
const POOL = '0x0000000000000000000000000000000000000011';
const USER_A = '0x00000000000000000000000000000000000000aa';
const USER_B = '0x00000000000000000000000000000000000000bb';
const query = (overrides: Partial<LegQuery> = {}): LegQuery => ({
  chainId: 1, address: ASSET, itemPoolId: POOL, leg: 'supply', itemHasBorrows: true, ...overrides,
});

test('every reviewed V3 market and V4/Pro spoke reaches DeBank enrichment, including native assets and separate brands', async () => {
  const original = globalThis.fetch;
  __resetAaveCacheForTests();
  __resetAave4CacheForTests();
  const requested = new Set<string>();
  const projects = [...inventory.v3, ...inventory.v4].flatMap((chain) => {
    assert.equal(CHAINS[chain.debankId].chainId, chain.chainId);
    const v3 = 'markets' in chain;
    return (v3 ? chain.markets : chain.spokes).map((market, index) => ({
      id: `market_brand_${v3 ? 3 : 4}_${chain.chainId}_${index}`,
      chain: chain.debankId, name: v3 ? 'Aave V3' : 'Aave Pro',
      portfolio_item_list: [{ name: 'Lending', pool: { id: `${market.address}:lending` },
        stats: { net_usd_value: 1_000 },
        detail: { supply_token_list: [{ id: chain.debankId, chain: chain.debankId, symbol: 'NATIVE', amount: 1_000, price: 1 }] },
      }],
    }));
  });
  globalThis.fetch = async (input, init) => {
    const { variables } = JSON.parse(String(init?.body));
    const chainId = variables.chainIds[0];
    const v3 = String(input).includes('api.v3.');
    requested.add(`${v3 ? 3 : 4}:${chainId}`);
    if (v3) return new Response(JSON.stringify({ data: { markets:
      inventory.v3.find((chain) => chain.chainId === chainId)!.markets.map((market) => ({
        ...market, chain: { chainId, nativeWrappedToken: ASSET }, reserves: [{
          underlyingToken: { address: ASSET }, supplyInfo: { apy: { value: '0.03' } }, incentives: [],
        }],
      })),
    } }));
    return new Response(JSON.stringify({ data: { reserves:
      inventory.v4.find((chain) => chain.chainId === chainId)!.spokes.map((spoke) => ({
        spoke: { ...spoke, chain: { chainId, nativeAsset: chainId === 5042
          ? { __typename: 'SharedBalanceNativeAsset', erc20Address: ASSET }
          : { __typename: 'WrappedNativeAsset', wrappedNativeTokenAddress: ASSET } } },
        asset: { underlying: { address: ASSET } }, summary: { supplyApy: { value: '0.04' }, rewards: [] },
      })),
    } }));
  };
  try {
    const result = await enrichPayload({ data: projects });
    assert.equal(result.cards.length, projects.length);
    assert.equal(requested.size, inventory.v3.length + inventory.v4.length);
    for (const card of result.cards) {
      assert.equal(card.yield.assets[0].baseApy, card.title === 'Aave V3' ? 0.03 : 0.04, card.key);
      assert.equal(card.yield.assets[0].rewardState, 'confirmed-zero', card.key);
    }
    assert.equal(result.summary?.rateCoverageComplete, true);
    for (const project of projects) {
      assert.equal(findAdapter(project.id), undefined);
      assert.equal(findAdapter(project.id, { chainId: 999999, poolIds: [project.portfolio_item_list[0].pool.id] }), undefined);
    }
    assert.equal(findAdapter('aave2'), undefined);
    assert.equal(findAdapter('unverified_aave_pro'), undefined);
    // A precise Aave market takes priority over a broad staking brand name.
    const market = inventory.v3.find((c) => c.chainId === 1)!.markets[0].address;
    const spoke = inventory.v4.find((c) => c.chainId === 1)!.spokes[0].address;
    assert.equal(findAdapter('etherfi', { chainId: 1, poolIds: [market] })?.name, 'aave-v3');
    assert.equal(findAdapter('etherfi')?.name, 'etherfi');
    assert.equal(findAdapter('aave3', { chainId: 1, poolIds: [market, spoke] }), undefined);
  } finally {
    globalThis.fetch = original;
    __resetAaveCacheForTests();
    __resetAave4CacheForTests();
  }
});

test('Aave V3 isolates chain failures and user eligibility, and caches each wallet/chain', async () => {
  const original = globalThis.fetch;
  __resetAaveCacheForTests();
  const requests: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const { variables } = JSON.parse(String(init?.body));
    assert.equal(variables.chainIds.length, 1);
    const chainId = variables.chainIds[0];
    requests.push(`${chainId}:${variables.user}`);
    if (chainId === 56) return new Response('{"errors":[{"message":"chain unavailable"}]}');
    return new Response(JSON.stringify({ data: { markets: [{
      address: POOL, chain: { chainId, nativeWrappedToken: ASSET }, reserves: [{
        underlyingToken: { address: ASSET }, supplyInfo: { apy: { value: chainId === 1 ? '0.03' : '0.05' } },
        incentives: [{ __typename: 'MerklSupplyIncentive', id: 'campaign', extraSupplyApr: { value: '0.02' }, userEligible: variables.user === USER_A }],
      }],
    }] } }));
  };
  try {
    const rates = await aaveAdapter.resolve([
      query({ userAddress: USER_A, address: 'eth' }),
      query({ userAddress: USER_B }),
      query({ userAddress: USER_A, chainId: 8453, address: 'base' }),
      query({ userAddress: USER_A, chainId: 56 }),
      query({ userAddress: USER_A, chainId: 8453, address: 'eth' }),
      query({ userAddress: USER_A, itemPoolId: USER_B, address: 'eth' }),
    ]);
    assert.deepEqual(rates.map((rate) => rate?.baseApy ?? null), [0.03, 0.03, 0.05, null, null, null]);
    assert.deepEqual(rates.slice(0, 3).map((rate) => rate?.rewardApr), [0.02, 0, 0.02]);
    await aaveAdapter.resolve([query({ userAddress: USER_A.toUpperCase().replace('0X', '0x') })]);
    assert.equal(requests.length, 4);
  } finally { globalThis.fetch = original; __resetAaveCacheForTests(); }
});

test('Aave V3 shared loading keeps a surviving subscriber after another cancels', async () => {
  const original = globalThis.fetch;
  __resetAaveCacheForTests();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ data: { markets: [{ address: POOL, chain: { chainId: 1 }, reserves: [{
      underlyingToken: { address: ASSET }, supplyInfo: { apy: { value: '0.03' } }, incentives: [],
    }] }] } }));
  };
  try {
    const controller = new AbortController();
    const cancelled = aaveAdapter.resolve([query()], controller.signal);
    const surviving = aaveAdapter.resolve([query()]);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal((await surviving)[0]?.baseApy, 0.03);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; __resetAaveCacheForTests(); }
});

test('Aave V4/Pro uses wallet risk premiums and effective rewards without leaking another wallet cache', async () => {
  const original = globalThis.fetch;
  __resetAave4CacheForTests();
  const requests: (string | null)[] = [];
  globalThis.fetch = async (_input, init) => {
    const { variables, query: gql } = JSON.parse(String(init?.body));
    assert.match(gql, /userState \{ borrowApy/);
    assert.match(gql, /userEffectiveExtraApy/);
    requests.push(variables.user);
    const eligible = variables.user === USER_A;
    return new Response(JSON.stringify({ data: { reserves: [{
      spoke: { address: POOL, chain: { chainId: 1 } }, asset: { underlying: { address: ASSET } },
      userState: variables.user === USER_A ? { borrowApy: { value: '0.055' } } : null,
      summary: {
        supplyApy: { value: '0.03' }, borrowApy: { value: '0.04' }, rewards: [
          { __typename: 'MerklSupplyReward', userEligible: eligible, extraApy: { value: '0.09' }, userEffectiveExtraApy: eligible ? { value: '0.02' } : null },
          { __typename: 'MerklBorrowReward', userEligible: eligible, discountApy: { value: '0.07' }, userEffectiveDiscountApy: eligible ? { value: '0.01' } : null },
        ],
      },
    }] } }));
  };
  try {
    const rates = await aave4Adapter.resolve([
      query({ userAddress: USER_A }), query({ userAddress: USER_A, leg: 'borrow' }),
      query({ userAddress: USER_B }), query({ userAddress: USER_B, leg: 'borrow' }),
      query(), query({ leg: 'borrow' }),
    ]);
    assert.deepEqual(rates.map((r) => r?.baseApy), [0.03, 0.055, 0.03, null, 0.03, 0.04]);
    assert.deepEqual(rates.map((r) => r?.rewardApr), [0.02, 0.01, 0, 0, null, null]);
    assert.deepEqual(rates.map((r) => r?.rewardState), ['numeric-known', 'numeric-known', 'confirmed-zero', 'confirmed-zero', 'unknown', 'unknown']);
    assert.equal(rates[0]?.rewardComponents?.[0].rateKind, 'apy');
    await aave4Adapter.resolve([query({ userAddress: USER_A }), query({ userAddress: USER_B })]);
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = original; __resetAave4CacheForTests(); }
});

test('Aave V4 resolves same-spoke same-token Hub reserves by the active wallet leg, never by response order', async () => {
  const original = globalThis.fetch;
  __resetAave4CacheForTests();
  globalThis.fetch = async (_input, init) => {
    const { variables, query: gql } = JSON.parse(String(init?.body));
    if (variables.user) assert.match(gql, /userSupplies\(request:/);
    const rows = ['hub-a', 'hub-b'].map((id, i) => ({
      id, spoke: { address: POOL, chain: { chainId: 1 } }, asset: { underlying: { address: ASSET } },
      userState: { borrowApy: { value: i === 0 ? '0.06' : '0.21' } },
      summary: { supplyApy: { value: i === 0 ? '0.03' : '0.18' }, rewards: [] },
    }));
    return new Response(JSON.stringify({ data: {
      reserves: rows,
      userSupplies: variables.user === USER_A ? [{ reserve: { id: 'hub-a' } }]
        : variables.user === USER_B ? rows.map(({ id }) => ({ reserve: { id } })) : [],
      userBorrows: variables.user === USER_A ? [{ reserve: { id: 'hub-b' } }] : [],
    } }));
  };
  try {
    const rates = await aave4Adapter.resolve([
      query(), query({ userAddress: USER_A }), query({ userAddress: USER_A, leg: 'borrow' }),
      query({ userAddress: USER_B }), query({ userAddress: USER_B, leg: 'borrow' }),
    ]);
    assert.deepEqual(rates.map((r) => r?.baseApy ?? null), [null, 0.03, 0.21, null, null]);
  } finally { globalThis.fetch = original; __resetAave4CacheForTests(); }
});
