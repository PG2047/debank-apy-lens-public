import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __resetLlamaCacheForTests } from '../utils/adapters/defillama.ts';
import {
  __resetSkyFarmCacheForTests,
  calculateSkyFarmApr,
  calculatePerSecondRayApy,
  skyAdapter,
  type SkyFarmState,
} from '../utils/adapters/sky.ts';

const FARM = '0x4e41488c19cd35eb4de3083fc3e204854c75c86a';
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f';
const GROVE = '0xb30fe1cf884b48a22a50d22a9282004f2c5e9406';
const SUSDS = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd';
const STUSDS = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9';
const USER = '0x000000000000000000000000000000000000f002';

const hex = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;
const addressHex = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`;
const bytes32Hex = (value: string): string => {
  const encoded = [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `0x${encoded.padEnd(64, '0')}`;
};

test('Sky farm APR uses exact onchain emission, pool supply and token prices', () => {
  const state: SkyFarmState = {
    farm: FARM,
    stakingToken: USDS,
    rewardsToken: GROVE,
    rewardRate: 10n ** 16n,
    periodFinish: 2_000_000_000,
    totalSupply: 1_000n * 10n ** 18n,
    stakingDecimals: 18,
    rewardDecimals: 18,
    rewardSymbol: 'GROVE',
  };
  assert.ok(Math.abs((calculateSkyFarmApr(state, 1, 0.01, 1_900_000_000) ?? 0) - 3.1536) < 1e-12);
  assert.equal(calculateSkyFarmApr({ ...state, periodFinish: 1_800_000_000 }, 1, 0.01, 1_900_000_000), 0);
  assert.equal(calculateSkyFarmApr(state, 1, 0, 1_900_000_000), null);
});

test('Sky savings APY compounds the exact per-second RAY rate', () => {
  const perSecond = Math.expm1(Math.log1p(0.036) / (365 * 24 * 60 * 60));
  const rate = 10n ** 27n + BigInt((perSecond * 1e27).toFixed(0));
  assert.ok(Math.abs((calculatePerSecondRayApy(rate) ?? 0) - 0.036) < 1e-8);
  assert.equal(calculatePerSecondRayApy(10n ** 27n - 1n), null);
});

test('Sky farm resolves an exact DeBank pool onchain and labels the GROVE reward', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  let llamaCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('yields.llama.fi/pools')) {
      llamaCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.includes('yields.llama.fi/lendBorrow')) {
      return new Response('[]', { status: 200 });
    }
    if (url.includes('info-sky.blockanalitica.com')) {
      return new Response(JSON.stringify({ results: [{ apr: '0.31536' }] }), { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] }[];
    const results = calls.map((call) => {
      const selector = call.params[0].data;
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                  : null;
      return { jsonrpc: '2.0', id: call.id, result };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  }) as typeof fetch;

  try {
    const [rate] = await skyAdapter.resolve([{
      chainId: 1,
      address: USDS,
      leg: 'supply',
      itemHasBorrows: false,
      itemAdapterId: 'sky_proxy_staked',
      itemPoolId: FARM,
      itemRewardTokens: [GROVE],
      itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
      itemRewards: [{
        address: GROVE,
        symbol: 'GROVE',
        amount: 1,
        usd: 0.01,
        priceUsd: 0.01,
        decimals: 18,
      }],
    }]);

    assert.equal(rate?.baseApy, 0);
    assert.ok(Math.abs((rate?.rewardApr ?? 0) - 0.31536) < 1e-12);
    assert.equal(rate?.rewardState, 'numeric-known');
    assert.equal(rate?.rewardComponents?.[0]?.label, 'GROVE');
    assert.equal(rate?.rewardComponents?.[0]?.rateKind, 'apr');
    assert.equal(rate?.source, 'sky:official-farm-api + onchain-identity');
    assert.equal(llamaCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky exact farm remains numeric with an empty DeBank reward list and shares cold loads', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  let baCalls = 0;
  let chainlogCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('chainlog.skyeco.com')) {
      chainlogCalls += 1;
      return new Response('{}', { status: 200 });
    }
    if (url.includes('info-sky.blockanalitica.com')) {
      baCalls += 1;
      return new Response(JSON.stringify({ results: [{ apr: '0.1' }] }), { status: 200 });
    }
    if (url.includes('yields.llama.fi')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    rpcCalls += 1;
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] }[];
    return new Response(JSON.stringify(calls.map((call) => {
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    })), { status: 200 });
  }) as typeof fetch;

  const query = {
    chainId: 1,
    address: USDS,
    leg: 'supply' as const,
    itemHasBorrows: false,
    itemAdapterId: 'sky_proxy_staked',
    itemPoolId: FARM,
    itemRewardTokens: [],
    itemRewards: [],
    itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
  };
  try {
    const rates = await skyAdapter.resolve(Array.from({ length: 8 }, () => ({ ...query })));
    assert.ok(rates.every((rate) => rate?.rewardApr === 0.1));
    assert.ok(rates.every((rate) => rate?.rewardComponents?.[0]?.label === 'GROVE'));
    assert.equal(chainlogCalls, 0);
    assert.equal(rpcCalls, 2);
    assert.equal(baCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky farm stays unknown when BA and onchain pricing fail instead of borrowing a Llama row', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  let llamaCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('info-sky.blockanalitica.com')) {
      return new Response('unavailable', { status: 503 });
    }
    if (url.includes('yields.llama.fi')) {
      llamaCalls += 1;
      return new Response(JSON.stringify({
        data: [{
          chain: 'Ethereum',
          project: 'sky-lending',
          underlyingTokens: [USDS],
          apyBase: null,
          apyReward: 77,
          rewardTokens: [GROVE],
          pool: 'unrelated-uuid',
        }],
      }), { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] }[];
    return new Response(JSON.stringify(calls.map((call) => {
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    })), { status: 200 });
  }) as typeof fetch;

  try {
    const [rate] = await skyAdapter.resolve([{
      chainId: 1,
      address: USDS,
      leg: 'supply',
      itemHasBorrows: false,
      itemAdapterId: 'sky_proxy_staked',
      itemPoolId: FARM,
      itemRewardTokens: [],
      itemRewards: [],
      itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
    }]);
    assert.equal(rate?.rewardState, 'unknown');
    assert.equal(rate?.rewardApr, null);
    assert.equal(llamaCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky optional farm API timeout preserves the calculable onchain APR', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = String(input);
    if (url.includes('info-sky.blockanalitica.com')) {
      return new Promise<Response>((_, reject) => {
        const aborted = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        if (init?.signal?.aborted) aborted();
        else init?.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] }[];
    return Promise.resolve(new Response(JSON.stringify(calls.map((call) => {
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    })), { status: 200 }));
  }) as typeof fetch;

  try {
    const [rate] = await skyAdapter.resolve([{
      chainId: 1,
      address: USDS,
      leg: 'supply',
      itemHasBorrows: false,
      itemAdapterId: 'sky_proxy_staked',
      itemPoolId: FARM,
      itemRewardTokens: [GROVE],
      itemRewards: [{
        address: GROVE,
        symbol: 'GROVE',
        amount: 1,
        usd: 0.01,
        priceUsd: 0.01,
        decimals: 18,
      }],
      itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
    }]);
    assert.ok(Math.abs((rate?.rewardApr ?? 0) - 3.1536) < 1e-12);
    assert.equal(rate?.rewardState, 'numeric-known');
    assert.equal(rate?.source, 'sky:onchain-farm');
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky discovery balance failure does not erase an independent exact farm result', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('chainlog.skyeco.com')) {
      return new Response(JSON.stringify({ REWARDS_USDS_GROVE: FARM }), { status: 200 });
    }
    if (url.includes('info-sky.blockanalitica.com')) {
      return new Response(JSON.stringify({ results: [{ apr: '0.1' }] }), { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] }[];
    if (calls.some((call) => call.params[0].data.startsWith('0x70a08231'))) {
      return new Response('balance unavailable', { status: 503 });
    }
    return new Response(JSON.stringify(calls.map((call) => {
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    })), { status: 200 });
  }) as typeof fetch;

  const base = {
    chainId: 1,
    address: USDS,
    leg: 'supply' as const,
    itemHasBorrows: false,
    itemAdapterId: 'sky_proxy_staked',
    itemRewardTokens: [] as string[],
    itemRewards: [],
    itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
  };
  try {
    const [exact, discovery] = await skyAdapter.resolve([
      { ...base, itemPoolId: FARM },
      { ...base, userAddress: USER },
    ]);
    assert.equal(exact?.rewardApr, 0.1);
    assert.equal(exact?.rewardState, 'numeric-known');
    assert.equal(discovery?.baseApy, 0);
    assert.equal(discovery?.rewardApr, null);
    assert.equal(discovery?.rewardState, 'unknown');
    assert.equal(discovery?.source, 'sky农场查询失败');
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky cancelled generation cannot evict an immediately retried shared load', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  type PendingRpc = {
    body: string;
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
  };
  const pending: PendingRpc[] = [];
  let rpcCalls = 0;
  let baCalls = 0;
  const rpcResponse = (body: string): Response => {
    const calls = JSON.parse(body) as { id: number; params: [{ data: string }] }[];
    return new Response(JSON.stringify(calls.map((call) => {
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    })), { status: 200 });
  };
  globalThis.fetch = ((input, init) => {
    const url = String(input);
    if (url.includes('info-sky.blockanalitica.com')) {
      baCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ results: [{ apr: '0.1' }] }), { status: 200 }));
    }
    rpcCalls += 1;
    return new Promise<Response>((resolve, reject) => {
      const row = { body: String(init?.body), resolve, reject };
      pending.push(row);
      const aborted = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) aborted();
      else init?.signal?.addEventListener('abort', aborted, { once: true });
    });
  }) as typeof fetch;
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let index = 0; index < 100 && !predicate(); index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(predicate(), true);
  };
  const query = {
    chainId: 1,
    address: USDS,
    leg: 'supply' as const,
    itemHasBorrows: false,
    itemAdapterId: 'sky_proxy_staked',
    itemPoolId: FARM,
    itemRewardTokens: [] as string[],
    itemRewards: [],
    itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
  };
  try {
    const firstController = new AbortController();
    const first = skyAdapter.resolve([query], firstController.signal);
    await waitFor(() => pending.length === 1);
    firstController.abort(new DOMException('first left', 'AbortError'));
    const second = skyAdapter.resolve([query]);
    await assert.rejects(first, /first left|abort/i);
    await waitFor(() => pending.length === 2);
    const third = skyAdapter.resolve([query]);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.equal(rpcCalls, 2);

    pending[1].resolve(rpcResponse(pending[1].body));
    await waitFor(() => pending.length === 3);
    pending[2].resolve(rpcResponse(pending[2].body));
    const [secondRates, thirdRates] = await Promise.all([second, third]);
    assert.equal(secondRates[0]?.rewardApr, 0.1);
    assert.equal(thirdRates[0]?.rewardApr, 0.1);
    assert.equal(rpcCalls, 3);
    assert.equal(baCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky exact pool mismatch fails closed without discovering a different farm', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  const wrongStaking = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let chainlogCalls = 0;
  let baCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('chainlog.skyeco.com')) {
      chainlogCalls += 1;
      return new Response(JSON.stringify({ REWARDS_USDS_GROVE: FARM }), { status: 200 });
    }
    if (url.includes('info-sky.blockanalitica.com')) {
      baCalls += 1;
      return new Response(JSON.stringify({ results: [{ apr: '0.1' }] }), { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] }[];
    return new Response(JSON.stringify(calls.map((call) => {
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(wrongStaking)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    })), { status: 200 });
  }) as typeof fetch;

  try {
    const [rate] = await skyAdapter.resolve([{
      chainId: 1,
      address: USDS,
      leg: 'supply',
      itemHasBorrows: false,
      itemAdapterId: 'sky_proxy_staked',
      itemPoolId: FARM,
      userAddress: USER,
      itemRewardTokens: [GROVE],
      itemRewards: [],
      itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
    }]);
    assert.equal(rate?.rewardState, 'unknown');
    assert.equal(rate?.rewardApr, null);
    assert.equal(chainlogCalls, 0);
    assert.equal(baCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky savings resolves an exact share token without collapsing sUSDS and stUSDS by underlying', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  let llamaCalls = 0;
  const ssrPerSecond = Math.expm1(Math.log1p(0.036) / (365 * 24 * 60 * 60));
  const strPerSecond = Math.expm1(Math.log1p(0.0699) / (365 * 24 * 60 * 60));
  const ssr = 10n ** 27n + BigInt((ssrPerSecond * 1e27).toFixed(0));
  const str = 10n ** 27n + BigInt((strPerSecond * 1e27).toFixed(0));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('yields.llama.fi')) {
      llamaCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)) as {
      id: number;
      params: [{ to: string; data: string }];
    }[];
    return new Response(JSON.stringify(calls.map((call) => ({
      jsonrpc: '2.0',
      id: call.id,
      ...(call.params[0].data === '0x38d52e0f'
        ? { result: addressHex(USDS) }
        : call.params[0].data === '0x03607ceb' && call.params[0].to.toLowerCase() === SUSDS
          ? { result: hex(ssr) }
          : call.params[0].data === '0xc15bae84' && call.params[0].to.toLowerCase() === STUSDS
            ? { result: hex(str) }
          : { error: { code: -32_000, message: 'selector unavailable' } }),
    }))), { status: 200 });
  }) as typeof fetch;

  try {
    const [sUsdsRate, stUsdsRate] = await skyAdapter.resolve([
      {
        chainId: 1,
        address: SUSDS,
        leg: 'supply',
        itemHasBorrows: false,
        itemAdapterId: 'sky_savings',
      },
      {
        chainId: 1,
        address: STUSDS,
        leg: 'supply',
        itemHasBorrows: false,
        itemAdapterId: 'sky_savings',
      },
    ]);
    assert.ok(Math.abs((sUsdsRate?.baseApy ?? 0) - 0.036) < 1e-8);
    assert.ok(Math.abs((stUsdsRate?.baseApy ?? 0) - 0.0699) < 1e-8);
    assert.equal(sUsdsRate?.rewardState, 'not-applicable');
    assert.equal(stUsdsRate?.rewardState, 'not-applicable');
    assert.equal(sUsdsRate?.includesIntrinsicYield, true);
    assert.equal(stUsdsRate?.includesIntrinsicYield, true);
    assert.match(sUsdsRate?.source ?? '', /sky:ssr:onchain/);
    assert.match(stUsdsRate?.source ?? '', /sky:str:onchain/);
    assert.equal(llamaCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});

test('Sky farm discovery uses Chainlog, wallet balance and item amount to disambiguate same-token farms', async () => {
  __resetLlamaCacheForTests();
  __resetSkyFarmCacheForTests();
  const originalFetch = globalThis.fetch;
  const otherFarm = '0x1111111111111111111111111111111111111111';
  let llamaCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('chainlog.skyeco.com')) {
      return new Response(JSON.stringify({
        REWARDS_USDS_GROVE: FARM,
        REWARDS_USDS_GROVE_ALT: otherFarm,
        REWARDS_DIST_USDS_GROVE: '0x2222222222222222222222222222222222222222',
      }), { status: 200 });
    }
    if (url.includes('info-sky.blockanalitica.com')) {
      assert.ok(url.toLowerCase().includes(FARM));
      return new Response(JSON.stringify({ results: [{ apr: '0.10484453' }] }), { status: 200 });
    }
    if (url.includes('yields.llama.fi')) {
      llamaCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const calls = JSON.parse(String(init?.body)) as {
      id: number;
      params: [{ to: string; data: string }];
    }[];
    const results = calls.map((call) => {
      const to = call.params[0].to.toLowerCase();
      const selector = call.params[0].data.slice(0, 10);
      const result = selector === '0x72f702f3'
        ? addressHex(USDS)
        : selector === '0xd1af0c7d'
          ? addressHex(GROVE)
          : selector === '0x7b0a47ee'
            ? hex(10n ** 16n)
            : selector === '0xebe2b12b'
              ? hex(2_000_000_000n)
              : selector === '0x18160ddd'
                ? hex(1_000n * 10n ** 18n)
                : selector === '0x313ce567'
                  ? hex(18n)
                  : selector === '0x95d89b41'
                    ? bytes32Hex('GROVE')
                  : selector === '0x70a08231'
                    ? hex((to === FARM ? 100n : 200n) * 10n ** 18n)
                    : null;
      return { jsonrpc: '2.0', id: call.id, result };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  }) as typeof fetch;

  try {
    const [rate] = await skyAdapter.resolve([{
      chainId: 1,
      address: USDS,
      leg: 'supply',
      itemHasBorrows: false,
      itemAdapterId: 'sky_proxy_staked',
      userAddress: USER,
      itemRewardTokens: [GROVE],
      itemSupplies: [{ address: USDS, amount: 100, usd: 100, priceUsd: 1, decimals: 18 }],
      itemRewards: [{
        address: GROVE,
        symbol: 'GROVE',
        amount: 1,
        usd: 0.01,
        priceUsd: 0.01,
        decimals: 18,
      }],
    }]);
    assert.equal(rate?.rewardApr, 0.10484453);
    assert.equal(rate?.rewardComponents?.[0]?.label, 'GROVE');
    assert.equal(rate?.rewardComponents?.[0]?.rateKind, 'apr');
    assert.equal(llamaCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
    __resetSkyFarmCacheForTests();
  }
});
