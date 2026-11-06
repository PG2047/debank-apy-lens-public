import { tr, getLocale } from './i18n';
// 嵌入式徽章：净APY/杠杆挂协议标题旁；每个独立仓位挂「净值·杠杆·净APY」徽章；
// 每资产行旁挂利率小徽章。
//
// 锚定策略刻意不依赖 DeBank 的 class 名（CSS-module 哈希名每次发版都变）：
//   1. 协议锚点 = 文本恰好等于协议名的元素（如 "Aave V3"）
//   2. 同名多锚点（侧边栏/过滤器也有协议名）按「资产符号就近出现数」评分消歧，
//      真卡片标题附近必有资产符号；净值金额匹配只作加分项
//   3. 仓位锚点 = 卡片容器内文本恰好等于仓位名（如 "Lending"）的元素，同样按该仓位的符号评分
//   4. 资产锚点 = 仓位子容器内文本恰好等于 symbol 的元素
//
// ⚠️ 关键时序：API 响应先于 React 渲染到达——首次注入时卡片往往还不存在。
// 因此本模块自己接管「内嵌 vs 悬浮面板」的编排：每次页面有实质变化（非我们自己的
// 徽章增删）就重试锚定，成功一个就从面板里挪走一个；React 重渲染冲掉徽章也走同一条路自愈。
// 安全：页面数据一律 textContent，不进 innerHTML。

import { usd } from './apy';
import type { AssetYield, ProtocolYield } from './apy';
import {
  assetRatePresentation,
  assetRateLines,
  liquidityRiskPresentation,
  portfolioDailyHeadline,
  renderPanel,
  removePanel,
  rangeText,
  yieldHeadline,
  PANEL_HOST_ID,
} from './overlay';
import type { EnrichResult, ItemYield, ProtocolCard } from './overlay';
import {
  rewardComponentSource,
  rewardEntitlementSource,
  type RewardSourcePresentation,
} from './reward-sources';
import { fmtPrice, type LpRange } from './uniswap';
import type { HistoryListResult } from './history';

const CHIP_ATTR = 'data-dal-chip';
const KEY_ATTR = 'data-dal-key';

const CHIP_CSS = `
:host { all: initial; position: relative; display: inline-block; margin-left: 8px; vertical-align: middle; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 9px; white-space: nowrap;
  font: 600 11px/1.6 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  cursor: default;
}
.chip:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
.chip.pos { color: #2da44e; background: rgba(45,164,78,.12); }
.chip.neg { color: #cf222e; background: rgba(207,34,46,.12); }
.chip.na  { color: #6e7781; background: rgba(110,119,129,.12); }
.chip.warn { color: #9a6700; background: rgba(210,153,34,.14); }
.chip.mini { font-weight: 500; padding: 0 6px; }
.chip.risk { margin-left: 6px; }
.reward { color: #bf8700; }
.points { color: #8250df; }
.tip {
  display: none; position: absolute; top: 100%; left: 0; z-index: 2147483647;
  width: 320px; padding: 10px 12px; border-radius: 10px;
  background: #101418; color: #e8eaed; border: 1px solid #2a3138;
  font: 12px/1.6 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  box-shadow: 0 8px 30px rgba(0,0,0,.45); text-align: left;
}
.chip:hover + .tip, .chip:focus + .tip, .chip[aria-expanded="true"] + .tip, .tip:hover { display: block; }
.tip .row { display: flex; justify-content: space-between; gap: 8px; }
.tip .row .sym { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tip .supply .sym::before { content: "▲ "; color: #3fb950; }
.tip .borrow .sym::before { content: "▼ "; color: #f85149; }
.tip .rates { color: #8b949e; white-space: nowrap; }
.tip .item { margin-top: 6px; padding-top: 4px; border-top: 1px dashed #2a3138; color: #9ea7b3; font-weight: 600; }
/* LP 区间小部件：状态行 + 区间条(游标=现价位置) + 三价标注。
   颜色策略：主文字用 inherit/currentColor 跟随 DeBank 明暗主题，次要文字用两种主题都可读的中灰 */
.rw { width: 204px; max-width: calc(100vw - 24px); padding: 6px 9px; border-radius: 8px; box-sizing: border-box;
  background: rgba(110,119,129,.1);
  font: 11px/1.45 -apple-system, "SF Pro Text", "PingFang SC", sans-serif; color: inherit; }
.rw-id { display: flex; align-items: center; gap: 6px; white-space: nowrap; margin-bottom: 2px; }
.rw-id .pid { font-size: 13px; font-weight: 600; color: inherit; }
.rw-id .tag { padding: 0 6px; border-radius: 7px; font-weight: 600; flex: none; }
.rw.pos .tag { color: #2da44e; background: rgba(45,164,78,.15); }
.rw.neg .tag { color: #cf222e; background: rgba(207,34,46,.15); }
.rw-cur { position: relative; height: 14px; }
.rw-cur .cur { position: absolute; transform: translateX(-50%); font-weight: 700; color: inherit; white-space: nowrap; }
.rw-bar { position: relative; height: 6px; border-radius: 3px; margin: 2px 0 3px; }
.rw.pos .rw-bar { background: rgba(45,164,78,.35); }
.rw.neg .rw-bar { background: rgba(110,119,129,.16); }
.rw-range { position: absolute; top: 0; height: 6px; min-width: 3px; border-radius: 3px; background: rgba(207,34,46,.38); }
.rw-dot { position: absolute; top: -3px; width: 3px; height: 12px; border-radius: 1.5px; background: currentColor; }
.rw-bounds { display: flex; justify-content: space-between; gap: 4px; color: #8b949e; }
.rw-bounds.out { justify-content: flex-end; white-space: nowrap; }
.rw-bounds.out.above { justify-content: flex-start; }
.rw-comp2 { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.rw-mbar { display: flex; height: 5px; width: 58px; border-radius: 3px; overflow: hidden; flex: none; }
.rw-mbar span { display: block; height: 100%; }
.rw-ctxt { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tip .meta { color: #7d8590; margin-top: 6px; }
.tip .flag { color: #d29922; margin-top: 4px; }
.tip .source-block { margin-top: 8px; padding-top: 7px; border-top: 1px dashed #2a3138; }
.tip .source-title { color: #e8eaed; font-weight: 600; }
.tip .source-desc { color: #9ea7b3; margin-top: 3px; }
.tip .source-link { display: inline-block; margin-top: 4px; color: #58a6ff; text-decoration: none; }
.tip .source-link:hover, .tip .source-link:focus-visible { text-decoration: underline; }
.tip.portal-tip { position: fixed; top: 0; left: 0; pointer-events: auto; }
.tip.portal-tip.open { display: block; }
@media (max-width: 420px) {
  :host { margin-left: 4px; max-width: calc(100vw - 24px); }
  .chip { max-width: calc(100vw - 32px); white-space: normal; }
  .tip { position: fixed; top: auto; left: 12px; right: 12px; bottom: 12px; width: auto; max-height: 60vh; overflow-y: auto; }
  .tip .row { flex-wrap: wrap; }
  .tip .rates { white-space: normal; }
  .rw { width: min(204px, calc(100vw - 24px)); }
}
`;

let lastResult: EnrichResult | null = null;
let lastAnchoredCount = 0;
let lastSubAnchorsMissing = 0;
let lastLeftovers: ProtocolCard[] = [];
let lastPanelKeys: string | null = null;
let lastLogLine = '';
let observer: MutationObserver | null = null;
let reinjectTimer: number | null = null;
let injecting = false;
let immediateSyncQueued = false;
let tooltipSeq = 0;
type HistorySource = Readonly<HistoryListResult> | (() => HistoryListResult);
let lastHistorySource: HistorySource | null = null;

function readHistory(): Readonly<HistoryListResult> {
  try {
    return typeof lastHistorySource === 'function'
      ? lastHistorySource()
      : lastHistorySource ?? { entries: [], droppedRows: 0 };
  } catch {
    return { entries: [], droppedRows: 0 };
  }
}

function panelStateKey(leftovers: readonly ProtocolCard[], history: Readonly<HistoryListResult>): string {
  const cards = leftovers.map((card) => card.key).sort().join('|');
  const timeline = [...history.entries]
    .sort((a, b) => b.timeAt - a.timeAt)
    .slice(0, 20)
    .map((entry) => `${entry.id}:${entry.timeAt}`)
    .join('|');
  return `${cards}::${history.droppedRows}:${timeline}`;
}

// ─── 文本锚定 ────────────────────────────────────────────────
function exactTextElements(root: Node, text: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeValue?.trim() !== text) continue;
    const el = n.parentElement;
    if (!el || el.closest(`[${CHIP_ATTR}]`)) continue;
    out.push(el);
  }
  return out;
}

// DeBank 头部净值的常见展示格式（整数带千分位 / 两位小数）
function usdVariants(v: number): string[] {
  const r = Math.abs(v);
  return [
    '$' + Math.round(r).toLocaleString('en-US'),
    '$' + r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ];
}

function symbolsOf(y: ProtocolYield): string[] {
  return [...new Set(y.assets.map((a) => a.token.symbol))];
}

// ─── 锚定核心：fsa（first-symbol-ancestor，首个含符号祖先）───
// 真机踩坑史（2026-07-07/08 两轮张冠李戴）沉淀出的三条铁律：
//   ① 必须停在「第一个包含任何已知符号的祖先」——它就是该文本所属的最小语义容器。
//     继续往上会进入包含多张卡片/整页的公共容器，所有候选得分趋同，必然漂移。
//   ② score（容器内命中自己符号的数量）优先——真卡片旁必有自己的资产符号；
//     侧边栏/汇总区的同名文本旁只有金额没有全套符号。
//   ③ 同分时 **容器文本越小越优**——真卡片标题的容器是卡片本身，
//     侧边栏 chip 的容器是巨大的页面区块（B 地址实测 360 vs 1383+）。
interface Fsa {
  el: HTMLElement;
  score: number;
  size: number;
  text: string;
}

function firstSymbolAncestor(
  anchor: HTMLElement,
  ownSymbols: string[],
  anySymbols: string[],
  maxUp = 10,
): Fsa | null {
  let el: HTMLElement = anchor;
  for (let i = 0; i < maxUp && el.parentElement; i++) {
    el = el.parentElement;
    const t = el.textContent ?? '';
    if (anySymbols.some((s) => t.includes(s))) {
      return { el, score: ownSymbols.filter((s) => t.includes(s)).length, size: t.length, text: t };
    }
    if (t.length > 20000) break;
  }
  return null;
}

// 卡片头部的协议总金额元素（文本恰为 "$1,234" / "$1,234.56" / "-$1,234"，DOM 顺序上
// 卡片内第一个）。负号(借>存的负净值卡)必须识别,否则 walker 跳到下一个资产行金额
// 当 header,数值身份判定就建立在错的数字上;value 取绝对值(身份比较两侧都取 abs)。
function findHeaderAmountEx(
  container: HTMLElement,
): { el: HTMLElement; value: number } | null {
  const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = w.nextNode())) {
    const t = (n.nodeValue ?? '').trim();
    if (/^[−-]?\$[\d,]+(\.\d+)?$/.test(t)) {
      const el = n.parentElement;
      if (el && !el.closest(`[${CHIP_ATTR}]`)) {
        return { el, value: Number(t.replace(/^[−-]/, '').slice(1).replace(/,/g, '')) };
      }
    }
  }
  return null;
}

const findHeaderAmount = (container: HTMLElement): HTMLElement | null =>
  findHeaderAmountEx(container)?.el ?? null;

// chip 落点数值同一性:协议 chip 插在容器首个美元金额的左侧,所以那个数字必须
// ≈ 本卡净值才谈得上"贴对了"。±2% 容差吸收「页面渲染时刻 vs 抓包时刻」的价格漂移
// (字符串精确匹配一漂移就失效,2026-07-14 二次事故复盘发现的脆弱点)。
const equityMatches = (headerValue: number, equityUsd: number): boolean =>
  Math.abs(headerValue - Math.abs(equityUsd)) <= Math.max(Math.abs(equityUsd) * 0.02, 2);

// 锚点容器体量上限(第四铁律,2026-07-14 链筛选错位事故;上限为**绝对**,无任何豁免):
// 真卡片容器实测 87~360 字符;聚合容器(侧栏协议列表+链格+钱包区合体)满页时 3008+。
// ⚠️ 但上限**不是充分条件**:过滤视图/渐进渲染下聚合容器可以合法缩到 1600 以下
// (真机实测 2026-07-14 二次事故:Robinhood 过滤+半渲染态,body 全文才 3482 字符),
// 必须叠加下面的结构性谓词(卡片表头标记 + 聚合区特征拒绝 + 他卡净值防抢)。
const MAX_ANCHOR_CONTAINER_CHARS = 1600;

// 真卡片的表格列头标记:DeBank 每张仓位卡(含 LP)的资产表必有 "USD Value"(真机
// 全卡实测)。注意它也不是充分条件——聚合容器嵌套着 Wallet 表格(同样有此表头),
// 只能当滤网之一。本扩展本就锚定英文 UI 文本("Data updated"),此标记与该假设同源。
const CARD_TABLE_MARKER = 'USD Value';

// 聚合区(侧栏协议列表+链格+钱包)的排他特征——真卡片容器**永远没有**(实测
// 87~360 字符内零链名、零 "Wallet"):①侧栏首行 "Wallet" 文本,过滤/不过滤视图都在;
// ②链格在任何视图都列出全部链名。链名取自 enrich 结果的 chainLabel,只用 ≥4 字符
// 的标签做子串匹配("OP" 这类短标签误伤率太高);阈值 2 防「协议名恰好等于链名」
// (实锤:Lighter 既是协议又是链)造成的单命中误杀。
export function makeAggregateTextCheck(cards: readonly ProtocolCard[]): (t: string) => boolean {
  const labels = [...new Set(cards.map((c) => c.chainLabel).filter((l) => l.length >= 4))];
  return (t: string) =>
    t.includes('Wallet') || labels.filter((l) => t.includes(l)).length >= 2;
}

interface PickOptions {
  /** 协议级=true:候选容器必须含卡片表头标记 + 不得命中聚合区特征 */
  cardPredicates?: boolean;
  /** 本卡净值:容器首金额落在其 ±2% 内 = 身份确证(排序首要键) */
  ownEquityUsd?: number;
  /** 其他同名卡的净值:容器首金额落在任何一个的 ±2% 内即禁用——那是别人的卡。
   *  按落点数值判定而非文本精确匹配,价格漂移不会让守卫失效 */
  foreignEquities?: readonly number[];
  /** 两段式认领第一段:只接受「首金额≈本卡净值」的候选 */
  requireOwnUsd?: boolean;
  /** 聚合区特征检测(injectAll 每轮按当前 cards 构建一次) */
  isAggregateText?: (t: string) => boolean;
  /** 本轮已被别的卡认领的容器:按元素身份直接排除。真机实测每张卡有 2~4 个同名
   *  标题节点,不排除的话第二个节点是后续卡再锚进同一容器的入口。与 foreign 数值
   *  判定大面积重叠,留作容差逻辑日后调整时的兜底不变量:一个容器只放一张卡 */
  claimedScopes?: ReadonlySet<HTMLElement>;
}

/** 选最优锚点并返回其语义容器。
 *  排序:落点数值同一性(首金额≈本卡净值,最强身份信号)> 符号评分 > 容器越小越优。
 *  2026-07-14 二次事故教训:score 排前会让「嵌套真卡片的聚合容器」(文本超集,
 *  score 恒 ≥ 真卡片)压过真卡片,身份信号必须是首要键。 */
function pickAnchor(
  anchors: HTMLElement[],
  used: Set<HTMLElement>,
  ownSymbols: string[],
  anySymbols: string[],
  usdVariantsList: string[],
  opts: PickOptions = {},
): { anchor: HTMLElement; scope: HTMLElement } | null {
  const ranked = anchors
    .filter((a) => !used.has(a))
    .map((a) => ({ a, fsa: firstSymbolAncestor(a, ownSymbols, anySymbols) }))
    .filter((x): x is { a: HTMLElement; fsa: Fsa } => !!x.fsa && x.fsa.score >= 1)
    .filter((x) => x.fsa.size <= MAX_ANCHOR_CONTAINER_CHARS)
    .filter(
      (x) =>
        !opts.cardPredicates ||
        (x.fsa.text.includes(CARD_TABLE_MARKER) && !(opts.isAggregateText?.(x.fsa.text) ?? false)),
    )
    .filter((x) => !opts.claimedScopes?.has(x.fsa.el))
    .map((x) => {
      // 身份判定:协议级用容器首金额的数值邻域;仓位级沿用净值文本命中(卡内小范围)
      const header = opts.ownEquityUsd !== undefined ? findHeaderAmountEx(x.fsa.el) : null;
      // 协议级认领必须有首金额:无金额的容器=渲染半成品,凭符号裸认领曾被 Codex
      // 复现"错认他卡后金额补上也不重分配"(2026-07-14 独立盲审 finding 1)
      const headerMissing = opts.ownEquityUsd !== undefined && header === null;
      const own = opts.ownEquityUsd ?? 0;
      const ownDist = header ? Math.abs(header.value - Math.abs(own)) : Infinity;
      const ownHit =
        opts.ownEquityUsd !== undefined
          ? header !== null && equityMatches(header.value, own)
          : usdVariantsList.some((v) => x.fsa.text.includes(v));
      // foreign 否决用**纯距离裁决**而非邻域命中:①两张近值真卡($1,000/$1,010)
      // 各自的 header 同时落进 own/foreign ±2%,无条件否决=双双永久拒锚(Codex
      // finding 2 复现);②他卡漂移出自己 ±2% 带后带宽前置会放行抢锚(对抗审查
      // finding 13 复现:+3% 漂移窗口里排前的兄弟卡抢走容器)。裁决:首金额离
      // 任何他卡不比离本卡远,就判定为别人的卡;等距(真歧义)双拒落面板。
      const foreignHit =
        header !== null &&
        (opts.foreignEquities ?? []).some(
          (e) => Math.abs(header.value - Math.abs(e)) <= ownDist,
        );
      // 宽带约束(评分认领段):首金额偏离本卡净值 ±10% 以上不许凭符号认领——
      // 它属于别的仓位(典型:被 enrich 跳过的同名卡,数值守卫护不到)。曾设 ±25%,
      // 小净值下太松($99 的卡被 $120 的卡抢走,Codex finding 1 复现);合法漂移
      // >10% 时本卡落面板等下一轮 enrich 重新对齐,是 fail-safe 方向。
      const wildMismatch =
        opts.ownEquityUsd !== undefined &&
        header !== null &&
        ownDist > Math.max(Math.abs(own) * 0.1, 2);
      return { ...x, usd: ownHit && !foreignHit ? 1 : 0, headerMissing, foreignHit, wildMismatch };
    })
    .filter((x) => !x.headerMissing && !x.foreignHit && !x.wildMismatch)
    .filter((x) => !opts.requireOwnUsd || x.usd === 1)
    .sort((x, y) => y.usd - x.usd || y.fsa.score - x.fsa.score || x.fsa.size - y.fsa.size);
  const top = ranked[0];
  return top ? { anchor: top.a, scope: top.fsa.el } : null;
}

// ─── 已放置锚点登记 + 持续复检(自愈闭环)──────────────────────
// 2026-07-14 二次事故的死区:渐进渲染早期所有卡都(错误地)锚上、chip 数量稳定、
// leftovers=0,重试条件永不触发,错位被永久冻结。唯一解法是把锚定谓词随页面演化
// 持续复检——任何已放置容器长大成聚合区/失去卡片特征,立即全量重锚。
// 数值回查用**宽容差 ±25%**(认领时是 ±10%):杠杆仓位的页面净值随价格实时波动,
// 复检容差必须比认领容差松一档,否则正常波动就反复全量重注入;而错认的容器
// (真实金额与本卡净值通常差数倍)一旦金额补全/更新立即被 25% 带抓住并重锚
// (Codex 独立盲审 finding 1c:"金额出现后必须复检归属")。
interface PlacedAnchor {
  scope: HTMLElement;
  ownSymbols: string[];
  ownNetUsd: number;
  foreignNetUsds: number[];
}
let placedAnchors: PlacedAnchor[] = [];
let aggregateTextCheck: ((t: string) => boolean) | null = null;

export function placedAnchorsStillValid(): boolean {
  return placedAnchors.every(({ scope, ownSymbols, ownNetUsd, foreignNetUsds }) => {
    if (!scope.isConnected) return false;
    const t = scope.textContent ?? '';
    const header = findHeaderAmountEx(scope);
    if (header === null) return false;
    const ownDist = Math.abs(header.value - Math.abs(ownNetUsd));
    return (
      t.length <= MAX_ANCHOR_CONTAINER_CHARS &&
      t.includes(CARD_TABLE_MARKER) &&
      !(aggregateTextCheck?.(t) ?? false) &&
      ownSymbols.some((s) => t.includes(s)) &&
      ownDist <= Math.max(Math.abs(ownNetUsd) * 0.25, 2) &&
      // React 原地互换两张同协议卡的内容时,结构谓词全盲(符号共享)——但互换后
      // scope 首金额会精确等于**他卡**净值,距离裁决立即抓住(对抗审查 finding 4)
      !foreignNetUsds.some((e) => Math.abs(header.value - Math.abs(e)) < ownDist)
    );
  });
}

// ─── 徽章构造 ────────────────────────────────────────────────
function makeHost(
  kind: 'protocol' | 'item' | 'asset' | 'summary' | 'tooltip',
  key: string,
): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement('span');
  host.setAttribute(CHIP_ATTR, kind);
  host.setAttribute(KEY_ATTR, key);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CHIP_CSS;
  root.appendChild(style);
  return { host, root };
}

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

function appendSourceOverview(tip: HTMLElement, source: RewardSourcePresentation): void {
  const block = el('div', 'source-block');
  block.appendChild(el('div', 'source-title', source.title));
  block.appendChild(el('div', 'source-desc', source.description));
  const link = el('a', 'source-link', `${source.linkLabel} ↗`);
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  block.appendChild(link);
  tip.appendChild(block);
}

function appendRewardOverview(tip: HTMLElement): void {
  const block = el('div', 'source-block');
  block.appendChild(el('div', 'source-title', tr("奖励与积分说明")));
  block.appendChild(el(
    'div',
    'source-desc',
    tr("奖励 APY 按对应活动来源单独展示；积分只展示倍数或资格，不折算成 APY。下方链接用于核对活动规则、计算方式与适用范围。"),
  ));
  tip.appendChild(block);
}

function attachPortalTooltip(
  trigger: HTMLElement,
  tip: HTMLElement,
  label: string,
  key: string,
): void {
  const { host, root } = makeHost('tooltip', `${key}:tooltip`);
  host.style.cssText = 'position:fixed;inset:0;width:0;height:0;margin:0;z-index:2147483647;pointer-events:none;';
  tip.classList.add('portal-tip');
  root.appendChild(tip);
  document.body.appendChild(host);

  const id = `dal-tip-${++tooltipSeq}`;
  let hideTimer: number | null = null;
  let pinned = false;
  const cancelHide = () => {
    if (hideTimer === null) return;
    window.clearTimeout(hideTimer);
    hideTimer = null;
  };
  const position = () => {
    const anchor = trigger.getBoundingClientRect();
    const popup = tip.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 1_024;
    const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 768;
    const left = Math.min(
      Math.max(margin, anchor.left),
      Math.max(margin, viewportWidth - popup.width - margin),
    );
    const below = anchor.bottom;
    const above = anchor.top - popup.height;
    const top = below + popup.height <= viewportHeight - margin
      ? below
      : Math.max(margin, above);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const show = () => {
    cancelHide();
    if (!tip.isConnected) return;
    tip.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    position();
  };
  const hide = () => {
    cancelHide();
    tip.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const scheduleHide = () => {
    if (pinned || hideTimer !== null) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      hide();
    }, 120);
  };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    pinned = false;
    hide();
    trigger.blur();
  };

  tip.id = id;
  tip.setAttribute('role', 'tooltip');
  trigger.tabIndex = 0;
  trigger.setAttribute('role', 'button');
  trigger.setAttribute('aria-label', tr(label));
  trigger.setAttribute('aria-describedby', id);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('pointerenter', show);
  trigger.addEventListener('pointerleave', scheduleHide);
  trigger.addEventListener('focus', show);
  trigger.addEventListener('blur', scheduleHide);
  trigger.addEventListener('click', () => {
    pinned = !pinned;
    if (pinned) show();
    else hide();
  });
  trigger.addEventListener('keydown', onEscape);
  tip.addEventListener('pointerenter', () => {
    cancelHide();
    show();
  });
  tip.addEventListener('pointerleave', scheduleHide);
  tip.addEventListener('focusin', show);
  tip.addEventListener('focusout', scheduleHide);
  tip.addEventListener('keydown', onEscape);
}

function linkTooltip(trigger: HTMLElement, tip: HTMLElement, label: string): void {
  const id = `dal-tip-${++tooltipSeq}`;
  let pointerPending = false;
  let pointerWasOpen = false;
  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true';
  const setOpen = (open: boolean) => trigger.setAttribute('aria-expanded', String(open));
  trigger.tabIndex = 0;
  trigger.setAttribute('role', 'button');
  trigger.setAttribute('aria-label', tr(label));
  trigger.setAttribute('aria-describedby', id);
  setOpen(false);
  trigger.addEventListener('pointerdown', () => {
    pointerPending = true;
    pointerWasOpen = isOpen();
  });
  trigger.addEventListener('focus', () => setOpen(true));
  trigger.addEventListener('blur', () => setOpen(false));
  trigger.addEventListener('click', () => {
    const next = pointerPending ? !pointerWasOpen : !isOpen();
    pointerPending = false;
    setOpen(next);
    if (next) trigger.focus();
    else trigger.blur();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      trigger.blur();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      trigger.click();
    }
  });
  tip.id = id;
  tip.setAttribute('role', 'tooltip');
}

function clsOf(y: ProtocolYield): string {
  const value = y.rewardCoverageComplete && y.rateCoverageComplete ? y.netApy : y.knownNetApy;
  return value === null ? 'na' : value >= 0 ? 'pos' : 'neg';
}

function appendAssetRows(tip: HTMLElement, assets: AssetYield[]): void {
  for (const a of assets) {
    const row = el('div', `row ${a.leg}`);
    row.appendChild(el('span', 'sym', `${a.token.symbol} ${usd(a.token.usd)}`));
    row.appendChild(el('span', 'rates', assetRateLines(a).join(' · ')));
    tip.appendChild(row);
  }
}

function protocolChip(card: ProtocolCard, generatedAt: number): HTMLElement {
  const y = card.yield;
  const { host, root } = makeHost('protocol', card.key);
  let label: string;
  let cls: string;
  if (card.kind === 'lp') {
    const anyOut = card.items.some((it) => it.range && !it.range.inRange);
    label = tr("LP {0} · {1} 仓位 · 手续费收益未计入", usd(y.equityUsd), card.items.length);
    cls = card.items.some((it) => it.range) ? (anyOut ? 'neg' : 'pos') : 'na';
  } else {
    label =
      yieldHeadline(y) +
      (y.leverage !== null && y.leverage > 1.05 ? ` · ${y.leverage.toFixed(2)}x` : '');
    cls = clsOf(y);
  }
  const trigger = el('span', `chip ${cls}`, label);
  root.appendChild(trigger);

  const tip = el('div', 'tip');
  const multiItem = card.items.length > 1;
  for (const it of card.items) {
    if (card.kind === 'lp') {
      const r = it.range;
      tip.appendChild(
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
      tip.appendChild(
        el('div', 'item', tr("{0} · 净值 {1}{2} · {3}", it.name, usd(iy.equityUsd), lev, yieldHeadline(iy))),
      );
    }
    appendAssetRows(tip, it.yield.assets);
  }
  const complete = y.rewardCoverageComplete && y.rateCoverageComplete;
  const daily = complete ? y.estDailyUsd : y.knownEstDailyUsd;
  if (daily !== null) {
    tip.appendChild(
      el(
        'div',
        'meta',
        tr("权益 {0} · {1} {2}（按当前已知利率前瞻推算）", usd(y.equityUsd), complete ? tr("预估日收益") : tr("日收益小计"), usd(daily)),
      ),
    );
  }
  for (const f of y.flags) tip.appendChild(el('div', 'flag', `⚠ ${f}`));
  tip.appendChild(el('div', 'meta', `APY Lens · ${new Date(generatedAt).toLocaleTimeString(getLocale())}`));
  linkTooltip(trigger, tip, label);
  root.appendChild(tip);
  return host;
}

// 代币构成配色（与 Uniswap 卡片一致的暖/青双色，多币循环）
const COMP_COLORS = ['#e8833a', '#26a17b', '#8a63d2', '#3fb950', '#d29922'];

// LP 区间小部件（进度条式，同 Uniswap 官方 UI 的可读性）：
//   #339010 [区间内]
//   ▬▬▬▬▬▬▬|▬▬▬▬   （条=区间，游标=现价位置，tick 线性）
//   0.08911     0.09571     0.09868
//   ▮▮▮▮▮▮▮▮▮▮▮▮   （代币构成：按 USD 占比）
//   BASED 30%          USDT 70%
export function rangeWidget(r: LpRange, assets: AssetYield[], key: string): HTMLElement {
  const { host, root } = makeHost('item', key);
  const box = el('div', `rw ${r.inRange ? 'pos' : 'neg'}`);
  box.setAttribute('role', 'group');
  const lower = r.fullRange ? '0' : fmtPrice(r.lowerPrice);
  const upper = r.fullRange ? '∞' : fmtPrice(r.upperPrice);
  const ariaParts = [
    `#${r.positionIndex}`,
    r.inRange ? tr("区间内") : tr("区间外"),
    fmtPrice(r.currentPrice),
    lower,
    upper,
  ];

  // 第一行放仓位编号（原 DeBank 编号会被隐藏、由这里接管）——整个模块从行顶排起，
  // 行高 108px 才装得下完整模块（真机实测 2026-07-08，编号原位于行内 45px 处，往下排必溢出）
  const idRow = el('div', 'rw-id');
  idRow.appendChild(el('span', 'pid', `#${r.positionIndex}`));
  idRow.appendChild(el('span', 'tag', r.inRange ? tr("区间内") : tr("区间外")));
  box.appendChild(idRow);

  const belowRange = !r.inRange && r.currentPrice < r.lowerPrice;
  const aboveRange = !r.inRange && r.currentPrice > r.upperPrice;
  const pctPos = belowRange ? 0 : aboveRange ? 100 : Math.min(88, Math.max(12, r.pct * 100));
  const curRow = el('div', 'rw-cur');
  const cur = el('span', 'cur', fmtPrice(r.currentPrice));
  cur.style.left = `${pctPos.toFixed(1)}%`;
  if (belowRange) cur.style.transform = 'none';
  if (aboveRange) cur.style.transform = 'translateX(-100%)';
  curRow.appendChild(cur);
  box.appendChild(curRow);

  const bar = el('div', 'rw-bar');
  if (!r.inRange) {
    const range = el('span', 'rw-range');
    if (belowRange) {
      const lowerPct = Math.max(0, Math.min(100, ((r.lowerPrice - r.currentPrice) / (r.upperPrice - r.currentPrice)) * 100));
      range.style.left = `${lowerPct.toFixed(1)}%`;
      range.style.right = '0';
    } else if (aboveRange) {
      const upperPct = Math.max(0, Math.min(100, ((r.upperPrice - r.lowerPrice) / (r.currentPrice - r.lowerPrice)) * 100));
      range.style.left = '0';
      range.style.width = `${upperPct.toFixed(1)}%`;
    }
    bar.appendChild(range);
  }
  const dot = el('span', 'rw-dot');
  dot.style.left = belowRange
    ? '0'
    : aboveRange
      ? 'calc(100% - 3px)'
      : `calc(${(r.pct * 100).toFixed(1)}% - 1.5px)`;
  bar.appendChild(dot);
  box.appendChild(bar);

  const bounds = el('div', `rw-bounds${r.inRange ? '' : ` out${aboveRange ? ' above' : ''}`}`);
  if (r.inRange) {
    bounds.appendChild(el('span', undefined, lower));
    bounds.appendChild(el('span', undefined, upper));
  } else {
    bounds.appendChild(el('span', 'lower', lower));
    bounds.appendChild(el('span', 'upper', upper));
  }
  box.appendChild(bounds);

  // 代币构成条（单行紧凑：迷你双色条 + 内联百分比）——「我存的是什么、各占多少」，
  // 对齐 Uniswap 卡片强调的信息。压成一行以贴合 DeBank 行高、不挤到下一仓位。
  const supplies = assets.filter((a) => a.leg === 'supply' && a.token.usd > 0);
  const total = supplies.reduce((s, a) => s + a.token.usd, 0);
  if (supplies.length >= 2 && total > 0) {
    const row = el('div', 'rw-comp2');
    const mbar = el('div', 'rw-mbar');
    supplies.forEach((a, i) => {
      const seg = el('span');
      seg.style.width = `${((a.token.usd / total) * 100).toFixed(1)}%`;
      seg.style.background = COMP_COLORS[i % COMP_COLORS.length];
      mbar.appendChild(seg);
    });
    row.appendChild(mbar);
    const composition = supplies
      .map((a) => `${a.token.symbol} ${((a.token.usd / total) * 100).toFixed(0)}%`)
      .join(' · ');
    row.appendChild(el('span', 'rw-ctxt', composition));
    ariaParts.push(composition);
    box.appendChild(row);
  }

  box.setAttribute('aria-label', ariaParts.join(' · '));

  root.appendChild(box);
  return host;
}

// 被接管隐藏的原 #编号 元素——每轮重注入前必须恢复可见（React 若复用旧节点，样式会残留）
const hiddenAnchors: HTMLElement[] = [];

export function restoreHiddenAnchors(): void {
  for (const a of hiddenAnchors) a.style.visibility = '';
  hiddenAnchors.length = 0;
}

// 把区间小部件挂到仓位行内：重新 parent 到「最宽的近祖先」（=仓位行，1160px/108px 高）
// 并绝对定位到行顶，逃出 DeBank 窄单元格(226px, overflow:hidden)的横向裁剪；
// 原 #编号 文本隐藏、由模块第一行接管显示——否则模块只能从编号下方(行内 45px)排起，必然溢出行底。
function placeRangeWidget(anchor: HTMLElement, host: HTMLElement): void {
  let row: HTMLElement = anchor;
  let widest: HTMLElement = anchor;
  for (let i = 0; i < 8 && row.parentElement; i++) {
    row = row.parentElement;
    if (row.clientWidth > widest.clientWidth) widest = row;
    if (widest.clientWidth >= 480) break;
  }
  if (getComputedStyle(widest).position === 'static') widest.style.position = 'relative';
  const a = anchor.getBoundingClientRect();
  const w = widest.getBoundingClientRect();
  host.style.position = 'absolute';
  host.style.left = `${Math.max(0, a.left - w.left)}px`;
  host.style.top = '8px';
  host.style.margin = '0';
  host.style.zIndex = '2147483000';
  widest.appendChild(host);
  anchor.style.visibility = 'hidden';
  hiddenAnchors.push(anchor);
}

function itemChip(item: ItemYield, key: string): HTMLElement {
  const y = item.yield;
  const { host, root } = makeHost('item', key);
  const lev = y.leverage !== null && y.leverage > 1.05 ? ` · ${y.leverage.toFixed(2)}x` : '';
  const label = tr("净值 {0}{1} · {2}", usd(y.equityUsd), lev, yieldHeadline(y));
  const chip = el('span', `chip ${clsOf(y)}`, label);
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-label', tr(label));
  root.appendChild(chip);
  return host;
}

// 仓位徽章挂到仓位块右侧、与仓位名同一行高（用户要求：Lending 行最右）
function placeItemChip(anchor: HTMLElement, block: HTMLElement, chip: HTMLElement): void {
  if (getComputedStyle(block).position === 'static') block.style.position = 'relative';
  const a = anchor.getBoundingClientRect();
  const b = block.getBoundingClientRect();
  chip.style.position = 'absolute';
  chip.style.right = '16px';
  chip.style.top = `${Math.max(0, a.top - b.top + Math.max(0, (a.height - 22) / 2))}px`;
  chip.style.marginLeft = '0';
  block.appendChild(chip);
}

// Portfolio 头部汇总徽章：今日预估收益（挂在 "Data updated" 旁）
function summaryChip(s: NonNullable<EnrichResult['summary']>, generatedAt: number): HTMLElement {
  const { host, root } = makeHost('summary', 'portfolio-summary');
  const fmt = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
  const daily = portfolioDailyHeadline(s);
  const { complete } = daily;
  const displayedDaily = daily.value;
  const cls = displayedDaily >= 0 ? 'pos' : 'neg';
  // LP 区间状态是用户核心诉求，直接进头部徽章文本；出区间用 ⚠ 醒目
  const lpPart =
    s.lpTotal > 0
      ? s.lpOutOfRange > 0
        ? tr(" · ⚠LP {0}/{1}在区间", s.lpTotal - s.lpOutOfRange, s.lpTotal)
        : tr(" · LP {0}/{1}在区间", s.lpTotal, s.lpTotal)
      : '';
  const claimPart =
    s.claimableState === 'unknown'
      ? tr(" · 待领 --")
      : s.claimableState === 'partial'
        ? tr(" · 待领部分 {0}", s.claimableUsd !== null ? usd(s.claimableUsd) : '--')
        : s.claimableUsd !== null && s.claimableUsd > 1
          ? tr(" · 待领 {0}", usd(s.claimableUsd))
          : '';
  const liquidityPart = (s.liquidityRedCount ?? 0) > 0
    ? tr(" · ⚠流动性 {0}", s.liquidityRedCount)
    : '';
  const label = `${daily.label} ${fmt(displayedDaily)}${lpPart}${liquidityPart}${claimPart}`;
  const trigger = el(
    'span',
    `chip ${(s.liquidityRedCount ?? 0) > 0 || s.lpOutOfRange > 0 ? 'neg' : cls}`,
    label,
  );
  root.appendChild(trigger);
  const tip = el('div', 'tip');
  if (s.claimTop.length > 0) {
    tip.appendChild(
      el('div', 'row', tr("待领奖励：{0}（Merkl）", s.claimTop.map((t) => `${t.symbol} ${usd(t.usd)}`).join(' · '))),
    );
  }
  if (s.claimableState !== 'complete') {
    const failureDetails = (s.claimFailures ?? [])
      .map((failure) => `${failure.chainLabel}（${failure.reason}）`)
      .join('、');
    tip.appendChild(
      el(
        'div',
        'flag',
        s.claimableState === 'partial'
          ? tr("⚠ Merkl 待领奖励部分查询失败{0}", failureDetails ? `：${failureDetails}` : '')
          : tr("⚠ Merkl 待领奖励查询未知{0}", failureDetails ? `：${failureDetails}` : ''),
      ),
    );
  }
  if ((s.liquidityRedCount ?? 0) > 0) {
    tip.appendChild(
      el('div', 'flag', tr("⚠ {0} 个出借资产的当前可提流动性不超过仓位的 110%", s.liquidityRedCount)),
    );
  }
  tip.appendChild(
    el(
      'div',
      'row',
      complete
        ? tr("今日预估：按当前已知的基础与奖励利率前瞻折算到 1 天")
        : tr("今日小计：基础利率或奖励覆盖不完整，不代表完整组合日收益"),
    ),
  );
  const excluded = s.excludedUsd && s.excludedUsd > 0
    ? tr("；策略排除 {0}（LP 手续费收益不估算）", usd(s.excludedUsd))
    : '';
  tip.appendChild(el('div', 'meta', tr("覆盖 {0} 仓位；未覆盖 {1}{2}", usd(s.coveredUsd), usd(s.uncoveredUsd), excluded)));
  tip.appendChild(el('div', 'meta', `APY Lens · ${new Date(generatedAt).toLocaleTimeString(getLocale())}`));
  linkTooltip(trigger, tip, label);
  root.appendChild(tip);
  return host;
}

function assetChip(a: AssetYield, cardKey: string): HTMLElement {
  const { host, root } = makeHost('asset', `${cardKey}:${a.leg}:${a.token.address}`);
  const presentation = assetRatePresentation(a);
  const cls = a.baseApy === null ? 'na' : presentation.incomplete ? 'warn' : a.leg === 'supply' ? 'pos' : 'neg';
  const chip = el('span', `chip mini ${cls}`, presentation.compactBase);
  for (const value of presentation.compactRewards) {
    chip.appendChild(el('span', 'reward', ` + ${value}`));
  }
  for (const value of presentation.compactEntitlements) {
    chip.appendChild(el('span', 'points', ` · ${value}`));
  }
  root.appendChild(chip);

  const tip = el('div', 'tip');
  for (const line of presentation.details) tip.appendChild(el('div', 'row', line));
  if ((a.rewardComponents?.length ?? 0) > 0 || (a.rewardEntitlements?.length ?? 0) > 0) {
    appendRewardOverview(tip);
  }
  for (const component of a.rewardComponents ?? []) {
    const source = rewardComponentSource(component);
    if (source) appendSourceOverview(tip, source);
    else tip.appendChild(el('div', 'meta', tr("{0} 来源：{1}", component.label ?? component.id, component.source)));
  }
  for (const entitlement of a.rewardEntitlements ?? []) {
    const source = rewardEntitlementSource(entitlement);
    if (source) appendSourceOverview(tip, source);
    else tip.appendChild(el('div', 'meta', tr("{0} 来源：{1}", entitlement.label, entitlement.source)));
    for (const note of entitlement.notes ?? (entitlement.note ? [entitlement.note] : [])) {
      tip.appendChild(el('div', 'flag', note));
    }
  }
  tip.appendChild(el('div', 'meta', tr("数据源：{0}", a.source)));
  attachPortalTooltip(
    chip,
    tip,
    `${a.token.symbol}：${presentation.details.join('；')}`,
    `${cardKey}:${a.leg}:${a.token.address}`,
  );

  const risk = liquidityRiskPresentation(a);
  if (risk) {
    const riskChip = el('span', `chip mini risk ${risk.level === 'red' ? 'neg' : 'warn'}`, risk.compact);
    root.appendChild(riskChip);
    const riskTip = el('div', 'tip');
    for (const line of risk.details) riskTip.appendChild(el('div', 'row', line));
    linkTooltip(riskChip, riskTip, `${a.token.symbol}：${risk.details.join('；')}`);
    root.appendChild(riskTip);
  }
  return host;
}

// ─── 注入 ────────────────────────────────────────────────────
function injectAll(result: EnrichResult): ProtocolCard[] {
  injecting = true;
  try {
    restoreHiddenAnchors(); // 先恢复被接管隐藏的原 #编号，防止重注入失败时编号消失
    document.querySelectorAll(`[${CHIP_ATTR}]`).forEach((n) => n.remove());
    placedAnchors = [];
    lastSubAnchorsMissing = 0;
    aggregateTextCheck = makeAggregateTextCheck(result.cards);
    const leftovers: ProtocolCard[] = [];
    const zeroAnchorTitles: string[] = [];
    const lowScoreTitles: string[] = [];
    let anchored = 0;

    // 锚定身份基准 = 页面渲染的卡头净值(含待领奖励),不是 equityUsd(ΣS−ΣB)——
    // 两者结构性相差奖励值,奖励重仓卡用 equityUsd 对比卡头金额会被数值守卫误杀
    const identityOf = (c: ProtocolCard): number => c.pageNetUsd ?? c.yield.equityUsd;

    const byTitle = new Map<string, ProtocolCard[]>();
    for (const c of result.cards) byTitle.set(c.title, [...(byTitle.get(c.title) ?? []), c]);

    for (const [title, cards] of byTitle) {
      const anchors = exactTextElements(document.body, title);
      if (anchors.length === 0) {
        zeroAnchorTitles.push(title);
        leftovers.push(...cards);
        continue;
      }
      // 两段式认领:先让「容器首金额≈自己净值」的卡认领(身份近乎确证),剩下的卡
      // 再按符号评分认领——否则渲染顺序在先的卡会在自己真卡片缺席时(渐进渲染/
      // 链筛选)抢走别人的真卡片锚点(2026-07-14 二次事故实测路径)
      const used = new Set<HTMLElement>();
      const claimedScopes = new Set<HTMLElement>();
      const picks = new Map<ProtocolCard, { anchor: HTMLElement; scope: HTMLElement }>();
      for (const requireOwnUsd of [true, false]) {
        for (const card of cards) {
          if (picks.has(card)) continue;
          const cardSymbols = symbolsOf(card.yield);
          const picked = pickAnchor(anchors, used, cardSymbols, cardSymbols, [], {
            cardPredicates: true,
            isAggregateText: aggregateTextCheck,
            ownEquityUsd: identityOf(card),
            foreignEquities: cards.filter((c) => c !== card).map((c) => identityOf(c)),
            requireOwnUsd,
            claimedScopes,
          });
          if (!picked) continue;
          picks.set(card, picked);
          used.add(picked.anchor);
          claimedScopes.add(picked.scope);
        }
      }
      for (const card of cards) {
        const picked = picks.get(card);
        if (!picked) {
          lowScoreTitles.push(`${title}(${anchors.length}个锚点均不满足真卡片谓词)`);
          leftovers.push(card);
          continue;
        }
        const { anchor, scope: container } = picked;
        anchored++;
        placedAnchors.push({
          scope: container,
          ownSymbols: symbolsOf(card.yield),
          ownNetUsd: identityOf(card),
          foreignNetUsds: cards.filter((c) => c !== card).map((c) => identityOf(c)),
        });
        // 显示规则 R3：协议级净APY 挂在「协议净资产金额」之前（卡片头部右侧），
        // 找不到头部金额元素时回落挂在协议名之后
        const headerAmount = findHeaderAmount(container);
        const pChip = card.kind === 'lp' ? null : protocolChip(card, result.generatedAt);
        if (pChip && headerAmount) {
          // 显示规则 R3：紧贴协议净资产的 "$" 符号左侧。
          // 必须插进金额元素**内部开头**（afterbegin）——插成兄弟节点时，DeBank 头部行是
          // justify-between 布局，chip 会被排到行中间（真机截图踩坑 2026-07-09）
          pChip.style.marginLeft = '0';
          pChip.style.marginRight = '6px';
          headerAmount.insertAdjacentElement('afterbegin', pChip);
        } else if (pChip) {
          anchor.insertAdjacentElement('afterend', pChip);
        }

        // LP 卡片：区间徽章锚定唯一的 #仓位号，不挂利率类徽章
        if (card.kind === 'lp') {
          card.items.forEach((item, idx) => {
            const r = item.range;
            if (!r) return;
            const target = exactTextElements(container, `#${r.positionIndex}`)[0];
            if (!target) {
              // #编号晚于标题/表头渲染时卡已计入 anchored、leftovers=0,若不记账
              // 重试条件永不触发,widget 永缺(Codex 独立盲审 finding 4)
              lastSubAnchorsMissing++;
              return;
            }
            placeRangeWidget(target, rangeWidget(r, item.yield.assets, `${card.key}:lp${idx}`));
          });
          continue;
        }

        // 仓位级与资产级徽章。usedEls 全卡片共享，防止两个仓位的同名资产抢同一行
        const allSymbols = [...new Set(card.items.flatMap((it) => symbolsOf(it.yield)))];
        const usedEls = new Set<HTMLElement>();
        const usedItemAnchors = new Set<HTMLElement>();
        const multiItem = card.items.length > 1;
        const nameCount = (name: string): number => card.items.filter((it) => it.name === name).length;
        const displayNameUnique = (name: string): boolean =>
          card.items.filter((it) => it.displayName === name).length === 1;
        card.items.forEach((item, idx) => {
          let scope: HTMLElement = container;
          if (multiItem) {
            // 同名 item 可能共用一个类型标题（如两笔 Midnight 都叫 Yield），而 API
            // 顺序还可能与页面行顺序相反。优先用唯一的仓位说明认领各自的表格行；
            // 没有独立说明时，只有页面确有足够多的同名标题才允许回退。
            const count = nameCount(item.name);
            const detailAnchors = count > 1 && item.displayName && displayNameUnique(item.displayName)
              ? exactTextElements(container, item.displayName)
              : [];
            const nameAnchors = exactTextElements(container, item.name);
            const itemAnchors = detailAnchors.length > 0
              ? detailAnchors
              : nameAnchors.length >= count ? nameAnchors : [];
            const pickedItem = pickAnchor(itemAnchors, usedItemAnchors, symbolsOf(item.yield), allSymbols, usdVariants(item.yield.equityUsd));
            if (pickedItem) {
              usedItemAnchors.add(pickedItem.anchor);
              scope = pickedItem.scope;
              placeItemChip(pickedItem.anchor, scope, itemChip(item, `${card.key}:item${idx}`));
            } else {
              // 认领不到子块 → 该仓位的资产徽章一并放弃（在整卡范围乱贴比不贴更糟），
              // 明细仍在协议徽章 tooltip 里;计入缺失账,子块晚渲染时靠重试自愈
              lastSubAnchorsMissing++;
              return;
            }
          }
          for (const a of item.yield.assets) {
            const target = exactTextElements(scope, a.token.symbol).find((e) => !usedEls.has(e));
            if (!target) continue;
            usedEls.add(target);
            target.insertAdjacentElement('afterend', assetChip(a, `${card.key}:item${idx}`));
          }
        });
      }
    }

    // 头部汇总徽章（挂 "Data updated" 旁；锚不到就算了，不进 leftover）
    if (result.summary) {
      const sa = exactTextElements(document.body, 'Data updated')[0];
      if (sa) sa.insertAdjacentElement('afterend', summaryChip(result.summary, result.generatedAt));
    }

    lastAnchoredCount = document.querySelectorAll(
      `[${CHIP_ATTR}="protocol"], [${CHIP_ATTR}="item"]`,
    ).length;
    // 诊断日志（仅在状态变化时打，避免刷屏）
    const line =
      `[APY Lens] 内嵌锚定 ${anchored}/${result.cards.length}` +
      (leftovers.length ? tr("，降级面板: {0}", leftovers.map((c) => c.title).join(', ')) : '') +
      (zeroAnchorTitles.length ? tr("，页面上找不到标题文本: {0}", zeroAnchorTitles.join(', ')) : '') +
      (lowScoreTitles.length ? tr("，锚点评分不足: {0}", lowScoreTitles.join(', ')) : '');
    if (line !== lastLogLine) {
      lastLogLine = line;
      console.info(line);
    }
    return leftovers;
  } finally {
    injecting = false;
  }
}

function syncPanel(result: EnrichResult, leftovers: ProtocolCard[]): void {
  const history = readHistory();
  const keys = panelStateKey(leftovers, history);
  if (keys === lastPanelKeys) return; // 面板内容没变就不重建（也避免触发自己的 observer）
  lastPanelKeys = keys;
  lastLeftovers = leftovers;
  if (result.cards.length === 0 || leftovers.length > 0 || history.entries.length > 0) {
    renderPanel({ ...result, cards: leftovers }, history);
  } else {
    removePanel();
  }
}

// ─── 自愈：页面实质变化时重试锚定 ─────────────────────────────
function isOurNode(n: Node): boolean {
  return n instanceof HTMLElement && (n.hasAttribute(CHIP_ATTR) || n.id === PANEL_HOST_ID);
}

/** 页面自己的变化才算数;我们注入/移除徽章造成的变动忽略,防自激循环。
 *  characterData 记录必须算:React 更新文本常走原地 nodeValue(不增删节点),
 *  只看 childList 会漏掉「文本演化让已放置容器谓词失效」的复检时机
 *  (Codex 独立盲审 finding 3)。chip 内容都在 shadow DOM,不会产生这类记录。 */
export function isMeaningfulMutation(records: readonly MutationRecord[]): boolean {
  return records.some((r) =>
    r.type === 'characterData'
      ? !isOurNode(r.target.parentElement ?? r.target)
      : [...r.addedNodes, ...r.removedNodes].some((n) => !isOurNode(n)),
  );
}

/** 重试判定(独立成函数以便回归测试直接钉死每个条件——observer 定时器链路
 *  在测试环境不可靠,而这里少一个条件就是一类错位被永久冻结)。 */
export function reinjectNeeded(): boolean {
  if (!lastResult) return false;
  const present = document.querySelectorAll(
    `[${CHIP_ATTR}="protocol"], [${CHIP_ATTR}="item"]`,
  ).length;
  // 头部汇总 chip 单独查：它锚在 "Data updated" 旁，DeBank 周期性刷新该时间戳会连带
  // 冲掉 chip 而 protocol chip 数不变——曾致 A 地址汇总时有时无（真机破案 2026-07-10）
  const summaryGone =
    !!lastResult.summary && !document.querySelector(`[${CHIP_ATTR}="summary"]`);
  const historyChanged = panelStateKey(lastLeftovers, readHistory()) !== lastPanelKeys;
  // 徽章被 React 冲掉;或还有卡片没锚定成功(API 响应先于渲染到达);或 LP 编号/
  // 仓位子块晚渲染还欠着子锚点;或任何已放置容器不再满足锚定谓词(渐进渲染期的
  // 容器后来长成聚合区/被 React 原地换成别的卡)→ 重试
  return (
    present !== lastAnchoredCount ||
    lastLeftovers.length > 0 ||
    lastSubAnchorsMissing > 0 ||
    summaryGone ||
    historyChanged ||
    !placedAnchorsStillValid()
  );
}

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (injecting || !lastResult || reinjectTimer !== null) return;
    if (!isMeaningfulMutation(records)) return;
    reinjectTimer = window.setTimeout(() => {
      reinjectTimer = null;
      if (!lastResult) return;
      try {
        if (reinjectNeeded()) {
          syncPanel(lastResult, injectAll(lastResult));
        }
      } catch (e) {
        // 定时器回调里的异常没人接，会进扩展错误面板——降级为 warn
        console.warn('[APY Lens] reinject failed:', e);
      }
    }, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 窗口尺寸变化不触发 mutation，但会改变仓位徽章的绝对定位基准 → 重挂对齐
  window.addEventListener('resize', () => {
    if (!lastResult || reinjectTimer !== null) return;
    reinjectTimer = window.setTimeout(() => {
      reinjectTimer = null;
      try {
        if (lastResult) syncPanel(lastResult, injectAll(lastResult));
      } catch (e) {
        console.warn('[APY Lens] resize reinject failed:', e);
      }
    }, 300);
  });
}

/** 渲染入口：优先内嵌，锚定失败的卡片自动落悬浮面板；随页面渲染进度持续重试 */
export function renderInline(result: EnrichResult, history?: HistorySource): void {
  lastResult = result;
  lastHistorySource = history ?? null;
  lastPanelKeys = null; // 新数据强制刷新面板
  if (!document.body) {
    lastLeftovers = result.cards;
    return;
  }
  ensureObserver();
  syncPanel(result, injectAll(result));
}

/** Store-only data changed: refresh through the normal guarded injection path without waiting for page DOM. */
export function scheduleInlineSync(): void {
  if (!lastResult || immediateSyncQueued) return;
  const scheduledResult = lastResult;
  immediateSyncQueued = true;
  queueMicrotask(() => {
    immediateSyncQueued = false;
    // A pending 400ms DOM retry already observes historyChanged; never race it or an active injection.
    if (lastResult !== scheduledResult || injecting || reinjectTimer !== null) return;
    try {
      syncPanel(scheduledResult, injectAll(scheduledResult));
    } catch (e) {
      console.warn('[APY Lens] immediate sync failed:', e);
    }
  });
}

/** 地址导航时立即清掉旧钱包状态，observer 不得把旧结果重新注入新页面。 */
export function clearInline(): void {
  lastResult = null;
  lastHistorySource = null;
  lastAnchoredCount = 0;
  lastSubAnchorsMissing = 0;
  lastLeftovers = [];
  lastPanelKeys = null;
  lastLogLine = '';
  immediateSyncQueued = false;
  placedAnchors = [];
  aggregateTextCheck = null;
  if (reinjectTimer !== null) {
    window.clearTimeout(reinjectTimer);
    reinjectTimer = null;
  }
  restoreHiddenAnchors();
  document.querySelectorAll(`[${CHIP_ATTR}]`).forEach((node) => node.remove());
  removePanel();
}

/** Repaint the current result without fetching or changing rate caches. */
export function redrawInline(): void {
  if (lastResult) renderInline(lastResult, lastHistorySource ?? undefined);
}
