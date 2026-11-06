import assert from 'node:assert/strict';
import test from 'node:test';

import type { PositionItem } from '../utils/debank.ts';
import { DEBANK_INPUT_LIMITS, InputLimitError } from '../utils/input-limits.ts';
import { rpcBatch, uniswapRanges } from '../utils/uniswap.ts';

const item: PositionItem = {
  itemName: 'LP',
  supplies: [],
  borrows: [],
  rewards: [],
  principalInputCoverageComplete: true,
  rewardInputCoverageComplete: true,
  netUsd: 0,
  positionIndex: '1',
};

test('LP position overflow is rejected before any RPC request', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('[]');
  }) as typeof fetch;
  try {
    await assert.rejects(
      uniswapRanges(
        1,
        Array.from({ length: DEBANK_INPUT_LIMITS.lpPositionsPerCard + 1 }, () => item),
      ),
      InputLimitError,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('opaque protocol position identities are still rejected by the LP uint256 gate', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('[]');
  }) as typeof fetch;
  try {
    await assert.rejects(
      uniswapRanges(1, [{
        ...item,
        positionIndex: '0x4992b11a44ccdae37936da8098afd86427bad833_' + '9'.repeat(77),
      }]),
      InputLimitError,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('oversized RPC batches fail before endpoint lookup or network work', async () => {
  const calls = Array.from(
    { length: DEBANK_INPUT_LIMITS.rpcCallsPerBatch + 1 },
    () => ({ to: '0x0000000000000000000000000000000000000000', data: '0x' }),
  );
  await assert.rejects(rpcBatch(1, calls), InputLimitError);
});

test('RPC response ids and row counts cannot expand or overrun the result batch', async () => {
  const originalFetch = globalThis.fetch;
  const call = [{ to: '0x0000000000000000000000000000000000000000', data: '0x00' }];
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify([{
      jsonrpc: '2.0',
      id: 4_294_967_294,
      result: '0x00',
    }]))) as typeof fetch;
    await assert.rejects(rpcBatch(1, call), /rpc response id invalid/i);

    const twoCalls = [...call, ...call];
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { jsonrpc: '2.0', id: 0, result: '0x00' },
      { jsonrpc: '2.0', id: 0, result: '0x00' },
    ]))) as typeof fetch;
    await assert.rejects(rpcBatch(1, twoCalls), /rpc response id invalid/i);

    globalThis.fetch = (async () => new Response(JSON.stringify([
      { jsonrpc: '2.0', id: 0, result: '0x00' },
      { jsonrpc: '2.0', id: 1, result: '0x00' },
    ]))) as typeof fetch;
    await assert.rejects(rpcBatch(1, call), /row limit exceeded/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normal empty LP input remains accepted without RPC work', async () => {
  assert.deepEqual(await uniswapRanges(1, []), new Map());
});
