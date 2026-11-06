import deployments from './deployments.json';

export interface V3Deployment { factory: string; positionManager: string }
export interface V4Deployment { positionManager: string; stateView: string }

export const UNISWAP_V3: Record<number, V3Deployment> = Object.fromEntries(
  Object.entries(deployments.uniswap.v3).map(([id, row]) => [id, {
    factory: row.UniswapV3Factory,
    positionManager: row.NonfungiblePositionManager,
  }]),
);
export const UNISWAP_V4: Record<number, V4Deployment> = Object.fromEntries(
  Object.entries(deployments.uniswap.v4).map(([id, row]) => [id, {
    positionManager: row.PositionManager,
    stateView: row.StateView,
  }]),
);

// https://developer.pancakeswap.finance/contracts/v3/addresses (2026-09-21)
// Mainnets only. zkSync has different bytecode and therefore different addresses.
export const PANCAKE_V3: Record<number, V3Deployment> = Object.fromEntries(
  [1, 56, 42161, 59144, 8453, 204, 143, 4663].map((id) => [id, {
    factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    positionManager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
  }]),
);
PANCAKE_V3[324] = {
  factory: '0x1bb72e0cbbea93c08f535fc7856e0338d7f7a8ab',
  positionManager: '0xa815e2ed7f7d5b0c49fda367f249232a1b9d2883',
};
