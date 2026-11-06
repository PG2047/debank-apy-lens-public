import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHTML } from 'linkedom';

import type { HistoryEntry, HistoryTransfer } from '../utils/history.ts';
import {
  buildTimelinePresentation,
  classifyEntry,
  historyDroppedRowsNotice,
  summarizeFlows,
} from '../utils/history-presentation.ts';

const priced = (tokenId: string, amount: number, price = 1): HistoryTransfer => ({
  tokenId,
  amount,
  price,
  symbol: null,
});

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: '0xhistory',
    chain: 'base',
    projectId: 'base_morphoblue',
    cateId: 'deposit',
    txName: 'deposit',
    timeAt: Date.UTC(2026, 6, 11, 0, 34) / 1_000,
    isScam: false,
    sends: [],
    receives: [],
    ...overrides,
  };
}

test('classifyEntry applies the fixed authorization and flow rules', () => {
  assert.equal(classifyEntry(entry({ cateId: 'approve', sends: [priced('USDe', 1)] })).kind, '授权');
  // 纯转账(无协议动词)不冒充加减仓——方向法曾把 stake 误标减仓/withdraw 误标加仓(真机 2026-07-12)
  assert.equal(classifyEntry(entry({ txName: 'transfer', cateId: 'send', sends: [priced('USDe', 2)] })).kind, '其他');
  assert.equal(classifyEntry(entry({ txName: null, cateId: 'receive', receives: [priced('USDe', 3)] })).kind, '其他');
  assert.equal(classifyEntry(entry({ txName: 'stake', sends: [priced('USDS', 2)] })).kind, '加仓');
  assert.equal(classifyEntry(entry({ txName: 'supply', sends: [priced('USDC', 2)], receives: [priced('aUSDC', 2)] })).kind, '加仓');
  assert.equal(classifyEntry(entry({ txName: 'withdraw', receives: [priced('USDG', 3)] })).kind, '减仓');
  assert.equal(classifyEntry(entry({ txName: 'redeem', sends: [priced('sUSDe', 1)], receives: [priced('USDe', 1)] })).kind, '减仓');
  assert.equal(classifyEntry(entry({
    txName: 'getReward',
    receives: [priced('MORPHO', 4)],
  })).kind, '领奖');
  assert.equal(classifyEntry(entry({
    txName: 'exec',
    sends: [priced('USDe', 5)],
    receives: [priced('USDC', 5)],
  })).kind, '换仓');
  assert.equal(classifyEntry(entry()).kind, '其他');
});

test('claim recognition wins over add-position only in an inbound-only entry', () => {
  assert.deepEqual(classifyEntry(entry({
    txName: 'claim_rewards',
    receives: [priced('MORPHO', 10, 0.5)],
  })), {
    kind: '领奖',
    detail: '领取 $5.00 MORPHO → base_morphoblue',
  });
});

test('missing prices stay as quantities and are counted without estimation', () => {
  const result = buildTimelinePresentation({
    entries: [entry({ receives: [{ tokenId: 'UNKNOWN', amount: 14_000_000, price: null, symbol: null }] })],
    droppedRows: 0,
  });

  assert.equal(result.unpricedLegs, 1);
  assert.match(result.rows[0]?.detail ?? '', /14\.00M UNKNOWN/);
  assert.doesNotMatch(result.rows[0]?.detail ?? '', /\$/);
});

test('timeline time is always formatted in Taipei time and protocol ids are annotated', () => {
  const result = buildTimelinePresentation({ entries: [entry()], droppedRows: 2 });

  assert.equal(result.rows[0]?.time, '07-11 08:34');
  assert.equal(result.rows[0]?.chainLabel, 'Base');
  assert.equal(result.rows[0]?.project, 'morpho');
  assert.equal(result.droppedRows, 2);
});

test('dropped-row notice is emitted only when rows were dropped', () => {
  assert.equal(historyDroppedRowsNotice(0), null);
  assert.equal(
    historyDroppedRowsNotice(2),
    '有 2 条记录未纳入(诈骗过滤/无法解析/超出配额)',
  );
});

test('summarizeFlows computes per-project net USD and skips unpriced legs', () => {
  const summary = summarizeFlows([
    entry({
      sends: [priced('USDe', 10)],
      receives: [priced('USDC', 40), { tokenId: 'POINTS', amount: 5, price: null, symbol: null }],
    }),
    entry({ projectId: 'ethena', sends: [priced('USDe', 7, 2)] }),
  ]);

  assert.deepEqual(summary, {
    projects: [
      { projectId: 'base_morphoblue', project: 'morpho', netUsd: 30, pricedLegs: 2, unpricedLegs: 1 },
      { projectId: 'ethena', project: 'ethena', netUsd: -14, pricedLegs: 1, unpricedLegs: 0 },
    ],
    unpricedLegs: 1,
  });
});

test('timeline details are capped at 120 characters', () => {
  const detail = classifyEntry(entry({
    projectId: 'p'.repeat(140),
    receives: [priced('XTOKEN', 1)],
  })).detail;

  assert.equal(detail.length, 120);
  assert.ok(detail.endsWith('…'));
});

test('renderPanel adds a collapsed recent-activity section and conditional meta text', async () => {
  const env = parseHTML('<html><body></body></html>');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: env.document,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    writable: true,
    value: env.window.HTMLElement,
  });

  try {
    const { PANEL_HOST_ID, removePanel, renderPanel } = await import('../utils/overlay.ts');
    renderPanel({ cards: [], skippedProtocols: 0, generatedAt: 0 }, {
      entries: [entry({ receives: [priced('USDe', 14_000_000)] })],
      droppedRows: 3,
    });

    const host = env.document.getElementById(PANEL_HOST_ID);
    const timeline = host?.shadowRoot?.querySelector<HTMLDetailsElement>('details.timeline');
    assert.ok(timeline);
    assert.equal(timeline.hasAttribute('open'), false);
    assert.equal(timeline.querySelector('summary')?.textContent, '近期动向(1 条)');
    assert.match(timeline.textContent ?? '', /07-11 08:34Base加仓存入 \$14\.00M USDe/);
    assert.match(timeline.textContent ?? '', /有 3 条记录未纳入\(诈骗过滤\/无法解析\/超出配额\)/);
    assert.match(timeline.querySelector('summary')?.title ?? '', /morpho：净流入 \$14\.00M/);

    renderPanel({ cards: [], skippedProtocols: 0, generatedAt: 0 }, {
      entries: [
        entry({ projectId: 'unknown', receives: [{ tokenId: 'A', amount: 1, price: null, symbol: null }] }),
        entry({
          id: 'partial',
          projectId: 'partial',
          sends: [priced('USDC', 2), { tokenId: 'B', amount: 1, price: null, symbol: null }],
        }),
      ],
      droppedRows: 0,
    });
    const flowTitle = host?.shadowRoot?.querySelector('details.timeline summary')?.getAttribute('title') ?? '';
    assert.match(flowTitle, /unknown：净流向未知\(1 条腿未计价\)/);
    assert.match(flowTitle, /partial：已计价腿净流出 \$2\.00\(另 1 条腿未计价\)/);
    assert.doesNotMatch(flowTitle, /unknown：净流向持平 \$0\.00/);

    renderPanel({ cards: [], skippedProtocols: 0, generatedAt: 0 }, {
      entries: [],
      droppedRows: 3,
    });
    assert.equal(host?.shadowRoot?.querySelector('details.timeline'), null);
    removePanel();
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement);
    else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});
