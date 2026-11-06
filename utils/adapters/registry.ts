// 协议适配器统一注册表。每条可执行 rate/LP 路由必须同时声明奖励能力策略，
// 让运行时路由和审计清单无法独立漂移。

import { aaveAdapter } from './aave';
import { aave4Adapter } from './aave4';
import { morphoAdapter } from './morpho';
import { listaAdapter } from './lista';
import { skyAdapter } from './sky';
import { pendleAdapter } from './pendle';
import { curveAdapter } from './curve';
import { beefyAdapter, yearnAdapter } from './vaults';
import { lidoAdapter, rocketPoolAdapter, etherfiAdapter } from './staking';
import { makeLlamaAdapter } from './defillama';
import {
  withFallback,
  sparkOfficial,
  dolomiteOfficial,
  compoundOfficial,
  venusOfficial,
  fluidOfficial,
  ethenaOfficial,
  falconOfficial,
} from './official';
import type { RewardCapabilityPolicy } from './capabilities';
import type { ProtocolAdapter } from './types';
import type { DexFamily } from '../uniswap';

// SparkLend（借贷，可循环贷）+ Spark Savings（sUSDS/sUSDC/sUSDT… 金库）
const sparkAdapter = makeLlamaAdapter({
  name: 'spark',
  idPattern: /^([a-z0-9]+_)?spark$/,
  lendProjects: ['sparklend'],
  savingsProjects: ['spark-savings'],
});

// 只有 Spark 允许用 Llama 逐组件补缺；其余官方适配器都依赖精确容器身份，
// token-level Llama fallback 会绕过 Comet/vToken/vault 等消歧，故失败时保持 unknown。

export interface RegisteredRateRoute {
  readonly route: string;
  readonly kind: 'rate';
  readonly adapter: ProtocolAdapter;
  readonly capability: RewardCapabilityPolicy;
}

export interface RegisteredLpRoute {
  readonly route: string;
  readonly kind: 'lp';
  readonly family: DexFamily;
  readonly version: 3 | 4;
  readonly matches: (protocolId: string) => boolean;
  readonly capability: RewardCapabilityPolicy;
}

export type RegisteredRoute = RegisteredRateRoute | RegisteredLpRoute;

function defineRoutes<const T extends readonly RegisteredRoute[]>(routes: T): T {
  const names = new Set<string>();
  for (const route of routes) {
    if (names.has(route.route)) throw new Error(`Duplicate registered route: ${route.route}`);
    names.add(route.route);
    if (route.kind === 'rate' && route.route !== route.adapter.name) {
      throw new Error(`Rate route ${route.route} must match adapter ${route.adapter.name}`);
    }
  }
  return routes;
}

/** Single typed source of truth for all 19 rate adapters and all 3 LP range routes. */
export const REGISTERED_ROUTES = defineRoutes([
  {
    route: 'aave-v3',
    kind: 'rate',
    adapter: aaveAdapter,
    capability: {
      rewardTruth: 'AaveKit reserve incentives',
      exactIdentity: 'market address + reserve + leg',
      zeroProofRoles: ['supply', 'borrow'],
      unsupportedPolicy: 'non-annualizable',
    },
  },
  {
    route: 'aave-v4',
    kind: 'rate',
    adapter: aave4Adapter,
    capability: {
      rewardTruth: 'Aave V4 spoke reward union',
      exactIdentity: 'spoke address + reserve + leg',
      zeroProofRoles: ['supply', 'borrow'],
      unsupportedPolicy: 'non-annualizable',
    },
  },
  {
    route: 'morpho',
    kind: 'rate',
    adapter: morphoAdapter,
    capability: {
      rewardTruth: 'Morpho Blue API for market/vault; Merkl for collateral; Midnight fixed yield excludes Blue incentives',
      exactIdentity: 'market id, deposit proxy + market id, vault address, or Midnight market id + role',
      zeroProofRoles: ['supply', 'borrow', 'vault'],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'lista',
    kind: 'rate',
    adapter: listaAdapter,
    capability: {
      rewardTruth: 'Lista vault emission API; exact Moolah market detail emissions and points',
      exactIdentity: 'vault address or wallet-active Moolah market id',
      zeroProofRoles: ['vault', 'borrow', 'collateral'],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'spark',
    kind: 'rate',
    adapter: withFallback(sparkOfficial, sparkAdapter),
    capability: {
      rewardTruth: 'Spark base API with unique-product Llama evidence only',
      exactIdentity: 'product + chain + unique reserve',
      zeroProofRoles: [],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'sky',
    kind: 'rate',
    adapter: skyAdapter,
    capability: {
      rewardTruth: 'Sky Chainlog + onchain farm identity/active gate + exact-farm official APR',
      exactIdentity: 'share token or farm contract + staking/reward token + wallet balance',
      zeroProofRoles: ['farm'],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'dolomite',
    kind: 'rate',
    adapter: dolomiteOfficial,
    capability: {
      rewardTruth: 'Dolomite outside interest reward parts',
      exactIdentity: 'chain + market token + leg',
      zeroProofRoles: ['supply', 'borrow'],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'compound-v3',
    kind: 'rate',
    adapter: compoundOfficial,
    capability: {
      rewardTruth: 'Compound summary + rewards endpoints',
      exactIdentity: 'Comet address + base asset + leg',
      zeroProofRoles: ['supply', 'borrow'],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'venus',
    kind: 'rate',
    adapter: venusOfficial,
    capability: {
      rewardTruth: 'Venus explicit distributors, intrinsic/YTM details, and points',
      exactIdentity: 'comptroller or vToken + underlying + leg',
      zeroProofRoles: ['supply', 'borrow'],
      unsupportedPolicy: 'non-annualizable',
    },
  },
  {
    route: 'fluid',
    kind: 'rate',
    adapter: fluidOfficial,
    capability: {
      rewardTruth: 'Fluid fToken/vault rewards plus Smart Collateral/Debt DEX trading yield',
      exactIdentity: 'fToken or vault address + asset + leg',
      zeroProofRoles: ['fToken-supply', 'vault-supply', 'vault-borrow'],
      unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'ethena',
    kind: 'rate',
    adapter: ethenaOfficial,
    capability: {
      rewardTruth: 'Official sUSDe yield only; Ethena points and eligibility metadata are policy-excluded',
      exactIdentity: 'sUSDe share token or ENA underlying + sENA product identity',
      zeroProofRoles: [],
      unsupportedPolicy: 'not-applicable',
    },
  },
  {
    route: 'falcon',
    kind: 'rate',
    adapter: falconOfficial,
    capability: {
      rewardTruth: 'Official share-token base yield; extra incentives not exhaustive',
      exactIdentity: 'sUSDf share token',
      zeroProofRoles: [],
      unsupportedPolicy: 'non-annualizable',
    },
  },
  {
    route: 'pendle', kind: 'rate', adapter: pendleAdapter,
    capability: {
      rewardTruth: 'Official PT current implied APY; LP/YT rewards and points excluded',
      exactIdentity: 'chain + PT token + optional exact market; expiry gate',
      zeroProofRoles: [], unsupportedPolicy: 'not-applicable',
    },
  },
  {
    route: 'curve', kind: 'rate', adapter: curveAdapter,
    capability: {
      rewardTruth: 'Official pool base APY; personal gauge boost and incentives unknown',
      exactIdentity: 'chain + pool/LP/gauge address + constituent token',
      zeroProofRoles: [], unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'beefy', kind: 'rate', adapter: beefyAdapter,
    capability: {
      rewardTruth: 'Official net composite vault APY; external boosts unknown',
      exactIdentity: 'chain + active standard vault address',
      zeroProofRoles: [], unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'yearn', kind: 'rate', adapter: yearnAdapter,
    capability: {
      rewardTruth: 'Official seven-day share growth; external staking rewards unknown',
      exactIdentity: 'chain + vault address + deposit/share/constituent token',
      zeroProofRoles: [], unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'lido', kind: 'rate', adapter: lidoAdapter,
    capability: {
      rewardTruth: 'Official stETH seven-day APR converted to estimated APY',
      exactIdentity: 'chain + canonical stETH/wstETH token',
      zeroProofRoles: [], unsupportedPolicy: 'not-applicable',
    },
  },
  {
    route: 'rocket-pool', kind: 'rate', adapter: rocketPoolAdapter,
    capability: {
      rewardTruth: 'Official rETH APR converted to estimated APY',
      exactIdentity: 'Ethereum canonical rETH token',
      zeroProofRoles: [], unsupportedPolicy: 'not-applicable',
    },
  },
  {
    route: 'etherfi', kind: 'rate', adapter: etherfiAdapter,
    capability: {
      rewardTruth: 'Onchain weETH share growth; additional restaking rewards unknown',
      exactIdentity: 'Ethereum canonical eETH/weETH token',
      zeroProofRoles: [], unsupportedPolicy: 'unknown',
    },
  },
  {
    route: 'uniswap-v3',
    kind: 'lp',
    family: 'uniswap',
    version: 3,
    matches: (protocolId: string) => /^([a-z0-9]+_)?uniswap_?v?3$/.test(protocolId),
    capability: {
      rewardTruth: 'Fee APY and external incentive APY are policy-excluded',
      exactIdentity: 'pool + NFT + ticks + fee tier',
      zeroProofRoles: [],
      unsupportedPolicy: 'not-applicable',
    },
  },
  {
    route: 'uniswap-v4',
    kind: 'lp',
    family: 'uniswap',
    version: 4,
    matches: (protocolId: string) => /^([a-z0-9]+_)?uniswap_?v?4$/.test(protocolId),
    capability: {
      rewardTruth: 'Fee APY and external incentive APY are policy-excluded',
      exactIdentity: 'pool id + NFT + ticks + hooks',
      zeroProofRoles: [],
      unsupportedPolicy: 'not-applicable',
    },
  },
  {
    route: 'pancake-v3',
    kind: 'lp',
    family: 'pancake',
    version: 3,
    matches: (protocolId: string) => /^([a-z0-9]+_)?pancake_?v?3$/.test(protocolId),
    capability: {
      rewardTruth: 'Fee APY and external incentive APY are policy-excluded',
      exactIdentity: 'pool + NFT + ticks + fee tier',
      zeroProofRoles: [],
      unsupportedPolicy: 'not-applicable',
    },
  },
] satisfies readonly RegisteredRoute[]);

const isRateRoute = (route: RegisteredRoute): route is RegisteredRateRoute => route.kind === 'rate';
const isLpRoute = (route: RegisteredRoute): route is RegisteredLpRoute => route.kind === 'lp';
const registeredRoutes: readonly RegisteredRoute[] = REGISTERED_ROUTES;

export const RATE_ROUTES: readonly RegisteredRateRoute[] = registeredRoutes.filter(isRateRoute);
export const LP_ROUTES: readonly RegisteredLpRoute[] = registeredRoutes.filter(isLpRoute);
export const ADAPTERS: ProtocolAdapter[] = RATE_ROUTES.map(({ adapter }) => adapter);

export const findAdapter = (protocolId: string): ProtocolAdapter | undefined =>
  ADAPTERS.find((adapter) => adapter.matches(protocolId));

export function findLpRoute(protocolId: string): RegisteredLpRoute | undefined {
  const matches = LP_ROUTES.filter((route) => route.matches(protocolId));
  if (matches.length > 1) throw new Error(`Ambiguous LP route for protocol ${protocolId}`);
  return matches[0];
}
