import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseHTML } from 'linkedom';

import {
  findUniqueTransactionList,
  installTransactionScamFilter,
  isConfirmedScamTransactionRow,
  isDeBankTransactionHistoryPath,
  registerTransactionScamFilterCleanup,
  SCAM_FILTER_STATE_ATTR,
  SCAM_HIDDEN_ATTR,
  startTransactionScamFilterSafely,
} from '../utils/transaction-filter.ts';

const ADDRESS = '0x000000000000000000000000000000000000f002';
const HISTORY_PATH = `/profile/${ADDRESS}/history`;

interface RowOptions {
  id: string;
  scamMarkers?: number;
  txLinks?: number;
  extraColumn?: boolean;
  statusCount?: number;
  error?: boolean;
  gray?: boolean;
  fuzzyScamText?: boolean;
  nestedMarkerRow?: boolean;
  linkOutsideStatus?: boolean;
  linkNestedStatus?: boolean;
  markerOutsideStatus?: boolean;
}

function rowMarkup({
  id,
  scamMarkers = 0,
  txLinks = 1,
  extraColumn = false,
  statusCount = 1,
  error = false,
  gray = false,
  fuzzyScamText = false,
  nestedMarkerRow = false,
  linkOutsideStatus = false,
  linkNestedStatus = false,
  markerOutsideStatus = false,
}: RowOptions): string {
  const markers = Array.from(
    { length: scamMarkers },
    () => '<div class="History_scam__marker"><svg width="51" height="18"></svg></div>',
  ).join('');
  const links = Array.from(
    { length: txLinks },
    (_, index) => `<a href="https://explorer.test/tx/${id}-${index}">tx</a>`,
  ).join('');
  const nested = nestedMarkerRow
    ? '<div class="History_tableLine__nested"><div class="History_txStatus__nested"><div class="History_scam__nested"><svg width="51" height="18"></svg></div></div></div>'
    : '';
  const status = `
    <div class="History_txStatus__status">
      ${markerOutsideStatus ? '' : markers}
      ${linkOutsideStatus ? '' : linkNestedStatus ? `<span class="History_txStatus__nested">${links}</span>` : links}
      ${error ? '<span class="History_failed__label">Failed</span>' : ''}
      ${fuzzyScamText ? '<span>This might contain scam wording</span>' : ''}
    </div>`;
  return `
    <div id="${id}"
      class="History_tableLine__row${error ? ' History_error__row' : ''}"
      ${gray ? 'style="color: gray; opacity: 0.35"' : ''}>
      <div>${nested}${markerOutsideStatus ? markers : ''}</div>
      <div>${linkOutsideStatus ? links : ''}</div>
      ${Array.from({ length: statusCount }, () => status).join('')}
      <div>amount</div>
      ${extraColumn ? '<div>unexpected</div>' : ''}
    </div>`;
}

function createPage(rows: string, extras = '') {
  const parsed = parseHTML(`
    <html>
      <head></head>
      <body>
        <div class="HistoryContainer_historyContainer__root">
          <div class="History_table__list">${rows}</div>
        </div>
        ${extras}
      </body>
    </html>`);
  return {
    document: parsed.document as unknown as Document,
    window: parsed.window as unknown as Window,
  };
}

function installForPage(page: ReturnType<typeof createPage>, getPathname = () => HISTORY_PATH) {
  return installTransactionScamFilter({
    document: page.document,
    window: page.window,
    MutationObserver: (page.window as unknown as { MutationObserver: typeof MutationObserver })
      .MutationObserver,
    getPathname,
    debounceMs: 0,
    lifecyclePollMs: 0,
  });
}

async function settle(handle: ReturnType<typeof installForPage>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  handle.flush();
}

test('route contract enables one bounded EVM or non-EVM profile identifier only', () => {
  assert.equal(isDeBankTransactionHistoryPath(HISTORY_PATH), true);
  assert.equal(isDeBankTransactionHistoryPath(`${HISTORY_PATH}/`), true);
  assert.equal(isDeBankTransactionHistoryPath('/profile/7YWHMfk9hYNxTqdQphZ9/history'), true);
  assert.equal(isDeBankTransactionHistoryPath(`/profile/${ADDRESS}`), false);
  assert.equal(isDeBankTransactionHistoryPath(`/profile/${ADDRESS}/history/more`), false);
  assert.equal(isDeBankTransactionHistoryPath('/profile//history'), false);
  assert.equal(isDeBankTransactionHistoryPath(`/profile/${'a'.repeat(257)}/history`), false);
});

test('finite state reporting distinguishes route, root, attachment, budget and cleanup', () => {
  const page = createPage(rowMarkup({ id: 'ordinary' }));
  let pathname = `/profile/${ADDRESS}`;
  const states: string[] = [];
  const handle = installTransactionScamFilter({
    document: page.document,
    window: page.window,
    MutationObserver: (page.window as unknown as { MutationObserver: typeof MutationObserver })
      .MutationObserver,
    getPathname: () => pathname,
    onState: (state) => states.push(state),
    debounceMs: 0,
    lifecyclePollMs: 0,
  });
  assert.deepEqual(states, ['inactive-route']);

  pathname = HISTORY_PATH;
  handle.sync();
  assert.equal(states.at(-1), 'attached');
  page.document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="HistoryContainer_historyContainer__second"><div class="History_table__second"></div></div>',
  );
  handle.sync();
  assert.equal(states.at(-1), 'waiting-root');
  handle.cleanup();
  assert.equal(states.at(-1), 'stopped');

  const oversizedPage = createPage(
    Array.from({ length: 501 }, (_, index) => rowMarkup({ id: `oversized-${index}` })).join(''),
  );
  const oversizedStates: string[] = [];
  const oversized = installTransactionScamFilter({
    document: oversizedPage.document,
    window: oversizedPage.window,
    MutationObserver: (
      oversizedPage.window as unknown as { MutationObserver: typeof MutationObserver }
    ).MutationObserver,
    getPathname: () => HISTORY_PATH,
    onState: (state) => oversizedStates.push(state),
    debounceMs: 0,
    lifecyclePollMs: 0,
  });
  assert.deepEqual(oversizedStates, ['budget-detached']);
  assert.equal(oversizedPage.document.querySelector('[data-dal-scam-filter-style]'), null);
  oversized.cleanup();
  assert.equal(oversizedStates.at(-1), 'stopped');
});

test('bridge bootstrap persists finite state and contains installer or state callback failures', () => {
  const page = createPage(rowMarkup({ id: 'scam', scamMarkers: 1 }));
  const handle = startTransactionScamFilterSafely({
    document: page.document,
    window: page.window,
    install: (options) => installTransactionScamFilter({
      ...options,
      MutationObserver: (page.window as unknown as { MutationObserver: typeof MutationObserver })
        .MutationObserver,
      getPathname: () => HISTORY_PATH,
      lifecyclePollMs: 0,
    }),
  });
  assert.ok(handle);
  assert.equal(page.document.documentElement.getAttribute(SCAM_FILTER_STATE_ATTR), 'attached');
  handle.cleanup();
  assert.equal(page.document.documentElement.getAttribute(SCAM_FILTER_STATE_ATTR), 'stopped');

  const callbackFailurePage = createPage(rowMarkup({ id: 'callback-scam', scamMarkers: 1 }));
  const callbackFailureHandle = installTransactionScamFilter({
    document: callbackFailurePage.document,
    window: callbackFailurePage.window,
    MutationObserver: (
      callbackFailurePage.window as unknown as { MutationObserver: typeof MutationObserver }
    ).MutationObserver,
    getPathname: () => HISTORY_PATH,
    onState: () => {
      throw new Error('diagnostic callback failure');
    },
    lifecyclePollMs: 0,
  });
  assert.equal(
    callbackFailurePage.document.querySelector('#callback-scam')?.getAttribute(SCAM_HIDDEN_ATTR),
    'true',
  );
  callbackFailureHandle.cleanup();

  const installFailurePage = createPage(rowMarkup({ id: 'ordinary' }));
  let apySetupContinued = false;
  const failed = startTransactionScamFilterSafely({
    document: installFailurePage.document,
    window: installFailurePage.window,
    install: () => {
      throw new Error('synthetic install failure');
    },
  });
  apySetupContinued = true;
  assert.equal(failed, null);
  assert.equal(apySetupContinued, true);
  assert.equal(
    installFailurePage.document.documentElement.getAttribute(SCAM_FILTER_STATE_ATTR),
    'install-error',
  );

  const throwingConsolePage = createPage(rowMarkup({ id: 'console-scam', scamMarkers: 1 }));
  const originalConsoleInfo = console.info;
  let throwingConsoleHandle: ReturnType<typeof startTransactionScamFilterSafely> = null;
  try {
    console.info = () => {
      throw new Error('synthetic console failure');
    };
    throwingConsoleHandle = startTransactionScamFilterSafely({
      document: throwingConsolePage.document,
      window: throwingConsolePage.window,
      install: (options) => installTransactionScamFilter({
        ...options,
        MutationObserver: (
          throwingConsolePage.window as unknown as { MutationObserver: typeof MutationObserver }
        ).MutationObserver,
        getPathname: () => HISTORY_PATH,
        lifecyclePollMs: 0,
      }),
    });
    assert.ok(throwingConsoleHandle);
    assert.equal(
      throwingConsolePage.document.documentElement.getAttribute(SCAM_FILTER_STATE_ATTR),
      'attached',
    );
    assert.equal(
      throwingConsolePage.document.querySelector('#console-scam')?.getAttribute(SCAM_HIDDEN_ATTR),
      'true',
    );
    throwingConsoleHandle.cleanup();
    assert.equal(
      throwingConsolePage.document.documentElement.getAttribute(SCAM_FILTER_STATE_ATTR),
      'stopped',
    );
  } finally {
    console.info = originalConsoleInfo;
    throwingConsoleHandle?.cleanup();
  }
});

test('WXT invalidation and pagehide share one idempotent safe cleanup', () => {
  const page = createPage(rowMarkup({ id: 'invalidation-scam', scamMarkers: 1 }));
  const handle = startTransactionScamFilterSafely({
    document: page.document,
    window: page.window,
    install: (options) => installTransactionScamFilter({
      ...options,
      MutationObserver: (page.window as unknown as { MutationObserver: typeof MutationObserver })
        .MutationObserver,
      getPathname: () => HISTORY_PATH,
      lifecyclePollMs: 0,
    }),
  });
  assert.ok(handle);
  const invalidationCallbacks: Array<() => void> = [];
  const cleanup = registerTransactionScamFilterCleanup(handle, {
    onInvalidated(callback) {
      invalidationCallbacks.push(callback);
    },
  });
  const row = page.document.querySelector('#invalidation-scam');
  const root = findUniqueTransactionList(page.document);
  assert.ok(row && root);
  assert.equal(row.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  assert.equal(root.getAttribute('data-dal-transaction-list'), 'true');
  assert.ok(page.document.querySelector('[data-dal-scam-filter-style]'));
  assert.equal(invalidationCallbacks.length, 1);

  invalidationCallbacks[0]();
  assert.equal(row.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(root.hasAttribute('data-dal-transaction-list'), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);
  assert.equal(page.document.documentElement.getAttribute(SCAM_FILTER_STATE_ATTR), 'stopped');

  assert.doesNotThrow(() => cleanup());
  assert.doesNotThrow(() => invalidationCallbacks[0]());
});

test('static entry contract hosts the isolated DOM engine in bridge only', () => {
  const bridgeUrl = new URL('../entrypoints/bridge.content.ts', import.meta.url);
  const filterUrl = new URL('../utils/transaction-filter.ts', import.meta.url);
  const retiredEntryUrl = new URL('../entrypoints/scam-filter.content.ts', import.meta.url);
  const source = readFileSync(bridgeUrl, 'utf8');
  const filterSource = readFileSync(filterUrl, 'utf8');
  const moduleMarkerIndex = source.indexOf('[APY Lens] bridge module build 0.6.0: evaluated');
  const definitionIndex = source.indexOf('export default defineContentScript');
  assert.match(source, /registerTransactionScamFilterCleanup/);
  assert.match(source, /startTransactionScamFilterSafely/);
  assert.ok(moduleMarkerIndex >= 0);
  assert.ok(definitionIndex > moduleMarkerIndex);
  assert.match(source, /data-dal-bridge-module-build/);
  assert.match(source, /module diagnostics must not block content-script definition/);
  assert.match(source, /\[APY Lens\] scam filter build 0\.3\.5: bridge-enter/);
  assert.match(source, /diagnostics must not block bridge startup/);
  assert.match(source, /main\(ctx\)/);
  assert.match(source, /registerTransactionScamFilterCleanup\([\s\S]*transactionFilter,[\s\S]*ctx/);
  assert.match(source, /const transactionFilter = startTransactionScamFilterSafely\(\);/);
  assert.ok(
    source.indexOf('startTransactionScamFilterSafely();') < source.indexOf("let lastPayloadKey = ''"),
  );
  assert.match(source, /if \(!event\.persisted\)/);
  assert.match(source, /cleanupTransactionFilter\(\)/);
  assert.match(filterSource, /context\.onInvalidated\(cleanup\)/);
  assert.equal(existsSync(retiredEntryUrl), false);
});

test('unique semantic root and a textless scam wrapper containing inline SVG hide only the confirmed row', () => {
  const page = createPage([
    rowMarkup({ id: 'scam', scamMarkers: 1 }),
    rowMarkup({ id: 'ordinary' }),
  ].join(''));
  const root = findUniqueTransactionList(page.document);
  assert.ok(root);
  const scam = page.document.querySelector('#scam');
  const ordinary = page.document.querySelector('#ordinary');
  assert.ok(scam && ordinary);
  const marker = scam.querySelector('[class*="History_scam__"]');
  assert.equal(marker?.tagName, 'DIV');
  assert.equal(marker?.textContent, '');
  assert.equal(marker?.querySelector('svg[width="51"][height="18"]')?.tagName, 'SVG');
  assert.equal(isConfirmedScamTransactionRow(scam, root), true);
  assert.equal(isConfirmedScamTransactionRow(ordinary, root), false);

  const handle = installForPage(page);
  assert.equal(scam.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  assert.equal(ordinary.hasAttribute(SCAM_HIDDEN_ATTR), false);
  handle.cleanup();
});

test('gray, error, and fuzzy scam text are not positive evidence', () => {
  const page = createPage([
    rowMarkup({ id: 'gray', gray: true }),
    rowMarkup({ id: 'failed-gray', gray: true, error: true }),
    rowMarkup({ id: 'fuzzy-text', fuzzyScamText: true }),
  ].join(''));
  const handle = installForPage(page);
  for (const id of ['gray', 'failed-gray', 'fuzzy-text']) {
    assert.equal(page.document.querySelector(`#${id}`)?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  }
  handle.cleanup();
});

test('ambiguous marker/row/link/column boundaries all fail open', () => {
  const page = createPage([
    rowMarkup({ id: 'nested', nestedMarkerRow: true }),
    rowMarkup({ id: 'two-markers', scamMarkers: 2 }),
    rowMarkup({ id: 'two-links', scamMarkers: 1, txLinks: 2 }),
    rowMarkup({ id: 'two-statuses', scamMarkers: 1, statusCount: 2 }),
    rowMarkup({ id: 'link-outside-status', scamMarkers: 1, linkOutsideStatus: true }),
    rowMarkup({ id: 'link-nested-status', scamMarkers: 1, linkNestedStatus: true }),
    rowMarkup({ id: 'marker-outside-status', scamMarkers: 1, markerOutsideStatus: true }),
    rowMarkup({ id: 'ordinary' }),
    '<div id="adjacent-marker" class="History_scam__adjacent"><svg width="51" height="18"></svg></div>',
  ].join(''));
  const handle = installForPage(page);
  for (const id of [
    'nested',
    'two-markers',
    'two-links',
    'two-statuses',
    'link-outside-status',
    'link-nested-status',
    'marker-outside-status',
    'ordinary',
  ]) {
    assert.equal(page.document.querySelector(`#${id}`)?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  }
  assert.equal(page.document.querySelector('#adjacent-marker')?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  handle.cleanup();
});

test('an extra harmless column does not invalidate otherwise exact semantic evidence', () => {
  const page = createPage(rowMarkup({ id: 'extra-column', scamMarkers: 1, extraColumn: true }));
  const handle = installForPage(page);
  assert.equal(
    page.document.querySelector('#extra-column')?.getAttribute(SCAM_HIDDEN_ATTR),
    'true',
  );
  handle.cleanup();
});

test('an absent, duplicate, or unrelated transaction-list root fails open', () => {
  const valid = rowMarkup({ id: 'scam', scamMarkers: 1 });
  const duplicate = createPage(
    valid,
    '<div class="HistoryContainer_historyContainer__second"><div class="History_table__second"></div></div>',
  );
  assert.equal(findUniqueTransactionList(duplicate.document), null);
  const duplicateHandle = installForPage(duplicate);
  assert.equal(duplicate.document.querySelector('#scam')?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(duplicate.document.querySelector('[data-dal-scam-filter-style]'), null);
  duplicateHandle.cleanup();

  const parsed = parseHTML(`<html><head></head><body>${valid}</body></html>`);
  const noRoot = {
    document: parsed.document as unknown as Document,
    window: parsed.window as unknown as Window,
  };
  assert.equal(findUniqueTransactionList(noRoot.document), null);
  const noRootHandle = installForPage(noRoot);
  assert.equal(noRoot.document.querySelector('#scam')?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  noRootHandle.cleanup();

  const unrelatedParsed = parseHTML(`
    <html><head></head><body>
      <div class="HistoryContainer_historyContainer__root"></div>
      <div class="History_table__list">${valid}</div>
    </body></html>`);
  const unrelated = {
    document: unrelatedParsed.document as unknown as Document,
    window: unrelatedParsed.window as unknown as Window,
  };
  assert.equal(findUniqueTransactionList(unrelated.document), null);
  const unrelatedHandle = installForPage(unrelated);
  assert.equal(unrelated.document.querySelector('#scam')?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  unrelatedHandle.cleanup();
});

test('stale extension markers are cleared before ordinary rows are reconciled', () => {
  const page = createPage(rowMarkup({ id: 'ordinary' }));
  const row = page.document.querySelector('#ordinary');
  row?.setAttribute(SCAM_HIDDEN_ATTR, 'true');
  page.document.head.insertAdjacentHTML(
    'beforeend',
    '<style data-dal-scam-filter-style>[data-dal-scam-hidden] { display:none }</style>',
  );

  const handle = installForPage(page);
  assert.equal(row?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelectorAll('[data-dal-scam-filter-style]').length, 1);
  assert.match(
    page.document.querySelector('[data-dal-scam-filter-style]')?.textContent ?? '',
    /data-dal-transaction-list.*History_table__.*>.*data-dal-scam-hidden.*History_tableLine__/,
  );
  handle.cleanup();
});

test('a previously verified root becoming ambiguous restores every hidden row', () => {
  const page = createPage(rowMarkup({ id: 'scam', scamMarkers: 1 }));
  const handle = installForPage(page);
  const scam = page.document.querySelector('#scam');
  assert.equal(scam?.getAttribute(SCAM_HIDDEN_ATTR), 'true');

  page.document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="HistoryContainer_historyContainer__second"><div class="History_table__second"></div></div>',
  );
  handle.sync();
  assert.equal(scam?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);
  handle.cleanup();
});

test('observer hides a newly added confirmed scam row without rescanning outside the list', async () => {
  const page = createPage(rowMarkup({ id: 'ordinary' }));
  const handle = installForPage(page);
  const root = findUniqueTransactionList(page.document);
  assert.ok(root);
  root.insertAdjacentHTML('beforeend', rowMarkup({ id: 'new-scam', scamMarkers: 1 }));
  await settle(handle);
  assert.equal(page.document.querySelector('#new-scam')?.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  handle.cleanup();
});

test('a recycled virtual row restores visibility as soon as scam evidence disappears', async () => {
  const page = createPage(rowMarkup({ id: 'recycled', scamMarkers: 1 }));
  const handle = installForPage(page);
  const row = page.document.querySelector('#recycled');
  const marker = row?.querySelector('[class*="History_scam__"]');
  assert.ok(row && marker);
  assert.equal(row.getAttribute(SCAM_HIDDEN_ATTR), 'true');

  marker.remove();
  await settle(handle);
  assert.equal(row.hasAttribute(SCAM_HIDDEN_ATTR), false);
  handle.cleanup();
});

test('row-count overflow detaches fail-open and a later bounded list can recover', async () => {
  const page = createPage(rowMarkup({ id: 'scam', scamMarkers: 1 }));
  const handle = installForPage(page);
  const root = findUniqueTransactionList(page.document);
  const scam = page.document.querySelector('#scam');
  assert.ok(root && scam);
  assert.equal(scam.getAttribute(SCAM_HIDDEN_ATTR), 'true');

  for (let index = 0; index < 500; index += 1) {
    root.insertAdjacentHTML('beforeend', rowMarkup({ id: `overflow-${index}` }));
  }
  await settle(handle);
  assert.equal(root.children.length, 501);
  assert.equal(scam.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);

  for (const row of Array.from(root.querySelectorAll('[id^="overflow-"]'))) row.remove();
  handle.sync();
  assert.equal(scam.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  handle.cleanup();
});

test('oversized mutation batch detaches fail-open and sync reacquires the verified list', () => {
  const page = createPage(rowMarkup({ id: 'scam', scamMarkers: 1 }));
  const callbacks: MutationCallback[] = [];
  class FakeMutationObserver {
    constructor(callback: MutationCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
    takeRecords(): MutationRecord[] {
      return [];
    }
  }

  const handle = installTransactionScamFilter({
    document: page.document,
    window: page.window,
    MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
    getPathname: () => HISTORY_PATH,
    debounceMs: 0,
    lifecyclePollMs: 0,
  });
  const scam = page.document.querySelector('#scam');
  assert.equal(scam?.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  assert.equal(callbacks.length, 1);

  const record = { type: 'attributes', target: scam } as unknown as MutationRecord;
  callbacks[0](Array.from({ length: 251 }, () => record), {} as MutationObserver);
  assert.equal(scam?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);

  handle.sync();
  assert.equal(callbacks.length, 2);
  assert.equal(scam?.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  handle.cleanup();
});

test('root-target reconciliation drops detached pending rows before a virtual row becomes ordinary', () => {
  const rows = [
    rowMarkup({ id: 'scam', scamMarkers: 1 }),
    ...Array.from({ length: 499 }, (_, index) => rowMarkup({ id: `old-${index}` })),
  ].join('');
  const page = createPage(rows);
  const callbacks: MutationCallback[] = [];
  class FakeMutationObserver {
    constructor(callback: MutationCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
    takeRecords(): MutationRecord[] {
      return [];
    }
  }
  const handle = installTransactionScamFilter({
    document: page.document,
    window: page.window,
    MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
    getPathname: () => HISTORY_PATH,
    debounceMs: 10_000,
    lifecyclePollMs: 0,
  });
  const root = findUniqueTransactionList(page.document);
  const scam = page.document.querySelector('#scam');
  const marker = scam?.querySelector('[class*="History_scam__"]');
  const status = scam?.querySelector('[class*="History_txStatus__"]');
  assert.ok(root && scam && marker && status);
  assert.equal(scam.getAttribute(SCAM_HIDDEN_ATTR), 'true');

  const oldRows = Array.from(root.querySelectorAll('[id^="old-"]')).slice(0, 250);
  callbacks[0](
    oldRows.map((target) => ({ type: 'attributes', target }) as unknown as MutationRecord),
    {} as MutationObserver,
  );
  for (const old of oldRows) old.remove();
  root.insertAdjacentHTML(
    'beforeend',
    Array.from({ length: 250 }, (_, index) => rowMarkup({ id: `replacement-${index}` })).join(''),
  );
  const replacements = Array.from(root.querySelectorAll('[id^="replacement-"]'));
  callbacks[0](
    oldRows.map((removed, index) => ({
      type: 'childList',
      target: root,
      removedNodes: [removed],
      addedNodes: [replacements[index]],
    }) as unknown as MutationRecord),
    {} as MutationObserver,
  );

  marker.remove();
  callbacks[0]([{
    type: 'childList',
    target: status,
    removedNodes: [marker],
    addedNodes: [],
  } as unknown as MutationRecord], {} as MutationObserver);
  handle.flush();
  const visible = !scam.hasAttribute(SCAM_HIDDEN_ATTR);
  handle.cleanup();
  assert.equal(visible, true);
});

test('pending-row overflow across bounded callbacks detaches instead of preserving stale hiding', () => {
  const rows = [
    rowMarkup({ id: 'scam', scamMarkers: 1 }),
    ...Array.from({ length: 499 }, (_, index) => rowMarkup({ id: `first-${index}` })),
  ].join('');
  const page = createPage(rows);
  const callbacks: MutationCallback[] = [];
  class FakeMutationObserver {
    constructor(callback: MutationCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
    takeRecords(): MutationRecord[] {
      return [];
    }
  }
  const handle = installTransactionScamFilter({
    document: page.document,
    window: page.window,
    MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
    getPathname: () => HISTORY_PATH,
    debounceMs: 10_000,
    lifecyclePollMs: 0,
  });
  const root = findUniqueTransactionList(page.document);
  const scam = page.document.querySelector('#scam');
  const marker = scam?.querySelector('[class*="History_scam__"]');
  const status = scam?.querySelector('[class*="History_txStatus__"]');
  assert.ok(root && scam && marker && status);

  const firstBatch = Array.from(root.querySelectorAll('[id^="first-"]')).slice(0, 250);
  callbacks[0](
    firstBatch.map((target) => ({ type: 'attributes', target }) as unknown as MutationRecord),
    {} as MutationObserver,
  );
  for (const row of firstBatch) row.remove();
  root.insertAdjacentHTML(
    'beforeend',
    Array.from({ length: 250 }, (_, index) => rowMarkup({ id: `second-${index}` })).join(''),
  );
  const secondBatch = Array.from(root.querySelectorAll('[id^="second-"]'));
  callbacks[0](
    secondBatch.map((target) => ({ type: 'attributes', target }) as unknown as MutationRecord),
    {} as MutationObserver,
  );

  marker.remove();
  callbacks[0]([{
    type: 'childList',
    target: status,
    removedNodes: [marker],
    addedNodes: [],
  } as unknown as MutationRecord], {} as MutationObserver);
  assert.equal(scam.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);

  handle.sync();
  assert.equal(callbacks.length, 2);
  assert.equal(scam.hasAttribute(SCAM_HIDDEN_ATTR), false);
  handle.cleanup();
});

test('SPA departure restores rows and later inactive mutations stay visible', async () => {
  const page = createPage(rowMarkup({ id: 'scam', scamMarkers: 1 }));
  let pathname = HISTORY_PATH;
  const handle = installForPage(page, () => pathname);
  const row = page.document.querySelector('#scam');
  assert.equal(row?.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  assert.equal(page.document.querySelectorAll('[data-dal-scam-filter-style]').length, 1);

  pathname = `/profile/${ADDRESS}`;
  handle.sync();
  assert.equal(row?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);

  row?.querySelector('[class*="History_scam__"]')?.remove();
  row?.querySelector('[class*="History_txStatus__"]')?.insertAdjacentHTML(
    'beforeend',
    '<div class="History_scam__replacement"><svg width="51" height="18"></svg></div>',
  );
  await settle(handle);
  assert.equal(row?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  handle.cleanup();
});

test('installation is idempotent and cleanup fully restores DOM ownership', () => {
  const page = createPage(rowMarkup({ id: 'scam', scamMarkers: 1 }));
  const first = installForPage(page);
  const second = installForPage(page);
  const row = page.document.querySelector('#scam');
  assert.equal(first, second);
  assert.equal(page.document.querySelectorAll('[data-dal-scam-filter-style]').length, 1);
  assert.equal(row?.getAttribute(SCAM_HIDDEN_ATTR), 'true');

  first.cleanup();
  assert.equal(row?.hasAttribute(SCAM_HIDDEN_ATTR), false);
  assert.equal(page.document.querySelector('[data-dal-scam-filter-style]'), null);

  const third = installForPage(page);
  assert.notEqual(third, first);
  assert.equal(row?.getAttribute(SCAM_HIDDEN_ATTR), 'true');
  third.cleanup();
});
