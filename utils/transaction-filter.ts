/**
 * DeBank transaction scam-row filter.
 *
 * This module is deliberately independent from the APY capture/enrichment path:
 * it reads only the already-rendered DOM and never sends messages or requests.
 * Every uncertain DOM shape fails open, leaving the row visible.
 */

export const SCAM_HIDDEN_ATTR = 'data-dal-scam-hidden';
export const SCAM_FILTER_STATE_ATTR = 'data-dal-scam-filter-state';
const VERIFIED_LIST_ATTR = 'data-dal-transaction-list';

const HISTORY_CONTAINER_CLASS_PREFIX = 'HistoryContainer_historyContainer__';
const HISTORY_TABLE_CLASS_PREFIX = 'History_table__';
const HISTORY_ROW_CLASS_PREFIX = 'History_tableLine__';
const HISTORY_STATUS_CLASS_PREFIX = 'History_txStatus__';
const HISTORY_SCAM_CLASS_PREFIX = 'History_scam__';

const HISTORY_CONTAINER_SELECTOR = '[class*="HistoryContainer_historyContainer__"]';
const HISTORY_TABLE_SELECTOR = '[class*="History_table__"]';
const HISTORY_ROW_SELECTOR = '[class*="History_tableLine__"]';
const HISTORY_STATUS_SELECTOR = '[class*="History_txStatus__"]';
const HISTORY_SCAM_SELECTOR = '[class*="History_scam__"]';
const TRANSACTION_LINK_SELECTOR = 'a[href*="/tx/"]';

const STYLE_MARK = 'data-dal-scam-filter-style';
const MAX_ROWS_PER_LIST = 500;
const MAX_MUTATIONS_PER_BATCH = 250;
const DEFAULT_DEBOUNCE_MS = 40;
const DEFAULT_LIFECYCLE_POLL_MS = 1_000;

type ObserverConstructor = typeof MutationObserver;

export type TransactionScamFilterState =
  | 'entry-started'
  | 'inactive-route'
  | 'waiting-root'
  | 'attached'
  | 'budget-detached'
  | 'install-error'
  | 'stopped';

export interface TransactionScamFilterHandle {
  /** Re-check the route and the unique transaction-list root immediately. */
  sync(): void;
  /** Apply all currently queued row decisions immediately. */
  flush(): void;
  /** Disconnect observers/timers and restore every row hidden by this instance. */
  cleanup(): void;
}

export interface TransactionScamFilterOptions {
  document?: Document;
  window?: Window;
  MutationObserver?: ObserverConstructor;
  getPathname?: () => string;
  onState?: (state: TransactionScamFilterState) => void;
  debounceMs?: number;
  lifecyclePollMs?: number;
}

export interface TransactionScamFilterBootstrapOptions {
  document?: Document;
  window?: Window;
  install?: typeof installTransactionScamFilter;
}

export interface TransactionFilterInvalidationContext {
  onInvalidated(callback: () => void): unknown;
}

const installations = new WeakMap<Document, TransactionScamFilterHandle>();

function hasSemanticClass(element: Element, prefix: string): boolean {
  return Array.from(element.classList).some((name) => name.startsWith(prefix));
}

function semanticMatches(
  root: ParentNode,
  selector: string,
  prefix: string,
): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((element) =>
    hasSemanticClass(element, prefix),
  );
}

/** Only one bounded profile identifier followed by /history is eligible. */
export function isDeBankTransactionHistoryPath(pathname: string): boolean {
  return /^\/profile\/[^/]{1,256}\/history\/?$/.test(pathname);
}

/**
 * Locate the list only through the two unique semantic CSS-module prefixes
 * observed on DeBank. Ambiguity or an unexpected containment relationship is
 * a fail-open result.
 */
export function findUniqueTransactionList(document: Document): Element | null {
  const containers = semanticMatches(
    document,
    HISTORY_CONTAINER_SELECTOR,
    HISTORY_CONTAINER_CLASS_PREFIX,
  );
  const tables = semanticMatches(document, HISTORY_TABLE_SELECTOR, HISTORY_TABLE_CLASS_PREFIX);
  if (containers.length !== 1 || tables.length !== 1) return null;

  const [container] = containers;
  const [table] = tables;
  if (!container.contains(table)) return null;
  const closestContainer = table.closest(HISTORY_CONTAINER_SELECTOR);
  if (closestContainer !== container || !hasSemanticClass(closestContainer, HISTORY_CONTAINER_CLASS_PREFIX)) {
    return null;
  }
  return table;
}

/**
 * Positive classification requires every independently observed invariant.
 * Color, opacity, error classes, token/address/amount content and fuzzy text
 * are intentionally absent from this predicate.
 */
export function isConfirmedScamTransactionRow(row: Element, listRoot: Element): boolean {
  if (row.parentElement !== listRoot) return false;
  if (!hasSemanticClass(row, HISTORY_ROW_CLASS_PREFIX)) return false;

  const statuses = Array.from(row.children).filter((child) =>
    hasSemanticClass(child, HISTORY_STATUS_CLASS_PREFIX),
  );
  if (statuses.length !== 1) return false;
  const [status] = statuses;

  const markers = semanticMatches(row, HISTORY_SCAM_SELECTOR, HISTORY_SCAM_CLASS_PREFIX);
  if (markers.length !== 1) return false;
  const [marker] = markers;
  if (marker.closest(HISTORY_ROW_SELECTOR) !== row) return false;
  if (
    status === marker ||
    !status.contains(marker) ||
    marker.closest(HISTORY_STATUS_SELECTOR) !== status
  ) {
    return false;
  }

  const transactionLinks = Array.from(row.querySelectorAll(TRANSACTION_LINK_SELECTOR));
  if (transactionLinks.length !== 1) return false;
  const [transactionLink] = transactionLinks;
  if (!status.contains(transactionLink)) return false;
  if (transactionLink.closest(HISTORY_STATUS_SELECTOR) !== status) return false;
  if (transactionLink.closest(HISTORY_ROW_SELECTOR) !== row) return false;

  return true;
}

function directChildForNode(listRoot: Element, node: Node): Element | null {
  let current = node.nodeType === 1
    ? (node as Element)
    : node.parentElement;
  while (current && current.parentElement !== listRoot) {
    if (current === listRoot) return null;
    current = current.parentElement;
  }
  return current?.parentElement === listRoot ? current : null;
}

function rowsOwnedWithin(node: Node, hiddenRows: Set<Element>): Element[] {
  if (node.nodeType !== 1) return [];
  const element = node as Element;
  return Array.from(hiddenRows).filter((row) => row === element || element.contains(row));
}

/** Install once per document; a repeated call returns the same live handle. */
export function installTransactionScamFilter(
  options: TransactionScamFilterOptions = {},
): TransactionScamFilterHandle {
  const document = options.document ?? globalThis.document;
  const window = options.window ?? document.defaultView ?? globalThis.window;
  const existing = installations.get(document);
  if (existing) return existing;

  const Observer = options.MutationObserver ?? globalThis.MutationObserver;
  const getPathname = options.getPathname ?? (() => window.location.pathname);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const lifecyclePollMs = Math.max(0, options.lifecyclePollMs ?? DEFAULT_LIFECYCLE_POLL_MS);

  let disposed = false;
  let active = false;
  let listRoot: Element | null = null;
  let listObserver: MutationObserver | null = null;
  let styleElement: HTMLStyleElement | null = null;
  let debounceTimer: number | null = null;
  let lifecycleTimer: number | null = null;
  const pendingRows = new Set<Element>();
  const hiddenRows = new Set<Element>();
  let lastReportedState: TransactionScamFilterState | null = null;

  const reportState = (state: TransactionScamFilterState) => {
    if (state === lastReportedState) return;
    lastReportedState = state;
    try {
      options.onState?.(state);
    } catch {
      // Diagnostics must never change filtering behavior.
    }
  };

  const removeOwnedHiddenState = (row: Element) => {
    hiddenRows.delete(row);
    row.removeAttribute(SCAM_HIDDEN_ATTR);
  };

  const clearHiddenAttributesWithin = (root: Element) => {
    root.removeAttribute(SCAM_HIDDEN_ATTR);
    for (const element of Array.from(root.querySelectorAll(`[${SCAM_HIDDEN_ATTR}]`))) {
      removeOwnedHiddenState(element);
    }
  };

  const restoreAllRows = () => {
    for (const row of Array.from(hiddenRows)) removeOwnedHiddenState(row);
  };

  const cancelDebounce = () => {
    if (debounceTimer === null) return;
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const flush = () => {
    cancelDebounce();
    if (!active || !listRoot) {
      pendingRows.clear();
      return;
    }
    const currentRoot = listRoot;
    for (const row of Array.from(pendingRows)) {
      pendingRows.delete(row);
      if (isConfirmedScamTransactionRow(row, currentRoot)) {
        row.setAttribute(SCAM_HIDDEN_ATTR, 'true');
        hiddenRows.add(row);
      } else {
        removeOwnedHiddenState(row);
      }
    }
  };

  const scheduleFlush = () => {
    if (debounceTimer !== null) return;
    debounceTimer = window.setTimeout(flush, debounceMs);
  };

  const queueRow = (row: Element | null): boolean => {
    if (!row || pendingRows.has(row)) return true;
    if (pendingRows.size >= MAX_ROWS_PER_LIST) {
      detachList();
      reportState('budget-detached');
      return false;
    }
    pendingRows.add(row);
    return true;
  };

  const queueFullList = () => {
    if (!listRoot) return;
    // A root-target mutation means individual ownership cannot be trusted.
    // Reconcile only the current direct children; never retain detached rows.
    pendingRows.clear();
    if (listRoot.children.length > MAX_ROWS_PER_LIST) {
      detachList();
      reportState('budget-detached');
      return;
    }
    for (const child of Array.from(listRoot.children)) {
      if (!queueRow(child)) return;
    }
    scheduleFlush();
  };

  const detachList = () => {
    listObserver?.disconnect();
    listObserver = null;
    if (listRoot) clearHiddenAttributesWithin(listRoot);
    listRoot?.removeAttribute(VERIFIED_LIST_ATTR);
    listRoot = null;
    pendingRows.clear();
    cancelDebounce();
    restoreAllRows();
    styleElement?.remove();
    styleElement = null;
  };

  const onListMutations: MutationCallback = (records) => {
    if (!active || !listRoot) return;
    if (
      records.length > MAX_MUTATIONS_PER_BATCH ||
      listRoot.children.length > MAX_ROWS_PER_LIST
    ) {
      detachList();
      reportState('budget-detached');
      return;
    }

    const currentRoot = listRoot;
    let needsBoundedFullScan = false;
    for (const record of records) {
      if (!queueRow(directChildForNode(currentRoot, record.target))) return;
      // Some DOM implementations collapse a descendant childList record to
      // the observed root. The original row is then unknowable, so rescan only
      // this already-bounded list rather than risking a stale hidden row.
      if (record.type === 'childList' && record.target === currentRoot) {
        needsBoundedFullScan = true;
      }
      if (record.type !== 'childList') continue;
      for (const removed of Array.from(record.removedNodes)) {
        for (const row of rowsOwnedWithin(removed, pendingRows)) pendingRows.delete(row);
        for (const row of rowsOwnedWithin(removed, hiddenRows)) removeOwnedHiddenState(row);
      }
      for (const added of Array.from(record.addedNodes)) {
        if (!queueRow(directChildForNode(currentRoot, added))) return;
      }
    }
    if (needsBoundedFullScan) queueFullList();
    else scheduleFlush();
  };

  const attachList = (nextRoot: Element) => {
    detachList();
    if (nextRoot.children.length > MAX_ROWS_PER_LIST) {
      reportState('budget-detached');
      return;
    }
    clearHiddenAttributesWithin(nextRoot);
    listRoot = nextRoot;
    nextRoot.setAttribute(VERIFIED_LIST_ATTR, 'true');
    ensureStyle();
    const observer = new Observer(onListMutations);
    observer.observe(nextRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'href'],
    });
    listObserver = observer;
    queueFullList();
    flush();
    if (listRoot === nextRoot) reportState('attached');
  };

  const ensureStyle = () => {
    if (styleElement?.isConnected) return;
    for (const stale of Array.from(document.querySelectorAll(`style[${STYLE_MARK}]`))) {
      stale.remove();
    }
    const style = document.createElement('style');
    style.setAttribute(STYLE_MARK, '');
    style.textContent = `[${VERIFIED_LIST_ATTR}="true"][class*="History_table__"] > [${SCAM_HIDDEN_ATTR}="true"][class*="History_tableLine__"] { display: none !important; }`;
    (document.head ?? document.documentElement).appendChild(style);
    styleElement = style;
  };

  const deactivate = () => {
    if (!active) return;
    active = false;
    detachList();
  };

  const sync = () => {
    if (disposed) return;
    if (!isDeBankTransactionHistoryPath(getPathname())) {
      deactivate();
      reportState('inactive-route');
      return;
    }

    if (!active) {
      active = true;
    }

    const nextRoot = findUniqueTransactionList(document);
    if (!nextRoot) {
      detachList();
      reportState('waiting-root');
      return;
    }
    if (nextRoot !== listRoot) attachList(nextRoot);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    deactivate();
    if (lifecycleTimer !== null) window.clearInterval(lifecycleTimer);
    window.removeEventListener('popstate', sync);
    window.removeEventListener('hashchange', sync);
    installations.delete(document);
    reportState('stopped');
  };

  const handle: TransactionScamFilterHandle = { sync, flush, cleanup };
  installations.set(document, handle);
  // A prior extension reload can leave inert DOM markers behind. Remove its
  // stylesheet before any route/root decision; a new scoped style is created
  // only after the unique verified list is found.
  for (const stale of Array.from(document.querySelectorAll(`style[${STYLE_MARK}]`))) {
    stale.remove();
  }
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  if (lifecyclePollMs > 0) lifecycleTimer = window.setInterval(sync, lifecyclePollMs);
  sync();
  return handle;
}

/**
 * Start the DOM engine behind an exception boundary so bridge/APY setup always
 * continues. State persistence is best-effort and contains no page identity.
 */
export function startTransactionScamFilterSafely(
  options: TransactionScamFilterBootstrapOptions = {},
): TransactionScamFilterHandle | null {
  const document = options.document ?? globalThis.document;
  const window = options.window ?? document.defaultView ?? globalThis.window;
  let latestState: TransactionScamFilterState = 'entry-started';
  let lastLoggedState: TransactionScamFilterState | null = null;
  let deferredWrite = false;

  const writeState = (state: TransactionScamFilterState) => {
    latestState = state;
    if (state !== lastLoggedState) {
      lastLoggedState = state;
      try {
        console.info(`[APY Lens] scam filter state: ${state}`);
      } catch {
        // Logging is optional; DOM state and engine startup must continue.
      }
    }
    try {
      if (document.documentElement) {
        document.documentElement.setAttribute(SCAM_FILTER_STATE_ATTR, latestState);
        return;
      }
      if (deferredWrite) return;
      deferredWrite = true;
      document.addEventListener('readystatechange', () => {
        deferredWrite = false;
        writeState(latestState);
      }, { once: true });
    } catch {
      // Observability must never become a runtime dependency.
    }
  };

  writeState('entry-started');
  try {
    return (options.install ?? installTransactionScamFilter)({
      document,
      window,
      onState: writeState,
    });
  } catch {
    writeState('install-error');
    return null;
  }
}

/** Share one idempotent cleanup boundary between WXT invalidation and pagehide. */
export function registerTransactionScamFilterCleanup(
  handle: TransactionScamFilterHandle | null,
  context: TransactionFilterInvalidationContext,
): () => void {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      handle?.cleanup();
    } catch {
      // Filter cleanup must never block bridge lifecycle handling.
    }
  };
  try {
    context.onInvalidated(cleanup);
  } catch {
    // pagehide still owns the same safe cleanup if registration is unavailable.
  }
  return cleanup;
}
