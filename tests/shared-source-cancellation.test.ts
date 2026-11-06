import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __resetLlamaCacheForTests,
  llamaProjectPools,
} from '../utils/adapters/defillama.ts';
import {
  __resetListaCacheForTests,
  listaVaultInfo,
} from '../utils/adapters/onchain.ts';

const VAULT = '0x00000000000000000000000000000000000000d1';

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

test('DeFiLlama cold load survives one subscriber abort and still serves the other', async () => {
  __resetLlamaCacheForTests();
  const originalFetch = globalThis.fetch;
  const project = 'shared-load-one-subscriber-aborts';
  const pending: Array<{
    url: string;
    signal: AbortSignal;
    resolve: (response: Response) => void;
  }> = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  globalThis.fetch = ((input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      pending.push({ url: String(input), signal, resolve });
      if (pending.length === 2) markStarted();
    })) as typeof fetch;

  const firstController = new AbortController();
  const secondController = new AbortController();
  try {
    const first = llamaProjectPools(project, firstController.signal);
    const second = llamaProjectPools(project, secondController.signal);
    await started;

    firstController.abort(new DOMException('first tab navigated', 'AbortError'));
    await assert.rejects(first, isAbortError);
    assert.equal(pending.length, 2);
    assert.ok(pending.every(({ signal }) => !signal.aborted));

    const pool = {
      project,
      chain: 'Ethereum',
      underlyingTokens: [VAULT],
      pool: `${project}-pool`,
      poolMeta: null,
      apyBase: 5,
    };
    for (const request of pending) {
      request.resolve(
        new Response(
          JSON.stringify(request.url.includes('/lendBorrow') ? [] : { data: [pool] }),
        ),
      );
    }

    assert.deepEqual(await second, [pool]);
    assert.equal(secondController.signal.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLlamaCacheForTests();
  }
});

test('Lista aborts shared cold work only after every subscriber cancels and permits a fresh load', async () => {
  __resetListaCacheForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  globalThis.fetch = ((_, init) => {
    calls += 1;
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    if (calls > 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { list: [{ address: VAULT, apy: '0.04', emissionApy: '0.01', marketIds: [] }] },
          }),
        ),
      );
    }

    firstSignal = signal;
    markStarted();
    return new Promise<Response>((_, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;

  const firstController = new AbortController();
  const secondController = new AbortController();
  try {
    const first = listaVaultInfo(VAULT, firstController.signal);
    const second = listaVaultInfo(VAULT, secondController.signal);
    await started;

    firstController.abort(new DOMException('first tab navigated', 'AbortError'));
    await assert.rejects(first, isAbortError);
    assert.equal(firstSignal?.aborted, false);
    assert.equal(calls, 1);

    secondController.abort(new DOMException('second tab navigated', 'AbortError'));
    await assert.rejects(second, isAbortError);
    assert.equal(firstSignal?.aborted, true);

    assert.equal((await listaVaultInfo(VAULT))?.apy, 0.04);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetListaCacheForTests();
  }
});
