// Public API verification. No wallet, API key, or local credential is used.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aaveAdapter, AAVE_V3_MARKETS_QUERY, __resetAaveCacheForTests } from '../utils/adapters/aave.ts';
import { aave4Adapter, AAVE_V4_RESERVES_QUERY, AAVE_V4_USER_RESERVES_QUERY, __resetAave4CacheForTests } from '../utils/adapters/aave4.ts';
import deployments from '../utils/deployments.json';
import reviewed from '../utils/aave-markets.json';
import type { LegQuery } from '../utils/adapters/types.ts';

const endpoints = reviewed.sources;
const networkFetch = globalThis.fetch;
async function gql(version: 'v3' | 'v4', query: string, variables = {}): Promise<any> {
  const response = await networkFetch(endpoints[version], {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${version} HTTP status`);
  const body = await response.json();
  assert.ok(!body.errors?.length, JSON.stringify(body.errors));
  return body;
}

const [v3Chains, v4Chains] = await Promise.all([
  gql('v3', 'query { chains { name chainId isTestnet } }'),
  gql('v4', 'query { chains(request:{query:{filter:MAINNET_ONLY}}) { name chainId isTestnet isFork } }'),
]);
// Exercise the personalized schema with a synthetic, non-personal address.
await gql('v4', AAVE_V4_USER_RESERVES_QUERY, { chainIds: [1], user: '0x0000000000000000000000000000000000000001' });
const inventory = {
  observedAt: new Date().toISOString().slice(0, 10), sources: endpoints,
  v3: [] as typeof reviewed.v3, v4: [] as typeof reviewed.v4,
};
const responses = new Map<string, any>();
const jobs = (['v3', 'v4'] as const).flatMap((version) =>
  (version === 'v3' ? v3Chains : v4Chains).data.chains
    .filter((chain: any) => !chain.isTestnet && !chain.isFork)
    .map((chain: any) => ({ version, chain })),
);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < jobs.length) {
    const { version, chain } = jobs[next++];
    const debank = deployments.chains.find((entry) => entry.chainId === chain.chainId);
    assert.ok(debank, `Missing DeBank chain: ${chain.name} (${chain.chainId})`);
    const body = await gql(version, version === 'v3' ? AAVE_V3_MARKETS_QUERY : AAVE_V4_RESERVES_QUERY,
      { chainIds: [chain.chainId], user: null });
    responses.set(`${version}:${chain.chainId}`, body);
    const base = { chainId: chain.chainId, name: chain.name, debankId: debank.id };
    if (version === 'v3') {
      assert.ok(body.data.markets.length > 0, `${version}:${chain.chainId} has no markets`);
      inventory.v3.push({ ...base, markets: body.data.markets.map((market: any) => {
        assert.equal(market.chain.chainId, chain.chainId);
        return { name: market.name, address: market.address.toLowerCase(), reserves: market.reserves.length };
      }).sort((a: any, b: any) => a.address.localeCompare(b.address)) });
    } else {
      assert.ok(body.data.reserves.length > 0, `${version}:${chain.chainId} has no reserves`);
      const spokes = new Map<string, { name: string; address: string; reserves: number }>();
      for (const reserve of body.data.reserves) {
        assert.equal(reserve.spoke.chain.chainId, chain.chainId);
        const address = reserve.spoke.address.toLowerCase();
        const row = spokes.get(address) ?? { name: reserve.spoke.name, address, reserves: 0 };
        row.reserves += 1;
        spokes.set(address, row);
      }
      inventory.v4.push({ ...base, spokes: [...spokes.values()].sort((a, b) => a.address.localeCompare(b.address)) });
    }
    console.log(`${version} ${chain.name}: API OK`);
  }
}));
inventory.v3.sort((a, b) => a.chainId - b.chainId);
inventory.v4.sort((a, b) => a.chainId - b.chainId);

// Replay the exact public responses through the production adapters. This
// checks every returned reserve and native alias, without a second network call.
globalThis.fetch = async (input, init) => {
  const version = String(input) === endpoints.v3 ? 'v3' : 'v4';
  const { variables } = JSON.parse(String(init?.body));
  assert.equal(variables.user, null);
  assert.equal(variables.chainIds.length, 1);
  const body = responses.get(`${version}:${variables.chainIds[0]}`);
  assert.ok(body);
  return new Response(JSON.stringify(body));
};
const checks: { version: string; chainId: number; reserves: number; checkedLegs: number; nativeLegs: number; ambiguousLegs: number }[] = [];
try {
  __resetAaveCacheForTests();
  __resetAave4CacheForTests();
  for (const { version, chain } of jobs) {
    const body = responses.get(`${version}:${chain.chainId}`);
    const debank = deployments.chains.find((entry) => entry.chainId === chain.chainId)!;
    const rows = version === 'v3'
      ? body.data.markets.flatMap((market: any) => market.reserves.map((r: any) => ({ ...r, market })))
      : body.data.reserves;
    const queries: LegQuery[] = [];
    const expected: (number | null)[] = [];
    const ambiguous: boolean[] = [];
    let nativeLegs = 0;
    for (const row of rows) {
      const address = version === 'v3' ? row.underlyingToken.address : row.asset.underlying.address;
      const pool = version === 'v3' ? row.market.address : row.spoke.address;
      const native = version === 'v3' ? row.market.chain.nativeWrappedToken
        : row.spoke.chain.nativeAsset?.wrappedNativeTokenAddress ?? row.spoke.chain.nativeAsset?.erc20Address;
      const addresses = [address.toLowerCase()];
      if (address.toLowerCase() === native?.toLowerCase()) addresses.push(debank.id);
      for (const token of addresses) {
        for (const leg of ['supply', 'borrow'] as const) {
          const raw = version === 'v3' ? row[`${leg}Info`]?.apy?.value : row.summary[`${leg}Apy`]?.value;
          const rate = raw == null ? null : Number(raw);
          queries.push({ chainId: chain.chainId, address: token, itemPoolId: pool, leg, itemHasBorrows: true });
          expected.push(rate !== null && rate >= 0 && rate < 10 ? rate : null);
          ambiguous.push(version === 'v4' && rows.filter((other: any) =>
            other.spoke.address.toLowerCase() === pool.toLowerCase() &&
            other.asset.underlying.address.toLowerCase() === address.toLowerCase(),
          ).length > 1);
          if (token === debank.id) nativeLegs += 1;
        }
      }
    }
    const results = await (version === 'v3' ? aaveAdapter : aave4Adapter).resolve(queries);
    results.forEach((result, index) => {
      if (ambiguous[index]) {
        assert.equal(result, null, `${version}:${chain.chainId} anonymous ambiguous reserve must stay unknown`);
        return;
      }
      assert.ok(result, `${version}:${chain.chainId} reserve not matched: ${index}`);
      assert.equal(result.baseApy, expected[index], `${version}:${chain.chainId} leg ${index}`);
    });
    checks.push({ version, chainId: chain.chainId, reserves: rows.length, checkedLegs: queries.length, nativeLegs, ambiguousLegs: ambiguous.filter(Boolean).length });
  }
} finally {
  globalThis.fetch = networkFetch;
  __resetAaveCacheForTests();
  __resetAave4CacheForTests();
}

function identities(data: typeof inventory) {
  return {
    v3: data.v3.map((chain) => [chain.chainId, chain.markets.map((m) => m.address).sort()]),
    v4: data.v4.map((chain) => [chain.chainId, chain.spokes.map((s) => s.address).sort()]),
  };
}
const write = process.argv.includes('--write');
if (write) await writeFile(new URL('../utils/aave-markets.json', import.meta.url), JSON.stringify(inventory, null, 2) + '\n');
else assert.deepEqual(identities(inventory), identities(reviewed), 'Aave deployment inventory changed; review and run --write');
const outputArg = process.argv.indexOf('--output');
if (outputArg >= 0) {
  const output = resolve(process.argv[outputArg + 1]);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'validation.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), inventory, checks,
    note: 'Anonymous live API responses replayed through production adapters. Wallet-specific rates and DeBank page rendering are covered by fixtures, not this live check.',
    noteZh: '匿名实时 API 响应已通过生产适配器回放。用户专属利率和 DeBank 页面匹配使用测试样例验证，不属于本次实时核验。',
  }, null, 2) + '\n');
}
console.log(`PASS: V3 ${inventory.v3.length} mainnets; V4/Pro ${inventory.v4.length} mainnets; ${checks.reduce((n, c) => n + c.checkedLegs, 0)} supply/borrow checks, including ${checks.reduce((n, c) => n + c.ambiguousLegs, 0)} anonymous ambiguous legs kept unknown.`);
