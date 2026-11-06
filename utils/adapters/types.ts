// 协议适配器统一接口：每个协议只需回答「这条腿的利率是多少」。

export type RewardState =
  | 'numeric-known'
  | 'confirmed-zero'
  | 'unknown'
  | 'non-annualizable'
  | 'not-applicable';

export type RewardRateKind = 'apr' | 'apy' | 'annual-usd';

export type RewardBasis =
  | 'supply'
  | 'borrow'
  | 'collateral'
  | 'vault'
  | 'net-supply'
  | 'liquidity'
  | 'position';

export type RewardEntitlementVerification =
  | 'index-confirmed'
  | 'rule-confirmed'
  | 'unverified';

/** Non-annualizable rights such as points, multipliers, or ecosystem rewards; never enter APY math. */
export interface RewardEntitlement {
  id: string;
  label: string;
  display: string;
  source: string;
  basis: RewardBasis;
  verification: RewardEntitlementVerification;
  category?: 'points' | 'ecosystem-reward';
  note?: string;
  notes?: string[];
  observedAt?: number;
}

export interface RewardComponent {
  /** 稳定去重键；应包含来源、活动/奖励 token 和计息基准。 */
  id: string;
  value: number;
  rateKind: RewardRateKind;
  source: string;
  /** Human-verifiable activity or official product page. */
  sourceUrl?: string;
  basis: RewardBasis;
  label?: string;
  observedAt?: number;
}

export interface RewardCoverage {
  rewardApr: number | null;
  rewardState: RewardState;
  rewardComponents: RewardComponent[];
}

/**
 * Runtime boundary for adapter output. State is authoritative: a scalar zero
 * never proves exhaustive coverage. Contradictions fail closed to `unknown`,
 * while individually valid components remain available as a known subtotal.
 */
export function normalizeRewardCoverage(
  input: Pick<RewardCoverage, 'rewardApr' | 'rewardState'> &
    Partial<Pick<RewardCoverage, 'rewardComponents'>>,
): RewardCoverage {
  let contradictory = false;
  const byId = new Map<string, RewardComponent>();
  const conflictingIds = new Set<string>();
  for (const component of input.rewardComponents ?? []) {
    if (
      !component ||
      typeof component.id !== 'string' ||
      component.id.length === 0 ||
      typeof component.source !== 'string' ||
      component.source.length === 0 ||
      !Number.isFinite(component.value) ||
      component.value < 0
    ) {
      contradictory = true;
      continue;
    }
    if (conflictingIds.has(component.id)) continue;
    const previous = byId.get(component.id);
    if (previous) {
      if (
        previous.value !== component.value ||
        previous.rateKind !== component.rateKind ||
        previous.source !== component.source ||
        previous.basis !== component.basis
      ) {
        contradictory = true;
        byId.delete(component.id);
        conflictingIds.add(component.id);
      }
      continue;
    }
    byId.set(component.id, component);
  }
  const rewardComponents = [...byId.values()];
  const rateComponents = rewardComponents.filter(
    (component) => component.rateKind !== 'annual-usd',
  );
  const componentRate = rateComponents.reduce(
    (sum, component) => sum + component.value,
    0,
  );
  const scalarMatchesComponents =
    input.rewardApr !== null &&
    Math.abs(input.rewardApr - componentRate) <=
      Math.max(1e-12, Math.abs(componentRate) * 1e-9);
  const scalarValid =
    input.rewardApr === null ||
    (Number.isFinite(input.rewardApr) && input.rewardApr >= 0);
  if (!scalarValid) contradictory = true;

  switch (input.rewardState) {
    case 'numeric-known':
      if (input.rewardApr === null || input.rewardApr <= 0) contradictory = true;
      if (rateComponents.length > 0 && !scalarMatchesComponents) contradictory = true;
      break;
    case 'confirmed-zero':
      if (
        input.rewardApr !== 0 ||
        rewardComponents.some((component) => component.value > 0)
      ) {
        contradictory = true;
      }
      break;
    case 'not-applicable':
      if (input.rewardApr !== null || rewardComponents.length > 0) contradictory = true;
      break;
    case 'unknown':
      if (input.rewardApr !== null && input.rewardApr > 0 && rateComponents.length === 0) {
        contradictory = true;
      }
      break;
    case 'non-annualizable':
      // A scalar alone cannot annualize points/private incentives. Only explicit
      // annualizable components may contribute a known subtotal.
      if (input.rewardApr !== null && rateComponents.length === 0) contradictory = true;
      if (rateComponents.length > 0 && !scalarMatchesComponents) contradictory = true;
      break;
  }

  if (!contradictory) {
    return {
      rewardApr: rateComponents.length > 0 ? componentRate : input.rewardApr,
      rewardState: input.rewardState,
      rewardComponents,
    };
  }

  return {
    rewardApr:
      rateComponents.length > 0
        ? componentRate
        : null,
    rewardState: 'unknown',
    rewardComponents,
  };
}

export interface LegQuery {
  chainId: number;
  address: string; // 小写底层资产地址
  leg: 'supply' | 'borrow';
  /** 同一 portfolio item 是否含借款腿——用于 lending vs savings 产品消歧（如 sparklend vs spark-savings） */
  itemHasBorrows: boolean;
  /** 页面正在查看的钱包地址（小写）——Morpho 等按用户仓位精确取利率的 adapter 需要 */
  userAddress?: string;
  /** DeBank item 的 pool.adapter_id（如 morpho_blue_lending2 / redeemable_tokenized_vault_yield）——链上引擎路由钥匙 */
  itemAdapterId?: string;
  /** DeBank item 的 pool.id（金库/主合约地址，可能带 :lending 后缀） */
  itemPoolId?: string;
  /** 该 item 正在累积的奖励代币地址（小写）——农场池按奖励代币匹配用（Sky GROVE 场景） */
  itemRewardTokens?: string[];
  /** 奖励代币的展示与定价上下文；用于精确农场合约验证和 APR 计算。 */
  itemRewards?: {
    address: string;
    symbol: string;
    amount: number;
    usd: number;
    priceUsd: number;
    decimals?: number;
  }[];
  /** 完整仓位身份；禁止仅按 token 猜市场。 */
  positionKey?: string;
  protocolId?: string;
  itemName?: string;
  itemSupplyAddresses?: string[];
  itemBorrowAddresses?: string[];
  itemSupplies?: {
    address: string;
    amount: number;
    usd: number;
    priceUsd: number;
    decimals?: number;
  }[];
  itemBorrows?: {
    address: string;
    amount: number;
    usd: number;
    priceUsd: number;
    decimals?: number;
  }[];
  positionIndex?: string;
}

export interface LegRates {
  baseApy: number | null; // 复利 APY，小数；null = 该方向未知
  /** true 表示 baseApy 已包含 share-token/native yield，background 不得再次叠加。 */
  includesIntrinsicYield?: boolean;
  rewardApr: number | null; // 单利 APR，小数；0 = 确认无激励
  rewardState: RewardState;
  rewardComponents?: RewardComponent[];
  rewardEntitlements?: RewardEntitlement[];
  /** 出借供给腿所在池子的总规模与即时可提流动性；未知或非供给腿省略。 */
  poolStat?: {
    total: number;
    available: number | null;
    unit: 'usd' | 'token';
    source: string;
  };
  source: string;
}

export interface ProtocolAdapter {
  name: string;
  /** 是否处理该 DeBank 协议 id（如 "aave3" / "arb_aave3" / "spark"） */
  matches(protocolId: string): boolean;
  /** 逐条解析利率；无法可靠匹配的返回 null（上游显示 "--"，绝不猜） */
  resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]>;
}
