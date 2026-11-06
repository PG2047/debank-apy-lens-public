// 收益计算核心。
// 约定：baseApy 为复利 APY（小数，0.05 = 5%）；rewardApr 为单利 APR（小数）。
// 两者计价基准不同，UI 上分开标注；净APY 为近似合并值（tooltip 说明口径）。

import type { TokenLeg } from './debank';
import {
  normalizeRewardCoverage,
  type LegRates,
  type RewardComponent,
  type RewardEntitlement,
  type RewardState,
} from './adapters/types';

export interface AssetYield {
  leg: 'supply' | 'borrow';
  token: TokenLeg;
  baseApy: number | null; // null = 未匹配到利率（不是 0！）
  includesIntrinsicYield?: boolean;
  rewardApr: number | null; // null = 未匹配；0 = 确认无激励
  rewardState: RewardState;
  rewardComponents?: RewardComponent[];
  /** Points/multipliers shown separately and excluded from APR, net APY, and daily USD. */
  rewardEntitlements?: RewardEntitlement[];
  poolStat?: LegRates['poolStat'];
  source: string;
}

export interface ProtocolYield {
  equityUsd: number;
  leverage: number | null;
  netApy: number | null; // 对权益的年化（小数）；null = 显示 "--"
  estDailyUsd: number | null;
  /** 即使奖励覆盖不完整，也保留已知组成部分的小计。 */
  knownNetApy: number | null;
  knownEstDailyUsd: number | null;
  /** 在 1% 物料性阈值内，数值是否足以称为完整净 APY。 */
  rewardCoverageComplete: boolean;
  /** 基础利率覆盖是否在 item 级 1% 物料性阈值内完整。 */
  rateCoverageComplete: boolean;
  flags: string[]; // 不为空时 UI 需展示原因
  assets: AssetYield[];
}

// ─── 边界策略（可调）──────────────────────────────────────────
// 决定「宁显示 -- 也不显示错数」的分界线：
//   MIN_EQUITY_RATIO  权益/总存款 低于此比例 → 视为近满杠杆（公式极点附近，数值不可信）
//   MIN_EQUITY_USD    权益绝对值下限（太小的分母把噪声放大成离谱百分数）
//   MAX_LEVERAGE      杠杆显示封顶（超过显示 ">50x"）
export const POLICY = {
  MIN_EQUITY_RATIO: 0.01,
  MIN_EQUITY_USD: 50,
  MAX_LEVERAGE: 50,
};

/** 已知奖励的年化美元值；组件存在时以组件为真相并按稳定 id 去重。 */
export function annualRewardUsd(asset: AssetYield): number {
  const reward = normalizeRewardCoverage(asset);
  if (!reward.rewardComponents.length) return asset.token.usd * (reward.rewardApr ?? 0);
  const seen = new Set<string>();
  return reward.rewardComponents.reduce((total, component) => {
    if (seen.has(component.id) || !Number.isFinite(component.value)) return total;
    seen.add(component.id);
    return (
      total +
      (component.rateKind === 'annual-usd'
        ? component.value
        : asset.token.usd * component.value)
    );
  }, 0);
}

/** 该腿全部已知组件的年化美元贡献；基础未知时仍保留已知奖励。 */
export function knownAnnualUsd(asset: AssetYield): number {
  const sign = asset.leg === 'supply' ? 1 : -1;
  return sign * asset.token.usd * (asset.baseApy ?? 0) + annualRewardUsd(asset);
}

/**
 * 净APY（对权益）：
 *   [ Σ 存款ᵢ·(基础APYᵢ + 奖励APRᵢ) − Σ 借款ⱼ·(借款APYⱼ − 借款侧奖励APRⱼ) ] / E,  E = ΣS − ΣB
 * 等价形式：净APY = L·加权存款收益 − (L−1)·加权借款成本，L = ΣS/E。
 * 借出的生息资产（如 USDe）自身收益不记给用户——只计借款利息成本。
 */
export function computeProtocolYield(assets: AssetYield[]): ProtocolYield {
  const normalizedAssets = assets.map((asset) => ({
    ...asset,
    ...normalizeRewardCoverage(asset),
  }));
  const supplies = normalizedAssets.filter((a) => a.leg === 'supply');
  const borrows = normalizedAssets.filter((a) => a.leg === 'borrow');
  const S = supplies.reduce((s, a) => s + a.token.usd, 0);
  const B = borrows.reduce((s, a) => s + a.token.usd, 0);
  const E = S - B;
  const flags: string[] = [];
  const grossUsd = S + B;
  const incompleteRewardUsd = normalizedAssets
    .filter((asset) => {
      const state = asset.rewardState;
      return state === 'unknown' || state === 'non-annualizable';
    })
    .reduce((sum, asset) => sum + asset.token.usd, 0);
  const rewardCoverageComplete =
    grossUsd <= 0 || incompleteRewardUsd <= grossUsd * 0.01;
  const unmatchedUsd = normalizedAssets
    .filter((asset) => asset.baseApy === null)
    .reduce((sum, asset) => sum + asset.token.usd, 0);
  const rateCoverageComplete = grossUsd <= 0 || unmatchedUsd <= grossUsd * 0.01;
  const result: ProtocolYield = {
    equityUsd: E,
    leverage: null,
    netApy: null,
    estDailyUsd: null,
    knownNetApy: null,
    knownEstDailyUsd: null,
    rewardCoverageComplete,
    rateCoverageComplete,
    flags,
    assets: normalizedAssets,
  };

  if (!rewardCoverageComplete) {
    flags.push('奖励覆盖不完整：仅显示已知收益小计');
  } else if (incompleteRewardUsd > 0) {
    flags.push(`奖励未知尘埃 ${usd(incompleteRewardUsd)}，按物料性阈值忽略`);
  }

  if (S <= 0) {
    flags.push('无存款腿，暂不支持该仓位类型');
    return result;
  }
  if (E <= 0) {
    flags.push('权益≤0（满杠杆或坏账），净APY在此无定义');
    return result;
  }

  const leverage = S / E;
  result.leverage = Math.min(leverage, POLICY.MAX_LEVERAGE);

  if (E < S * POLICY.MIN_EQUITY_RATIO) {
    flags.push('近满杠杆：权益占比过小，净APY数值不可信');
    return result;
  }
  if (E < POLICY.MIN_EQUITY_USD) {
    flags.push(`权益低于 $${POLICY.MIN_EQUITY_USD}（尘埃仓位），不显示净APY`);
    return result;
  }

  // 利率未匹配的腿：按 USD 占比裁决——占比 >1% 拒绝出数（宁缺毋滥）；
  // 尘埃腿（如协议里挂着 $0 的历史仓位）只忽略并注记，不拖死整个协议的净APY
  if (!rateCoverageComplete) {
    flags.push('部分资产利率未匹配，净APY不显示');
  } else if (unmatchedUsd > 0) {
    flags.push(`已忽略 ${usd(unmatchedUsd)} 未匹配尘埃腿`);
  }

  const gain = supplies.reduce(
    (sum, asset) => sum + knownAnnualUsd(asset),
    0,
  );
  const cost = borrows.reduce(
    (sum, asset) => sum - knownAnnualUsd(asset),
    0,
  );
  result.knownNetApy = (gain - cost) / E;
  result.knownEstDailyUsd = (gain - cost) / 365;

  if (!rateCoverageComplete || !rewardCoverageComplete) return result;

  result.netApy = result.knownNetApy;
  result.estDailyUsd = result.knownEstDailyUsd;
  return result;
}

/** 协议/组合覆盖必须合取子仓位；大仓位不能稀释另一个仓位中的未知奖励。 */
export function enforceChildCoverage(
  parent: ProtocolYield,
  children: readonly ProtocolYield[],
): ProtocolYield {
  const rewardIncomplete = children.some((child) => !child.rewardCoverageComplete);
  const rateIncomplete = children.some((child) => !child.rateCoverageComplete);
  if (!rewardIncomplete && !rateIncomplete) return parent;
  const flags = [...parent.flags];
  if (rewardIncomplete && !flags.includes('至少一个独立仓位的奖励覆盖不完整')) {
    flags.push('至少一个独立仓位的奖励覆盖不完整');
  }
  if (rateIncomplete && !flags.includes('至少一个独立仓位的基础利率覆盖不完整')) {
    flags.push('至少一个独立仓位的基础利率覆盖不完整');
  }
  return {
    ...parent,
    netApy: null,
    estDailyUsd: null,
    rewardCoverageComplete: rewardIncomplete ? false : parent.rewardCoverageComplete,
    rateCoverageComplete: rateIncomplete ? false : parent.rateCoverageComplete,
    flags,
  };
}

/** 百分比最多保留两位小数，并删除无意义的尾零。 */
export const pct = (v: number | null): string => {
  if (v === null) return '--';
  const percentage = Math.abs(v * 100) < 0.005 ? 0 : v * 100;
  return `${percentage.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
};

export const usd = (v: number): string => {
  const abs = Math.abs(v);
  const s =
    abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M` : abs >= 1e3 ? `$${(abs / 1e3).toFixed(1)}k` : `$${abs.toFixed(2)}`;
  return v < 0 ? `-${s}` : s;
};
