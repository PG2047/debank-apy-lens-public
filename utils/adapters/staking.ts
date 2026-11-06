import { fnSelector } from '../keccak';
import { rateDiffApy } from './onchain';
import { address, baseRate, numeric, poolAddress, publicJson, rate } from './public-data';
import type { LegQuery, ProtocolAdapter } from './types';

// Official proxy addresses, not implementation contracts or symbol matches.
// https://docs.lido.fi/deployed-contracts/
export const LIDO_TOKENS: Readonly<Record<number, readonly string[]>> = {
  1: ['0xae7ab96520de3a18e5e111b5eaab095312d7fe84', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'],
  10: ['0x1f32b1c2345538c0c6f582fcb022739c4a194ebb', '0x76a50b8c7349ccddb7578c6627e79b5d99d24138'],
  42161: ['0x5979d7b546e38e414f7e9822514be443a4800529'],
  8453: ['0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452'],
};
const RETH = '0xae78736cd615f374d3085123a210448e74fc6393';
const EETH = '0x35fa164735182de50811e8e2e824cfb9b6118ac2';
const WEETH = '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee';

function exactStakingProduct(q: LegQuery, tokens: readonly string[]): boolean {
  if (q.leg !== 'supply' || q.itemHasBorrows) return false;
  const pool = poolAddress(q);
  if (pool && !tokens.includes(pool)) return false;
  const native = ['eth', '0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'].includes(q.address);
  return tokens.includes(address(q.address) ?? '') || (native && pool !== null && tokens.includes(pool));
}

/** An explicitly labeled daily-compounding estimate from the provider's percent APR. */
export function stakingAprToApy(percent: unknown): number | null {
  const apr = numeric(percent);
  return apr === null ? null : rate(Math.expm1(365 * Math.log1p(apr / 100 / 365)));
}

export const lidoAdapter: ProtocolAdapter = {
  name: 'lido',
  matches: (id) => /^([a-z0-9]+_)?lido$/.test(id),
  async resolve(queries, signal) {
    if (!queries.some((q) => exactStakingProduct(q, LIDO_TOKENS[q.chainId] ?? []))) return queries.map(() => null);
    const data = await publicJson<{ data: { smaApr: number }; meta: { chainId: number; address: string } }>(
      'https://eth-api.lido.fi/v1/protocol/steth/apr/sma', signal);
    if (data.meta?.chainId !== 1 || address(data.meta.address) !== LIDO_TOKENS[1][0]) return queries.map(() => null);
    return queries.map((q) => exactStakingProduct(q, LIDO_TOKENS[q.chainId] ?? [])
      ? { ...baseRate(stakingAprToApy(data.data?.smaApr), 'lido官方(7日APR折算APY)'), rewardState: 'not-applicable' } : null);
  },
};

export const rocketPoolAdapter: ProtocolAdapter = {
  name: 'rocket-pool',
  matches: (id) => /^([a-z0-9]+_)?rocket_?pool$/.test(id),
  async resolve(queries, signal) {
    const matched = queries.map((q) => q.chainId === 1 && exactStakingProduct(q, [RETH]));
    if (!matched.some(Boolean)) return queries.map(() => null);
    const data = await publicJson<{ yearlyAPR: string }>('https://api.rocketpool.net/api/apr', signal);
    return matched.map((match) => match
      ? { ...baseRate(stakingAprToApy(data.yearlyAPR), 'rocket-pool官方(APR折算APY)'), rewardState: 'not-applicable' } : null);
  },
};

export const etherfiAdapter: ProtocolAdapter = {
  name: 'etherfi',
  matches: (id) => /^([a-z0-9]+_)?etherfi$/.test(id),
  async resolve(queries, signal) {
    const matched = queries.map((q) => q.chainId === 1 && exactStakingProduct(q, [EETH, WEETH]));
    if (!matched.some(Boolean)) return queries.map(() => null);
    const apy = await rateDiffApy(1, WEETH, fnSelector('getRate()'), signal);
    return matched.map((match) => match ? baseRate(apy, 'etherfi链上(24小时份额增长APY)') : null);
  },
};
