import { tr } from './i18n';
import type { RewardComponent, RewardEntitlement } from './adapters/types';

export interface RewardSourcePresentation {
  title: string;
  description: string;
  linkLabel: string;
  url: string;
}

interface SourceRule {
  matches: (source: string) => boolean;
  linkLabel: string;
  url: string;
  description: string;
}

const rules: readonly SourceRule[] = [
  {
    matches: (source) => source.includes('merkl'),
    linkLabel: '查看 Merkl 奖励活动',
    url: 'https://app.merkl.xyz/',
    description: '这部分额外收益由 Merkl 奖励活动发放，显示值来自活动当前公布的 APR。',
  },
  {
    matches: (source) => source.includes('defillama'),
    linkLabel: '查看 DeFiLlama 收益数据',
    url: 'https://defillama.com/yields',
    description: '这部分收益使用 DeFiLlama 的明确池级数据作为补充来源。',
  },
  {
    matches: (source) => source.includes('aave-v4'),
    linkLabel: '查看 Aave V4 官方市场',
    url: 'https://pro.aave.com/',
    description: '这部分奖励来自 Aave V4 官方 spoke 的奖励配置。',
  },
  {
    matches: (source) => source.includes('aave-v3'),
    linkLabel: '查看 Aave 官方市场',
    url: 'https://aave.com/',
    description: '这部分奖励来自 Aave 官方 reserve incentive 配置。',
  },
  {
    matches: (source) => source.includes('morpho-api'),
    linkLabel: '查看 Morpho 官方市场',
    url: 'https://app.morpho.org/',
    description: '这部分奖励来自 Morpho 官方市场或金库奖励数据。',
  },
  {
    matches: (source) => source.includes('lista') || source.includes('moolah'),
    linkLabel: '查看 Lista 官方产品',
    url: 'https://lista.org/',
    description: '这部分奖励来自 Lista 官方金库或 Moolah 产品数据。',
  },
  {
    matches: (source) => source.includes('spark'),
    linkLabel: '查看 Spark 官方市场',
    url: 'https://app.spark.fi/',
    description: '这部分奖励来自 Spark 官方市场；只有缺失组件才使用明确标注的补充来源。',
  },
  {
    matches: (source) => source.includes('sky'),
    linkLabel: '查看 Sky 官方奖励产品',
    url: 'https://app.sky.money/',
    description: '这部分奖励来自已精确匹配的 Sky farm 或储蓄产品。',
  },
  {
    matches: (source) => source.includes('dolomite'),
    linkLabel: '查看 Dolomite 官方市场',
    url: 'https://app.dolomite.io/',
    description: '这部分奖励来自 Dolomite 官方市场的额外利息或奖励组成。',
  },
  {
    matches: (source) => source.includes('compound'),
    linkLabel: '查看 Compound 官方市场',
    url: 'https://app.compound.finance/',
    description: '这部分奖励来自精确 Comet 市场的 Compound 官方奖励数据。',
  },
  {
    matches: (source) => source.includes('venus'),
    linkLabel: '查看 Venus 官方市场',
    url: 'https://venus.io/',
    description: '这部分奖励来自 Venus 官方 distributor 或其明确披露的活动。',
  },
  {
    matches: (source) => source.includes('fluid'),
    linkLabel: '查看 Fluid 官方产品',
    url: 'https://fluid.io/',
    description: '这部分奖励来自 Fluid 官方奖励或 Smart Collateral/Debt 收益数据。',
  },
  {
    matches: (source) => source.includes('ethena'),
    linkLabel: '查看 Ethena 官方产品',
    url: 'https://docs.ethena.fi/',
    description: '这部分收益来自 Ethena 官方公布的产品收益数据。',
  },
  {
    matches: (source) => source.includes('falcon'),
    linkLabel: '查看 Falcon 官方产品',
    url: 'https://falcon.finance/',
    description: '这部分收益来自 Falcon 官方公布的产品收益数据。',
  },
];

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function ruleFor(source: string): SourceRule | null {
  const normalized = source.toLowerCase();
  return rules.find((rule) => rule.matches(normalized)) ?? null;
}

export function rewardComponentSource(
  component: RewardComponent,
): RewardSourcePresentation | null {
  const rule = ruleFor(component.source);
  const exactUrl = safeHttpsUrl(component.sourceUrl);
  if (!rule && !exactUrl) return null;
  const reward = component.label ? tr("奖励 {0}", component.label) : tr("额外奖励");
  return {
    title: tr("{0} 来源说明", reward),
    description: rule ? tr(rule.description) : tr("这部分奖励由 {0} 提供。", component.source),
    linkLabel: exactUrl && component.source.toLowerCase().includes('merkl')
      ? tr("查看本次 Merkl 奖励活动")
      : (rule ? tr(rule.linkLabel) : tr("查看官方来源")),
    url: exactUrl ?? rule!.url,
  };
}

export function rewardEntitlementSource(
  entitlement: RewardEntitlement,
): RewardSourcePresentation | null {
  const rule = ruleFor(entitlement.source);
  const exactUrl = safeHttpsUrl(entitlement.source);
  if (!rule && !exactUrl) return null;
  const isPoints = entitlement.category !== 'ecosystem-reward';
  return {
    title: tr("{0}来源说明", isPoints ? tr("积分") : tr("资格")),
    description: isPoints
      ? tr("这是独立的积分或倍数资格，不折算成 APY；链接用于核对官方计算规则和资格边界。")
      : tr("这是非积分的生态奖励或空投资格；链接用于核对官方产品规则和已公布权益。"),
    linkLabel: isPoints ? tr("查看官方积分规则") : tr("查看官方资格说明"),
    url: exactUrl ?? rule!.url,
  };
}
