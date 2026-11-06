import { chainIdFromName } from '../chains';
import { address, baseRate, numeric, poolAddress, publicJson, rate } from './public-data';
import type { ProtocolAdapter } from './types';

interface BeefyVault {
  id: string; chain: string; status: string; type: string;
  earnContractAddress: string; earnedTokenAddress: string;
}

export const beefyAdapter: ProtocolAdapter = {
  name: 'beefy',
  matches: (id) => /^([a-z0-9]+_)?beefy$/.test(id),
  async resolve(queries, signal) {
    const [vaults, apys] = await Promise.all([
      // The full official catalog includes retired vaults and currently exceeds 4 MB.
      publicJson<BeefyVault[]>('https://api.beefy.finance/vaults', signal, 8 * 1024 * 1024),
      publicJson<Record<string, { totalApy?: number }>>('https://api.beefy.finance/apy/breakdown', signal),
    ]);
    return queries.map((q) => {
      if (q.leg !== 'supply' || q.itemHasBorrows) return null;
      const pool = poolAddress(q);
      const hits = vaults.filter((v) => chainIdFromName(v.chain) === q.chainId &&
        v.status === 'active' && v.type === 'standard' &&
        (pool ? [address(v.earnContractAddress), address(v.earnedTokenAddress)].includes(pool)
          : address(v.earnedTokenAddress) === address(q.address)));
      if (hits.length !== 1) return null;
      // This is the net composite vault APY, including compounded strategy rewards.
      // Do not add its component APRs or the underlying token's yield again.
      return baseRate(rate(apys[hits[0].id]?.totalApy), 'beefy官方(金库综合APY)');
    });
  },
};

interface YearnVault {
  address: string; chainID: number;
  info?: { isRetired?: boolean };
  token?: { address?: string; underlyingTokensAddresses?: string[] };
  apr?: { pricePerShare?: { today?: number; weekAgo?: number } };
}

export const YEARN_CHAINS = [1, 10, 137, 8453, 42161, 747474] as const;

export const yearnAdapter: ProtocolAdapter = {
  name: 'yearn',
  matches: (id) => /^([a-z0-9]+_)?yearn(?:_?v?[23])?$/.test(id),
  async resolve(queries, signal) {
    // Query exact vaults; no token-name lookup or truncated all-vault catalog.
    const ids = [...new Set(queries.filter((q) => q.leg === 'supply' && !q.itemHasBorrows &&
      (YEARN_CHAINS as readonly number[]).includes(q.chainId))
      .map((q) => `${q.chainId}/${poolAddress(q) ?? address(q.address)}`).filter((id) => !id.endsWith('/null')))];
    const responses = await Promise.allSettled(ids.map((id) => publicJson<YearnVault>(`https://ydaemon.yearn.fi/${id.split('/')[0]}/vaults/${id.split('/')[1]}`, signal)));
    signal?.throwIfAborted();
    const vaults = new Map(responses.flatMap((r, i) => r.status === 'fulfilled' ? [[ids[i], r.value] as const] : []));
    return queries.map((q) => {
      if (q.leg !== 'supply' || q.itemHasBorrows) return null;
      const identity = poolAddress(q) ?? address(q.address);
      const v = vaults.get(`${q.chainId}/${identity}`);
      if (!v || v.chainID !== q.chainId || address(v.address) !== identity || v.info?.isRetired) return null;
      const accepted = [address(v.address), address(v.token?.address), ...(v.token?.underlyingTokensAddresses ?? []).map(address)];
      if (!address(q.address) || !accepted.includes(address(q.address))) return null;
      const today = numeric(v.apr?.pricePerShare?.today);
      const previous = numeric(v.apr?.pricePerShare?.weekAgo);
      const apy = today !== null && previous !== null && today > 0 && previous > 0
        ? rate(Math.expm1(Math.log(today / previous) * 365 / 7)) : null;
      // Share-price growth is already net of vault fees and harvested rewards.
      return baseRate(apy, 'yearn官方(7日份额增长APY)');
    });
  },
};
