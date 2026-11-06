import type { LegRates } from './adapters/types';

// 流动性风险阈值（可调）：可提现金不超过仓位的 110% 为红色。
export const RED_AVAILABLE_MULTIPLE = 1.10;
// 流动性风险阈值（可调）：仓位达到池子总规模的 10% 为黄色。
export const YELLOW_SHARE_THRESHOLD = 0.10;

export interface LiquidityRiskAssessment {
  level: 'red' | 'yellow' | null;
  sharePct: number | null;
  availableRatio: number | null;
}

/**
 * 只比较同一口径的仓位与池子数据；缺失、非有限或非正基础值一律 fail-open。
 */
export function assessLiquidityRisk(
  leg: { usd: number; tokens: number },
  poolStat?: LegRates['poolStat'],
): LiquidityRiskAssessment {
  const empty: LiquidityRiskAssessment = {
    level: null,
    sharePct: null,
    availableRatio: null,
  };
  if (!poolStat || !Number.isFinite(poolStat.total) || poolStat.total <= 0) return empty;

  const position = poolStat.unit === 'usd' ? leg.usd : leg.tokens;
  if (!Number.isFinite(position) || position <= 0) return empty;

  const sharePct = position / poolStat.total;
  if (!Number.isFinite(sharePct)) return empty;
  const available = poolStat.available;
  const rawAvailableRatio = available !== null && Number.isFinite(available) && available >= 0
    ? available / position
    : null;
  const availableRatio = rawAvailableRatio !== null && Number.isFinite(rawAvailableRatio)
    ? rawAvailableRatio
    : null;
  const level = availableRatio !== null && availableRatio <= RED_AVAILABLE_MULTIPLE
    ? 'red'
    : sharePct >= YELLOW_SHARE_THRESHOLD
      ? 'yellow'
      : null;

  return { level, sharePct, availableRatio };
}
