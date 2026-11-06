import assert from 'node:assert/strict';
import test from 'node:test';
import { __resetMerklCachesForTests } from '../utils/adapters/merkl';
import {
  __resetMorphoCacheForTests,
  morphoAdapter,
  parseMorphoNativeRewards,
} from '../utils/adapters/morpho';
import type { LegQuery } from '../utils/adapters/types';

const USER = '0x000000000000000000000000000000000000f002';
const USDE = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const BASE_MARKET = '0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354';
const HOOD_MARKET = '0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6';
const DECOY_MARKET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REWARD = '0x6ff492ec3bb2af03eab5a5765383c3451bf744e2';

function marketPosition(marketId: string, loanAsset: string, collateralAsset: string, collateralUsd = 1_000) {
  return {
    market: {
      marketId,
      loanAsset: { address: loanAsset },
      collateralAsset: { address: collateralAsset },
      state: {
        supplyApy: 0.05,
        borrowApy: 0.06,
        supplyAssetsUsd: 10_000,
        borrowAssetsUsd: 4_000,
        liquidityAssetsUsd: 6_000,
        rewards: [{ id: `${marketId}:native`, asset: { address: REWARD }, supplyApr: 0.02, borrowApr: 0.01 }],
      },
    },
    state: { supplyAssetsUsd: 0, borrowAssetsUsd: 900, collateralUsd },
  };
}

function userPayload(chainId: number) {
  const positions = chainId === 8453
    ? [marketPosition(BASE_MARKET, USDC, USDE), marketPosition(DECOY_MARKET, USDG, USDE)]
    : [marketPosition(HOOD_MARKET, USDG, USDE)];
  return {
    data: {
      userByAddress: {
        marketPositions: positions,
        vaultPositions: [],
        vaultV2Positions: [],
      },
    },
  };
}

function merklOpportunity(chainId: number, marketId: string, apr: number) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: `${chainId}:${marketId}`,
    chainId,
    protocol: { id: 'morpho' },
    type: 'MORPHOCOLLATERAL',
    action: 'LEND',
    identifier: marketId.slice(0, 42),
    status: 'LIVE',
    apr,
    depositUrl: `https://app.morpho.org/chain/market/${marketId}`,
    earliestCampaignStart: String(now - 60),
    latestCampaignEnd: String(now + 3_600),
    tokens: [{ address: USDE }],
    aprRecord: {
      timestamp: String(now),
      breakdowns: [{ identifier: `campaign:${marketId}`, type: 'CAMPAIGN', value: apr }],
    },
    rewardsRecord: {
      breakdowns: [{ onChainCampaignId: `campaign:${marketId}`, token: { address: REWARD } }],
    },
  };
}

function lendingQuery(chainId: number, marketId: string, loanAsset: string, leg: 'supply' | 'borrow'): LegQuery {
  return {
    chainId,
    address: leg === 'supply' ? USDE : loanAsset,
    leg,
    itemHasBorrows: true,
    userAddress: USER,
    protocolId: `${chainId === 8453 ? 'base' : 'hood'}_morphoblue`,
    itemAdapterId: 'morpho_blue_lending2',
    itemPoolId: chainId === 8453
      ? '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      : '0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010',
    positionKey: `${chainId}:morpho:${marketId}`,
    itemSupplyAddresses: [USDE],
    itemBorrowAddresses: [loanAsset],
  };
}

test('Morpho attaches Base and Robinhood collateral rewards only to their exact active markets', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('blue-api.morpho.org')) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const chainId = body.query.includes('chainId: 4663') ? 4663 : 8453;
      return new Response(JSON.stringify(userPayload(chainId)), { status: 200 });
    }
    const chainId = new URL(url).searchParams.get('chainId') === '4663' ? 4663 : 8453;
    const rows = chainId === 4663
      ? [merklOpportunity(4663, HOOD_MARKET, 4.5)]
      : [merklOpportunity(8453, BASE_MARKET, 4.5), merklOpportunity(8453, DECOY_MARKET, 9)];
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;

  try {
    const queries = [
      lendingQuery(8453, BASE_MARKET, USDC, 'supply'),
      lendingQuery(8453, BASE_MARKET, USDC, 'borrow'),
      lendingQuery(4663, HOOD_MARKET, USDG, 'supply'),
    ];
    const [baseCollateral, baseBorrow, hoodCollateral] = await morphoAdapter.resolve(queries);

    assert.equal(baseCollateral?.baseApy, 0);
    assert.equal(baseCollateral?.rewardApr, 0.045);
    assert.equal(baseCollateral?.rewardState, 'numeric-known');
    assert.equal(baseCollateral?.rewardComponents?.[0]?.basis, 'collateral');
    assert.equal(baseCollateral?.rewardComponents?.length, 1);
    assert.deepEqual(baseCollateral?.rewardEntitlements ?? [], []);
    assert.equal(baseCollateral?.poolStat, undefined);

    assert.equal(baseBorrow?.baseApy, 0.06);
    assert.equal(baseBorrow?.rewardApr, 0.01);
    assert.equal(baseBorrow?.rewardState, 'numeric-known');
    assert.equal(baseBorrow?.rewardComponents?.[0]?.basis, 'borrow');
    assert.equal(baseBorrow?.poolStat, undefined);

    assert.equal(hoodCollateral?.baseApy, 0);
    assert.equal(hoodCollateral?.rewardApr, 0.045);
    assert.equal(hoodCollateral?.rewardState, 'numeric-known');
    assert.deepEqual(hoodCollateral?.rewardEntitlements ?? [], []);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});
test('Morpho preserves known collateral base when Merkl fails and marks reward unknown', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('blue-api.morpho.org')) {
      return new Response(JSON.stringify(userPayload(8453)), { status: 200 });
    }
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch;

  try {
    const [result] = await morphoAdapter.resolve([lendingQuery(8453, BASE_MARKET, USDC, 'supply')]);
    assert.equal(result?.baseApy, 0);
    assert.equal(result?.rewardApr, null);
    assert.equal(result?.rewardState, 'unknown');
    assert.deepEqual(result?.rewardComponents, []);
    assert.deepEqual(result?.rewardEntitlements ?? [], []);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('Morpho marks collateral reward zero when the complete LIVE Merkl snapshot has no exact market', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('blue-api.morpho.org')) {
      return new Response(JSON.stringify(userPayload(8453)), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;

  try {
    const [result] = await morphoAdapter.resolve([lendingQuery(8453, BASE_MARKET, USDC, 'supply')]);
    assert.equal(result?.baseApy, 0);
    assert.equal(result?.rewardApr, 0);
    assert.equal(result?.rewardState, 'confirmed-zero');
    assert.deepEqual(result?.rewardComponents, []);
    assert.match(result?.source ?? '', /merkl:complete/);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('Morpho keeps market, Vault V1 and Vault V2 positions separate even for the same asset', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const V1 = '0x1111111111111111111111111111111111111111';
  const V2 = '0x2222222222222222222222222222222222222222';
  const MARKET = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const originalFetch = globalThis.fetch;
  let lastBody = '';
  globalThis.fetch = (async (input, init) => {
    assert.ok(String(input).includes('blue-api.morpho.org'), 'non-collateral positions must not query Merkl');
    lastBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(JSON.stringify({
      data: {
        userByAddress: {
          marketPositions: [{
            market: {
              marketId: MARKET,
              loanAsset: { address: USDC },
              collateralAsset: { address: USDE },
              state: {
                supplyApy: 0.01,
                borrowApy: 0.02,
                supplyAssetsUsd: 1_000,
                borrowAssetsUsd: 400,
                liquidityAssetsUsd: 600,
                rewards: [{ id: 'market-reward', asset: { address: REWARD }, supplyApr: 0.005, borrowApr: 0 }],
              },
            },
            state: { supplyAssetsUsd: 100, borrowAssetsUsd: 0, collateralUsd: 0 },
          }],
          vaultPositions: [{
            vault: {
              address: V1,
              asset: { address: USDC },
              state: {
                apy: 0.03,
                netApy: 0.05,
                netApyExcludingRewards: 0.03,
                totalAssetsUsd: 2_000,
                allRewards: [{ asset: { address: REWARD }, supplyApr: 0.02 }],
              },
              liquidity: { usd: 1_500 },
            },
            state: { assetsUsd: 200 },
          }],
          vaultV2Positions: [{
            vault: {
              address: V2,
              asset: { address: USDC },
              apy: 0.04,
              netApy: 0.07,
              netApyExcludingRewards: 0.04,
              totalAssetsUsd: 3_000,
              rewards: [{ asset: { address: REWARD }, supplyApr: 0.03 }],
            },
            assetsUsd: 300,
          }],
        },
      },
    }), { status: 200 });
  }) as typeof fetch;

  const marketQuery: LegQuery = {
    chainId: 1,
    address: USDC,
    leg: 'supply',
    itemHasBorrows: false,
    userAddress: USER,
    itemAdapterId: 'morpho_blue_supply',
    itemPoolId: MARKET,
    itemSupplyAddresses: [USDC],
    itemBorrowAddresses: [],
  };
  const vault = (address: string, generation: 1 | 2): LegQuery => ({
    chainId: 1,
    address: USDC,
    leg: 'supply',
    itemHasBorrows: false,
    userAddress: USER,
    itemAdapterId: `morpho_vault_v${generation}`,
    itemPoolId: address,
    itemSupplyAddresses: [USDC],
    itemBorrowAddresses: [],
  });

  try {
    const [market, v1, v2] = await morphoAdapter.resolve([marketQuery, vault(V1, 1), vault(V2, 2)]);
    assert.deepEqual([market?.baseApy, market?.rewardApr], [0.01, 0.005]);
    assert.deepEqual([v1?.baseApy, v1?.rewardApr], [0.03, 0.02]);
    assert.deepEqual([v2?.baseApy, v2?.rewardApr], [0.04, 0.03]);
    assert.deepEqual(market?.poolStat, {
      total: 1_000,
      available: 600,
      unit: 'usd',
      source: 'morpho-api',
    });
    assert.deepEqual(v1?.poolStat, {
      total: 2_000,
      available: 1_500,
      unit: 'usd',
      source: 'morpho-api',
    });
    assert.deepEqual(v2?.poolStat, {
      total: 3_000,
      available: null, // VaultV2 无 liquidity{usd} 子结构(2026-07-12 服务端 400 实证),即时可提未知
      unit: 'usd',
      source: 'morpho-api',
    });
    assert.notEqual(v1?.rewardComponents?.[0]?.id, v2?.rewardComponents?.[0]?.id);
    // schema 回归钉(2026-07-12 事故):VaultV2 无 state 子对象、liquidity 为标量——
    // 查询里 vaultV2Positions 块若再出现子选择,整个 userByAddress 会被服务端 400,全腿未匹配
    const v2Block = String(lastBody).slice(String(lastBody).indexOf('vaultV2Positions'));
    assert.ok(!v2Block.includes('state {'), 'vaultV2 查询块不得包含 state 子选择');
    assert.ok(!v2Block.includes('liquidity {'), 'vaultV2 查询块不得包含 liquidity 子选择');
    assert.ok(v2Block.includes('totalAssetsUsd'), 'vaultV2 查询块必须用平铺 totalAssetsUsd');
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('Morpho resolves a Blue deposit proxy from its exact proxy and market position index', async () => {
  __resetMorphoCacheForTests();
  const proxy = '0x3333333333333333333333333333333333333333';
  const marketId = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const rawPosition = marketPosition(marketId, USDC, USDE);
  rawPosition.state = { supplyAssetsUsd: 500, borrowAssetsUsd: 0, collateralUsd: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(String(input).includes('blue-api.morpho.org'));
    const query = JSON.parse(String(init?.body)).query as string;
    const belongsToProxy = query.toLowerCase().includes(proxy);
    return new Response(JSON.stringify({
      data: {
        userByAddress: {
          marketPositions: belongsToProxy ? [rawPosition] : [],
          vaultPositions: [],
          vaultV2Positions: [],
        },
      },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const query: LegQuery = {
      chainId: 8453,
      address: USDC,
      leg: 'supply',
      itemHasBorrows: false,
      userAddress: USER,
      protocolId: 'base_morphoblue',
      itemAdapterId: 'morpho_blue_deposit',
      itemPoolId: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:deposit',
      positionIndex: `${proxy}:${marketId}`,
      itemSupplyAddresses: [USDC],
      itemBorrowAddresses: [],
    };
    const [result, wrongMarket, malformedIndex] = await morphoAdapter.resolve([
      query,
      { ...query, positionIndex: `${proxy}:${'0x' + 'd'.repeat(64)}` },
      { ...query, positionIndex: proxy },
    ]);
    assert.equal(result?.baseApy, 0.05);
    assert.equal(result?.rewardApr, 0.02);
    assert.equal(result?.rewardState, 'numeric-known');
    assert.equal(result?.source, 'morpho-api:market');
    assert.equal(wrongMarket, null);
    assert.equal(malformedIndex, null);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
  }
});

test('Morpho resolves a direct Ethereum Blue deposit by wallet and exact market ID', async () => {
  __resetMorphoCacheForTests();
  const wallet = '0x1111111111111111111111111111111111111111';
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const marketId = '0x' + 'e'.repeat(64);
  const direct = marketPosition(marketId, usdc, USDE);
  direct.state = { supplyAssetsUsd: 301_674, borrowAssetsUsd: 0, collateralUsd: 0 };
  direct.market.state.supplyApy = 0.0698;
  direct.market.state.rewards = [];
  const originalFetch = globalThis.fetch;
  const queriedOwners: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.ok(String(input).includes('blue-api.morpho.org'));
    const gql = JSON.parse(String(init?.body)).query as string;
    queriedOwners.push(gql);
    return new Response(JSON.stringify({ data: {
      userByAddress: {
        marketPositions: gql.includes(wallet) ? [direct] : [],
        vaultPositions: [], vaultV2Positions: [],
      },
    } }));
  }) as typeof fetch;

  try {
    const query: LegQuery = {
      chainId: 1, address: usdc, leg: 'supply', itemHasBorrows: false,
      userAddress: wallet, protocolId: 'morphoblue',
      itemAdapterId: 'morpho_blue_deposit',
      itemPoolId: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:deposit',
      positionIndex: marketId,
      itemSupplyAddresses: [usdc], itemBorrowAddresses: [],
    };
    const [result, otherMarket, wrongAsset, malformed] = await morphoAdapter.resolve([
      query,
      { ...query, positionIndex: '0x' + 'f'.repeat(64) },
      { ...query, address: USDE },
      { ...query, positionIndex: wallet },
    ]);
    assert.equal(queriedOwners.length, 1);
    assert.match(queriedOwners[0], new RegExp(wallet));
    assert.equal(result?.baseApy, 0.0698);
    assert.equal(result?.rewardApr, 0);
    assert.equal(result?.rewardState, 'confirmed-zero');
    assert.equal(result?.source, 'morpho-api:market');
    assert.equal(otherMarket, null);
    assert.equal(wrongAsset, null);
    assert.equal(malformed, null);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
  }
});

test('Morpho resolves distinct Midnight yield positions by their exact market IDs', async () => {
  __resetMorphoCacheForTests();
  const first = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  const second = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/v0/midnight/users/')) {
      return new Response(JSON.stringify({
        cursor: null,
        data: [
          { chain_id: 8453, market_id: first, user_address: USER, loan_token: USDC,
            type: 'lend', credit: '100000000', maturity: 4102444800,
            effective_rate_wad: '60000000000000000' },
          { chain_id: 8453, market_id: second, user_address: USER, loan_token: USDC,
            type: 'lend', credit: '200000000', maturity: 4102444800,
            effective_rate_wad: '70000000000000000' },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: { userByAddress: { marketPositions: [], vaultPositions: [], vaultV2Positions: [] } },
    }), { status: 200 });
  }) as typeof fetch;

  const midnightQuery = (positionIndex: string): LegQuery => ({
    chainId: 8453,
    address: USDC,
    leg: 'supply',
    itemHasBorrows: false,
    userAddress: USER,
    protocolId: 'base_morphoblue',
    itemAdapterId: 'morpho_midnight_yield',
    itemPoolId: '0xadedd8ab6de832766fedf0fac4992e5c4d3ea18a:yield',
    positionIndex,
    itemSupplyAddresses: [USDC],
    itemBorrowAddresses: [],
  });

  try {
    const [a, b, wrongAsset] = await morphoAdapter.resolve([
      midnightQuery(first),
      midnightQuery(second),
      { ...midnightQuery(first), address: USDE },
    ]);
    assert.equal(a?.baseApy, 0.06);
    assert.equal(b?.baseApy, 0.07);
    assert.equal(a?.rewardState, 'not-applicable');
    assert.equal(b?.rewardState, 'not-applicable');
    assert.equal(wrongAsset, null);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
  }
});

test('Morpho Midnight does not publish a rate from an incomplete positions page', async () => {
  __resetMorphoCacheForTests();
  const id = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls > 1) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({ cursor: 'next-page', data: [{
      chain_id: 8453, market_id: id, user_address: USER, loan_token: USDC,
      type: 'lend', credit: '100000000', maturity: 4102444800,
      effective_rate_wad: '60000000000000000',
    }] }), { status: 200 });
  }) as typeof fetch;
  console.warn = () => undefined;

  try {
    const [result] = await morphoAdapter.resolve([{
      chainId: 8453, address: USDC, leg: 'supply', itemHasBorrows: false,
      userAddress: USER, itemAdapterId: 'morpho_midnight_yield',
      itemPoolId: '0xadedd8ab6de832766fedf0fac4992e5c4d3ea18a:yield',
      positionIndex: id,
    }]);
    assert.equal(result, null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    __resetMorphoCacheForTests();
  }
});

test('Morpho preserves valid native reward components when a sibling row is malformed', () => {
  const result = parseMorphoNativeRewards(
    [
      { id: 'valid', asset: { address: REWARD }, supplyApr: 0.02, borrowApr: 0 },
      null,
      { id: 'valid', asset: { address: REWARD }, supplyApr: 0.03, borrowApr: 0 },
    ],
    'market:test',
    'supply',
    'supplyApr',
  );
  assert.equal(result.rewardApr, 0.02);
  assert.equal(result.rewardState, 'unknown');
  assert.equal(result.rewardComponents.length, 1);
});
