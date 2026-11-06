import assert from 'node:assert/strict';
import test from 'node:test';

import { __resetMerklCachesForTests } from '../utils/adapters/merkl.ts';
import { __resetMorphoCacheForTests } from '../utils/adapters/morpho.ts';
import { __resetListaCacheForTests } from '../utils/adapters/onchain.ts';
import { enrichPayload, lpIncentiveCoverageIssues, resolveLpCard } from '../utils/enrich.ts';
import type { ProtocolPosition } from '../utils/debank.ts';
import { DEBANK_INPUT_LIMITS } from '../utils/input-limits.ts';
import type { LpRange } from '../utils/uniswap.ts';

const USER = '0x000000000000000000000000000000000000f002';
const USDE = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const REWARD = '0x6ff492ec3bb2af03eab5a5765383c3451bf744e2';
const SUSDF = '0xc8cf6d7991f15525488b2a83df53468d682ba4b0';
const BASE_MARKET = '0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354';
const HOOD_MARKET = '0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6';
const OTHER_MARKET = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const AAVE_ASSET = '0x00000000000000000000000000000000000000a1';
const AAVE_MARKET = '0x0000000000000000000000000000000000000011';
const MONAD_USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const MONAD_VAULT = '0x78999cc96d2ba0341588c60ccb0e91c6c33cf371';
const STABLE_USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const STABLE_VAULT = '0xb7df8db22a5dbbfa9ebeb94b3910aec6a4f05c08';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DOLOMITE_POSITION_INDEX =
  '0x4992b11a44ccdae37936da8098afd86427bad833_' + '9'.repeat(77);

const token = (chain: string, address: string, symbol: string, amount: number) => ({
  id: address,
  chain,
  symbol,
  optimized_symbol: symbol,
  amount,
  price: 1,
  decimals: 18,
});

function project(chain: 'base' | 'hood', loan: string) {
  return {
    id: `${chain}_morphoblue`,
    chain,
    name: `Morpho ${chain}`,
    portfolio_item_list: [{
      name: 'Lending',
      pool: {
        id: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        adapter_id: 'morpho_blue_lending2',
      },
      stats: { net_usd_value: 500 },
      detail: {
        supply_token_list: [token(chain, USDE, 'USDe', 1_000)],
        borrow_token_list: [token(chain, loan, loan === USDC ? 'USDC' : 'USDG', 500)],
        reward_token_list: [],
      },
    }],
  };
}

function marketPosition(marketId: string, loanAsset: string) {
  return {
    market: {
      marketId,
      loanAsset: { address: loanAsset },
      collateralAsset: { address: USDE },
      state: {
        supplyApy: 0.05,
        borrowApy: 0.06,
        rewards: [{ id: `${marketId}:native`, asset: { address: REWARD }, supplyApr: 0, borrowApr: 0.01 }],
      },
    },
    state: { supplyAssetsUsd: 0, borrowAssetsUsd: 500, collateralUsd: 1_000 },
  };
}

function morphoUserPayload(chainId: number) {
  const position = chainId === 4663
    ? marketPosition(HOOD_MARKET, USDG)
    : marketPosition(BASE_MARKET, USDC);
  return { data: { userByAddress: { marketPositions: [position], vaultPositions: [], vaultV2Positions: [] } } };
}

function merklOpportunity(chainId: number, marketId: string) {
  const now = Math.floor(Date.now() / 1_000);
  const campaign = `campaign:${marketId}`;
  return {
    id: `${chainId}:${marketId}`,
    chainId,
    protocol: { id: 'morpho' },
    type: 'MORPHOCOLLATERAL',
    action: 'LEND',
    identifier: marketId,
    status: 'LIVE',
    apr: 4.5,
    depositUrl: `https://app.morpho.org/chain/market/${marketId}`,
    earliestCampaignStart: String(now - 60),
    latestCampaignEnd: String(now + 3_600),
    tokens: [{ address: USDE }],
    aprRecord: { timestamp: String(now), breakdowns: [{ identifier: campaign, type: 'CAMPAIGN', value: 4.5 }] },
    rewardsRecord: { breakdowns: [{ onChainCampaignId: campaign, token: { address: REWARD, symbol: 'RWD' } }] },
  };
}

test('real enrichment core routes Base and Robinhood DeBank payloads through Morpho to item, protocol, and portfolio', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('blue-api.morpho.org')) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      return new Response(JSON.stringify(morphoUserPayload(body.query.includes('chainId: 4663') ? 4663 : 8453)));
    }
    if (url.includes('/v4/opportunities')) {
      const chainId = Number(new URL(url).searchParams.get('chainId'));
      return new Response(JSON.stringify([
        merklOpportunity(chainId, chainId === 4663 ? HOOD_MARKET : BASE_MARKET),
      ]));
    }
    if (url.includes('/v4/users/')) return new Response('[]');
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const result = await enrichPayload({ data: [project('base', USDC), project('hood', USDG)] }, USER);
    for (const key of ['base:base_morphoblue', 'hood:hood_morphoblue']) {
      const card = result.cards.find((candidate) => candidate.key === key);
      assert.ok(card);
      const protocolCollateral = card.yield.assets.find((asset) => asset.leg === 'supply');
      const itemCollateral = card.items[0]?.yield.assets.find((asset) => asset.leg === 'supply');
      assert.equal(protocolCollateral?.baseApy, 0);
      assert.equal(protocolCollateral?.rewardApr, 0.045);
      assert.equal(protocolCollateral?.rewardState, 'numeric-known');
      assert.deepEqual(protocolCollateral?.rewardEntitlements ?? [], []);
      assert.equal(itemCollateral?.rewardApr, 0.045);
      assert.equal(card.yield.rewardCoverageComplete, true);
      assert.notEqual(card.yield.netApy, null);
    }
    assert.equal(result.summary?.rewardCoverageComplete, true);
    assert.equal(result.summary?.rateCoverageComplete, true);
    assert.ok((result.summary?.knownEstDailyUsd ?? 0) > 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('Base Morpho deposit proxy and Midnight yield items produce a complete protocol APY', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const proxy = '0x3333333333333333333333333333333333333333';
  const blueMarket = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const midnightMarkets = [
    '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ];
  const item = (name: string, poolId: string, adapterId: string, index: string, amount: number, description?: string) => ({
    name,
    pool: { id: poolId, adapter_id: adapterId },
    position_index: index,
    stats: { net_usd_value: amount },
    detail: {
      description,
      supply_token_list: [token('base', USDC, 'USDC', amount)],
      borrow_token_list: [],
      reward_token_list: [],
    },
  });
  const payload = { data: [{
    id: 'base_morphoblue', chain: 'base', name: 'Morpho',
    portfolio_item_list: [
      item('Deposit', '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:deposit',
        'morpho_blue_deposit', `${proxy}:${blueMarket}`, 1_000),
      ...midnightMarkets.map((id, index) =>
        item('Yield', '0xadedd8ab6de832766fedf0fac4992e5c4d3ea18a:yield',
          'morpho_midnight_yield', id, 200 + index * 100,
          index === 0 ? 'Midnight - Nov 27, 2026' : 'Midnight - Oct 30, 2026')),
    ],
  }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('blue-api.morpho.org')) {
      const query = JSON.parse(String(init?.body)).query as string;
      const marketPositions = query.toLowerCase().includes(proxy) ? [{
        market: {
          marketId: blueMarket,
          loanAsset: { address: USDC },
          collateralAsset: { address: USDE },
          state: { supplyApy: 0.04, borrowApy: 0.05, rewards: [] },
        },
        state: { supplyAssetsUsd: 1_000, borrowAssetsUsd: 0, collateralUsd: 0 },
      }] : [];
      return new Response(JSON.stringify({ data: {
        userByAddress: { marketPositions, vaultPositions: [], vaultV2Positions: [] },
      } }));
    }
    if (url.includes('/v0/midnight/users/')) {
      return new Response(JSON.stringify({ cursor: null, data: midnightMarkets.map((id, index) => ({
        chain_id: 8453, market_id: id, user_address: USER, loan_token: USDC,
        type: 'lend', credit: '200000000', maturity: 4102444800,
        effective_rate_wad: index === 0 ? '60000000000000000' : '70000000000000000',
      })) }));
    }
    if (url.includes('/v4/users/')) return new Response('[]');
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const result = await enrichPayload(payload, USER);
    const card = result.cards.find((candidate) => candidate.key === 'base:base_morphoblue');
    assert.ok(card);
    assert.equal(card.items.length, 3);
    assert.deepEqual(card.items.map((item) => item.displayName), [
      undefined, 'Midnight - Nov 27, 2026', 'Midnight - Oct 30, 2026',
    ]);
    assert.deepEqual(card.yield.assets.map((asset) => asset.baseApy), [0.04, 0.06, 0.07]);
    assert.equal(card.yield.rateCoverageComplete, true);
    assert.equal(card.yield.rewardCoverageComplete, true);
    assert.ok(card.yield.netApy !== null);
    assert.equal(result.coverageIssues?.some((issue) => issue.id === 'protocol:base:base_morphoblue'), false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('Ethereum Morpho direct Blue deposit clears protocol and portfolio coverage gaps', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const wallet = '0x1111111111111111111111111111111111111111';
  const marketId = '0x' + 'e'.repeat(64);
  const amount = 301_674;
  const payload = { data: [{
    id: 'morphoblue', chain: 'eth', name: 'Morpho',
    portfolio_item_list: [{
      name: 'Deposit',
      pool: { id: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:deposit', adapter_id: 'morpho_blue_deposit' },
      position_index: marketId,
      stats: { net_usd_value: amount },
      detail: {
        supply_token_list: [token('eth', ETH_USDC, 'USDC', amount)],
        borrow_token_list: [], reward_token_list: [],
      },
    }],
  }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('blue-api.morpho.org')) {
      const gql = JSON.parse(String(init?.body)).query as string;
      assert.match(gql, new RegExp(wallet));
      return new Response(JSON.stringify({ data: { userByAddress: {
        marketPositions: [{
          market: { marketId, loanAsset: { address: ETH_USDC }, collateralAsset: { address: USDE },
            state: { supplyApy: 0.0698, borrowApy: 0.08, rewards: [] } },
          state: { supplyAssetsUsd: amount, borrowAssetsUsd: 0, collateralUsd: 0 },
        }],
        vaultPositions: [], vaultV2Positions: [],
      } } }));
    }
    if (url.includes('/v4/users/')) return new Response('[]');
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const result = await enrichPayload(payload, wallet);
    const card = result.cards.find((candidate) => candidate.key === 'eth:morphoblue');
    assert.ok(card);
    assert.equal(card.items.length, 1);
    assert.equal(card.yield.assets[0]?.baseApy, 0.0698);
    assert.equal(card.yield.assets[0]?.rewardState, 'confirmed-zero');
    assert.equal(card.yield.rateCoverageComplete, true);
    assert.equal(card.yield.rewardCoverageComplete, true);
    assert.equal(card.yield.netApy, 0.0698);
    assert.equal(result.summary?.rateCoverageComplete, true);
    assert.equal(result.summary?.rewardCoverageComplete, true);
    assert.equal(result.coverageIssues?.some((issue) => issue.id === 'protocol:eth:morphoblue'), false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('late Monad and Stable Morpho V2 vaults survive a 96-project wallet and resolve exact APY', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('blue-api.morpho.org')) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const stable = body.query.includes('chainId: 988');
      const vault = stable ? STABLE_VAULT : MONAD_VAULT;
      const asset = stable ? STABLE_USDT0 : MONAD_USDC;
      const baseApy = stable ? 0.0410012435066905 : 0.0666836309107033;
      const rewardApr = stable ? 0.02681817638528369 : 0.009564810437177221;
      const assetsUsd = stable ? 559_401 : 2_060_549;
      return new Response(JSON.stringify({
        data: {
          userByAddress: {
            marketPositions: [],
            vaultPositions: [],
            vaultV2Positions: [{
              vault: {
                address: vault,
                asset: { address: asset },
                apy: baseApy,
                netApy: baseApy + rewardApr,
                netApyExcludingRewards: baseApy,
                totalAssetsUsd: stable ? 25_875_574 : 64_647_392,
                rewards: [{ asset: { address: vault }, supplyApr: rewardApr }],
              },
              assetsUsd,
            }],
          },
        },
      }));
    }
    if (url.includes('/v4/users/')) return new Response('[]');
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const filler = (index: number) => ({
    id: `eth_unsupported_${index}`,
    chain: 'eth',
    name: 'Unsupported',
    portfolio_item_list: [{
      name: 'Deposit',
      stats: { net_usd_value: 1 },
      detail: {
        supply_token_list: [token('eth', USDC, 'USDC', 1)],
        borrow_token_list: [],
        reward_token_list: [],
      },
    }],
  });
  const vaultProject = (
    chain: 'monad' | 'stable',
    vault: string,
    asset: string,
    amount: number,
  ) => ({
    id: `${chain}_morphoblue`,
    chain,
    name: 'Morpho',
    portfolio_item_list: [{
      name: 'Yield',
      pool: { id: vault, adapter_id: 'redeemable_tokenized_vault_yield' },
      stats: { net_usd_value: amount },
      detail: {
        supply_token_list: [token(chain, asset, chain === 'monad' ? 'USDC' : 'USDT0', amount)],
        borrow_token_list: [],
        reward_token_list: [],
      },
    }],
  });
  const projects = Array.from({ length: 96 }, (_, index) => filler(index));
  projects[77] = vaultProject('monad', MONAD_VAULT, MONAD_USDC, 2_060_549);
  projects[93] = vaultProject('stable', STABLE_VAULT, STABLE_USDT0, 559_401);

  try {
    const result = await enrichPayload({ data: projects }, USER);
    for (const expected of [
      { key: 'monad:monad_morphoblue', baseApy: 0.0666836309107033, rewardApr: 0.009564810437177221 },
      { key: 'stable:stable_morphoblue', baseApy: 0.0410012435066905, rewardApr: 0.02681817638528369 },
    ]) {
      const card = result.cards.find((candidate) => candidate.key === expected.key);
      assert.ok(card);
      const asset = card.items[0]?.yield.assets[0];
      assert.equal(asset?.baseApy, expected.baseApy);
      assert.equal(asset?.rewardApr, expected.rewardApr);
      assert.equal(asset?.rewardState, 'numeric-known');
      assert.equal(card.yield.rateCoverageComplete, true);
      assert.equal(card.yield.rewardCoverageComplete, true);
      assert.notEqual(card.yield.netApy, null);
    }
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('Dolomite resolves a live-shaped composite position identity without input coverage gaps', async () => {
  const originalFetch = globalThis.fetch;
  const supplyApr = 0.031694578639384867;
  const rewardApr = 0.043335849414199066;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('api.dolomite.io/tokens/1/interest-rates')) {
      return new Response(JSON.stringify({
        interestRates: [{
          token: { tokenAddress: ETH_USDC, marketId: '2' },
          supplyInterestRate: String(supplyApr),
          borrowInterestRate: '0.050831065016928000',
          outsideSupplyInterestRateParts: [
            { category: 'rewards', interestRate: '0.000000000000000000' },
            { category: 'rewards', interestRate: String(rewardApr) },
          ],
          outsideBorrowInterestRateParts: [],
        }],
      }));
    }
    return new Response('{}', { status: 503 });
  }) as typeof fetch;

  try {
    const result = await enrichPayload({
      data: [{
        id: 'dolomite',
        chain: 'eth',
        name: 'Dolomite',
        portfolio_item_list: [{
          name: 'Lending',
          position_index: DOLOMITE_POSITION_INDEX,
          pool: {
            id: '0x67567fce98a44745820069c37c395426f1c30ba6',
            adapter_id: 'dolomite_lending',
          },
          stats: { net_usd_value: 300_369.36 },
          detail: {
            supply_token_list: [token('eth', ETH_USDC, 'USDC', 300_129.0675)],
          },
        }],
      }],
    });
    const card = result.cards.find((candidate) => candidate.key === 'eth:dolomite');
    assert.ok(card);
    const asset = card.yield.assets[0];
    assert.equal(result.inputCoverageComplete, true);
    assert.deepEqual(result.inputLimitReasons, []);
    assert.equal(asset?.baseApy, Math.expm1(supplyApr));
    assert.equal(asset?.rewardApr, rewardApr);
    assert.equal(asset?.rewardState, 'numeric-known');
    assert.equal(card.yield.rateCoverageComplete, true);
    assert.equal(card.yield.rewardCoverageComplete, true);
    assert.notEqual(card.yield.netApy, null);
    assert.equal(result.coverageIssues?.some((issue) => issue.id === 'input-coverage'), false);
    assert.equal(result.coverageIssues?.some((issue) => issue.id === 'protocol:eth:dolomite'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('real enrichment core preserves an explicit unknown card when Morpho sources fail', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
  try {
    const result = await enrichPayload({ data: [project('base', USDC)] }, USER);
    const asset = result.cards[0]?.yield.assets[0];
    assert.equal(asset?.baseApy, null);
    assert.equal(asset?.rewardApr, null);
    assert.equal(asset?.rewardState, 'unknown');
    assert.equal(result.cards[0]?.yield.rewardCoverageComplete, false);
    const issue = result.coverageIssues?.find((candidate) => candidate.id === 'protocol:base:base_morphoblue');
    assert.match(issue?.detail ?? '', /Morpho base/);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('supported protocols below $100 net value are skipped before adapter requests', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('dust protocol must not start external work');
  }) as typeof fetch;
  const dust = {
    id: 'bsc_helio',
    chain: 'bsc',
    name: 'Lista DAO',
    portfolio_item_list: [{
      name: 'Yield Pool',
      pool: {
        id: '0xbe87beb6eca39b558ad43c0541471d50d09f3e76',
        adapter_id: 'redeemable_tokenized_vault_yield',
      },
      stats: { net_usd_value: 50 },
      detail: {
        supply_token_list: [token('bsc', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1', 50)],
        borrow_token_list: [],
        reward_token_list: [],
      },
    }],
  };

  try {
    const result = await enrichPayload({ data: [dust] });
    assert.equal(fetches, 0);
    assert.equal(result.cards.length, 0);
    assert.equal(result.coverageIssues?.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('a dust item inside a material protocol is removed before its adapter request and coverage accounting', async () => {
  __resetListaCacheForTests();
  const originalFetch = globalThis.fetch;
  const mainVault = '0xbe87beb6eca39b558ad43c0541471d50d09f3e76';
  const dustVault = '0xeb4f6ffb1038e1cca701e7d53083b37ec5b6ba33';
  let dustTouched = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    dustTouched ||= String(init?.body ?? '').toLowerCase().includes(dustVault.slice(2));
    if (url.includes('api.lista.org/api/moolah/vault/list')) {
      return new Response(JSON.stringify({
        data: {
          list: [
            { address: mainVault, apy: '0.03', emissionApy: '0', marketIds: [] },
            { address: dustVault, apy: '0.04', emissionApy: '0', marketIds: [] },
          ],
        },
      }));
    }
    return new Response('rpc unavailable', { status: 503 });
  }) as typeof fetch;

  const vaultItem = (address: string, symbol: string, amount: number) => ({
    name: 'Yield Pool',
    pool: { id: address, adapter_id: 'redeemable_tokenized_vault_yield' },
    stats: { net_usd_value: amount },
    detail: {
      supply_token_list: [token('bsc', symbol === 'USD1'
        ? '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d'
        : '0x55d398326f99059ff775485246999027b3197955', symbol, amount)],
      borrow_token_list: [],
      reward_token_list: [],
    },
  });

  try {
    const result = await enrichPayload({ data: [{
      id: 'bsc_helio',
      chain: 'bsc',
      name: 'Lista DAO',
      portfolio_item_list: [
        vaultItem(mainVault, 'USD1', 300),
        vaultItem(dustVault, 'USDT', 0.01),
      ],
    }] });
    const card = result.cards.find((candidate) => candidate.key === 'bsc:bsc_helio');
    assert.equal(card?.items.length, 1);
    assert.equal(card?.yield.assets[0]?.token.symbol, 'USD1');
    assert.equal(card?.yield.netApy, 0.03);
    assert.equal(result.coverageIssues?.length, 0);
    assert.equal(dustTouched, false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetListaCacheForTests();
  }
});

test('enrichment preserves supply pool stats and aggregates red liquidity warnings', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /api\.v3\.aave\.com/);
    return new Response(JSON.stringify({
      data: {
        markets: [{
          name: 'Aave fixture',
          address: AAVE_MARKET,
          chain: { chainId: 1 },
          reserves: [{
            underlyingToken: { address: AAVE_ASSET },
            supplyInfo: { apy: { value: '0.03' }, total: { value: 1_000 } },
            borrowInfo: { apy: { value: '0.04' }, availableLiquidity: { usd: 110, usdPerToken: 1 } },
            incentives: [],
          }],
        }],
      },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await enrichPayload({
      data: [{
        id: 'eth_aave3',
        chain: 'eth',
        name: 'Aave V3',
        portfolio_item_list: [{
          name: 'Lending',
          pool: { id: `${AAVE_MARKET}:lending`, adapter_id: 'aave_v3_lending' },
          stats: { net_usd_value: 100 },
          detail: {
            supply_token_list: [token('eth', AAVE_ASSET, 'TEST', 100)],
            borrow_token_list: [],
            reward_token_list: [],
          },
        }],
      }],
    });
    assert.deepEqual(result.cards[0]?.yield.assets[0]?.poolStat, {
      total: 1_000,
      available: 110,
      unit: 'usd',
      source: 'aave-api',
    });
    assert.equal(result.summary?.liquidityRedCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('navigation abort propagates through enrichment to active source requests', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  const sourceSignals: AbortSignal[] = [];
  globalThis.fetch = ((_input, init) => {
    if (init?.signal) sourceSignals.push(init.signal);
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const controller = new AbortController();
  try {
    const request = enrichPayload({ data: [project('base', USDC)] }, USER, controller.signal);
    for (let index = 0; index < 100 && sourceSignals.length === 0; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(sourceSignals.length > 0);
    controller.abort(new DOMException('profile navigation changed', 'AbortError'));
    await assert.rejects(request, /profile navigation changed|abort/i);
    assert.equal(sourceSignals.every((signal) => signal.aborted), true);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('LP whole-card deadline returns an explicit unknown LP card', async () => {
  const p: ProtocolPosition = {
    protocolId: 'base_uniswap3',
    chain: 'base',
    name: 'Uniswap V3',
    itemCoverageComplete: true,
    items: [{
      itemName: 'LP',
      supplies: [{
        address: USDC,
        chain: 'base',
        symbol: 'USDC',
        amount: 200,
        priceUsd: 1,
        usd: 200,
        decimals: 6,
      }],
      borrows: [],
      rewards: [],
      principalInputCoverageComplete: true,
      rewardInputCoverageComplete: true,
      netUsd: 200,
      positionIndex: '42',
    }],
  };
  const card = await resolveLpCard(
    { p, version: 3, family: 'uniswap', incentivePolicy: 'not-applicable' },
    5,
    () => new Promise<Map<string, never>>(() => undefined),
  );
  assert.equal(card.kind, 'lp');
  assert.equal(card.yield.rewardCoverageComplete, true);
  assert.equal(card.yield.rateCoverageComplete, true);
  assert.match(card.yield.flags.join(' '), /手续费收益按策略不估算且不计入组合收益/);
  assert.match(card.yield.flags.join(' '), /超时或失败/);
  assert.equal(card.yield.assets[0]?.source, 'lp-timeout-or-error');
  assert.equal(card.yield.assets[0]?.rewardState, 'not-applicable');
});

test('Uniswap V4 external incentive APY is policy-excluded from status gaps', async () => {
  const p: ProtocolPosition = {
    protocolId: 'eth_uniswap4',
    chain: 'eth',
    name: 'Uniswap V4',
    itemCoverageComplete: true,
    items: [{
      itemName: 'Liquidity Pool',
      supplies: [
        { address: USDE, chain: 'eth', symbol: 'USDe', amount: 100, priceUsd: 1, usd: 100, decimals: 18 },
        { address: USDC, chain: 'eth', symbol: 'USDC', amount: 100, priceUsd: 1, usd: 100, decimals: 6 },
      ],
      borrows: [],
      rewards: [],
      principalInputCoverageComplete: true,
      rewardInputCoverageComplete: true,
      netUsd: 200,
      positionIndex: '339010',
    }],
  };
  const range: LpRange = {
    positionIndex: '339010',
    inRange: true,
    fullRange: false,
    feePct: 0.00005,
    feeApy: null,
    incentiveApr: null,
    incentiveState: 'unknown',
    lowerPrice: 0.9998,
    upperPrice: 1,
    currentPrice: 0.9999,
    pct: 0.5,
    baseSymbol: 'USDe',
    quoteSymbol: 'USDC',
  };
  const card = await resolveLpCard(
    { p, version: 4, family: 'uniswap', incentivePolicy: 'not-applicable' },
    100,
    async () => new Map([['339010', range]]),
  );
  const issues = lpIncentiveCoverageIssues([card]);
  assert.equal(card.yield.rewardCoverageComplete, true);
  assert.equal(card.items[0]?.range?.incentiveState, 'not-applicable');
  assert.deepEqual(issues, []);
});

test('Pancake V3 fee and external incentive APY share the DEX exclusion policy', async () => {
  const p: ProtocolPosition = {
    protocolId: 'base_pancake3',
    chain: 'base',
    name: 'PancakeSwap V3',
    itemCoverageComplete: true,
    items: [{
      itemName: 'Liquidity Pool',
      supplies: [
        { address: USDE, chain: 'base', symbol: 'USDe', amount: 100, priceUsd: 1, usd: 100, decimals: 18 },
        { address: USDC, chain: 'base', symbol: 'USDC', amount: 100, priceUsd: 1, usd: 100, decimals: 6 },
      ],
      borrows: [],
      rewards: [],
      principalInputCoverageComplete: true,
      rewardInputCoverageComplete: true,
      netUsd: 200,
      positionIndex: '7',
    }],
  };
  const range: LpRange = {
    positionIndex: '7',
    inRange: true,
    fullRange: false,
    feePct: 0.0001,
    feeApy: null,
    incentiveApr: null,
    incentiveState: 'unknown',
    lowerPrice: 0.99,
    upperPrice: 1.01,
    currentPrice: 1,
    pct: 0.5,
    baseSymbol: 'USDe',
    quoteSymbol: 'USDC',
  };
  const card = await resolveLpCard(
    { p, version: 3, family: 'pancake', incentivePolicy: 'not-applicable' },
    100,
    async () => new Map([['7', range]]),
  );
  assert.equal(card.yield.rewardCoverageComplete, true);
  assert.equal(card.items[0]?.range?.incentiveState, 'not-applicable');
  assert.deepEqual(lpIncentiveCoverageIssues([card]), []);
});

test('LP value is policy-excluded from APY coverage instead of counted as an uncovered rate', async () => {
  const result = await enrichPayload({
    data: [{
      id: 'base_uniswap3',
      chain: 'base',
      name: 'Uniswap V3',
      portfolio_item_list: [{
        name: 'Liquidity Pool',
        stats: { net_usd_value: 200 },
        detail: {
          supply_token_list: [token('base', USDC, 'USDC', 200)],
          borrow_token_list: [],
          reward_token_list: [],
        },
      }],
    }],
  });
  assert.equal(result.summary?.uncoveredUsd, 0);
  assert.equal(result.summary?.excludedUsd, 200);
  assert.deepEqual(result.coverageIssues, []);
});

test('status gaps preserve the exact LP position alongside protocol and Merkl issues', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
  try {
    const result = await enrichPayload({
      data: [
        {
          id: 'eth_falcon',
          chain: 'eth',
          name: 'Falcon',
          portfolio_item_list: [{
            name: 'Staked',
            stats: { net_usd_value: 1_000 },
            detail: {
              supply_token_list: [token('eth', SUSDF, 'sUSDf', 1_000)],
              borrow_token_list: [],
              reward_token_list: [],
            },
          }],
        },
        {
          id: 'base_uniswap3',
          chain: 'base',
          name: 'Uniswap V3',
          portfolio_item_list: [{
            name: 'Liquidity Pool',
            stats: { net_usd_value: 200 },
            detail: {
              supply_token_list: [token('base', USDC, 'USDC', 200)],
              borrow_token_list: [],
              reward_token_list: [],
            },
          }],
        },
      ],
    }, USER);
    assert.deepEqual(
      result.coverageIssues?.map((issue) => issue.id),
      ['protocol:eth:eth_falcon', 'merkl-claimable'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('adapter query overflow processes a bounded prefix and leaves the suffix explicitly unknown', async () => {
  const queries = DEBANK_INPUT_LIMITS.adapterQueriesPerCard + 2;
  const perItem = 5;
  const items = Array.from({ length: Math.ceil(queries / perItem) }, (_, itemIndex) => ({
    name: `Savings ${itemIndex}`,
    stats: { net_usd_value: perItem * 100 },
    detail: {
      supply_token_list: Array.from({ length: perItem }, (_, legIndex) =>
        token('eth', `asset-${itemIndex}-${legIndex}`, `T${legIndex}`, 100)),
      borrow_token_list: [],
      reward_token_list: [],
    },
  }));
  // Keep the final item short so the project has exactly cap + 2 legs.
  const remainder = queries % perItem;
  if (remainder > 0) items[items.length - 1].detail.supply_token_list.length = remainder;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ stakingYield: { value: 4 } }))) as typeof fetch;
  try {
    const result = await enrichPayload({
      data: [{ id: 'eth_ethena', chain: 'eth', name: 'Ethena', portfolio_item_list: items }],
    });
    const assets = result.cards[0]?.yield.assets ?? [];
    assert.equal(assets.length, queries);
    assert.equal(assets.filter((asset) => asset.source === 'input-limit').length, 2);
    assert.equal(result.inputCoverageComplete, false);
    assert.ok(result.inputLimitReasons?.includes('adapter-query-limit'));
    assert.equal(result.summary?.rewardCoverageComplete, false);
    assert.equal(result.summary?.rateCoverageComplete, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retained items propagate principal and reward input coverage independently', async () => {
  __resetMorphoCacheForTests();
  __resetMerklCachesForTests();
  const originalProject = project('base', USDC);
  const first = originalProject.portfolio_item_list[0];
  const payload = {
    ...originalProject,
    portfolio_item_list: [
      first,
      {
        ...first,
        name: 'Lending with malformed rewards',
        detail: { ...first.detail, reward_token_list: { forged: true } },
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('blue-api.morpho.org')) {
      return new Response(JSON.stringify({
        data: {
          userByAddress: {
            marketPositions: [marketPosition(OTHER_MARKET, USDC)],
            vaultPositions: [],
            vaultV2Positions: [],
          },
        },
      }));
    }
    if (url.includes('/v4/opportunities')) {
      return new Response(JSON.stringify([merklOpportunity(8453, OTHER_MARKET)]));
    }
    if (url.includes('/v4/users/')) return new Response('[]');
    throw new Error(`unexpected URL ${url} ${String(init?.method ?? 'GET')}`);
  }) as typeof fetch;

  try {
    const result = await enrichPayload({ data: [payload] }, USER);
    const card = result.cards[0];
    assert.ok(card);
    assert.equal(card.items.length, 2);
    assert.equal(card.items[0].yield.rateCoverageComplete, true);
    assert.equal(card.items[0].yield.rewardCoverageComplete, true);
    assert.notEqual(card.items[0].yield.netApy, null);
    assert.equal(card.items[1].yield.rateCoverageComplete, true);
    assert.equal(card.items[1].yield.rewardCoverageComplete, false);
    assert.equal(card.items[1].yield.netApy, null);
    assert.equal(card.items[1].yield.estDailyUsd, null);
    assert.notEqual(card.items[1].yield.knownNetApy, null);
    assert.match(card.items[1].yield.flags.join(' '), /奖励腿数据不完整/);
    assert.equal(card.yield.rateCoverageComplete, true);
    assert.equal(card.yield.rewardCoverageComplete, false);
    assert.equal(result.summary?.rateCoverageComplete, true);
    assert.equal(result.summary?.rewardCoverageComplete, false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMorphoCacheForTests();
    __resetMerklCachesForTests();
  }
});

test('a retained item with malformed principal shape loses rate coverage independently', async () => {
  const supply = token('eth', SUSDF, 'sUSDf', 100);
  const item = {
    name: 'Savings',
    stats: { net_usd_value: 100 },
    detail: { supply_token_list: [supply], borrow_token_list: [], reward_token_list: [] },
  };
  const payload = {
    data: [{
      id: 'eth_falcon',
      chain: 'eth',
      name: 'Falcon',
      portfolio_item_list: [
        item,
        { ...item, name: 'Malformed borrow list', detail: { ...item.detail, borrow_token_list: {} } },
      ],
    }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ sUSDf_7d_apy: '0.05' }))) as typeof fetch;
  try {
    const result = await enrichPayload(payload);
    const card = result.cards[0];
    assert.ok(card);
    assert.equal(card.items.length, 2);
    assert.equal(card.items[0].yield.rateCoverageComplete, true);
    assert.equal(card.items[1].yield.assets[0]?.baseApy, 0.05);
    assert.equal(card.items[1].yield.rateCoverageComplete, false);
    assert.equal(card.items[1].yield.netApy, null);
    assert.equal(card.items[1].yield.estDailyUsd, null);
    assert.match(card.items[1].yield.flags.join(' '), /本金腿数据不完整/);
    assert.equal(result.summary?.rateCoverageComplete, false);
    assert.equal(result.summary?.rewardCoverageComplete, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prototype chain names cannot pass the supported-chain boundary', async () => {
  const forgedProjects = ['__proto__', 'constructor'].map((chain) => ({
    ...project('base', USDC),
    id: 'eth_ethena',
    chain,
  }));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('prototype chain must not start external work');
  }) as typeof fetch;
  try {
    const result = await enrichPayload({ data: forgedProjects });
    assert.deepEqual(result.cards, []);
    assert.equal(result.skippedProtocols, 2);
    assert.equal(result.inputCoverageComplete, true);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
