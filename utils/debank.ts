// DeBank /portfolio/project_list 响应解析。
// 原则：只信任通过结构校验的数据，形状不符一律丢弃（fail-safe hide）——
// 显示不出来是小事，显示错数字是大事。

import { DEBANK_INPUT_LIMITS } from './input-limits';

export interface TokenLeg {
  address: string; // 小写 token 地址（DeBank 的 id 字段）
  chain: string;
  symbol: string;
  amount: number;
  priceUsd: number;
  usd: number;
  decimals?: number;
}

export interface PositionItem {
  itemName: string; // DeBank 的仓位类型名，如 "Lending"
  supplies: TokenLeg[];
  borrows: TokenLeg[];
  rewards: TokenLeg[];
  /** False when this retained item's principal legs or routing identity are incomplete. */
  principalInputCoverageComplete: boolean;
  /** False when this retained item's reward legs or routing identity are incomplete. */
  rewardInputCoverageComplete: boolean;
  netUsd: number;
  /** DeBank 的不透明仓位编号；LP 路径会在 RPC 前另行验证为 uint256 tokenId。 */
  positionIndex?: string;
  /** DeBank 的 pool id（uniswap 场景通常就是池子合约地址） */
  poolId?: string;
  /** DeBank 的 pool.adapter_id——识别仓位类型的万能钥匙（morpho_blue_lending2 / redeemable_tokenized_vault_yield…） */
  adapterId?: string;
  /** detail.description（如 "Lorenzo Exclusive USD1 Vault"） */
  poolDesc?: string;
}

export interface ProtocolPosition {
  protocolId: string; // 如 "aave3" / "arb_aave3"
  chain: string; // DeBank chain id，如 "eth"
  name: string;
  items: PositionItem[];
  /** False when at least one principal item failed structural validation. */
  itemCoverageComplete?: boolean;
  /** False when reward legs or reward-relevant position identity were truncated/invalid. */
  rewardInputCoverageComplete?: boolean;
}

export interface ProjectListParseResult {
  protocols: ProtocolPosition[];
  /** False means some page-controlled input was not processed and totals must remain partial. */
  inputCoverageComplete: boolean;
  rateInputCoverageComplete: boolean;
  rewardInputCoverageComplete: boolean;
  /** Stable machine-readable reasons for UI/logging and boundary tests. */
  inputLimitReasons: string[];
  droppedProjects: number;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const nonNegativeNum = (v: unknown): number | null => {
  const parsed = num(v);
  return parsed !== null && parsed >= 0 ? parsed : null;
};
const str = (v: unknown, max: number = DEBANK_INPUT_LIMITS.identifierChars): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

function optionalStr(
  value: unknown,
  max: number = DEBANK_INPUT_LIMITS.identifierChars,
): { value: string | undefined; complete: boolean } {
  if (value === undefined || value === null || value === '') return { value: undefined, complete: true };
  const parsed = str(value, max);
  return { value: parsed ?? undefined, complete: parsed !== null };
}

function parseToken(raw: unknown): TokenLeg | null {
  const r = raw as Record<string, unknown> | null;
  const amount = nonNegativeNum(r?.amount);
  const price = nonNegativeNum(r?.price);
  const symbol = str(r?.optimized_symbol, DEBANK_INPUT_LIMITS.labelChars) ??
    str(r?.symbol, DEBANK_INPUT_LIMITS.labelChars);
  const address = str(r?.id);
  const chain = str(r?.chain);
  const usd = amount === null || price === null ? null : amount * price;
  if (
    amount === null ||
    price === null ||
    usd === null ||
    !Number.isFinite(usd) ||
    usd < 0 ||
    !symbol ||
    !address ||
    !chain
  ) return null;
  return {
    address: address.toLowerCase(),
    chain,
    symbol,
    amount,
    priceUsd: price,
    usd,
    decimals: num(r?.decimals) ?? undefined,
  };
}

interface ParseBudget {
  principalLegs: number;
  rewardLegs: number;
}

interface ParsedItem {
  item: PositionItem | null;
  principalComplete: boolean;
  rewardComplete: boolean;
  identityComplete: boolean;
}

function listField(
  detail: Record<string, unknown>,
  key: 'supply_token_list' | 'borrow_token_list' | 'reward_token_list',
): { list: unknown[]; shapeComplete: boolean } {
  const value = detail[key];
  if (value === undefined || value === null) return { list: [], shapeComplete: true };
  return Array.isArray(value)
    ? { list: value, shapeComplete: true }
    : { list: [], shapeComplete: false };
}

function parseItem(raw: unknown, budget: ParseBudget): ParsedItem {
  const r = raw as Record<string, any> | null;
  const detail = r?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return { item: null, principalComplete: false, rewardComplete: false, identityComplete: false };
  }

  const detailRecord = detail as Record<string, unknown>;
  const suppliesField = listField(detailRecord, 'supply_token_list');
  const borrowsField = listField(detailRecord, 'borrow_token_list');
  const rawSupplies = suppliesField.list;
  const rawBorrows = borrowsField.list;
  const allowedPrincipal = Math.min(
    DEBANK_INPUT_LIMITS.principalLegsPerItem,
    budget.principalLegs,
  );
  const keptSupplies = rawSupplies.slice(0, allowedPrincipal);
  const keptBorrows = rawBorrows.slice(0, Math.max(0, allowedPrincipal - keptSupplies.length));
  const principalKept = keptSupplies.length + keptBorrows.length;
  budget.principalLegs -= principalKept;
  const principalComplete =
    suppliesField.shapeComplete &&
    borrowsField.shapeComplete &&
    principalKept === rawSupplies.length + rawBorrows.length;
  const supplies = keptSupplies.map(parseToken);
  const borrows = keptBorrows.map(parseToken);
  // 存/借腿有任何一条解析失败 → 整个 item 不可信（金额权重会算错）
  if (supplies.some((t) => t === null) || borrows.some((t) => t === null)) {
    return { item: null, principalComplete: false, rewardComplete: false, identityComplete: false };
  }

  const rewardsField = listField(detailRecord, 'reward_token_list');
  const rawRewards = rewardsField.list;
  const allowedRewards = Math.min(
    DEBANK_INPUT_LIMITS.rewardLegsPerItem,
    budget.rewardLegs,
  );
  const keptRewards = rawRewards.slice(0, allowedRewards);
  budget.rewardLegs -= keptRewards.length;
  const parsedRewards = keptRewards
    .map(parseToken)
    .filter((t): t is TokenLeg => t !== null);
  const rewardComplete =
    rewardsField.shapeComplete &&
    keptRewards.length === rawRewards.length &&
    parsedRewards.length === keptRewards.length;

  const itemName = optionalStr(r?.name, DEBANK_INPUT_LIMITS.labelChars);
  const positionIndex = optionalStr(r?.position_index, DEBANK_INPUT_LIMITS.positionIdentityChars);
  const poolId = optionalStr(r?.pool && (r.pool as Record<string, unknown>).id);
  const adapterId = optionalStr(r?.pool && (r.pool as Record<string, unknown>).adapter_id);
  const poolDesc = optionalStr(
    (detail as Record<string, unknown>).description,
    DEBANK_INPUT_LIMITS.labelChars,
  );
  const identityComplete = [itemName, positionIndex, poolId, adapterId, poolDesc]
    .every((field) => field.complete);
  const principalInputCoverageComplete = principalComplete && identityComplete;
  const rewardInputCoverageComplete = rewardComplete && identityComplete;

  return {
    item: {
      itemName: itemName.value ?? 'Position',
      supplies: supplies as TokenLeg[],
      borrows: borrows as TokenLeg[],
      rewards: parsedRewards,
      principalInputCoverageComplete,
      rewardInputCoverageComplete,
      netUsd: num(r?.stats && (r.stats as Record<string, unknown>).net_usd_value) ?? 0,
      positionIndex: positionIndex.value,
      poolId: poolId.value,
      adapterId: adapterId.value,
      poolDesc: poolDesc.value,
    },
    principalComplete,
    rewardComplete,
    identityComplete,
  };
}

/**
 * Parse a bounded prefix and return explicit global coverage. Any omitted input
 * is unknown, never an implicit zero. Compatible with {data:[...]} and arrays.
 */
export function parseProjectListWithCoverage(payload: unknown): ProjectListParseResult {
  const p = payload as Record<string, unknown> | unknown[] | null;
  const list = Array.isArray((p as Record<string, unknown>)?.data)
    ? ((p as Record<string, unknown>).data as unknown[])
    : Array.isArray(p)
      ? p
      : null;
  if (!list) {
    return {
      protocols: [],
      inputCoverageComplete: false,
      rateInputCoverageComplete: false,
      rewardInputCoverageComplete: false,
      inputLimitReasons: ['invalid-project-list'],
      droppedProjects: 0,
    };
  }

  const reasons = new Set<string>();
  const droppedProjects = Math.max(0, list.length - DEBANK_INPUT_LIMITS.projects);
  let rateInputCoverageComplete = droppedProjects === 0;
  let rewardInputCoverageComplete = droppedProjects === 0;
  if (droppedProjects > 0) reasons.add('project-limit');
  const budget: ParseBudget = {
    principalLegs: DEBANK_INPUT_LIMITS.totalPrincipalLegs,
    rewardLegs: DEBANK_INPUT_LIMITS.totalRewardLegs,
  };
  let remainingItems = DEBANK_INPUT_LIMITS.totalItems;
  const out: ProtocolPosition[] = [];
  for (const raw of list.slice(0, DEBANK_INPUT_LIMITS.projects)) {
    const r = raw as Record<string, unknown> | null;
    const protocolId = str(r?.id);
    const chain = str(r?.chain);
    if (!protocolId || !chain || !Array.isArray(r?.portfolio_item_list)) {
      reasons.add('invalid-project');
      rateInputCoverageComplete = false;
      rewardInputCoverageComplete = false;
      continue;
    }
    const rawItems = r.portfolio_item_list as unknown[];
    if (rawItems.length === 0) continue;
    const itemLimit = Math.min(DEBANK_INPUT_LIMITS.itemsPerProject, remainingItems);
    const keptRawItems = rawItems.slice(0, itemLimit);
    remainingItems -= keptRawItems.length;
    const itemsComplete = keptRawItems.length === rawItems.length;
    if (!itemsComplete) {
      reasons.add('item-limit');
      rateInputCoverageComplete = false;
      rewardInputCoverageComplete = false;
    }

    const parsedItems = keptRawItems.map((item) => parseItem(item, budget));
    const items = parsedItems
      .map((result) => result.item)
      .filter((item): item is PositionItem => item !== null);
    const principalComplete = parsedItems.every(
      (result) => result.item !== null && result.principalComplete && result.identityComplete,
    );
    const rewardsComplete = parsedItems.every(
      (result) => result.item !== null && result.rewardComplete && result.identityComplete,
    );
    if (!principalComplete) {
      reasons.add('principal-leg-or-identity-limit');
      rateInputCoverageComplete = false;
      rewardInputCoverageComplete = false;
    }
    if (!rewardsComplete) {
      reasons.add('reward-leg-or-identity-limit');
      rewardInputCoverageComplete = false;
    }

    out.push({
      protocolId,
      chain,
      name: str(r?.name, DEBANK_INPUT_LIMITS.labelChars) ?? protocolId,
      items,
      itemCoverageComplete: itemsComplete && principalComplete,
      rewardInputCoverageComplete: itemsComplete && rewardsComplete,
    });
  }
  return {
    protocols: out,
    inputCoverageComplete: rateInputCoverageComplete && rewardInputCoverageComplete,
    rateInputCoverageComplete,
    rewardInputCoverageComplete,
    inputLimitReasons: [...reasons],
    droppedProjects,
  };
}

/** Backward-compatible parser for callers that only need the bounded positions. */
export function parseProjectList(payload: unknown): ProtocolPosition[] {
  return parseProjectListWithCoverage(payload).protocols;
}
