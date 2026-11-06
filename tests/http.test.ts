import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchWithTimeout, withDeadline } from '../utils/http.ts';

test('source and card deadlines reject non-cooperative never-resolving work', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  try {
    await assert.rejects(fetchWithTimeout('https://example.invalid', {}, 5), /timed out/i);
    let cardAborted = false;
    await assert.rejects(
      withDeadline(
        (signal) => new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            cardAborted = true;
            reject(signal.reason);
          }, { once: true });
        }),
        5,
        'card',
      ),
      /card timed out/i,
    );
    assert.equal(cardAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP limiter remains held until response body EOF', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  let started = 0;
  globalThis.fetch = (async () => {
    started += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodies.push(controller);
      },
    }));
  }) as typeof fetch;

  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100 && !predicate(); index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(predicate(), true);
  };

  try {
    const first = Array.from({ length: 4 }, (_, index) =>
      fetchWithTimeout(`https://example.invalid/eof-${index}`, {}, 1_000));
    const fifth = fetchWithTimeout('https://example.invalid/eof-fifth', {}, 1_000);
    await waitFor(() => started === 4);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(started, 4);

    bodies[0].enqueue(new TextEncoder().encode('ok'));
    bodies[0].close();
    await waitFor(() => started === 5);
    for (const body of bodies.slice(1)) body.close();
    const responses = await Promise.all([...first, fifth]);
    assert.equal(await responses[0].text(), 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Content-Length and chunked bodies are rejected within the byte budget', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }), { headers: { 'content-length': '9' } })) as typeof fetch;
    await assert.rejects(
      fetchWithTimeout('https://example.invalid/content-length', {}, 1_000, 8),
      /exceeds 8 byte limit/i,
    );
    assert.equal(cancelled, true);

    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
      },
      cancel() {
        cancelled = true;
      },
    }))) as typeof fetch;
    cancelled = false;
    await assert.rejects(
      fetchWithTimeout('https://example.invalid/chunked', {}, 1_000, 7),
      /exceeds 7 byte limit/i,
    );
    assert.equal(cancelled, true);

    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4_097; index += 1) {
          controller.enqueue(new Uint8Array([index & 0xff]));
        }
      },
      cancel() {
        cancelled = true;
      },
    }))) as typeof fetch;
    cancelled = false;
    await assert.rejects(
      fetchWithTimeout('https://example.invalid/chunk-count', {}, 1_000, 8_192),
      /exceeds 4096 chunk limit/i,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('upstream abort cancels body consumption after headers and releases capacity', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  }))) as typeof fetch;
  try {
    const controller = new AbortController();
    const request = fetchWithTimeout(
      'https://example.invalid/body-abort',
      { signal: controller.signal },
      1_000,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    controller.abort(new DOMException('navigation changed', 'AbortError'));
    await assert.rejects(request, /navigation changed|abort/i);
    assert.equal(cancelled, true);

    globalThis.fetch = (async () => new Response('released')) as typeof fetch;
    assert.equal(await (await fetchWithTimeout('https://example.invalid/probe')).text(), 'released');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP limiter caps six calls at four and queued aborts do not leak capacity', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const releases: Array<() => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    active += 1;
    started += 1;
    maxActive = Math.max(maxActive, active);
    releases.push(() => {
      active -= 1;
      resolve(new Response('ok'));
    });
  })) as typeof fetch;

  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100 && !predicate(); index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(predicate(), true);
  };

  try {
    const first = Array.from({ length: 4 }, (_, index) =>
      fetchWithTimeout(`https://example.invalid/${index}`, {}, 1_000));
    const controller = new AbortController();
    const queuedAbort = fetchWithTimeout(
      'https://example.invalid/queued-abort',
      { signal: controller.signal },
      1_000,
    );
    const sixth = fetchWithTimeout('https://example.invalid/sixth', {}, 1_000);
    await waitFor(() => started === 4);
    controller.abort(new DOMException('queued test abort', 'AbortError'));
    await assert.rejects(queuedAbort, /queued test abort|abort/i);
    assert.equal(started, 4);

    releases.shift()?.();
    await waitFor(() => started === 5);
    assert.equal(maxActive, 4);
    while (releases.length > 0) releases.shift()?.();
    await Promise.all([...first, sixth]);

    const probeStart = started;
    const probes = Array.from({ length: 4 }, (_, index) =>
      fetchWithTimeout(`https://example.invalid/probe-${index}`, {}, 1_000));
    await waitFor(() => started === probeStart + 4);
    assert.equal(maxActive, 4);
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(probes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a queued source receives its full network timeout after acquiring a shared slot', async () => {
  const originalFetch = globalThis.fetch;
  let started = 0;
  const releases: Array<() => void> = [];
  globalThis.fetch = ((input) => {
    started += 1;
    if (String(input).endsWith('/queued')) return Promise.resolve(new Response('queued-ok'));
    return new Promise<Response>((resolve) => {
      releases.push(() => resolve(new Response('released')));
    });
  }) as typeof fetch;

  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100 && !predicate(); index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(predicate(), true);
  };

  try {
    const blockers = Array.from({ length: 4 }, (_, index) =>
      fetchWithTimeout(`https://example.invalid/blocker-${index}`, {}, 100));
    await waitFor(() => started === 4);
    const queued = fetchWithTimeout('https://example.invalid/queued', {}, 5);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    releases.shift()?.();
    assert.equal(await (await queued).text(), 'queued-ok');
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(blockers);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
