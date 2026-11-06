import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendleAdapter } from '../utils/adapters/pendle.ts';
import { curveAdapter } from '../utils/adapters/curve.ts';
import { beefyAdapter, yearnAdapter } from '../utils/adapters/vaults.ts';
import { lidoAdapter, rocketPoolAdapter, etherfiAdapter, LIDO_TOKENS, stakingAprToApy } from '../utils/adapters/staking.ts';
import { __resetPublicDataForTests } from '../utils/adapters/public-data.ts';
import { findAdapter } from '../utils/adapters/registry.ts';
import { computeProtocolYield } from '../utils/apy.ts';
import type { LegQuery } from '../utils/adapters/types.ts';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b1';
const PT = '0x00000000000000000000000000000000000000c1';
const YT = '0x00000000000000000000000000000000000000c2';
const VAULT = '0x00000000000000000000000000000000000000d1';
const POOL = '0x00000000000000000000000000000000000000e1';
const GAUGE = '0x00000000000000000000000000000000000000f1';
const q = (overrides: Partial<LegQuery> = {}): LegQuery => ({ chainId: 1, address: A, leg: 'supply', itemHasBorrows: false, ...overrides });
const json = (value: unknown) => new Response(JSON.stringify(value));
async function withFetch(handler: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  __resetPublicDataForTests();
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = original; __resetPublicDataForTests(); }
}

test('new routes accept chain-prefixed DeBank IDs without claiming other products', () => {
  for (const [id, name] of [['arb_pendle2', 'pendle'], ['bsc_curve', 'curve'], ['base_beefy', 'beefy'],
    ['op_yearn2', 'yearn'], ['base_yearn3', 'yearn'], ['lido', 'lido'], ['rocketpool', 'rocket-pool'], ['etherfi', 'etherfi']]) {
    assert.equal(findAdapter(id)?.name, name);
  }
  for (const id of ['convex', 'euler2', 'silo2', 'etherfi_liquid', 'pendle_boros', 'curve_lending']) assert.equal(findAdapter(id), undefined);
});

test('Pendle paginates and matches PT by chain and address, never LP or YT', async () => {
  const market = { chainId: 42161, address: POOL, pt: `42161-${PT}`, yt: `42161-${YT}`,
    underlyingAsset: `42161-${A}`, expiry: '2099-01-01T00:00:00Z', details: { impliedApy: 0.08 } };
  const requests: string[] = [];
  await withFetch(async (input) => {
    const url = String(input); requests.push(url);
    return json(url.includes('skip=100') ? { total: 101, results: [market] } : {
      total: 101, results: Array.from({ length: 100 }, (_, i) => ({ ...market, chainId: 10000 + i })),
    });
  }, async () => {
    const results = await pendleAdapter.resolve([
      q({ chainId: 42161, address: PT, itemPoolId: POOL }),
      q({ chainId: 42161, address: YT, itemPoolId: POOL }),
      q({ chainId: 42161, address: A, itemPoolId: POOL }),
      q({ chainId: 1, address: PT }),
      q({ chainId: 42161, address: PT, itemPoolId: VAULT }),
      q({ chainId: 42161, address: A, itemPoolId: PT }),
    ]);
    assert.equal(results[0]?.baseApy, 0.08);
    assert.equal(results[0]?.rewardState, 'not-applicable');
    assert.equal(results[0]?.includesIntrinsicYield, true);
    assert.deepEqual(results.slice(1, 5), [null, null, null, null]);
    assert.equal(results[5]?.baseApy, 0.08);
    assert.equal(requests.length, 2);
  });
});

test('matured Pendle PT has no future discount yield; missing current APY stays unknown', async () => {
  await withFetch(async () => json({ total: 2, results: [
    { chainId: 1, address: POOL, pt: `1-${PT}`, expiry: '2020-01-01', details: { impliedApy: 0.3 } },
    { chainId: 1, address: VAULT, pt: `1-${YT}`, expiry: '2099-01-01', details: {} },
  ] }), async () => {
    const results = await pendleAdapter.resolve([q({ address: PT }), q({ address: YT })]);
    assert.equal(results[0]?.baseApy, 0);
    assert.equal(results[1]?.baseApy, null);
  });
});

test('Beefy uses the exact active vault composite once, not an underlying-token guess', async () => {
  await withFetch(async (input) => json(String(input).endsWith('/vaults') ? [
    { id: 'eth-vault', chain: 'ethereum', status: 'active', type: 'standard', earnContractAddress: VAULT, earnedTokenAddress: VAULT },
    { id: 'base-vault', chain: 'base', status: 'active', type: 'standard', earnContractAddress: VAULT, earnedTokenAddress: VAULT },
    { id: 'old-vault', chain: 'ethereum', status: 'eol', type: 'standard', earnContractAddress: POOL, earnedTokenAddress: POOL },
  ] : { 'eth-vault': { totalApy: 0.15, vaultApr: 0.08, tradingApr: 0.03 }, 'base-vault': { totalApy: 0.07 } }), async () => {
    const results = await beefyAdapter.resolve([
      q({ itemPoolId: VAULT }), q({ chainId: 8453, itemPoolId: VAULT }), q(),
      q({ itemPoolId: POOL }), q({ itemPoolId: VAULT, leg: 'borrow', itemHasBorrows: true }),
    ]);
    assert.equal(results[0]?.baseApy, 0.15);
    assert.equal(results[1]?.baseApy, 0.07);
    assert.equal(results[0]?.rewardState, 'unknown');
    assert.equal(results[0]?.includesIntrinsicYield, true);
    assert.deepEqual(results.slice(2), [null, null, null]);
  });
});

test('Yearn compounds observed weekly share growth and isolates a failed vault', async () => {
  await withFetch(async (input) => {
    if (String(input).endsWith(POOL)) return new Response('', { status: 503 });
    return json({ address: VAULT, chainID: 1, token: { address: A }, info: { isRetired: false },
      apr: { netAPR: 999, pricePerShare: { today: 1.001, weekAgo: 1 } } });
  }, async () => {
    const results = await yearnAdapter.resolve([
      q({ itemPoolId: VAULT }), q({ itemPoolId: POOL }), q({ itemPoolId: VAULT, address: B }),
      q({ chainId: 8453, itemPoolId: VAULT }),
    ]);
    assert.ok(Math.abs(results[0]!.baseApy! - (1.001 ** (365 / 7) - 1)) < 1e-12);
    assert.equal(results[0]?.rewardState, 'unknown');
    assert.equal(results[0]?.includesIntrinsicYield, true);
    assert.deepEqual(results.slice(1), [null, null, null]);
  });
});

test('Curve matches pool/gauge and constituent tokens; a failed chain stays isolated', async () => {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/arbitrum')) return new Response('', { status: 503 });
    if (url.includes('/getPools/')) return json({ success: true, data: { poolData: [
      { address: POOL, lpTokenAddress: VAULT, gaugeAddress: GAUGE, coins: [{ address: A }, { address: B }] },
    ] } });
    return json({ success: true, data: { poolList: [{ address: POOL, latestWeeklyApy: 5 }] } });
  }, async () => {
    const results = await curveAdapter.resolve([
      q({ itemPoolId: POOL }), q({ address: B, itemPoolId: GAUGE }), q(),
      q({ itemPoolId: POOL, address: PT }), q({ chainId: 42161, itemPoolId: POOL }),
    ]);
    assert.equal(results[0]?.baseApy, 0.05);
    assert.equal(results[1]?.baseApy, 0.05);
    assert.equal(results[0]?.rewardState, 'unknown');
    assert.deepEqual(results.slice(2), [null, null, null]);
    const combined = computeProtocolYield(results.slice(0, 2).map((r, i) => ({
      ...r!, leg: 'supply' as const, token: { address: i ? B : A, chain: 'eth', symbol: i ? 'B' : 'A', amount: 100, priceUsd: 1, usd: 100 },
    })));
    assert.equal(combined.knownNetApy, 0.05);
    assert.equal(combined.knownEstDailyUsd, 10 / 365);
    assert.equal(combined.netApy, null);
  });
});

test('Lido validates source and canonical chain/token pairs and explicitly converts APR', async () => {
  await withFetch(async () => json({ data: { smaApr: 4 }, meta: { chainId: 1, address: LIDO_TOKENS[1][0] } }), async () => {
    const results = await lidoAdapter.resolve([
      q({ address: LIDO_TOKENS[1][0] }), q({ chainId: 8453, address: LIDO_TOKENS[8453][0] }),
      q({ chainId: 8453, address: LIDO_TOKENS[1][0] }), q({ address: 'eth' }),
      q({ address: 'eth', itemPoolId: LIDO_TOKENS[1][0] }),
    ]);
    assert.equal(results[0]?.baseApy, stakingAprToApy(4));
    assert.ok(results[0]!.baseApy! > 0.04);
    assert.equal(results[1]?.baseApy, results[0]?.baseApy);
    assert.deepEqual(results.slice(2, 4), [null, null]);
    assert.equal(results[4]?.baseApy, results[0]?.baseApy);
    assert.equal(results[0]?.rewardState, 'not-applicable');
  });
});

test('Rocket Pool applies rETH APR only to the Ethereum rETH product', async () => {
  const reth = '0xae78736cd615f374d3085123a210448e74fc6393';
  await withFetch(async () => json({ yearlyAPR: '3' }), async () => {
    const results = await rocketPoolAdapter.resolve([q({ address: reth }), q({ chainId: 8453, address: reth }), q({ address: A })]);
    assert.equal(results[0]?.baseApy, stakingAprToApy(3));
    assert.deepEqual(results.slice(1), [null, null]);
  });
});

test('ether.fi reads share growth once for eETH/weETH and does not claim extra reward completeness', async () => {
  const originalBrowser = (globalThis as any).browser;
  (globalThis as any).browser = { storage: { sync: { get: async () => ({}) } } };
  let rateCalls = 0;
  try {
    await withFetch(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'eth_blockNumber') return json({ result: '0x100000' });
      if (request.method === 'eth_getBlockByNumber') return json({ result: { timestamp: request.params[0] === '0x100000' ? '0x200000' : '0x1c5680' } });
      assert.equal(request.method, 'eth_call'); rateCalls++;
      const value = request.params[1] === 'latest' ? 10001n : 10000n;
      return json({ result: '0x' + value.toString(16).padStart(64, '0') });
    }, async () => {
      const result = await etherfiAdapter.resolve([
        q({ address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee' }),
        q({ address: '0x35fa164735182de50811e8e2e824cfb9b6118ac2' }),
        q({ chainId: 8453, address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee' }),
      ]);
      assert.ok(Math.abs(result[0]!.baseApy! - (1.0001 ** 365 - 1)) < 1e-12);
      assert.equal(result[0]?.baseApy, result[1]?.baseApy);
      assert.equal(result[0]?.rewardState, 'unknown');
      assert.equal(result[0]?.includesIntrinsicYield, true);
      assert.equal(result[2], null);
      assert.equal(rateCalls, 2);
    });
  } finally { (globalThis as any).browser = originalBrowser; }
});
