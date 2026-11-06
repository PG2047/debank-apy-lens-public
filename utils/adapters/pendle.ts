import { address, baseRate, poolAddress, publicJson, rate } from './public-data';
import type { ProtocolAdapter } from './types';

interface Market {
  chainId: number; address: string; pt: string; yt: string; underlyingAsset: string;
  expiry: string; details?: { impliedApy?: number };
}
interface MarketPage { total: number; results: Market[] }
const URL = 'https://api-v2.pendle.finance/core/v2/markets/all?limit=100';

async function markets(signal?: AbortSignal): Promise<Market[]> {
  const first = await publicJson<MarketPage>(URL, signal);
  if (!Array.isArray(first.results) || !Number.isSafeInteger(first.total) || first.total < first.results.length || first.total > 2000) {
    throw new Error('Pendle market catalog exceeds supported page budget');
  }
  const pages = await Promise.all(Array.from({ length: Math.ceil(first.total / 100) - 1 }, (_, i) =>
    publicJson<MarketPage>(`${URL}&skip=${(i + 1) * 100}`, signal)));
  return [first, ...pages].flatMap((page) => page.results);
}

const assetAddress = (id: string, chain: number) => id?.startsWith(`${chain}-`) ? address(id.slice(String(chain).length + 1)) : null;

export const pendleAdapter: ProtocolAdapter = {
  name: 'pendle',
  matches: (id) => /^([a-z0-9]+_)?pendle(?:_?v?2)?$/.test(id),
  async resolve(queries, signal) {
    const rows = await markets(signal);
    return queries.map((q) => {
      if (q.leg !== 'supply' || q.itemHasBorrows) return null;
      const pool = poolAddress(q);
      const token = address(q.address);
      const hits = rows.filter((m) => {
        if (m.chainId !== q.chainId) return false;
        const pt = assetAddress(m.pt, m.chainId);
        if (!pt) return false;
        if (pool && pool !== pt && pool !== address(m.address)) return false;
        // A market address alone does not distinguish LP, PT, and YT positions.
        return token === pt || (pool === pt && token !== null && token === assetAddress(m.underlyingAsset, m.chainId));
      });
      if (hits.length !== 1) return null;
      const market = hits[0];
      const expiry = Date.parse(market.expiry);
      if (!Number.isFinite(expiry)) return null;
      const result = baseRate(expiry <= Date.now() ? 0 : rate(market.details?.impliedApy), 'pendle官方(PT当前到期APY)');
      // PT yield is the market discount to redemption. Points and YT/LP rewards
      // are not PT interest and are excluded from this route.
      result.rewardState = 'not-applicable';
      return result;
    });
  },
};
