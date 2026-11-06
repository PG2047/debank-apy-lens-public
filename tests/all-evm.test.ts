import assert from 'node:assert/strict';
import test from 'node:test';
import deployments from '../utils/deployments.json';
import { CHAINS, chainIdFromName } from '../utils/chains.ts';
import { PUBLIC_RPC, ALCHEMY_NETWORKS } from '../utils/rpc-config.ts';
import { APPROVED_HOST_PERMISSIONS } from '../utils/hosts.ts';
import { enrichPayload } from '../utils/enrich.ts';
import { aave4Adapter, __resetAave4CacheForTests } from '../utils/adapters/aave4.ts';
import { ethenaOfficial, falconOfficial } from '../utils/adapters/official.ts';
import type { LegQuery } from '../utils/adapters/types.ts';
import { UNISWAP_V3, UNISWAP_V4, PANCAKE_V3 } from '../utils/lp-deployments.ts';
import { uniswapRanges, __resetUniswapCacheForTests } from '../utils/uniswap.ts';
import { DEFAULT_RPC } from '../utils/rpc.ts';
import type { PositionItem } from '../utils/debank.ts';
import { keccak256, hexToBytes } from '../utils/keccak.ts';

const ASSET = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000a2';
const MARKET = '0x0000000000000000000000000000000000000011';
const query = (chainId: number): LegQuery => ({ chainId, address: ASSET, leg: 'supply', itemHasBorrows: false, itemPoolId: MARKET });

test('every current DeBank EVM chain reaches exact Aave routing without a TVL whitelist', async () => {
  const original = globalThis.fetch;
  const requested = new Set<number>();
  globalThis.fetch = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: { markets: variables.chainIds.map((chainId: number) => {
      requested.add(chainId);
      return { address: MARKET, chain: { chainId }, reserves: [{
        underlyingToken: { address: ASSET }, supplyInfo: { apy: { value: '0.03' } }, incentives: [],
      }] };
    }) } }));
  };
  try {
    const result = await enrichPayload({ data: deployments.chains.map(({ id }) => ({
      id: `${id}_aave3`, chain: id, name: 'Aave V3', portfolio_item_list: [{
        name: 'Lending', pool: { id: MARKET }, stats: { net_usd_value: 1_000 },
        detail: { supply_token_list: [{ id: ASSET, chain: id, symbol: 'TEST', amount: 1_000, price: 1 }] },
      }],
    })) });
    assert.equal(result.cards.length, deployments.chains.length);
    assert.equal(requested.size, deployments.chains.length);
    assert.ok(result.cards.find((c) => c.key === 'xlayer:xlayer_aave3'));
    for (const card of result.cards) {
      assert.equal(card.yield.assets[0].baseApy, 0.03, card.key);
      assert.equal(card.yield.assets[0].rewardState, 'confirmed-zero', card.key);
    }
    assert.equal(result.summary?.rateCoverageComplete, true);
    assert.equal(result.summary?.rewardCoverageComplete, true);
  } finally { globalThis.fetch = original; }
});

test('new network and LP RPC origins are present in the actual MV3 permission source', () => {
  const permissions = new Set<string>(APPROVED_HOST_PERMISSIONS);
  for (const chain of deployments.chains) {
    assert.equal(CHAINS[chain.id].chainId, chain.chainId);
    assert.ok(PUBLIC_RPC[chain.chainId], `missing public RPC: ${chain.id}`);
    assert.ok(permissions.has(`${new URL(PUBLIC_RPC[chain.chainId]).origin}/*`));
  }
  for (const table of [UNISWAP_V3, UNISWAP_V4, PANCAKE_V3]) {
    for (const chainId of Object.keys(table)) {
      assert.ok(DEFAULT_RPC[Number(chainId)], `missing LP RPC: ${chainId}`);
    }
  }
  for (const slug of Object.values(ALCHEMY_NETWORKS)) assert.ok(permissions.has(`https://${slug}.g.alchemy.com/*`));
  assert.equal(CHAINS.xlayer.chainId, 196);
  assert.equal(chainIdFromName('X Layer'), 196);
  assert.equal(chainIdFromName('Berachain'), 80094);
  assert.equal(chainIdFromName('ethereum'), 1);
  assert.equal(chainIdFromName('bsc'), 56);
  assert.equal(chainIdFromName('unverified-chain'), undefined);
  assert.equal(CHAINS.movement, undefined); // Move VM is not an EVM network.
});

test('Aave V4 isolates same-address spokes across chains, cache, and chain-local failures', async () => {
  __resetAave4CacheForTests();
  const original = globalThis.fetch;
  const requests: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const cid = JSON.parse(String(init?.body)).variables.chainIds[0];
    requests.push(cid);
    if (cid === 196) return new Response('{"errors":[{"message":"unavailable"}]}');
    return new Response(JSON.stringify({ data: { reserves: [{
      spoke: { address: MARKET }, asset: { underlying: { address: ASSET } },
      summary: { supplyApy: { value: cid === 1 ? '0.01' : '0.05' }, rewards: [] },
    }] } }));
  };
  try {
    const rates = await aave4Adapter.resolve([query(1), query(8453), query(196)]);
    assert.deepEqual(rates.map((r) => r?.baseApy ?? null), [0.01, 0.05, null]);
    const cached = await aave4Adapter.resolve([query(8453), query(1)]);
    assert.deepEqual(cached.map((r) => r?.baseApy), [0.05, 0.01]);
    assert.deepEqual(requests.sort((a, b) => a - b), [1, 196, 8453]);
  } finally { globalThis.fetch = original; __resetAave4CacheForTests(); }
});

test('Ethena uses canonical cross-chain shares and rejects a mainnet address on the wrong chain', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"stakingYield":{"value":4},"sUSDf_7d_apy":0.05}');
  try {
    const addresses = [
      [196, '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2'],
      [324, '0xad17da2f6ac76746ef261e835c50b2651ce36da8'],
      [4217, '0x20c000000000000000000000bd95bfb69fbe6ce3'],
      [196, '0x9d39a5de30e57443bff2a8307a4256c8797a3497'],
      [324, '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2'],
    ] as const;
    const rates = await ethenaOfficial.resolve(addresses.map(([cid, address]) => ({ ...query(cid), address })));
    assert.deepEqual(rates.map((r) => r?.baseApy ?? null), [0.04, 0.04, 0.04, null, null]);
    const falcon = await falconOfficial.resolve([1, 56].map((cid) => ({ ...query(cid), address: '0xc8cf6d7991f15525488b2a83df53468d682ba4b0' })));
    assert.deepEqual(falcon.map((r) => r?.baseApy ?? null), [0.05, null]);
  } finally { globalThis.fetch = original; }
});

const word = (value: string | number | bigint) => typeof value === 'string'
  ? value.replace(/^0x/, '').padStart(64, '0')
  : BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const abi = (...words: (string | number | bigint)[]) => '0x' + words.map(word).join('');
const lpItem = (): PositionItem => ({
  itemName: 'LP', positionIndex: '7', supplies: [ASSET, OTHER].map((address, index) => ({
    address, chain: 'xlayer', symbol: index ? 'USDC' : 'ASSET', amount: 1, priceUsd: 1, usd: 1, decimals: 18,
  })), borrows: [], rewards: [], netUsd: 1_000, principalInputCoverageComplete: true, rewardInputCoverageComplete: true,
});

test('all V3 deployments resolve NFT range via their own manager, factory, and RPC', async () => {
  const original = globalThis.fetch;
  __resetUniswapCacheForTests();
  try {
    for (const [family, table] of [['uniswap', UNISWAP_V3], ['pancake', PANCAKE_V3]] as const) {
      for (const [id, deployment] of Object.entries(table)) {
        const chainId = Number(id);
        globalThis.fetch = async (url, init) => {
          assert.equal(String(url), DEFAULT_RPC[chainId]);
          return new Response(JSON.stringify(JSON.parse(String(init?.body)).map((call: any) => {
            const { to, data } = call.params[0];
            let result: string;
            if (data.startsWith('0x99fbab88')) {
              assert.equal(to.toLowerCase(), deployment.positionManager);
              result = abi(0, 0, ASSET, OTHER, 3000, -60, 60, 1, 0, 0, 0, 0);
            } else if (data.startsWith('0x1698ee82')) {
              assert.equal(to.toLowerCase(), deployment.factory);
              result = abi(MARKET);
            } else {
              assert.equal(to, MARKET); assert.equal(data, '0x3850c7bd');
              result = abi(1, 0);
            }
            return { jsonrpc: '2.0', id: call.id, result };
          })));
        };
        const result = (await uniswapRanges(chainId, [lpItem()], 3, family)).get('7');
        assert.equal(result?.inRange, true, `${family}:${id}`);
        assert.equal(result?.feePct, 0.003);
        assert.equal(result?.pct, 0.5);
      }
    }
  } finally { globalThis.fetch = original; __resetUniswapCacheForTests(); }
});

test('all V4 deployments resolve the pool key and StateView without cross-chain cache reuse', async () => {
  const original = globalThis.fetch;
  __resetUniswapCacheForTests();
  const poolKey = abi(ASSET, OTHER, 3000, 60, 0);
  const poolId = keccak256(hexToBytes(poolKey.slice(2)));
  const packed = (BigInt('0x' + poolId.slice(0, 50)) << 56n) | (60n << 32n) | (BigInt.asUintN(24, -60n) << 8n);
  try {
    for (const [id, deployment] of Object.entries(UNISWAP_V4)) {
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), DEFAULT_RPC[Number(id)]);
        return new Response(JSON.stringify(JSON.parse(String(init?.body)).map((call: any) => {
          const { to, data } = call.params[0];
          let result: string;
          if (data.startsWith('0x89097a6a')) {
            assert.equal(to, deployment.positionManager); result = abi(packed);
          } else if (data.startsWith('0x86b6be7d')) {
            assert.equal(to, deployment.positionManager); result = poolKey;
          } else {
            assert.equal(to, deployment.stateView); assert.equal(data, '0xc815641c' + poolId);
            result = abi(1, 0, 0, 3000);
          }
          return { jsonrpc: '2.0', id: call.id, result };
        })));
      };
      const result = (await uniswapRanges(Number(id), [lpItem()], 4)).get('7');
      assert.equal(result?.inRange, true, id);
      assert.equal(result?.pct, 0.5);
    }
  } finally { globalThis.fetch = original; __resetUniswapCacheForTests(); }
});
