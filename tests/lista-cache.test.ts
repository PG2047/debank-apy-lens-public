import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __resetListaCacheForTests,
  listaVaultInfo,
} from '../utils/adapters/onchain.ts';

const VAULT = '0x00000000000000000000000000000000000000d1';

test('Lista transient refresh failure keeps prior success and retries after the 30s error TTL', async () => {
  __resetListaCacheForTests();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000_000;
  let calls = 0;
  let mode: 'first' | 'fail' | 'recover' = 'first';
  Date.now = () => now;
  globalThis.fetch = (async () => {
    calls += 1;
    if (mode === 'fail') return new Response('unavailable', { status: 503 });
    const apy = mode === 'recover' ? '0.04' : '0.03';
    return new Response(JSON.stringify({
      data: { list: [{ address: VAULT, apy, emissionApy: '0.01', marketIds: [] }] },
    }));
  }) as typeof fetch;

  try {
    assert.equal((await listaVaultInfo(VAULT))?.apy, 0.03);
    now += 30 * 60 * 1_000 + 1;
    mode = 'fail';
    assert.equal((await listaVaultInfo(VAULT))?.apy, 0.03);
    assert.equal(calls, 2);

    now += 29_000;
    assert.equal((await listaVaultInfo(VAULT))?.apy, 0.03);
    assert.equal(calls, 2);

    now += 1_001;
    mode = 'recover';
    assert.equal((await listaVaultInfo(VAULT))?.apy, 0.04);
    assert.equal(calls, 3);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    __resetListaCacheForTests();
  }
});
