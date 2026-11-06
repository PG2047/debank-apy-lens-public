// Lista DAO 适配器。关键事实（2026-07-08 真机验证）：
//   - DeBank 协议 id 是 **bsc_helio**（Lista 前身 Helio Protocol），不是 lista
//   - 金库仓位 adapter_id = redeemable_tokenized_vault_yield，pool.id = ERC-4626 vault 地址
//     （如 Lorenzo Exclusive USD1 Vault 0xbe87beb6…）→ 走 erc4626 24h 差分引擎
//   - 借贷仓位 adapter_id = morpho_blue_lending2，pool.id = "0x8f73b65b…:lending"
//     → Lista Moolah 是 Morpho Blue fork，链上标准三件套读利率
//   - Binance Web3 Wallet 专属补贴记账在币安内部，任何外部渠道都取不到——不显示、不猜

import { erc4626Apy, listaVaultInfo, moolahRates, type ListaVaultInfo } from './onchain';
import { normalizeRewardCoverage, type LegQuery, type LegRates, type ProtocolAdapter } from './types';

const addrOf = (poolId: string | undefined): string | undefined => {
  const m = (poolId ?? '').toLowerCase().match(/^(0x[0-9a-f]{40})/);
  return m ? m[1] : undefined;
};

export function composeListaVaultRates(
  pool: string,
  realizedApy: number | null,
  info: ListaVaultInfo | undefined,
): LegRates | null {
  const baseApy = realizedApy ?? info?.apy ?? null;
  const rewardApr = info?.emissionApy ?? null;
  if (baseApy === null && rewardApr === null) return null;
  const rewardState = info?.emissionState ?? 'unknown';
  const reward = normalizeRewardCoverage({
    rewardApr,
    rewardState,
    rewardComponents:
      rewardState === 'numeric-known' && rewardApr !== null
        ? [
            {
              id: `lista:${pool}:emission`,
              value: rewardApr,
              rateKind: 'apy',
              source: 'lista-api',
              basis: 'vault',
              observedAt: Date.now(),
            },
          ]
        : [],
  });
  return {
    baseApy,
    ...reward,
    source:
      realizedApy !== null && info
        ? 'erc4626(24h实现) + lista-api奖励'
        : realizedApy !== null
          ? 'erc4626(24h实现)'
          : 'lista-api',
  };
}

export const listaAdapter: ProtocolAdapter = {
  name: 'lista',
  matches: (id) => /^([a-z0-9]+_)?(lista(dao)?|helio)$/.test(id),
  async resolve(queries: LegQuery[], signal?: AbortSignal): Promise<(LegRates | null)[]> {
    const moolahLoads = new Map<string, ReturnType<typeof moolahRates>>();
    return Promise.all(
      queries.map(async (q) => {
        const adapterId = q.itemAdapterId ?? '';
        const pool = addrOf(q.itemPoolId);

        // ERC-4626 金库（Lorenzo / Pangolins / Gauntlet 系）——只有 supply 腿。
        // 首选链上 24h 差分（需归档 RPC，publicnode 免费层会 403）；失败降级 Lista 官方 API 的 apy
        if (adapterId.includes('tokenized_vault') && pool && q.leg === 'supply') {
          const [realizedApy, info] = await Promise.all([
            erc4626Apy(q.chainId, pool, signal),
            listaVaultInfo(pool, signal),
          ]);
          return composeListaVaultRates(pool, realizedApy, info);
        }

        // Moolah 借贷（Morpho Blue fork）
        if (adapterId.includes('morpho_blue') && pool) {
          const opposite =
            q.leg === 'borrow'
              ? [...new Set((q.itemSupplyAddresses ?? []).map((a) => a.toLowerCase()))]
              : [...new Set((q.itemBorrowAddresses ?? []).map((a) => a.toLowerCase()))];
          if (opposite.length !== 1) return null;
          const loanToken = q.leg === 'borrow' ? q.address : opposite[0];
          const collateralToken = q.leg === 'borrow' ? opposite[0] : q.address;
          const cacheKey = `${q.chainId}:${pool}:${loanToken}:${collateralToken}:${q.userAddress ?? ''}`;
          let load = moolahLoads.get(cacheKey);
          if (!load) {
            load = moolahRates(
              q.chainId,
              pool,
              loanToken,
              collateralToken,
              q.userAddress,
              signal,
            );
            moolahLoads.set(cacheKey, load);
          }
          const r = await load;
          if (!r) return null;
          if (q.leg === 'borrow') {
            const reward = normalizeRewardCoverage({
              rewardApr: r.borrowRewardApy,
              rewardState: r.borrowRewardState,
              rewardComponents:
                r.borrowRewardState === 'numeric-known' && r.borrowRewardApy !== null
                  ? [{
                      id: `lista:${r.marketId}:borrow-emission`,
                      value: r.borrowRewardApy,
                      rateKind: 'apy',
                      source: 'lista-market-api',
                      sourceUrl: `https://api.lista.org/api/moolah/market/${r.marketId}`,
                      basis: 'borrow',
                      observedAt: Date.now(),
                    }]
                  : [],
            });
            return {
              baseApy: r.borrowApy,
              ...reward,
              source: `moolah链上 + lista-market-api(${r.marketId})`,
            };
          }
          // supply 腿在 Morpho 语义里是抵押品，不生息（利息归 vault/市场出借人）
          return {
            baseApy: 0,
            rewardApr: r.collateralRewardState === 'confirmed-zero' ? 0 : null,
            rewardState: r.collateralRewardState,
            rewardComponents: [],
            rewardEntitlements: r.points.map((point) => ({
              id: `lista:${r.marketId}:${point.name}:${point.multiplier}`,
              label: `${point.name} 积分`,
              display: `${point.multiplier} ${point.name}`,
              source: 'https://lista.org/lending',
              basis: 'collateral',
              verification: 'index-confirmed',
              category: 'points',
              notes: [
                'Lista 官方市场当前列出该积分倍数。',
                '积分不折算成 APY，也不进入净收益或今日小计。',
              ],
              observedAt: Date.now(),
            })),
            source: `moolah抵押品(不生息) + lista-market-api(${r.marketId})`,
          };
        }

        return null;
      }),
    );
  },
};
