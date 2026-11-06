import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryStore, parseHistoryList, type HistoryEntry } from '../utils/history.ts';
import { DEBANK_INPUT_LIMITS } from '../utils/input-limits.ts';

const validRow = (id: string, timeAt: number, overrides: Record<string, unknown> = {}) => ({
  id,
  chain: 'eth',
  project_id: 'uniswap4',
  cate_id: 'send',
  is_scam: false,
  time_at: timeAt,
  tx: { name: 'swap' },
  sends: [{ amount: 2, token_id: 'eth', price: 3_000 }],
  receives: [{ amount: 6_000, token_id: 'usdc', price: 1 }],
  ...overrides,
});

test('strict parser accepts nullable fields, maps non-positive prices to unknown, and drops scams', () => {
  const result = parseHistoryList({
    data: {
      history_list: [
        validRow('0xvalid', 200, {
          project_id: null,
          cate_id: null,
          tx: { name: null },
          sends: [{ amount: 2, token_id: 'eth', price: 0 }],
          receives: [{ amount: 6_000, token_id: 'usdc' }],
        }),
        validRow('0xscam', 300, { is_scam: true }),
      ],
    },
    error_code: 0,
  });

  assert.deepEqual(result, {
    entries: [{
      id: '0xvalid',
      chain: 'eth',
      projectId: null,
      cateId: null,
      txName: null,
      timeAt: 200,
      isScam: false,
      sends: [{ amount: 2, tokenId: 'eth', price: null, symbol: null }],
      receives: [{ amount: 6_000, tokenId: 'usdc', price: null, symbol: null }],
    }],
    droppedRows: 1,
  });
});

test('parser tolerates the direct data array shape and rejects invalid top-level or row fields', () => {
  assert.equal(parseHistoryList({ data: [validRow('0xdirect', 1)] }).entries.length, 1);
  assert.deepEqual(parseHistoryList({}), { entries: [], droppedRows: 0 });
  assert.deepEqual(parseHistoryList([]), { entries: [], droppedRows: 0 });
  assert.deepEqual(
    parseHistoryList({ data: { history_list: 'invalid' } }),
    { entries: [], droppedRows: 0 },
  );
  assert.equal(parseHistoryList({ data: [validRow('0xbad', 1, { chain: 1 })] }).droppedRows, 1);
  assert.equal(parseHistoryList({ data: [validRow('0xbad', 1, { sends: 'invalid' })] }).droppedRows, 1);
  assert.equal(parseHistoryList({
    data: [validRow('0xbad', 1, { project_id: 'x'.repeat(DEBANK_INPUT_LIMITS.identifierChars + 1) })],
  }).droppedRows, 1);
});

test('parser sorts newest first and limits one payload to the newest 200 valid rows', () => {
  const rows = Array.from({ length: DEBANK_INPUT_LIMITS.historyRows + 5 }, (_, index) =>
    validRow(`0x${index}`, index));
  const result = parseHistoryList({ data: { history_list: rows } });
  assert.equal(result.entries.length, DEBANK_INPUT_LIMITS.historyRows);
  assert.equal(result.entries[0]?.timeAt, DEBANK_INPUT_LIMITS.historyRows + 4);
  assert.equal(result.entries.at(-1)?.timeAt, 5);
  assert.equal(result.droppedRows, 5);
});

test('malformed rows do not consume the valid-row output quota', () => {
  const malformed = Array.from(
    { length: DEBANK_INPUT_LIMITS.historyRows },
    (_, index) => validRow(`0xbad-${index}`, 10_000 + index, { chain: 1 }),
  );
  const result = parseHistoryList({ data: [...malformed, validRow('0xvalid', 1)] });
  assert.deepEqual(result.entries.map(({ id }) => id), ['0xvalid']);
  assert.equal(result.droppedRows, DEBANK_INPUT_LIMITS.historyRows);
});

test('parser scans only the bounded raw prefix and reports uninspected rows as dropped', () => {
  const rows = Array.from(
    { length: DEBANK_INPUT_LIMITS.historyInputRows + 1 },
    (_, index) => validRow(`0x${index}`, index),
  );
  const result = parseHistoryList({ data: rows });
  assert.equal(result.entries[0]?.timeAt, DEBANK_INPUT_LIMITS.historyInputRows - 1);
  assert.equal(result.droppedRows, rows.length - DEBANK_INPUT_LIMITS.historyRows);
});

const entry = (id: string, timeAt: number): HistoryEntry => ({
  id,
  chain: 'base',
  projectId: 'base_morphoblue',
  cateId: 'receive',
  txName: null,
  timeAt,
  isScam: false,
  sends: [],
  receives: [],
});

test('HistoryStore isolates lowercase addresses, deduplicates by id, sorts, and keeps 100 entries', () => {
  const store = new HistoryStore();
  const address = '0xAbC';
  store.append(address, {
    entries: Array.from({ length: 105 }, (_, index) => entry(`0x${index}`, index)),
    droppedRows: 2,
  });
  store.append(address.toLowerCase(), { entries: [entry('0x50', 1_000)], droppedRows: 1 });

  const stored = store.get('0xABC');
  assert.equal(stored.entries.length, DEBANK_INPUT_LIMITS.historyEntriesPerAddress);
  assert.equal(stored.entries[0]?.id, '0x50');
  assert.equal(stored.entries.filter(({ id }) => id === '0x50').length, 1);
  assert.ok(stored.entries.every(
    (value, index) => index === 0 || stored.entries[index - 1]!.timeAt >= value.timeAt,
  ));
  assert.equal(stored.droppedRows, 1);
  assert.deepEqual(store.get('0xdef'), { entries: [], droppedRows: 0 });

  stored.entries[0]!.receives.push({ amount: 1, tokenId: 'mutated', price: 1, symbol: null });
  assert.deepEqual(store.get(address).entries[0]!.receives, []);
});

test('HistoryStore droppedRows reflects only the latest response parse', () => {
  const store = new HistoryStore();
  const result = { entries: [entry('same', 1)], droppedRows: 4 };
  store.append('0xabc', result);
  store.append('0xabc', result);
  assert.equal(store.get('0xabc').droppedRows, 4);

  store.append('0xabc', { entries: [entry('new', 2)], droppedRows: 1 });
  assert.equal(store.get('0xabc').droppedRows, 1);
});

test('HistoryStore keeps the newest duplicate within one batch and across delayed batches', () => {
  const store = new HistoryStore();
  store.append('0xabc', {
    entries: [entry('same', 20), entry('same', 10)],
    droppedRows: 0,
  });
  assert.equal(store.get('0xabc').entries[0]?.timeAt, 20);

  store.append('0xabc', { entries: [entry('same', 5)], droppedRows: 0 });
  assert.equal(store.get('0xabc').entries[0]?.timeAt, 20);
});

test('HistoryStore enforces an address-level LRU bound', () => {
  const store = new HistoryStore();
  for (let index = 0; index < DEBANK_INPUT_LIMITS.historyAddresses; index += 1) {
    store.append(`0x${index}`, { entries: [entry(`id-${index}`, index)], droppedRows: 0 });
  }
  store.get('0x0');
  store.append('0xoverflow', { entries: [entry('new', 100)], droppedRows: 0 });

  assert.equal(store.get('0x1').entries.length, 0);
  assert.equal(store.get('0x0').entries.length, 1);
  assert.equal(store.get('0xoverflow').entries.length, 1);
});
