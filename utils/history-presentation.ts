// DeBank history 的纯展示层：只按已确认的资产流向分类、计价与汇总，不推断策略好坏。

import { usd } from './apy';
import { REGISTERED_ROUTES } from './adapters/registry';
import { CHAINS } from './chains';
import type {
  HistoryEntry,
  HistoryListResult,
  HistoryTransfer,
} from './history';

export type HistoryKind = '加仓' | '减仓' | '领奖' | '换仓' | '授权' | '其他';

export interface ClassifiedHistoryEntry {
  kind: HistoryKind;
  detail: string;
}

export interface ProjectFlowSummary {
  projectId: string | null;
  project: string | null;
  netUsd: number;
  pricedLegs: number;
  unpricedLegs: number;
}

export interface HistoryFlowSummary {
  projects: ProjectFlowSummary[];
  unpricedLegs: number;
}

export interface TimelineRow extends ClassifiedHistoryEntry {
  time: string;
  chainLabel: string;
  project: string | null;
}

export interface TimelinePresentation {
  rows: TimelineRow[];
  droppedRows: number;
  unpricedLegs: number;
}

const APPROVAL_PATTERN = /approve|approval|authorize|authorization|permit|授权/i;
const CLAIM_PATTERN = /claim|getreward|harvest/i;
// 协议动词优先于转账方向:stake 是「把钱送进协议」的加仓,withdraw 是「从协议拿回」的减仓
// (真机 2026-07-12:makerdao stake 曾被方向法误标为减仓、aave4 withdraw 误标为加仓)
const DEPOSIT_PATTERN = /stake|supply|deposit|mint|lock|bond|provide|addliquidity|join/i;
const WITHDRAW_PATTERN = /withdraw|redeem|unstake|exit|unlock|removeliquidity/i;
const DETAIL_MAX_CHARS = 120;

function routeMatchesProject(projectId: string): string | null {
  for (const route of REGISTERED_ROUTES) {
    const matches = route.kind === 'rate'
      ? route.adapter.matches(projectId)
      : route.matches(projectId);
    if (matches) return route.route;
  }
  return null;
}

function projectLabel(projectId: string | null): string | null {
  if (projectId === null) return null;
  return routeMatchesProject(projectId) ?? projectId;
}

function compactQuantity(value: number): string {
  const abs = Math.abs(value);
  const raw = abs >= 1e9
    ? `${(abs / 1e9).toFixed(2)}B`
    : abs >= 1e6
      ? `${(abs / 1e6).toFixed(2)}M`
      : abs >= 1e3
        ? `${(abs / 1e3).toFixed(1)}k`
        : abs.toFixed(4).replace(/\.?0+$/, '');
  return `${value < 0 ? '-' : ''}${raw || '0'}`;
}

/** 无 symbol 时用地址缩写(0x1234…abcd);非地址型 id 截前 10 位。 */
function tokenLabel(transfer: HistoryTransfer): string {
  if (transfer.symbol) return transfer.symbol;
  const id = transfer.tokenId;
  if (/^0x[0-9a-fA-F]{40}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

function transferText(transfer: HistoryTransfer): string {
  const amount = transfer.price === null
    ? compactQuantity(transfer.amount)
    : usd(transfer.amount * transfer.price);
  return `${amount} ${tokenLabel(transfer)}`;
}

function transfersText(transfers: HistoryTransfer[]): string {
  return transfers.map(transferText).join(' + ');
}

function truncateDetail(value: string): string {
  return value.length <= DETAIL_MAX_CHARS
    ? value
    : `${value.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

function target(entry: HistoryEntry): string {
  return entry.projectId ?? '未标注协议';
}

/** 规则顺序固定:授权 > 领奖(claim 动词) > 加仓/减仓(协议动词) > 换仓(双向) > 纯转账(其他)。
 *  协议动词优先于转账方向——方向法会把 stake 误标减仓、withdraw 误标加仓(真机实证)。 */
export function classifyEntry(entry: HistoryEntry): ClassifiedHistoryEntry {
  const approvalText = `${entry.cateId ?? ''} ${entry.txName ?? ''}`;
  if (APPROVAL_PATTERN.test(approvalText)) {
    return {
      kind: '授权',
      detail: truncateDetail(`授权${entry.txName ? ` ${entry.txName}` : ''} → ${target(entry)}`),
    };
  }

  const hasSends = entry.sends.length > 0;
  const hasReceives = entry.receives.length > 0;
  const normalizedTxName = (entry.txName ?? '').replace(/[^a-z]/gi, '');
  if (CLAIM_PATTERN.test(normalizedTxName) && hasReceives) {
    return {
      kind: '领奖',
      detail: truncateDetail(`领取 ${transfersText(entry.receives)} → ${target(entry)}`),
    };
  }
  if (DEPOSIT_PATTERN.test(normalizedTxName) && (hasSends || hasReceives)) {
    // 存入协议:资产从钱包流出(sends);带回执代币的存款也以流出侧为准
    const legs = hasSends ? entry.sends : entry.receives;
    return {
      kind: '加仓',
      detail: truncateDetail(`存入 ${transfersText(legs)} → ${target(entry)}`),
    };
  }
  if (WITHDRAW_PATTERN.test(normalizedTxName) && (hasSends || hasReceives)) {
    // 取出协议:资产流回钱包(receives);销毁份额型取款以流入侧为准
    const legs = hasReceives ? entry.receives : entry.sends;
    return {
      kind: '减仓',
      detail: truncateDetail(`取出 ${transfersText(legs)} ← ${target(entry)}`),
    };
  }
  if (hasSends && hasReceives) {
    return {
      kind: '换仓',
      detail: truncateDetail(
        `换出 ${transfersText(entry.sends)} → 换入 ${transfersText(entry.receives)} · ${target(entry)}`,
      ),
    };
  }
  if (hasSends) {
    // 无协议动词的纯流出=普通转账,不冒充减仓
    return {
      kind: '其他',
      detail: truncateDetail(`转出 ${transfersText(entry.sends)} → ${target(entry)}`),
    };
  }
  if (hasReceives) {
    return {
      kind: '其他',
      detail: truncateDetail(`收到 ${transfersText(entry.receives)} ← ${target(entry)}`),
    };
  }
  return {
    kind: '其他',
    detail: truncateDetail(`${entry.txName ?? entry.cateId ?? '无资产流动'} · ${target(entry)}`),
  };
}

/** 按原始 projectId 汇总已计价腿；缺价腿不进入金额，只累计数量。 */
export function summarizeFlows(entries: readonly HistoryEntry[]): HistoryFlowSummary {
  const byProject = new Map<string | null, ProjectFlowSummary>();
  let unpricedLegs = 0;
  for (const entry of entries) {
    const summary = byProject.get(entry.projectId) ?? {
      projectId: entry.projectId,
      project: projectLabel(entry.projectId),
      netUsd: 0,
      pricedLegs: 0,
      unpricedLegs: 0,
    };
    const apply = (transfer: HistoryTransfer, sign: 1 | -1) => {
      if (transfer.price === null) {
        summary.unpricedLegs += 1;
        unpricedLegs += 1;
        return;
      }
      summary.pricedLegs += 1;
      summary.netUsd += sign * transfer.amount * transfer.price;
    };
    for (const transfer of entry.sends) apply(transfer, -1);
    for (const transfer of entry.receives) apply(transfer, 1);
    byProject.set(entry.projectId, summary);
  }
  return { projects: [...byProject.values()], unpricedLegs };
}

function taipeiTime(timeAt: number): string {
  const date = new Date((timeAt + 8 * 60 * 60) * 1_000);
  if (!Number.isFinite(date.getTime())) return '--';
  const shifted = date.toISOString();
  return `${shifted.slice(5, 10)} ${shifted.slice(11, 16)}`;
}

export function historyDroppedRowsNotice(droppedRows: number): string | null {
  return droppedRows > 0
    ? `有 ${droppedRows} 条记录未纳入(诈骗过滤/无法解析/超出配额)`
    : null;
}

export function buildTimelinePresentation(
  result: Readonly<HistoryListResult>,
  max = 20,
): TimelinePresentation {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 20;
  const entries = [...result.entries]
    .sort((a, b) => b.timeAt - a.timeAt)
    .slice(0, limit);
  const flow = summarizeFlows(entries);
  return {
    rows: entries.map((entry) => ({
      time: taipeiTime(entry.timeAt),
      chainLabel: CHAINS[entry.chain]?.label ?? entry.chain,
      project: projectLabel(entry.projectId),
      ...classifyEntry(entry),
    })),
    droppedRows: result.droppedRows,
    unpricedLegs: flow.unpricedLegs,
  };
}
