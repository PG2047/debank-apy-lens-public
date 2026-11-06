import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureBoundaryError,
  cloneBoundedJson,
  parseBoundedJsonText,
  readBoundedJsonResponse,
} from '../utils/input-boundary.ts';

function hasReason(reason: CaptureBoundaryError['reason']) {
  return (error: unknown) => error instanceof CaptureBoundaryError && error.reason === reason;
}

test('fetch capture reads valid JSON through EOF within the byte budget', async () => {
  const result = await readBoundedJsonResponse(new Response('{"data":[1,2,3]}'), 64);
  assert.deepEqual(result, { data: [1, 2, 3] });
});

test('fetch capture rejects declared and streamed bodies beyond the byte budget', async () => {
  let declaredBodyCancelled = false;
  const declaredStream = new ReadableStream<Uint8Array>({
    cancel() {
      declaredBodyCancelled = true;
    },
  });
  await assert.rejects(
    readBoundedJsonResponse(new Response(declaredStream, { headers: { 'content-length': '65' } }), 64),
    hasReason('payload-too-large'),
  );
  assert.equal(declaredBodyCancelled, true);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(5));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedJsonResponse(new Response(stream), 8),
    hasReason('payload-too-large'),
  );
});

test('fetch capture bounds adversarial tiny-chunk streams and cancels the clone reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([0x20]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readBoundedJsonResponse(new Response(stream), 64, 3),
    hasReason('payload-too-large'),
  );
  assert.equal(cancelled, true);
});

test('XHR text length is checked before malformed JSON parsing', () => {
  assert.throws(() => parseBoundedJsonText('{'.repeat(65), 64), hasReason('payload-too-large'));
  assert.throws(() => parseBoundedJsonText('{', 64), hasReason('malformed-payload'));
  assert.deepEqual(parseBoundedJsonText('{"ok":true}', 64), { ok: true });
});

test('page-message cloning produces a detached bounded JSON value', () => {
  const source = { data: [{ symbol: 'USDe', amount: 1 }], enabled: true };
  const bounded = cloneBoundedJson(source, {
    maxChars: 256,
    maxNodes: 16,
    maxContainerEntries: 8,
    maxDepth: 8,
  });
  assert.equal(bounded.serialized, JSON.stringify(source));
  assert.deepEqual(bounded.value, source);
  assert.notEqual(bounded.value, source);
});

test('page-message cloning stops at string, container, node, and depth limits', () => {
  assert.throws(() => cloneBoundedJson('12345678', { maxChars: 8 }), hasReason('payload-too-large'));
  assert.throws(() => cloneBoundedJson([1, 2, 3], { maxContainerEntries: 2 }), hasReason('payload-too-large'));
  assert.throws(() => cloneBoundedJson([1, 2], { maxNodes: 2 }), hasReason('payload-too-large'));
  assert.throws(() => cloneBoundedJson([[1]], { maxDepth: 1 }), hasReason('payload-too-large'));
});

test('page-message cloning rejects cycles and accessors without invoking page getters', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => cloneBoundedJson(cyclic), hasReason('malformed-payload'));

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'unsafe', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  assert.throws(() => cloneBoundedJson(accessor), hasReason('malformed-payload'));
  assert.equal(getterCalls, 0);
});
