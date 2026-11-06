import { tr, getLocale } from './i18n';
// 悬浮面板渲染（Shadow DOM 样式隔离）。
// v0.1 刻意用固定悬浮面板而非嵌入 DeBank 卡片——对 DeBank 的 DOM 改版免疫；
// Phase 1.5 拿到真实 DOM 锚点后再做嵌入式徽章。
// 安全：页面数据一律走 textContent，不进 innerHTML。

import { pct, usd, type AssetYield, type ProtocolYield } from './apy';
import {
  normalizeRewardCoverage,
  type RewardComponent,
} from './adapters/types';
import { fmtPrice, type LpRange } from './uniswap';
import {
  assessLiquidityRisk,
  RED_AVAILABLE_MULTIPLE,
  YELLOW_SHARE_THRESHOLD,
  type LiquidityRiskAssessment,
} from './liquidity-risk';
import type { HistoryListResult } from './history';
import {
  buildTimelinePresentation,
  historyDroppedRowsNotice,
  summarizeFlows,
} from './history-presentation';

export interface ItemYield {
  name: string; // DeBank 的仓位类型名，如 "Lending"
  /** DeBank 的独立仓位说明，如同一 Yield 表内的不同 Midnight 市场。 */
  displayName?: string;
  /** LP NFT / position identifier, retained even when range lookup fails. */
  positionId?: string;
  yield: ProtocolYield;
  /** Uniswap V3 等 LP 仓位的区间信息（链上实时读取） */
  range?: LpRange;
}

export interface ProtocolCard {
  key: string;
  title: string;
  chainLabel: string;
  /** DeBank 卡头渲染的净值(Σ item.stats.net_usd_value,**含待领奖励**)。
   *  锚定身份基准必须用它而非 yield.equityUsd(=ΣS−ΣB,不含奖励腿)——
   *  奖励重仓卡两者可差 >10%,用 equityUsd 对比卡头金额会系统性误杀
   *  (2026-07-14 对抗审查 finding:身份基准错位)。 */
  pageNetUsd?: number;
  /** rates = 借贷/储蓄类（有利率）；lp = 流动性仓位（看区间） */
  kind: 'rates' | 'lp';
  /** 协议级合并统计（全部仓位加总） */
  yield: ProtocolYield;
  /** 每个独立仓位（DeBank portfolio_item）各自的净值/杠杆/净APY */
  items: ItemYield[];
}

function componentValue(component: RewardComponent): string {
  if (component.rateKind === 'annual-usd') return tr("{0}/年", usd(component.value));
  return `${pct(component.value)} ${component.rateKind.toUpperCase()}`;
}

export interface AssetRatePresentation {
  compactBase: string;
  compactRewards: string[];
  compactEntitlements: string[];
  compact: string;
  details: string[];
  incomplete: boolean;
}

/** 同一份语义同时生成默认简写与悬浮详情，避免两套 UI 漂移。 */
export function assetRatePresentation(asset: AssetYield): AssetRatePresentation {
  const reward = normalizeRewardCoverage(asset);
  const signedBase = asset.baseApy === null
    ? null
    : asset.leg === 'borrow'
      ? -asset.baseApy
      : asset.baseApy;
  const compactBase = `APY ${pct(signedBase)}`;
  const details = [
    asset.leg === 'borrow'
      ? tr("借款成本 {0}", pct(signedBase))
      : tr("基础 APY {0}", pct(asset.baseApy)),
  ];
  const components = [
    ...new Map(reward.rewardComponents.map((component) => [component.id, component])).values(),
  ];
  const entitlements = [
    ...new Map(
      (asset.rewardEntitlements ?? []).map((entry) => [entry.id, entry] as const),
    ).values(),
  ];
  const compactRewards: string[] = [];
  if (components.length > 0) {
    for (const component of components) {
      details.push(tr("奖励{0} {1}", component.label ? ` ${component.label}` : '', componentValue(component)));
    }
    const rateTotal = components
      .filter((component) => component.rateKind !== 'annual-usd')
      .reduce((sum, component) => sum + component.value, 0);
    const annualUsd = components
      .filter((component) => component.rateKind === 'annual-usd')
      .reduce((sum, component) => sum + component.value, 0);
    if (rateTotal > 0) compactRewards.push(pct(rateTotal));
    if (annualUsd > 0) compactRewards.push(tr("{0}/年", usd(annualUsd)));
    const state = reward.rewardState;
    if (state === 'unknown') {
      if (entitlements.length === 0) {
        details.push(tr("其他奖励 未知"));
        compactRewards.push('--');
      }
    } else if (state === 'non-annualizable') {
      if (entitlements.length === 0) {
        details.push(tr("另有奖励存在，无法年化"));
        compactRewards.push('--');
      }
    }
  } else {
    switch (reward.rewardState) {
      case 'numeric-known':
        details.push(reward.rewardApr === null ? tr("奖励 未知") : tr("奖励 {0} APR", pct(reward.rewardApr)));
        compactRewards.push(reward.rewardApr === null ? '--' : pct(reward.rewardApr));
        break;
      case 'confirmed-zero':
        details.push(tr("奖励 0%"));
        compactRewards.push('0%');
        break;
      case 'unknown':
        details.push(tr("奖励 未知"));
        compactRewards.push('--');
        break;
      case 'non-annualizable':
        details.push(tr("奖励存在，无法年化"));
        compactRewards.push('--');
        break;
      case 'not-applicable':
        if (entitlements.length === 0) details.push(tr("奖励 不适用"));
        break;
    }
  }
  for (const entitlement of entitlements) {
    const verification = entitlement.verification === 'index-confirmed'
      ? tr("索引已核实")
      : entitlement.verification === 'rule-confirmed'
        ? tr("当前规则已核实")
        : tr("资格未核实");
    const category = entitlement.category === 'ecosystem-reward' ? tr("生态奖励") : tr("积分");
    details.push(`${category} ${entitlement.label}：${entitlement.display}`);
    details.push(tr("资格状态：{0}", verification));
    details.push(tr("计算口径：不可折算 APY，不计入净APY或今日收益"));
  }
  const compactEntitlements = entitlements.map((entry) => tr(entry.display));
  const compactRates = [compactBase, ...compactRewards].join(' + ');
  return {
    compactBase,
    compactRewards,
    compactEntitlements,
    compact: compactEntitlements.length > 0
      ? `${compactRates} · ${compactEntitlements.join(' · ')}`
      : compactRates,
    details,
    incomplete:
      asset.baseApy === null ||
      reward.rewardState === 'unknown' ||
      reward.rewardState === 'non-annualizable',
  };
}

/** 资产行的完整悬浮语义。 */
export function assetRateLines(asset: AssetYield): string[] {
  return assetRatePresentation(asset).details;
}

/** 资产行默认显示的粗颗粒度简写。 */
export function assetRateCompact(asset: AssetYield): string {
  return assetRatePresentation(asset).compact;
}

export interface LiquidityRiskPresentation extends LiquidityRiskAssessment {
  compact: string;
  details: string[];
}

function tokenAmount(value: number, symbol: string): string {
  const abs = Math.abs(value);
  const scaledRaw = abs >= 1e9
    ? `${(abs / 1e9).toFixed(2)}B`
    : abs >= 1e6
      ? `${(abs / 1e6).toFixed(2)}M`
      : abs >= 1e3
        ? `${(abs / 1e3).toFixed(1)}k`
        : abs.toFixed(4).replace(/\.?0+$/, '');
  const scaled = scaledRaw || '0';
  return `${value < 0 ? '-' : ''}${scaled} ${symbol}`;
}

/** 流动性徽章与 tooltip 共用的 presentation；无警戒命中时不生成展示。 */
export function liquidityRiskPresentation(asset: AssetYield): LiquidityRiskPresentation | null {
  if (asset.leg !== 'supply' || !asset.poolStat) return null;
  const assessment = assessLiquidityRisk(
    { usd: asset.token.usd, tokens: asset.token.amount },
    asset.poolStat,
  );
  if (!assessment.level || assessment.sharePct === null) return null;

  const isUsd = asset.poolStat.unit === 'usd';
  const position = isUsd ? asset.token.usd : asset.token.amount;
  const format = isUsd
    ? (value: number) => usd(value)
    : (value: number) => tokenAmount(value, asset.token.symbol);
  const available = asset.poolStat.available === null
    ? '--'
    : format(asset.poolStat.available);
  const basis = isUsd ? '' : tr("（token 口径）");
  return {
    ...assessment,
    compact: assessment.level === 'red'
      ? tr("⚠流动性紧张")
      : tr("占比 {0}", pct(assessment.sharePct)),
    details: [
      tr("我仓位 {0} · 占池子 {1}{2}", format(position), pct(assessment.sharePct), basis),
      tr("池子总规模 {0} · 当前可提 {1}{2}", format(asset.poolStat.total), available, basis),
      tr("规则：当前可提≤我仓位×{0} 为红；占池子≥{1} 为黄（红优先）", pct(RED_AVAILABLE_MULTIPLE), pct(YELLOW_SHARE_THRESHOLD)),
      tr("流动性数据源：{0}", asset.poolStat.source),
    ],
  };
}

/** 只有覆盖完整时才使用“净 APY”；否则明确标成已知组成部分的小计。 */
export function yieldHeadline(yieldValue: ProtocolYield): string {
  if (
    (!yieldValue.rewardCoverageComplete || !yieldValue.rateCoverageComplete) &&
    yieldValue.knownNetApy !== null
  ) {
    return tr("小计 {0}", pct(yieldValue.knownNetApy));
  }
  return tr("净APY {0}", pct(yieldValue.netApy));
}

/** LP 区间文字只保留状态与价格；DEX APY 策略不占用仓位卡片。 */
export const rangeText = (r: LpRange): string =>
  `${r.inRange ? tr("区间内") : tr("区间外")} ` +
  (r.fullRange
    ? tr("全区间 ⟨{0}⟩", fmtPrice(r.currentPrice))
    : `${fmtPrice(r.lowerPrice)} ⟨${fmtPrice(r.currentPrice)}⟩ ${fmtPrice(r.upperPrice)}`);

export interface PortfolioSummary {
  estDailyUsd: number; // 今日预估（当前利率前瞻）
  /** 奖励覆盖不完整时保留的已知日收益小计。 */
  knownEstDailyUsd?: number | null;
  /** false 时 estDailyUsd 不得作为完整组合收益展示。 */
  rewardCoverageComplete?: boolean;
  rateCoverageComplete?: boolean;
  coveredUsd: number; // 参与计算的仓位规模
  uncoveredUsd: number; // 应纳入 APY、但利率未匹配的仓位规模
  excludedUsd?: number; // 按产品策略明确排除的规模（当前为 LP 手续费收益）
  lpTotal: number; // LP 仓位总数（含区间信息的）
  lpOutOfRange: number; // 出区间的 LP 仓位数
  liquidityRedCount?: number; // 可提流动性命中红线的出借腿数量
  claimableUsd: number | null; // Merkl 待领奖励合计；null=全部查询未知
  claimableState: 'complete' | 'partial' | 'unknown';
  claimTop: { symbol: string; usd: number }[]; // 待领前三
  claimFailures?: { chainId: number; chainLabel: string; reason: string }[];
}

export interface CoverageIssue {
  id: string;
  label: string;
  detail: string;
}

export function portfolioDailyHeadline(summary: PortfolioSummary): {
  complete: boolean;
  label: string;
  value: number;
} {
  const grossUsd = summary.coveredUsd + summary.uncoveredUsd;
  const materialUncovered = grossUsd > 0 && summary.uncoveredUsd > grossUsd * 0.01;
  const complete =
    (summary.rewardCoverageComplete ?? true) &&
    (summary.rateCoverageComplete ?? true) &&
    !materialUncovered;
  return {
    complete,
    label: complete ? tr("今日预估") : tr("今日小计"),
    value: complete
      ? summary.estDailyUsd
      : (summary.knownEstDailyUsd ?? summary.estDailyUsd),
  };
}

export interface EnrichResult {
  summary?: PortfolioSummary;
  cards: ProtocolCard[];
  skippedProtocols: number;
  /** False when the page payload exceeded a structural work budget. */
  inputCoverageComplete?: boolean;
  inputLimitReasons?: string[];
  /** Product-level gaps, deduplicated for the page status bar. */
  coverageIssues?: CoverageIssue[];
  generatedAt: number;
  error?: string;
}

export const PANEL_HOST_ID = 'debank-apy-lens-host';
const HOST_ID = PANEL_HOST_ID;

const CSS = `
:host { all: initial; }
.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  width: 340px; max-height: 70vh; overflow-y: auto;
  background: #101418; color: #e8eaed;
  border: 1px solid #2a3138; border-radius: 10px;
  font: 12px/1.5 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  box-shadow: 0 8px 30px rgba(0,0,0,.45);
}
.panel:focus-visible, .hbtn:focus-visible, summary:focus-visible {
  outline: 2px solid #58a6ff; outline-offset: 2px;
}
.hdr { display: flex; justify-content: space-between; align-items: center;
  padding: 10px 12px; border-bottom: 1px solid #2a3138; position: sticky; top: 0; background: #101418; }
.hdr b { font-size: 13px; }
.hdr-right { display: flex; align-items: center; gap: 6px; }
.hbtn { border: none; background: #1c2228; color: #c9d1d9; width: 20px; height: 20px;
  border-radius: 5px; cursor: pointer; font-size: 11px; line-height: 1; padding: 0; }
.hbtn:hover, .hbtn:focus-visible { background: #2a3138; }
.age { color: #7d8590; font-size: 11px; }
.proto { padding: 8px 12px; border-bottom: 1px solid #1c2228; }
.proto:last-child { border-bottom: none; }
summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; gap: 8px; }
summary::-webkit-details-marker { display: none; }
.name { font-weight: 600; }
.chain { color: #7d8590; margin-left: 6px; font-weight: 400; }
.net { font-weight: 700; }
.net.pos { color: #3fb950; } .net.neg { color: #f85149; } .net.na { color: #7d8590; }
.lev { color: #d29922; margin-left: 6px; font-weight: 400; }
.item { margin-top: 6px; padding-top: 4px; border-top: 1px dashed #2a3138; color: #9ea7b3; font-weight: 600; }
.row { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-top: 4px; color: #c9d1d9; }
.row .sym { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.supply .sym::before { content: "▲ "; color: #3fb950; }
.borrow .sym::before { content: "▼ "; color: #f85149; }
.rates { color: #8b949e; min-width: 0; text-align: right; }
.risk.red { color: #cf222e; }
.risk.yellow { color: #9a6700; }
.rate-line { display: block; }
.flag { margin-top: 6px; color: #d29922; font-size: 11px; }
.empty { padding: 12px; color: #7d8590; }
.daily { color: #7d8590; margin-top: 4px; }
.timeline-row {
  display: grid; grid-template-columns: 68px 64px 34px minmax(0, 1fr);
  gap: 6px; align-items: start; margin-top: 6px; color: #c9d1d9;
}
.timeline-time, .timeline-chain { color: #7d8590; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.timeline-kind { color: #c9d1d9; background: #1c2228; border-radius: 5px; text-align: center; white-space: nowrap; }
.timeline-detail { min-width: 0; overflow-wrap: anywhere; }
.timeline-meta { color: #7d8590; font-size: 11px; margin-top: 8px; }
@media (max-width: 420px) {
  .panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); max-height: 75vh; }
  summary, .row { flex-wrap: wrap; }
  .rates { width: 100%; margin-left: 18px; text-align: left; }
  .timeline-row { grid-template-columns: 68px 58px 34px minmax(0, 1fr); }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = tr(text);
  return node;
}

function ensureRoot(): ShadowRoot {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
  }
  if (!host.shadowRoot) {
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }
  return host.shadowRoot!;
}

export function removePanel(): void {
  document.getElementById(HOST_ID)?.remove();
}

// 用户手动关闭后本页会话内不再弹出；最小化只留标题条
let panelDismissed = false;
let panelMinimized = false;

export function renderPanel(result: EnrichResult, history?: Readonly<HistoryListResult>): void {
  if (panelDismissed) return;
  const root = ensureRoot();
  root.querySelector('.panel')?.remove();

  const panel = el('div', 'panel');
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', tr("APY Lens 收益覆盖详情"));
  const hdr = el('div', 'hdr');
  hdr.appendChild(el('b', undefined, 'APY Lens'));
  const right = el('span', 'hdr-right');
  right.appendChild(el('span', 'age', new Date(result.generatedAt).toLocaleTimeString(getLocale())));
  const btnMin = el('button', 'hbtn', panelMinimized ? '□' : '—');
  btnMin.type = 'button';
  btnMin.title = panelMinimized ? tr("展开") : tr("最小化");
  btnMin.setAttribute('aria-label', panelMinimized ? tr("展开 APY Lens") : tr("最小化 APY Lens"));
  btnMin.setAttribute('aria-expanded', String(!panelMinimized));
  btnMin.addEventListener('click', () => {
    panelMinimized = !panelMinimized;
    renderPanel(result, history);
  });
  const btnClose = el('button', 'hbtn', '✕');
  btnClose.type = 'button';
  btnClose.title = tr("关闭（本页不再显示）");
  btnClose.setAttribute('aria-label', tr("关闭 APY Lens"));
  btnClose.addEventListener('click', () => {
    panelDismissed = true;
    removePanel();
  });
  right.appendChild(btnMin);
  right.appendChild(btnClose);
  hdr.appendChild(right);
  panel.appendChild(hdr);

  if (panelMinimized) {
    root.appendChild(panel);
    return; // 只留标题条
  }

  if (result.inputCoverageComplete === false) {
    panel.appendChild(
      el('div', 'empty', tr("DeBank 仓位输入超出安全处理上限；仅显示已验证小计，未处理部分保持未知。")),
    );
  } else if (result.cards.length === 0) {
    panel.appendChild(
      el('div', 'empty', tr("本页未发现可解析的受支持仓位（跳过 {0} 个其他协议）", result.skippedProtocols)),
    );
  }

  for (const card of result.cards) {
    const y = card.yield;
    const details = document.createElement('details');
    details.className = 'proto';
    details.open = true;

    const summary = document.createElement('summary');
    const left = el('span');
    left.appendChild(el('span', 'name', card.title));
    left.appendChild(el('span', 'chain', card.chainLabel));
    const right = el('span');
    if (card.kind === 'lp') {
      const anyOut = card.items.some((it) => it.range && !it.range.inRange);
      right.appendChild(el('span', `net ${anyOut ? 'neg' : 'pos'}`, `LP ×${card.items.length}`));
    } else {
      const complete = y.rewardCoverageComplete && y.rateCoverageComplete;
      const shownYield = complete ? y.netApy : y.knownNetApy;
      const netCls = shownYield === null ? 'na' : shownYield >= 0 ? 'pos' : 'neg';
      right.appendChild(el('span', `net ${netCls}`, yieldHeadline(y)));
      if (y.leverage !== null && y.leverage > 1.05) {
        right.appendChild(el('span', 'lev', `${y.leverage.toFixed(2)}x`));
      }
    }
    summary.appendChild(left);
    summary.appendChild(right);
    details.appendChild(summary);

    const multiItem = card.items.length > 1;
    for (const it of card.items) {
      if (card.kind === 'lp') {
        const r = it.range;
        details.appendChild(
          el(
            'div',
            'item',
            r
              ? `#${r.positionIndex} ${rangeText(r)} · ${usd(it.yield.equityUsd)}`
              : tr("{0} · {1} · 区间数据不可用", it.name, usd(it.yield.equityUsd)),
          ),
        );
        continue;
      }
      if (multiItem) {
        const iy = it.yield;
        const lev = iy.leverage !== null && iy.leverage > 1.05 ? ` · ${iy.leverage.toFixed(2)}x` : '';
        details.appendChild(
          el('div', 'item', tr("{0} · 净值 {1}{2} · {3}", it.name, usd(iy.equityUsd), lev, yieldHeadline(iy))),
        );
      }
      for (const a of it.yield.assets) {
        const row = el('div', `row ${a.leg}`);
        row.appendChild(el('span', 'sym', `${a.token.symbol} ${usd(a.token.usd)}`));
        const presentation = assetRatePresentation(a);
        const rates = el('span', 'rates', presentation.compact);
        const risk = liquidityRiskPresentation(a);
        if (risk) rates.appendChild(el('span', `risk ${risk.level}`, ` · ${risk.compact}`));
        const rateDetails = [...presentation.details, ...(risk?.details ?? [])];
        rates.title = tr(rateDetails.join(' + '));
        rates.setAttribute('aria-label', tr(rateDetails.join('；')));
        row.appendChild(rates);
        details.appendChild(row);
      }
    }

    const complete = y.rewardCoverageComplete && y.rateCoverageComplete;
    const daily = complete ? y.estDailyUsd : y.knownEstDailyUsd;
    if (daily !== null) {
      details.appendChild(
        el(
          'div',
          'daily',
          tr("权益 {0} · {1} {2}（按当前已知利率前瞻推算）", usd(y.equityUsd), complete ? tr("预估日收益") : tr("日收益小计"), usd(daily)),
        ),
      );
    }
    for (const f of y.flags) {
      const flag = el('div', 'flag', `⚠ ${f}`);
      flag.setAttribute('role', 'status');
      details.appendChild(flag);
    }

    panel.appendChild(details);
  }

  if (history && history.entries.length > 0) {
    const timeline = buildTimelinePresentation(history);
    const details = document.createElement('details');
    details.className = 'proto timeline';

    const summary = document.createElement('summary');
    summary.appendChild(el('span', 'name', tr("近期动向({0} 条)", timeline.rows.length)));
    const shownEntries = [...history.entries]
      .sort((a, b) => b.timeAt - a.timeAt)
      .slice(0, timeline.rows.length);
    const flow = summarizeFlows(shownEntries);
    const flowLines = flow.projects.map((item) => {
      if (item.pricedLegs === 0 && item.unpricedLegs > 0) {
        return tr("{0}：净流向未知({1} 条腿未计价)", item.project ?? tr("未标注协议"), item.unpricedLegs);
      }
      const direction = item.netUsd > 0 ? tr("净流入") : item.netUsd < 0 ? tr("净流出") : tr("净流向持平");
      const amount = item.netUsd === 0 ? usd(0) : usd(Math.abs(item.netUsd));
      const scope = item.unpricedLegs > 0 ? tr("已计价腿") : '';
      const omitted = item.unpricedLegs > 0 ? tr("(另 {0} 条腿未计价)", item.unpricedLegs) : '';
      return `${item.project ?? tr("未标注协议")}：${scope}${direction} ${amount}${omitted}`;
    });
    if (flowLines.length > 0) {
      const tooltip = flowLines.join('\n');
      summary.title = tooltip;
      summary.setAttribute('aria-label', tr("近期动向 {0} 条；{1}", timeline.rows.length, flowLines.join('；')));
    }
    details.appendChild(summary);

    for (const row of timeline.rows) {
      const line = el('div', 'timeline-row');
      line.appendChild(el('span', 'timeline-time', row.time));
      const chain = el('span', 'timeline-chain', row.chainLabel);
      chain.title = row.chainLabel;
      line.appendChild(chain);
      line.appendChild(el('span', 'timeline-kind', row.kind));
      line.appendChild(el('span', 'timeline-detail', row.detail));
      details.appendChild(line);
    }
    const notice = historyDroppedRowsNotice(timeline.droppedRows);
    if (notice) details.appendChild(el('div', 'timeline-meta', notice));
    panel.appendChild(details);
  }

  root.appendChild(panel);
}
