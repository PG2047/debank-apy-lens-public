import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __resetAave4CacheForTests, aave4Adapter } from '../utils/adapters/aave4.ts';
import { makeLlamaAdapter } from '../utils/adapters/defillama.ts';
import { composeListaVaultRates, listaAdapter } from '../utils/adapters/lista.ts';
import {
  fluidOfficial,
  parseFluidRewards,
  sparkOfficial,
  venusOfficial,
  withFallback,
} from '../utils/adapters/official.ts';
import {
  __resetListaCacheForTests,
  annualizeDailyGrowth,
  selectMoolahMarketIdByPosition,
} from '../utils/adapters/onchain.ts';
import type { LegQuery, ProtocolAdapter } from '../utils/adapters/types.ts';

const ASSET = '0x00000000000000000000000000000000000000a1';
const ASSET_2 = '0x00000000000000000000000000000000000000a2';
const FTOKEN = '0x00000000000000000000000000000000000000f1';
const FLUID_VAULT = '0x00000000000000000000000000000000000000d1';
const FLUID_VAULT_2 = '0x00000000000000000000000000000000000000d2';
const FLUID_VAULT_3 = '0x00000000000000000000000000000000000000d3';
const FLUID_VAULT_4 = '0x00000000000000000000000000000000000000d4';

function query(overrides: Partial<LegQuery> = {}): LegQuery {
  return {
    chainId: 1,
    address: ASSET,
    leg: 'supply',
    itemHasBorrows: false,
    ...overrides,
  };
}

test('withFallback fills missing base and reward components independently', async () => {
  const primary: ProtocolAdapter = {
    name: 'primary',
    matches: () => true,
    async resolve() {
      return [
        {
          baseApy: 0.03,
          rewardApr: null,
          rewardState: 'unknown',
          source: 'primary',
        },
        {
          baseApy: null,
          rewardApr: 0.02,
          rewardState: 'numeric-known',
          rewardComponents: [
            { id: 'primary-reward', value: 0.02, rateKind: 'apr', source: 'primary', basis: 'supply' },
          ],
          source: 'primary',
        },
      ];
    },
  };
  const fallback: ProtocolAdapter = {
    name: 'fallback',
    matches: () => true,
    async resolve() {
      return [
        {
          baseApy: 0.01,
          rewardApr: 0.04,
          rewardState: 'numeric-known',
          rewardComponents: [
            { id: 'fallback-reward', value: 0.04, rateKind: 'apr', source: 'fallback', basis: 'supply' },
          ],
          source: 'fallback',
        },
        {
          baseApy: 0.05,
          rewardApr: 0.07,
          rewardState: 'numeric-known',
          rewardComponents: [
            { id: 'other-reward', value: 0.07, rateKind: 'apr', source: 'fallback', basis: 'supply' },
          ],
          source: 'fallback',
        },
      ];
    },
  };

  const result = await withFallback(primary, fallback).resolve([query(), query()]);
  assert.equal(result[0]?.baseApy, 0.03);
  assert.equal(result[0]?.rewardApr, 0.04);
  assert.equal(result[0]?.rewardState, 'numeric-known');
  assert.deepEqual(result[0]?.rewardComponents?.map((c) => c.id), ['fallback-reward']);
  assert.equal(result[1]?.baseApy, 0.05);
  assert.equal(result[1]?.rewardApr, 0.02);
  assert.deepEqual(result[1]?.rewardComponents?.map((c) => c.id), ['primary-reward']);
});

test('DeFiLlama missing reward fields stay unknown while numeric rewards stay known', async () => {
  const originalFetch = globalThis.fetch;
  let project = 'unit4-missing-reward';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/lendBorrow')) {
      return new Response(JSON.stringify([
        {
          pool: `${project}-pool`,
          borrowable: true,
          apyBaseBorrow: null,
          apyRewardBorrow: 3,
        },
      ]));
    }
    return new Response(
      JSON.stringify({
        data: [
          {
            project,
            chain: 'Ethereum',
            underlyingTokens: [ASSET],
            pool: `${project}-pool`,
            poolMeta: null,
            apyBase: 5,
            ...(project.includes('known') ? { apyReward: 2 } : {}),
          },
        ],
      }),
    );
  };

  try {
    const missing = makeLlamaAdapter({
      name: project,
      idPattern: /unit4-missing/,
      lendProjects: [],
      savingsProjects: [project],
    });
    const [unknown] = await missing.resolve([query()]);
    assert.equal(unknown?.baseApy, 0.05);
    assert.equal(unknown?.rewardApr, null);
    assert.equal(unknown?.rewardState, 'unknown');

    project = 'unit4-known-reward';
    const known = makeLlamaAdapter({
      name: project,
      idPattern: /unit4-known/,
      lendProjects: [],
      savingsProjects: [project],
    });
    const [numeric] = await known.resolve([query()]);
    assert.equal(numeric?.rewardApr, 0.02);
    assert.equal(numeric?.rewardState, 'numeric-known');
    assert.equal(numeric?.rewardComponents?.[0]?.value, 0.02);
    assert.equal(numeric?.rewardComponents?.[0]?.rateKind, 'apy');

    project = 'unit4-borrow-reward-only';
    const borrowOnly = makeLlamaAdapter({
      name: project,
      idPattern: /unit4-borrow-reward-only/,
      lendProjects: [project],
      savingsProjects: [],
    });
    const [borrow] = await borrowOnly.resolve([query({ leg: 'borrow', itemHasBorrows: true })]);
    assert.equal(borrow?.baseApy, null);
    assert.equal(borrow?.rewardApr, 0.03);
    assert.equal(borrow?.rewardState, 'numeric-known');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeFiLlama preserves required pool supply data when optional lendBorrow transport fails', async () => {
  const project = 'unit4-optional-borrow-failure';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/lendBorrow')) throw new Error('borrow transport failed');
    return new Response(JSON.stringify({
      data: [{
        project,
        chain: 'Ethereum',
        underlyingTokens: [ASSET],
        pool: `${project}-pool`,
        poolMeta: null,
        apyBase: 5,
        apyReward: 2,
      }],
    }));
  }) as typeof fetch;
  try {
    const adapter = makeLlamaAdapter({
      name: project,
      idPattern: /unit4-optional-borrow-failure/,
      lendProjects: [],
      savingsProjects: [project],
    });
    const [result] = await adapter.resolve([query()]);
    assert.equal(result?.baseApy, 0.05);
    assert.equal(result?.rewardApr, 0.02);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeFiLlama preserves valid pool supply data when optional lendBorrow JSON is malformed', async () => {
  const project = 'unit4-optional-borrow-malformed';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/lendBorrow')) {
      return new Response('{"data":[', { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{
        project,
        chain: 'Ethereum',
        underlyingTokens: [ASSET],
        pool: `${project}-pool`,
        poolMeta: null,
        apyBase: 5,
        apyReward: 2,
      }],
    }));
  }) as typeof fetch;
  try {
    const adapter = makeLlamaAdapter({
      name: project,
      idPattern: /unit4-optional-borrow-malformed/,
      lendProjects: [],
      savingsProjects: [project],
    });
    const [result] = await adapter.resolve([query()]);
    assert.equal(result?.baseApy, 0.05);
    assert.equal(result?.rewardApr, 0.02);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('official adapters preserve unknown rewards and parse Fluid/Venus reward legs', async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('spark-api.blockanalitica.com')) {
      return new Response(
        JSON.stringify([
          { underlying_address: ASSET, supply_apy: '0.03', borrow_variable_apy: '0.04' },
        ]),
      );
    }
    if (url.includes('/v2/lending/777/tokens')) {
      return new Response(
        JSON.stringify([{ address: FTOKEN, asset: { address: ASSET }, supplyRate: '500' }]),
      );
    }
    if (url.includes('/v2/lending/777/rewards')) {
      return new Response(
        JSON.stringify({
          [FTOKEN]: [{ rate: '250', endTime: now + 60_000, type: 'supply' }],
        }),
      );
    }
    if (url.includes('/v2/777/vaults')) return new Response(JSON.stringify([]));
    if (url.includes('/v2/lending/778/tokens')) return new Response(JSON.stringify([]));
    if (url.includes('/v2/lending/778/rewards')) return new Response(JSON.stringify({}));
    if (url.includes('/v2/778/vaults')) {
      return new Response(
        JSON.stringify([
          {
            address: FLUID_VAULT,
            type: '1',
            supplyToken: { token0: { address: ASSET } },
            borrowToken: { token0: { address: ASSET } },
            supplyRate: { liquidity: { token0: '400' }, dex: { trading: '0' }, vault: { rate: '400' } },
            borrowRate: { liquidity: { token0: '800' }, dex: { trading: '0' }, vault: { rate: '800' } },
            rewards: [
              { rate: '150', endTime: now + 60_000, type: 'supply' },
              { rate: '250', endTime: now + 60_000, type: 'borrow' },
            ],
          },
          {
            address: FLUID_VAULT_2,
            type: '2',
            supplyToken: { token0: { address: ASSET }, token1: { address: ASSET_2 } },
            borrowToken: { token0: { address: ASSET } },
            supplyRate: { liquidity: { token0: '400', token1: '500' }, dex: { trading: '100' }, vault: { rate: '0' } },
            borrowRate: { liquidity: { token0: '800' }, dex: { trading: '0' }, vault: { rate: '800' } },
            rewards: [],
          },
          {
            address: FLUID_VAULT_3,
            type: '3',
            supplyToken: { token0: { address: ASSET } },
            borrowToken: { token0: { address: ASSET }, token1: { address: ASSET_2 } },
            supplyRate: { liquidity: { token0: '400' }, dex: { trading: '0' }, vault: { rate: '400' } },
            borrowRate: { liquidity: { token0: '800', token1: '900' }, dex: { trading: '200' }, vault: { rate: '0' } },
            rewards: [],
          },
          {
            address: FLUID_VAULT_4,
            type: '4',
            supplyToken: { token0: { address: ASSET }, token1: { address: ASSET_2 } },
            borrowToken: { token0: { address: ASSET }, token1: { address: ASSET_2 } },
            supplyRate: { liquidity: { token0: '400', token1: '500' }, dex: { trading: '100' }, vault: { rate: '0' } },
            borrowRate: { liquidity: { token0: '800', token1: '900' }, dex: { trading: '200' }, vault: { rate: '0' } },
            rewards: [],
          },
        ]),
      );
    }
    if (url.includes('api.venus.io')) {
      return new Response(
        JSON.stringify({
          result: [
            {
              isListed: true,
              address: '0x00000000000000000000000000000000000000b1',
              underlyingAddress: ASSET,
              poolComptrollerAddress: '0x00000000000000000000000000000000000000c1',
              supplyApyDecimal: '0.04',
              totalSupplyApyDecimal: '0.06',
              supplyXvsApr: '0.02',
              borrowApyDecimal: '0.08',
              totalBorrowApyDecimal: '0.05',
              borrowXvsApr: '0.03',
              rewardsDistributors: [],
              pointsDistributions: [],
              totalSupplyUsd: '1000000',
            },
          ],
        }),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const [spark] = await sparkOfficial.resolve([query({ itemAdapterId: 'aave_v3_lending' })]);
    assert.equal(spark?.baseApy, 0.03);
    assert.equal(spark?.rewardApr, null);
    assert.equal(spark?.rewardState, 'unknown');
    const [sparkSavings] = await sparkOfficial.resolve([
      query({ itemAdapterId: 'redeemable_tokenized_vault_yield' }),
    ]);
    assert.equal(sparkSavings, null);

    const [fluid, fluidMissingIdentity] = await fluidOfficial.resolve([
      query({ chainId: 777, itemPoolId: FTOKEN }),
      query({ chainId: 777 }),
    ]);
    assert.equal(fluid?.baseApy, 0.05);
    assert.equal(fluid?.rewardApr, 0.025);
    assert.equal(fluid?.rewardState, 'numeric-known');
    assert.equal(fluidMissingIdentity, null);

    const [
      fluidVaultSupply,
      fluidVaultBorrow,
      smartCollateral0,
      smartCollateral1,
      smartDebt,
      smartBothSupply,
      smartBothBorrow,
    ] = await fluidOfficial.resolve([
      query({ chainId: 778, itemPoolId: FLUID_VAULT }),
      query({ chainId: 778, itemPoolId: FLUID_VAULT, leg: 'borrow', itemHasBorrows: true }),
      query({ chainId: 778, itemPoolId: FLUID_VAULT_2 }),
      query({ chainId: 778, address: ASSET_2, itemPoolId: FLUID_VAULT_2 }),
      query({ chainId: 778, itemPoolId: FLUID_VAULT_3, leg: 'borrow', itemHasBorrows: true }),
      query({ chainId: 778, itemPoolId: FLUID_VAULT_4 }),
      query({ chainId: 778, itemPoolId: FLUID_VAULT_4, leg: 'borrow', itemHasBorrows: true }),
    ]);
    assert.equal(fluidVaultSupply?.baseApy, 0.04);
    assert.equal(fluidVaultSupply?.rewardApr, 0.015);
    assert.equal(fluidVaultBorrow?.baseApy, 0.08);
    assert.equal(fluidVaultBorrow?.rewardApr, 0.025);
    assert.deepEqual([smartCollateral0?.baseApy, smartCollateral0?.rewardApr], [0.04, 0.01]);
    assert.deepEqual([smartCollateral1?.baseApy, smartCollateral1?.rewardApr], [0.05, 0.01]);
    assert.equal(smartCollateral0?.rewardComponents?.[0]?.rateKind, 'apy');
    assert.deepEqual([smartDebt?.baseApy, smartDebt?.rewardApr], [0.08, 0.02]);
    assert.deepEqual([smartBothSupply?.baseApy, smartBothSupply?.rewardApr], [0.04, 0.01]);
    assert.deepEqual([smartBothBorrow?.baseApy, smartBothBorrow?.rewardApr], [0.08, 0.02]);

    const [venusBorrow] = await venusOfficial.resolve([
      query({
        chainId: 779,
        leg: 'borrow',
        itemHasBorrows: true,
        itemPoolId: '0x00000000000000000000000000000000000000c1',
      }),
    ]);
    assert.equal(venusBorrow?.baseApy, 0.08);
    assert.equal(venusBorrow?.rewardApr, 0.03);
    assert.equal(venusBorrow?.rewardState, 'numeric-known');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Aave V4 never falls back across spokes for the same asset', async () => {
  const originalFetch = globalThis.fetch;
  __resetAave4CacheForTests();
  let lastV4Body = '';
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    lastV4Body = typeof init?.body === 'string' ? init.body : '';
    return new Response(
      JSON.stringify({
        data: {
          reserves: [
            {
              spoke: { address: '0x0000000000000000000000000000000000000011' },
              asset: { underlying: { address: ASSET }, summary: { supplied: { amount: { value: '1000' } }, availableLiquidity: { amount: { value: '30' } } } },
              summary: {
                supplyApy: { value: '0.03' },
                borrowApy: { value: '0.04' },
                rewards: [],
              },
            },
            {
              spoke: { address: '0x0000000000000000000000000000000000000022' },
              asset: { underlying: { address: ASSET }, summary: { supplied: { amount: { value: '1000' } }, availableLiquidity: { amount: { value: '30' } } } },
              summary: {
                supplyApy: { value: '0.09' },
                borrowApy: { value: '0.10' },
                rewards: [
                  { __typename: 'MerklSupplyReward', extraApy: { value: '0.02' } },
                  { __typename: 'SupplyPointsReward', multiplier: 5 },
                ],
              },
            },
            {
              spoke: { address: '0x0000000000000000000000000000000000000033' },
              asset: { underlying: { address: ASSET }, summary: { supplied: { amount: { value: '1000' } }, availableLiquidity: { amount: { value: '30' } } } },
              summary: {
                supplyApy: { value: null },
                borrowApy: { value: null },
                rewards: [{ __typename: 'MerklSupplyReward', extraApy: { value: '0.015' } }],
              },
            },
          ],
        },
      }),
    );
  };

  try {
    const [missingIdentity, exact, zero, rewardOnly] = await aave4Adapter.resolve([
      query(),
      query({ itemPoolId: '0x0000000000000000000000000000000000000022' }),
      query({ itemPoolId: '0x0000000000000000000000000000000000000011' }),
      query({ itemPoolId: '0x0000000000000000000000000000000000000033' }),
    ]);
    assert.equal(missingIdentity, null);
    assert.equal(exact?.baseApy, 0.09);
    assert.equal(exact?.rewardApr, 0.02);
    assert.equal(exact?.rewardState, 'non-annualizable');
    // Hub 级可提=30,故意不等于旧语义的 spoke 差值(1000−900=100)——V4 流动性由 Hub 共享,
    // 禁止 spoke 级自行相减(codex-review 2026-07-11 高危 finding 的回归钉)
    assert.deepEqual(exact?.poolStat, {
      total: 1_000,
      available: 30,
      unit: 'token',
      source: 'aave-v4-api',
    });
    assert.equal(exact?.rewardComponents?.[0]?.value, 0.02);
    assert.equal(exact?.rewardComponents?.[0]?.rateKind, 'apy');
    assert.equal(zero?.rewardApr, 0);
    assert.equal(zero?.rewardState, 'confirmed-zero');
    // 同 Hub 的另一个 spoke 必须报告完全相同的 Hub 级流动性
    assert.deepEqual(zero?.poolStat, {
      total: 1_000,
      available: 30,
      unit: 'token',
      source: 'aave-v4-api',
    });
    assert.equal(rewardOnly?.baseApy, null);
    assert.equal(rewardOnly?.rewardApr, 0.015);
    assert.equal(rewardOnly?.rewardState, 'numeric-known');
    assert.equal(rewardOnly?.poolStat?.available, 30);
    // 查询必须读取 Hub 级 availableLiquidity(而非 spoke 级 borrowed 自行相减)
    assert.ok(lastV4Body.includes('availableLiquidity'));
    assert.ok(!lastV4Body.includes('borrowed'));
  } finally {
    globalThis.fetch = originalFetch;
    __resetAave4CacheForTests();
  }
});

test('Aave V4 shares one cold load while allowing one subscriber to cancel', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetches = 0;
  __resetAave4CacheForTests();
  globalThis.fetch = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(
      JSON.stringify({
        data: {
          reserves: [
            {
              spoke: { address: '0x0000000000000000000000000000000000000044' },
              asset: { underlying: { address: ASSET } },
              summary: { supplyApy: { value: '0.0124' }, borrowApy: { value: '0.02' }, rewards: [] },
            },
          ],
        },
      }),
    );
  };

  try {
    const cancelled = aave4Adapter.resolve(
      [query({ itemPoolId: '0x0000000000000000000000000000000000000044' })],
      controller.signal,
    );
    const surviving = aave4Adapter.resolve([
      query({ itemPoolId: '0x0000000000000000000000000000000000000044' }),
    ]);
    controller.abort();

    await assert.rejects(cancelled, { name: 'AbortError' });
    const [rate] = await surviving;
    assert.equal(fetches, 1);
    assert.equal(rate?.baseApy, 0.0124);
  } finally {
    globalThis.fetch = originalFetch;
    __resetAave4CacheForTests();
  }
});

test('Fluid reward parser accepts object and array wrappers without reviving expired campaigns', () => {
  const now = 2_000_000_000_000;
  const objectShape = parseFluidRewards(
    {
      [FTOKEN]: [
        { rate: '250', type: 'supply', endTime: now + 1_000 },
        { rate: '900', type: 'supply', endTime: now - 1 },
        { rate: '125', type: 'borrow' },
      ],
      malformed: 'ignored-but-incomplete',
    },
    now,
  );
  assert.equal(objectShape.complete, false);
  assert.deepEqual(objectShape.rates.get(FTOKEN), { supply: 0.025, borrow: 0.0125 });
  assert.equal(objectShape.incompleteKeys.has(FTOKEN), false);

  const arrayShape = parseFluidRewards(
    [{ key: FTOKEN, value: [{ rate: '300', type: 'supply', endTime: Math.floor((now + 1_000) / 1000) }] }],
    now,
  );
  assert.equal(arrayShape.complete, true);
  assert.equal(arrayShape.rates.get(FTOKEN)?.supply, 0.03);
  assert.equal(parseFluidRewards({ data: 'bad' }).complete, false);

  const partialTarget = parseFluidRewards({
    [FTOKEN]: [
      { rate: '250', type: 'supply' },
      { rate: 'bad', type: 'supply' },
    ],
  });
  assert.equal(partialTarget.rates.get(FTOKEN)?.supply, 0.025);
  assert.equal(partialTarget.incompleteKeys.has(FTOKEN), true);
});

test('Lista composes realized vault base with official emission and keeps Moolah identity strict', async () => {
  const combined = composeListaVaultRates('0x00000000000000000000000000000000000000aa', 0.03, {
    apy: 0.02,
    emissionApy: 0.04,
    emissionState: 'numeric-known',
  });
  assert.equal(combined?.baseApy, 0.03);
  assert.equal(combined?.rewardApr, 0.04);
  assert.equal(combined?.rewardState, 'numeric-known');
  assert.equal(combined?.rewardComponents?.[0]?.rateKind, 'apy');

  const rewardWithoutBase = composeListaVaultRates(
    '0x00000000000000000000000000000000000000aa',
    null,
    { apy: null, emissionApy: 0.04, emissionState: 'numeric-known' },
  );
  assert.equal(rewardWithoutBase?.baseApy, null);
  assert.equal(rewardWithoutBase?.rewardApr, 0.04);
  assert.equal(rewardWithoutBase?.rewardState, 'numeric-known');

  const missingEmission = composeListaVaultRates('0x00000000000000000000000000000000000000aa', 0.03, undefined);
  assert.equal(missingEmission?.rewardApr, null);
  assert.equal(missingEmission?.rewardState, 'unknown');

  const [ambiguous] = await listaAdapter.resolve([
    query({
      chainId: 56,
      leg: 'borrow',
      itemHasBorrows: true,
      itemAdapterId: 'morpho_blue_lending2',
      itemPoolId: '0x00000000000000000000000000000000000000aa:lending',
      itemSupplyAddresses: [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ],
    }),
  ]);
  assert.equal(ambiguous, null);
});

test('Lista selects the one wallet-active Moolah market when several markets share an asset pair', () => {
  const ids = [
    `0x${'11'.repeat(32)}`,
    `0x${'22'.repeat(32)}`,
    `0x${'33'.repeat(32)}`,
  ];
  const zeroPosition = `0x${'0'.repeat(64 * 3)}`;
  const activePosition = `0x${'0'.repeat(64)}${'1'.padStart(64, '0')}${'2'.padStart(64, '0')}`;

  assert.equal(
    selectMoolahMarketIdByPosition(ids, [zeroPosition, activePosition, zeroPosition]),
    ids[1],
  );
  assert.equal(
    selectMoolahMarketIdByPosition(ids, [activePosition, activePosition, zeroPosition]),
    null,
  );
  assert.equal(selectMoolahMarketIdByPosition(ids, [zeroPosition]), null);
});

test('Lista resolves a wallet-active market after the official market directory exceeds the RPC batch limit', async () => {
  __resetListaCacheForTests();
  const originalFetch = globalThis.fetch;
  const loanToken = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';
  const collateralToken = '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c';
  const otherToken = '0x00000000000000000000000000000000000000ff';
  const moolah = '0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c';
  const irm = '0xfe7dae87ebb11a7beb9f534bb23267992d9cde7c';
  const wallet = '0x000000000000000000000000000000000000f001';
  const targetMarket = '0xd9c00925089bfdfa28fd1e9ee734da1461d0b1b9bed9647f6e7ec5acb9d20fc6';
  const pairMarkets = [
    targetMarket,
    `0x${'35'.repeat(32)}`,
    `0x${'8d'.repeat(32)}`,
  ];
  const marketIds = Array.from({ length: 257 }, (_, index) =>
    index < pairMarkets.length
      ? pairMarkets[index]
      : `0x${(index + 1).toString(16).padStart(64, '0')}`,
  );
  const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, '0');
  const uintWord = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0');
  const zeroPosition = `0x${'0'.repeat(64 * 3)}`;
  const activePosition = `0x${uintWord(0)}${uintWord(1)}${uintWord(2)}`;
  let rpcStage = 0;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('/api/moolah/vault/list')) {
      return new Response(JSON.stringify({
        data: {
          list: [{
            address: '0x00000000000000000000000000000000000000a1',
            apy: '0',
            emissionApy: '0',
            marketIds,
          }],
        },
      }));
    }
    if (url.endsWith('/api/moolah/allMarkets')) {
      return new Response(JSON.stringify({
        data: marketIds.map((id, index) => ({
          id,
          loanToken: index < pairMarkets.length ? loanToken : otherToken,
          collateralToken: index < pairMarkets.length ? collateralToken : otherToken,
          irm,
          chain: 'bsc',
        })),
      }));
    }
    if (url.includes(`/api/moolah/market/${targetMarket}`)) {
      return new Response(JSON.stringify({
        data: {
          marketId: targetMarket,
          borrowRate: 0.01720920501066126,
          borrowEmissionApy: '0',
          holderBorrowEmissionApy: '0',
          borrowEmissionDetail: [],
          emissionDetail: [],
          rewards: [],
        },
      }));
    }
    if (url === 'https://bsc-rpc.publicnode.com') {
      const calls = JSON.parse(String(init?.body)) as { id: number }[];
      rpcStage += 1;
      if (rpcStage === 1) {
        const marketParams = `0x${addressWord(loanToken)}${addressWord(collateralToken)}${addressWord(otherToken)}${addressWord(irm)}${uintWord(700_000_000_000_000_000n)}`;
        return new Response(JSON.stringify(calls.map(({ id }) => ({ id, result: marketParams }))));
      }
      if (rpcStage === 2) {
        return new Response(JSON.stringify(calls.map(({ id }, index) => ({
          id,
          result: index === 0 ? activePosition : zeroPosition,
        }))));
      }
      if (rpcStage === 3) {
        const marketState = `0x${uintWord(1_000)}${uintWord(1_000)}${uintWord(500)}${uintWord(500)}${uintWord(1)}${uintWord(100_000_000_000_000_000n)}`;
        return new Response(JSON.stringify(calls.map(({ id }) => ({ id, result: marketState }))));
      }
      return new Response(JSON.stringify(calls.map(({ id }) => ({ id, result: `0x${uintWord(1_000_000_000)}` }))));
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const common = {
      chainId: 56,
      itemHasBorrows: true,
      userAddress: wallet,
      itemAdapterId: 'morpho_blue_lending2',
      itemPoolId: `${moolah}:lending`,
      itemSupplyAddresses: [collateralToken],
      itemBorrowAddresses: [loanToken],
    };
    const [collateral, borrow] = await listaAdapter.resolve([
      query({ ...common, address: collateralToken, leg: 'supply' }),
      query({ ...common, address: loanToken, leg: 'borrow' }),
    ]);

    assert.equal(collateral?.baseApy, 0);
    assert.equal(collateral?.rewardApr, 0);
    assert.equal(collateral?.rewardState, 'confirmed-zero');
    assert.equal(borrow?.baseApy, 0.01720920501066126);
    assert.equal(borrow?.rewardApr, 0);
    assert.equal(borrow?.rewardState, 'confirmed-zero');
    assert.ok(requestedUrls.some((url) => url.endsWith('/api/moolah/allMarkets')));
  } finally {
    globalThis.fetch = originalFetch;
    __resetListaCacheForTests();
  }
});

test('24h realized growth is compounded into effective annual APY', () => {
  const daily = 0.001;
  assert.ok(Math.abs((annualizeDailyGrowth(daily) ?? 0) - Math.expm1(Math.log1p(daily) * 365)) < 1e-12);
  assert.equal(annualizeDailyGrowth(-1), null);
});
