// Official yield-bearing token identities; a ticker or an address on another chain is insufficient.
// https://docs.ethena.fi/technical-design/key-addresses (2026-09-21)
const SUSDE_L2 = '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2';
export const SUSDE_BY_CHAIN: Record<number, string> = Object.fromEntries(
  [80094, 5000, 81457, 42161, 10, 8453, 48900, 56, 59144, 169, 534352, 252, 34443, 196, 1088, 2222, 2818, 1923]
    .map((chainId) => [chainId, SUSDE_L2]),
);
SUSDE_BY_CHAIN[1] = '0x9d39a5de30e57443bff2a8307a4256c8797a3497';
SUSDE_BY_CHAIN[324] = '0xad17da2f6ac76746ef261e835c50b2651ce36da8';
SUSDE_BY_CHAIN[4217] = '0x20c000000000000000000000bd95bfb69fbe6ce3';

// https://docs.falcon.finance/resources/smart-contracts (2026-09-21)
// USDf deployments on BNB/XDC are not sUSDf and do not inherit its staking APY.
export const SUSDF_BY_CHAIN: Record<number, string> = {
  1: '0xc8cf6d7991f15525488b2a83df53468d682ba4b0',
};
