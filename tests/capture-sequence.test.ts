import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureSequenceCoordinator,
  CaptureSequenceIssuer,
  isCaptureSequence,
} from '../utils/capture-sequence.ts';

test('fetch and XHR share one monotonic request-start sequence issuer', () => {
  const issuer = new CaptureSequenceIssuer();
  const fetchSequence = issuer.next();
  const xhrSequence = issuer.next();
  assert.equal(fetchSequence, 1);
  assert.equal(xhrSequence, 2);
});

test('new success followed by old success keeps the new request accepted', () => {
  const coordinator = new CaptureSequenceCoordinator();
  assert.equal(coordinator.accept(2), true);
  assert.equal(coordinator.accept(1), false);
  assert.equal(coordinator.latestAccepted, 2);
});

test('new success followed by old rejection cannot clear the new result', () => {
  const coordinator = new CaptureSequenceCoordinator();
  assert.equal(coordinator.accept(8), true);
  assert.equal(coordinator.accept(7), false);
  assert.equal(coordinator.latestAccepted, 8);
});

test('new rejection followed by old success cannot revive the old payload', () => {
  const coordinator = new CaptureSequenceCoordinator();
  assert.equal(coordinator.accept(12), true);
  assert.equal(coordinator.accept(11), false);
  assert.equal(coordinator.latestAccepted, 12);
});

test('duplicate and malformed sequences never advance the coordinator', () => {
  const coordinator = new CaptureSequenceCoordinator();
  for (const malformed of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.equal(isCaptureSequence(malformed), false);
    assert.equal(coordinator.accept(malformed), false);
  }
  assert.equal(coordinator.accept(1), true);
  assert.equal(coordinator.accept(1), false);
  assert.equal(coordinator.latestAccepted, 1);
});
