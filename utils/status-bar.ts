import type { CoverageIssue } from './overlay';

export type LensPhase =
  | 'waiting'
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'stopping'
  | 'stopped'
  | 'error';

export type LensCoverage = 'none' | 'complete' | 'partial' | 'empty';

export interface LensStatus {
  phase: LensPhase;
  coverage: LensCoverage;
  gapCount?: number;
  gapDetails?: string[];
  hasData: boolean;
  canRefresh: boolean;
  lastUpdatedAt?: number;
  detail?: string;
}

export interface LensStatusActions {
  refresh(): void;
  stop(): void;
}

export function formatCoverageIssue(issue: CoverageIssue): string {
  return issue.detail.startsWith(`${issue.label}：`)
    ? issue.detail
    : `${issue.label}：${issue.detail}`;
}

const STATUS_ATTR = 'data-dal-status';

// 常驻版本号:截图即可判断页面里实际运行的代码版本(诊断「扩展 Reload 了但旧
// content script 还活在老标签页」这类假缓存问题)。测试/非扩展环境拿不到则不显示。
const EXT_VERSION = (() => {
  try {
    return browser?.runtime?.getManifest?.().version ?? '';
  } catch {
    return '';
  }
})();
const STATUS_CSS = `
:host { all: initial; display: inline-flex; margin-right: 8px; vertical-align: middle; }
.status-wrap { position: relative; display: inline-flex; }
.bar {
  display: inline-flex; align-items: center; gap: 7px; padding: 2px 4px 2px 8px;
  border: 1px solid rgba(110,119,129,.22); border-radius: 11px;
  background: rgba(110,119,129,.08); color: #6e7781;
  font: 600 11px/1.6 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  white-space: nowrap;
}
.status-tip {
  display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 2147483647;
  width: max-content; max-width: min(560px, calc(100vw - 24px)); padding: 10px 12px;
  border: 1px solid #2a3138; border-radius: 10px;
  background: #101418; color: #e8eaed; box-shadow: 0 8px 30px rgba(0,0,0,.45);
  font: 400 12px/1.6 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  white-space: normal; text-align: left;
}
.status-wrap:hover .status-tip, .status-wrap:focus-within .status-tip { display: block; }
.tip-line + .tip-line { margin-top: 4px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #8c959f; flex: none; }
.bar.busy .dot { background: #bf8700; animation: pulse 1s ease-in-out infinite; }
.bar.ok .dot { background: #2da44e; }
.bar.warn .dot { background: #d29922; }
.bar.err .dot, .bar.stopped .dot { background: #cf222e; }
.label { min-width: 44px; }
.ver { color: #8c959f; font-weight: 400; font-size: 10px; }
button {
  appearance: none; border: 0; border-radius: 8px; padding: 1px 7px;
  background: rgba(88,166,255,.14); color: #0969da; cursor: pointer;
  font: inherit; line-height: 1.6;
}
button:hover:not(:disabled) { background: rgba(88,166,255,.22); }
button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
button:disabled { cursor: default; opacity: .5; }
@keyframes pulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
@media (max-width: 520px) {
  :host { margin-right: 4px; }
  .bar { gap: 5px; padding-left: 6px; }
}
`;

let currentStatus: LensStatus | null = null;
let currentActions: LensStatusActions | null = null;
let observer: MutationObserver | null = null;
let rendering = false;
let pendingRender = false;

function exactTextElement(root: Node, text: string): HTMLElement | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeValue?.trim() !== text) continue;
    const element = node.parentElement;
    if (element && !element.closest(`[${STATUS_ATTR}]`)) return element;
  }
  return null;
}

function presentation(status: LensStatus): {
  label: string;
  tone: 'busy' | 'ok' | 'warn' | 'err' | 'stopped';
  button: string;
  action: 'refresh' | 'stop' | null;
} {
  switch (status.phase) {
    case 'waiting':
      return { label: '等待页面数据', tone: 'warn', button: '等待', action: null };
    case 'loading':
      return { label: '载入中', tone: 'busy', button: '停止', action: 'stop' };
    case 'refreshing':
      return { label: '刷新中', tone: 'busy', button: '停止刷新', action: 'stop' };
    case 'stopping':
      return { label: '正在停止', tone: 'busy', button: '停止中', action: null };
    case 'stopped':
      return {
        label: '已停止',
        tone: 'stopped',
        button: status.canRefresh ? '继续刷新' : '等待',
        action: status.canRefresh ? 'refresh' : null,
      };
    case 'error':
      return {
        label: status.hasData ? '刷新失败 · 保留旧数据' : '载入失败',
        tone: 'err',
        button: status.canRefresh ? '重试' : '等待',
        action: status.canRefresh ? 'refresh' : null,
      };
    case 'ready':
      return {
        label:
          status.coverage === 'partial'
            ? status.gapCount && status.gapCount > 0
              ? `载入完成 · ${status.gapCount}项缺口`
              : '载入完成 · 部分数据'
            : status.coverage === 'empty'
              ? '载入完成 · 无仓位'
              : '载入完成',
        tone: status.coverage === 'partial' ? 'warn' : 'ok',
        button: '刷新',
        action: status.canRefresh ? 'refresh' : null,
      };
  }
}

function tryRender(): void {
  if (!currentStatus || !currentActions) return;
  if (!document.body) {
    pendingRender = true;
    return;
  }
  const anchor = exactTextElement(document.body, 'Data updated');
  if (!anchor) {
    pendingRender = true;
    return;
  }

  rendering = true;
  try {
    document.querySelectorAll(`[${STATUS_ATTR}]`).forEach((node) => node.remove());
    const host = document.createElement('span');
    host.setAttribute(STATUS_ATTR, currentStatus.phase);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STATUS_CSS;
    root.appendChild(style);

    const view = presentation(currentStatus);
    const wrap = document.createElement('span');
    wrap.className = 'status-wrap';
    const bar = document.createElement('span');
    bar.className = `bar ${view.tone}`;
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    const tipLines = [
      ...(EXT_VERSION ? [`APY Lens v${EXT_VERSION}`] : []),
      currentStatus.detail ?? view.label,
      ...(currentStatus.gapDetails ?? []),
      ...(currentStatus.lastUpdatedAt
        ? [`最近完成：${new Date(currentStatus.lastUpdatedAt).toLocaleTimeString()}`]
        : []),
    ];
    bar.setAttribute('aria-label', tipLines.join('；'));

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    bar.appendChild(dot);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = view.label;
    bar.appendChild(label);
    if (EXT_VERSION) {
      const ver = document.createElement('span');
      ver.className = 'ver';
      ver.textContent = `v${EXT_VERSION}`;
      bar.appendChild(ver);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = view.button;
    button.disabled = view.action === null;
    button.setAttribute('aria-label', `APY Lens：${view.button}`);
    if (view.action === 'refresh') button.addEventListener('click', () => currentActions?.refresh());
    if (view.action === 'stop') button.addEventListener('click', () => currentActions?.stop());
    bar.appendChild(button);
    const tip = document.createElement('span');
    tip.className = 'status-tip';
    tip.setAttribute('role', 'tooltip');
    for (const line of tipLines) {
      const row = document.createElement('div');
      row.className = 'tip-line';
      row.textContent = line;
      tip.appendChild(row);
    }
    wrap.appendChild(bar);
    wrap.appendChild(tip);
    root.appendChild(wrap);
    anchor.insertAdjacentElement('beforebegin', host);
    pendingRender = false;
  } finally {
    rendering = false;
  }
}

function ensureObserver(): void {
  if (observer || !document.documentElement) return;
  observer = new MutationObserver((records) => {
    if (rendering || !currentStatus) return;
    const meaningful = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(
        (node) => !(node instanceof HTMLElement && node.hasAttribute(STATUS_ATTR)),
      ));
    if (!meaningful) return;
    const existing = document.querySelector(`[${STATUS_ATTR}]`);
    if (pendingRender || !existing) tryRender();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

export function renderStatusBar(status: LensStatus, actions: LensStatusActions): void {
  currentStatus = status;
  currentActions = actions;
  pendingRender = true;
  ensureObserver();
  tryRender();
}

export function destroyStatusBar(): void {
  currentStatus = null;
  currentActions = null;
  pendingRender = false;
  observer?.disconnect();
  observer = null;
  document.querySelectorAll(`[${STATUS_ATTR}]`).forEach((node) => node.remove());
}
