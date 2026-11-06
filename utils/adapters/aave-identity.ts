import { CHAINS } from '../chains';

/** DeBank identifies a native token by its chain ID, not by its ticker. */
export function aaveNativeAliases(chainId: number): string[] {
  return Object.entries(CHAINS)
    .filter(([, chain]) => chain.chainId === chainId)
    .map(([id]) => id);
}

export function aaveMarketAddress(poolId: string | undefined): string | null {
  return poolId?.toLowerCase().match(/^(0x[0-9a-f]{40})(?::|$)/)?.[1] ?? null;
}

export function aaveRequestKey(chainId: number, user?: string): string {
  return `${chainId}:${user?.toLowerCase() || 'anonymous'}`;
}
