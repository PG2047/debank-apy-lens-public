import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHTML } from 'linkedom';

test('status bar exposes loading, stop, partial, and refresh states before Data updated', async () => {
  const env = parseHTML('<html><body><span id="updated">Data updated</span></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
  });

  const { destroyStatusBar, formatCoverageIssue, renderStatusBar } = await import('../utils/status-bar.ts');
  assert.equal(
    formatCoverageIssue({
      id: 'protocol:bsc:bsc_helio',
      label: 'Lista DAO 数据不完整',
      detail: 'USD1 借款基础利率未匹配',
    }),
    'Lista DAO 数据不完整：USD1 借款基础利率未匹配',
  );
  let refreshes = 0;
  let stops = 0;
  const actions = {
    refresh: () => { refreshes += 1; },
    stop: () => { stops += 1; },
  };

  renderStatusBar({
    phase: 'loading',
    coverage: 'none',
    hasData: false,
    canRefresh: true,
  }, actions);
  let host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  let button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  assert.ok(host && button);
  assert.equal(host.nextElementSibling?.id, 'updated');
  assert.equal(host.shadowRoot?.querySelector('.label')?.textContent, '载入中');
  button.click();
  assert.equal(stops, 1);

  renderStatusBar({
    phase: 'ready',
    coverage: 'partial',
    gapCount: 3,
    gapDetails: ['Merkl 查询超时', 'Ethena 数据不完整', 'LP 外部激励未知'],
    hasData: true,
    canRefresh: true,
    lastUpdatedAt: Date.now(),
  }, actions);
  host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  assert.ok(host && button);
  assert.equal(host.shadowRoot?.querySelector('.label')?.textContent, '载入完成 · 3项缺口');
  const tipLines = [...(host.shadowRoot?.querySelectorAll('.status-tip .tip-line') ?? [])]
    .map((line) => line.textContent);
  assert.equal(host.shadowRoot?.querySelector('.bar')?.hasAttribute('title'), false);
  assert.equal(tipLines.length, 5);
  assert.equal(tipLines[1], 'Merkl 查询超时');
  assert.equal(tipLines[2], 'Ethena 数据不完整');
  assert.equal(tipLines[3], 'LP 外部激励未知');
  button.click();
  assert.equal(refreshes, 1);

  renderStatusBar({
    phase: 'error',
    coverage: 'partial',
    hasData: true,
    canRefresh: true,
  }, actions);
  host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  assert.equal(host?.shadowRoot?.querySelector('.label')?.textContent, '刷新失败 · 保留旧数据');
  assert.equal(button?.textContent, '重试');

  renderStatusBar({
    phase: 'stopped',
    coverage: 'partial',
    hasData: true,
    canRefresh: true,
  }, actions);
  host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  assert.equal(host?.shadowRoot?.querySelector('.label')?.textContent, '已停止');
  assert.equal(button?.textContent, '继续刷新');

  destroyStatusBar();
  assert.equal(localWindow.document.querySelector('[data-dal-status]'), null);
});

test('status bar applies the latest phase when the DeBank anchor returns', async () => {
  const env = parseHTML(
    '<html><body><section id="portfolio"><span id="updated">Data updated</span></section></body></html>',
  );
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
  });

  const { destroyStatusBar, renderStatusBar } = await import('../utils/status-bar.ts');
  const actions = { refresh: () => {}, stop: () => {} };

  renderStatusBar({
    phase: 'waiting',
    coverage: 'none',
    hasData: false,
    canRefresh: false,
  }, actions);
  let host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  assert.equal(host?.getAttribute('data-dal-status'), 'waiting');

  localWindow.document.querySelector('#updated')?.remove();
  renderStatusBar({
    phase: 'ready',
    coverage: 'complete',
    hasData: true,
    canRefresh: true,
  }, actions);
  host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  assert.equal(host?.getAttribute('data-dal-status'), 'waiting');

  const restoredAnchor = localWindow.document.createElement('span');
  restoredAnchor.textContent = 'Data updated';
  localWindow.document.querySelector('#portfolio')?.appendChild(restoredAnchor);
  await Promise.resolve();

  host = localWindow.document.querySelector<HTMLElement>('[data-dal-status]');
  assert.equal(host?.getAttribute('data-dal-status'), 'ready');
  assert.equal(host?.shadowRoot?.querySelector('.label')?.textContent, '载入完成');

  destroyStatusBar();
});
