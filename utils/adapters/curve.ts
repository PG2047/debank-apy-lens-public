import { address, baseRate, byChain, numeric, poolAddress, publicJson, rate } from './public-data';
import type { ProtocolAdapter } from './types';

export const CURVE_CHAINS: Readonly<Record<number, string>> = {
  1: 'ethereum', 10: 'optimism', 56: 'bsc', 100: 'xdai', 137: 'polygon',
  196: 'x-layer', 252: 'fraxtal', 324: 'zksync', 999: 'hyperliquid',
  2222: 'kava', 5000: 'mantle', 8453: 'base',
  42161: 'arbitrum', 42220: 'celo', 43114: 'avalanche', 146: 'sonic',
};
interface Pool {
  address: string; lpTokenAddress?: string; gaugeAddress?: string; isBroken?: boolean;
  coins?: { address: string }[]; underlyingCoins?: { address: string }[];
}
interface YieldRow { address: string; latestWeeklyApy?: number }

const canonicalToken = (value: string): string | null =>
  ['eth', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'].includes(value.toLowerCase())
    ? '0x0000000000000000000000000000000000000000' : address(value);

export const curveAdapter: ProtocolAdapter = {
  name: 'curve',
  matches: (id) => /^([a-z0-9]+_)?curve(?:_?v?2)?$/.test(id),
  async resolve(queries, signal) {
    const catalogs = await byChain(queries, async (chainId) => {
      const chain = CURVE_CHAINS[chainId];
      if (!chain) return null;
      const [pools, yields] = await Promise.all([
        // Ethereum's complete pool catalog currently exceeds 5 MB.
        publicJson<{ success: boolean; data: { poolData: Pool[] } }>(`https://api.curve.finance/v1/getPools/all/${chain}`, signal, 8 * 1024 * 1024),
        publicJson<{ success: boolean; data: { poolList: YieldRow[] } }>(`https://api.curve.finance/v1/getSubgraphData/${chain}`, signal),
      ]);
      if (!pools.success || !yields.success) return null;
      return { pools: pools.data.poolData, yields: yields.data.poolList };
    }, signal);
    return queries.map((q) => {
      const catalog = catalogs.get(q.chainId);
      if (!catalog || q.leg !== 'supply' || q.itemHasBorrows) return null;
      const pool = poolAddress(q);
      const token = canonicalToken(q.address);
      const hits = catalog.pools.filter((p) => !p.isBroken && (pool
        ? [address(p.address), address(p.lpTokenAddress), address(p.gaugeAddress)].includes(pool)
        : address(p.lpTokenAddress) !== null && address(p.lpTokenAddress) === token));
      if (hits.length !== 1) return null;
      const p = hits[0];
      const tokens = [p.address, p.lpTokenAddress, p.gaugeAddress,
        ...(p.coins ?? []).map((c) => c.address), ...(p.underlyingCoins ?? []).map((c) => c.address)]
        .filter((a): a is string => typeof a === 'string').map(canonicalToken);
      if (!token || !tokens.includes(token)) return null;
      const rows = catalog.yields.filter((row) => address(row.address) === address(p.address));
      if (rows.length !== 1) return null;
      const percent = numeric(rows[0].latestWeeklyApy);
      // Official pool-wide base APY includes fees and any supported LST yield.
      // Gauge boost and wallet-specific incentives remain unknown, never zero.
      return baseRate(percent === null ? null : rate(percent / 100), 'curve官方(池7日基础APY)');
    });
  },
};
