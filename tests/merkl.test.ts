import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetMerklCachesForTests,
  discoverMerklOpportunities,
  matchMerklRewards,
  merklClaimable,
  normalizeMerklOpportunity,
  type MerklDiscovery,
} from '../utils/adapters/merkl';
import { fetchWithTimeout } from '../utils/http';

const USDE = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34';
const REWARD = '0x6ff492ec3bb2af03eab5a5765383c3451bf744e2';
const BASE_MARKET = '0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354';
const OTHER_MARKET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CLAIM_WALLET = '0x00000000000000000000000000000000000000ff';
const CLAIM_TOKEN = '0x00000000000000000000000000000000000000aa';

function claimReward({
  amount = '1000000',
  claimed = '0',
  price = 1,
  decimals = 6,
  symbol = 'RWD',
  recipient = CLAIM_WALLET,
  chainId = 1,
  root = `0x${'1'.repeat(64)}`,
  tokenAddress = CLAIM_TOKEN,
}: {
  amount?: string;
  claimed?: string;
  price?: number;
  decimals?: number;
  symbol?: string;
  recipient?: string;
  chainId?: number;
  root?: string;
  tokenAddress?: string;
} = {}) {
  return {
    amount,
    claimed,
    recipient,
    distributionChainId: chainId,
    root,
    token: { address: tokenAddress, decimals, price, symbol },
  };
}

function rawOpportunity({
  id,
  marketId = BASE_MARKET,
  chainId = 8453,
  apr = 4.5,
  campaignId = `campaign-${id}`,
  type = 'MORPHOCOLLATERAL',
  action = 'LEND',
  identifier = marketId.slice(0, 42),
  depositUrl = `https://app.morpho.org/base/market/${marketId}`,
}: {
  id: string;
  marketId?: string;
  chainId?: number;
  apr?: number;
  campaignId?: string;
  type?: string;
  action?: string;
  identifier?: string;
  depositUrl?: string;
}) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id,
    chainId,
    protocol: { id: 'morpho' },
    type,
    action,
    identifier,
    status: 'LIVE',
    apr,
    depositUrl,
    earliestCampaignStart: String(now - 60),
    latestCampaignEnd: String(now + 3_600),
    tokens: [{ address: USDE }],
    aprRecord: {
      timestamp: String(now),
      breakdowns: [{ identifier: campaignId, type: 'CAMPAIGN', value: apr }],
    },
    rewardsRecord: {
      breakdowns: [
        {
          onChainCampaignId: campaignId,
          campaignId,
          token: { address: REWARD, symbol: 'USDe' },
        },
      ],
    },
  };
}

test('Merkl matches protocol, chain, type, action, asset and exact container, then deduplicates campaigns', () => {
  const rows = [
    rawOpportunity({ id: 'one', apr: 2, campaignId: 'campaign-a' }),
    rawOpportunity({ id: 'duplicate', apr: 2, campaignId: 'campaign-a' }),
    rawOpportunity({ id: 'two', apr: 2.5, campaignId: 'campaign-b' }),
    rawOpportunity({ id: 'wrong-market', marketId: OTHER_MARKET, apr: 9 }),
  ];
  const opportunities = rows.map((row) => normalizeMerklOpportunity(row, 8453, 'morpho')).filter((x) => x !== null);
  const discovery: MerklDiscovery = {
    state: 'complete',
    opportunities,
    observedAt: Date.now(),
  };

  const matched = matchMerklRewards(discovery, {
    chainId: 8453,
    protocolId: 'morpho',
    opportunityType: 'MORPHOCOLLATERAL',
    action: 'LEND',
    containerId: `market:${BASE_MARKET}`,
    assetAddress: USDE,
    basis: 'collateral',
  });

  assert.equal(matched.rewardState, 'numeric-known');
  assert.equal(matched.rewardApr, 0.045);
  assert.equal(matched.rewardComponents.length, 2);
  assert.deepEqual(matched.rewardComponents.map((x) => x.id).sort(), [
    'merkl:8453:campaign-a',
    'merkl:8453:campaign-b',
  ]);
  assert.equal(
    matched.rewardComponents.find((component) => component.id === 'merkl:8453:campaign-a')?.sourceUrl,
    'https://app.merkl.xyz/opportunities/one',
  );

  const wrongContainer = matchMerklRewards(discovery, {
    chainId: 8453,
    protocolId: 'morpho',
    opportunityType: 'MORPHOCOLLATERAL',
    action: 'LEND',
    containerId: `market:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    assetAddress: USDE,
    basis: 'collateral',
  });
  assert.equal(wrongContainer.rewardState, 'unknown');
  assert.equal(wrongContainer.rewardApr, null);
});

test('Merkl normalization rejects non-finite, unknown, gated and unsafe opportunities', () => {
  assert.equal(normalizeMerklOpportunity(rawOpportunity({ id: 'nan', apr: Number.NaN }), 8453, 'morpho'), null);
  assert.equal(
    normalizeMerklOpportunity(rawOpportunity({ id: 'unknown', type: 'UNREVIEWED_TYPE' }), 8453, 'morpho'),
    null,
  );
  assert.equal(
    normalizeMerklOpportunity(
      rawOpportunity({ id: 'gated', identifier: `${BASE_MARKET.slice(0, 42)}WHITELIST_CAMPAIGN` }),
      8453,
      'morpho',
    ),
    null,
  );
  assert.equal(
    normalizeMerklOpportunity(rawOpportunity({ id: 'unsafe', depositUrl: `javascript:${BASE_MARKET}` }), 8453, 'morpho'),
    null,
  );

  const mixedPoints = rawOpportunity({ id: 'mixed', apr: 5, campaignId: 'token-campaign' });
  mixedPoints.aprRecord.breakdowns.push({ identifier: 'points-campaign', type: 'CAMPAIGN', value: 3 });
  assert.equal(normalizeMerklOpportunity(mixedPoints, 8453, 'morpho'), null);
});

test('Merkl HTTP failure is unknown rather than confirmed zero', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('upstream unavailable', { status: 503 })) as typeof fetch;
  try {
    const discovery = await discoverMerklOpportunities(8453, 'morpho');
    assert.equal(discovery.state, 'unknown');
    const matched = matchMerklRewards(discovery, {
      chainId: 8453,
      protocolId: 'morpho',
      opportunityType: 'MORPHOCOLLATERAL',
      action: 'LEND',
      containerId: `market:${BASE_MARKET}`,
      assetAddress: USDE,
      basis: 'collateral',
    });
    assert.equal(matched.rewardState, 'unknown');
    assert.equal(matched.rewardApr, null);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});
test('concurrent Merkl opportunity discovery shares one cancellation-safe keyed load', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  try {
    const [first, second] = await Promise.all([
      discoverMerklOpportunities(8453, 'morpho'),
      discoverMerklOpportunities(8453, 'morpho'),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.state, 'complete');
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl pagination stops at the five-page budget and marks completeness unknown', async () => {
  __resetMerklCachesForTests();
  const page = Array.from({ length: 100 }, (_, i) => rawOpportunity({ id: `row-${i}` }));
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const discovery = await discoverMerklOpportunities(9_999_991, 'morpho');
    assert.equal(calls, 5);
    assert.equal(discovery.state, 'unknown');
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl applies one cumulative 2MiB discovery budget across pages', async () => {
  __resetMerklCachesForTests();
  const page = Array.from({ length: 100 }, (_, index) => ({
    ...rawOpportunity({ id: `large-${index}` }),
    ignoredPadding: 'x'.repeat(11_000),
  }));
  const encoded = JSON.stringify(page);
  assert.ok(new TextEncoder().encode(encoded).byteLength < 2 * 1024 * 1024);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(encoded, { status: 200 });
  }) as typeof fetch;
  try {
    const discovery = await discoverMerklOpportunities(9_999_992, 'morpho');
    assert.equal(calls, 2);
    assert.equal(discovery.state, 'unknown');
    assert.match(discovery.state === 'unknown' ? discovery.reason : '', /byte budget/i);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable requests are wallet-scoped, signal-bound and reserve HTTP capacity for APY sources', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  const seen = new Set<string>();
  globalThis.fetch = (async (input, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    assert.ok(init?.signal instanceof AbortSignal);
    seen.add(String(input));
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await merklClaimable(
      '0x00000000000000000000000000000000000000ff',
      [1, 10, 56, 100, 137, 8453, 42161, 43114],
    );
    assert.equal(result.totalUsd, 0);
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(result.failedChains, []);
    assert.deepEqual(result.failures, []);
    assert.equal(maxActive, 2);
    assert.equal(seen.size, 8);
    assert.ok([...seen].every((url) => url.includes('/0x00000000000000000000000000000000000000ff/')));
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('two concurrent wallets share two global Merkl slots and leave capacity for rate sources', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  let activeMerkl = 0;
  let maxActiveMerkl = 0;
  let merklStarts = 0;
  globalThis.fetch = ((input, init) => {
    const url = String(input);
    if (!url.includes('api.merkl.xyz')) return Promise.resolve(new Response('rate-ok'));
    merklStarts += 1;
    activeMerkl += 1;
    maxActiveMerkl = Math.max(maxActiveMerkl, activeMerkl);
    return new Promise<Response>((_, reject) => {
      const aborted = () => {
        activeMerkl -= 1;
        reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
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
  try {
    const claims = [
      merklClaimable(
        '0x00000000000000000000000000000000000000ff',
        [1, 10],
        undefined,
        30,
      ),
      merklClaimable(
        '0x00000000000000000000000000000000000000ee',
        [1, 10],
        undefined,
        30,
      ),
    ];
    await waitFor(() => merklStarts === 2);
    const probes = await Promise.all([
      fetchWithTimeout('https://rate-source.invalid/one', {}, 100),
      fetchWithTimeout('https://rate-source.invalid/two', {}, 100),
    ]);
    assert.deepEqual(await Promise.all(probes.map((response) => response.text())), ['rate-ok', 'rate-ok']);
    const results = await Promise.all(claims);
    assert.ok(results.every((result) => result.coverage === 'unknown'));
    assert.equal(maxActiveMerkl, 2);
    assert.ok(merklStarts >= 2 && merklStarts <= 4);
    assert.ok(results.every((result) => result.failedChains.join(',') === '1,10'));
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('same wallet and chain set share one cancellation-safe Merkl load', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify([{
      chain: { id: 1 },
      rewards: [claimReward()],
    }]), { status: 200 });
  }) as typeof fetch;
  try {
    const args = [
      '0x00000000000000000000000000000000000000ff',
      [1],
    ] as const;
    const [first, second] = await Promise.all([
      merklClaimable(args[0], [...args[1]]),
      merklClaimable(args[0], [...args[1]]),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.coverage, 'complete');
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('slower partial Merkl refresh cannot overwrite a concurrent complete snapshot', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_, init) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(new Response(JSON.stringify([{
        chain: { id: 1 },
        rewards: [claimReward()],
      }]), { status: 200 }));
    }
    return new Promise<Response>((_, reject) => {
      const aborted = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) aborted();
      else init?.signal?.addEventListener('abort', aborted, { once: true });
    });
  }) as typeof fetch;
  try {
    const wallet = '0x00000000000000000000000000000000000000ff';
    const [complete, slower] = await Promise.all([
      merklClaimable(wallet, [1], undefined, 100),
      merklClaimable(wallet, [1], undefined, 30),
    ]);
    assert.equal(calls, 2);
    assert.equal(complete.coverage, 'complete');
    assert.deepEqual(slower, complete);
    assert.deepEqual(await merklClaimable(wallet, [1]), complete);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable keeps partial and failed-chain coverage explicit', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) =>
    new URL(String(input)).searchParams.get('chainId') === '1'
      ? new Response('[]', { status: 200 })
      : new Response('unavailable', { status: 503 })) as typeof fetch;
  try {
    const result = await merklClaimable(
      '0x00000000000000000000000000000000000000ff',
      [1, 10],
    );
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.failedChains, [10]);
    assert.deepEqual(result.failures, [{ chainId: 10, reason: 'http', status: 503 }]);
    assert.equal(result.totalUsd, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable classifies bounded transport and parse failures', async () => {
  const originalFetch = globalThis.fetch;
  const cases: {
    reason: 'invalid-json' | 'invalid-shape' | 'response-too-large' | 'network';
    response: () => Promise<Response>;
  }[] = [
    { reason: 'invalid-json', response: async () => new Response('{', { status: 200 }) },
    { reason: 'invalid-shape', response: async () => new Response('{}', { status: 200 }) },
    {
      reason: 'response-too-large',
      response: async () => new Response('x', {
        status: 200,
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
    },
    { reason: 'network', response: async () => { throw new TypeError('offline'); } },
  ];
  try {
    for (const fixture of cases) {
      __resetMerklCachesForTests();
      globalThis.fetch = fixture.response as typeof fetch;
      const result = await merklClaimable(
        '0x00000000000000000000000000000000000000ff',
        [1],
      );
      assert.equal(result.coverage, 'unknown');
      assert.deepEqual(result.failures, [{ chainId: 1, reason: fixture.reason }]);
    }
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl total budget preserves successful chains and marks unfinished chains timeout', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const chainId = new URL(String(input)).searchParams.get('chainId');
    if (chainId === '1') {
      return Promise.resolve(new Response(JSON.stringify([{
        chain: { id: 1 },
        rewards: [claimReward({ amount: '2000000' })],
      }]), { status: 200 }));
    }
    return new Promise<Response>((_, reject) => {
      const aborted = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) aborted();
      else init?.signal?.addEventListener('abort', aborted, { once: true });
    });
  }) as typeof fetch;
  try {
    const result = await merklClaimable(
      '0x00000000000000000000000000000000000000ff',
      [1, 2, 3, 4, 5],
      undefined,
      25,
    );
    assert.equal(result.coverage, 'partial');
    assert.equal(result.totalUsd, 2);
    assert.deepEqual(result.failedChains, [2, 3, 4, 5]);
    assert.deepEqual(result.failures, [2, 3, 4, 5].map((chainId) => ({
      chainId,
      reason: 'timeout',
    })));
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable preserves a known subtotal but marks malformed reward rows partial', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([
    {
      chain: { id: 1 },
      rewards: [
        {
          ...claimReward({ amount: '2000000' }),
        },
        {
          ...claimReward({ amount: '1000000', root: `0x${'2'.repeat(64)}` }),
          token: { address: CLAIM_TOKEN, decimals: 6, symbol: 'BROKEN' },
        },
      ],
    },
  ]), { status: 200 })) as typeof fetch;
  try {
    const result = await merklClaimable(
      '0x00000000000000000000000000000000000000ff',
      [1],
    );
    assert.equal(result.totalUsd, 2);
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.failedChains, [1]);
    assert.deepEqual(result.failures, [{ chainId: 1, reason: 'invalid-reward' }]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable rejects a valid-shaped response for the wrong chain', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    chain: { id: 8453 },
    rewards: [claimReward({ amount: '2000000', chainId: 8453 })],
  }]), { status: 200 })) as typeof fetch;
  try {
    const result = await merklClaimable(
      '0x00000000000000000000000000000000000000ff',
      [1],
    );
    assert.equal(result.totalUsd, 0);
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(result.failures, [{ chainId: 1, reason: 'invalid-shape' }]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable rejects duplicate chain rows and non-finite reward arithmetic', async () => {
  const originalFetch = globalThis.fetch;
  const wallet = '0x00000000000000000000000000000000000000ff';
  const validRow = {
    chain: { id: 1 },
    rewards: [claimReward()],
  };
  try {
    __resetMerklCachesForTests();
    globalThis.fetch = (async () => new Response(JSON.stringify([
      validRow,
      validRow,
    ]), { status: 200 })) as typeof fetch;
    const duplicate = await merklClaimable(wallet, [1]);
    assert.equal(duplicate.totalUsd, 0);
    assert.equal(duplicate.coverage, 'unknown');
    assert.deepEqual(duplicate.failures, [{ chainId: 1, reason: 'invalid-shape' }]);

    __resetMerklCachesForTests();
    globalThis.fetch = (async () => new Response(JSON.stringify([{
      chain: { id: 1 },
      rewards: [claimReward({
        amount: ((1n << 256n) - 1n).toString(),
        decimals: 0,
        price: Number.MAX_VALUE,
        symbol: 'BROKEN',
      })],
    }]), { status: 200 })) as typeof fetch;
    const overflow = await merklClaimable(wallet, [1]);
    assert.equal(overflow.totalUsd, 0);
    assert.equal(overflow.coverage, 'unknown');
    assert.deepEqual(overflow.failures, [{ chainId: 1, reason: 'invalid-reward' }]);

    __resetMerklCachesForTests();
    globalThis.fetch = (async () => new Response(JSON.stringify([{
      chain: { id: 1 },
      rewards: [claimReward({
        recipient: '0x00000000000000000000000000000000000000ee',
      })],
    }]), { status: 200 })) as typeof fetch;
    const wrongRecipient = await merklClaimable(wallet, [1]);
    assert.equal(wrongRecipient.totalUsd, 0);
    assert.equal(wrongRecipient.coverage, 'unknown');
    assert.deepEqual(wrongRecipient.failures, [{ chainId: 1, reason: 'invalid-reward' }]);

    __resetMerklCachesForTests();
    globalThis.fetch = (async () => new Response(JSON.stringify([{
      chain: { id: 1 },
      rewards: [claimReward(), claimReward()],
    }]), { status: 200 })) as typeof fetch;
    const duplicateReward = await merklClaimable(wallet, [1]);
    assert.equal(duplicateReward.totalUsd, 1);
    assert.equal(duplicateReward.coverage, 'partial');
    assert.deepEqual(duplicateReward.failures, [{ chainId: 1, reason: 'invalid-reward' }]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});

test('Merkl claimable total includes valid sub-dollar rows even when top list filters them', async () => {
  __resetMerklCachesForTests();
  const originalFetch = globalThis.fetch;
  const small = Array.from({ length: 100 }, (_, index) => claimReward({
    amount: '400000',
    symbol: 'DUST',
    root: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  }));
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    chain: { id: 1 },
    rewards: small,
  }]), { status: 200 })) as typeof fetch;
  try {
    const result = await merklClaimable(
      '0x00000000000000000000000000000000000000ff',
      [1],
    );
    assert.ok(Math.abs(result.totalUsd - 40) < 1e-9);
    assert.deepEqual(result.top, []);
    assert.equal(result.coverage, 'complete');
  } finally {
    globalThis.fetch = originalFetch;
    __resetMerklCachesForTests();
  }
});
