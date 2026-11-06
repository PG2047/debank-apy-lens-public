import assert from 'node:assert/strict';
import test from 'node:test';

import { EnrichRequestCoordinator, requestSenderKey } from '../utils/request-coordinator.ts';

const REQUEST_A = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_B = '223e4567-e89b-42d3-a456-426614174000';

function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

test('navigation cancel aborts active wallet work within its tab and frame', async () => {
  const coordinator = new EnrichRequestCoordinator();
  const key = requestSenderKey({ tab: { id: 7 }, frameId: 0 });
  assert.equal(key, 'tab:7:frame:0');
  const running = coordinator.runLatest(key, REQUEST_A, abortable);
  assert.equal(coordinator.cancel(key, REQUEST_A), true);
  await assert.rejects(running, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(coordinator.cancel(key, REQUEST_A), false);
});

test('new work aborts old work and the old finally cannot delete the replacement', async () => {
  const coordinator = new EnrichRequestCoordinator();
  const key = 'tab:8:frame:0';
  const oldWork = coordinator.runLatest(key, REQUEST_A, abortable);
  const newWork = coordinator.runLatest(key, REQUEST_B, abortable);

  await assert.rejects(oldWork, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(coordinator.cancel(key, REQUEST_A), false);
  assert.equal(coordinator.cancel(key, REQUEST_B), true);
  await assert.rejects(newWork, (error) => error instanceof DOMException && error.name === 'AbortError');
});

test('sender keys isolate active work by frame and reject non-tab senders', async () => {
  const coordinator = new EnrichRequestCoordinator();
  const topFrame = requestSenderKey({ tab: { id: 9 }, frameId: 0 });
  const childFrame = requestSenderKey({ tab: { id: 9 }, frameId: 2 });
  assert.ok(topFrame);
  assert.ok(childFrame);
  assert.notEqual(topFrame, childFrame);
  const topWork = coordinator.runLatest(topFrame, REQUEST_A, abortable);
  const childWork = coordinator.runLatest(childFrame, REQUEST_B, abortable);
  assert.equal(coordinator.cancel(topFrame, REQUEST_A), true);
  await assert.rejects(topWork);
  assert.equal(coordinator.cancel(childFrame, REQUEST_B), true);
  await assert.rejects(childWork);
  assert.equal(requestSenderKey({}), undefined);
  assert.equal(requestSenderKey({ tab: { id: -1 }, frameId: 0 }), undefined);
});
