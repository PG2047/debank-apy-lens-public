import type { LegQuery } from './adapters/types';
import type { ProtocolPosition, TokenLeg } from './debank';

export interface LegBinding {
  itemIdx: number;
  leg: 'supply' | 'borrow';
  token: TokenLeg;
}

function stablePositionKey(position: ProtocolPosition, itemIdx: number): string {
  const item = position.items[itemIdx];
  return [
    position.chain,
    position.protocolId,
    item.adapterId ?? '',
    item.poolId ?? '',
    item.positionIndex ?? '',
    String(itemIdx),
  ]
    .map(encodeURIComponent)
    .join('/');
}

/** 将 DeBank item 展开成腿时，仍在每条腿上保留完整 item 身份与全部资产集合。 */
export function buildLegQueries(
  position: ProtocolPosition,
  chainId: number,
  userAddress?: string,
): { queries: LegQuery[]; legs: LegBinding[] } {
  const queries: LegQuery[] = [];
  const legs: LegBinding[] = [];

  position.items.forEach((item, itemIdx) => {
    const itemHasBorrows = item.borrows.length > 0;
    const itemSupplyAddresses = item.supplies.map((token) => token.address);
    const itemBorrowAddresses = item.borrows.map((token) => token.address);
    const context = {
      protocolId: position.protocolId,
      positionKey: stablePositionKey(position, itemIdx),
      itemName: item.poolDesc ?? item.itemName,
      itemAdapterId: item.adapterId,
      itemPoolId: item.poolId,
      itemSupplyAddresses,
      itemBorrowAddresses,
      itemSupplies: item.supplies.map(({ address, amount, usd, priceUsd, decimals }) => ({
        address,
        amount,
        usd,
        priceUsd,
        decimals,
      })),
      itemBorrows: item.borrows.map(({ address, amount, usd, priceUsd, decimals }) => ({
        address,
        amount,
        usd,
        priceUsd,
        decimals,
      })),
      positionIndex: item.positionIndex,
      itemRewardTokens: item.rewards.map((reward) => reward.address),
      itemRewards: item.rewards.map(({ address, symbol, amount, usd, priceUsd, decimals }) => ({
        address,
        symbol,
        amount,
        usd,
        priceUsd,
        decimals,
      })),
    };

    for (const token of item.supplies) {
      queries.push({
        chainId,
        address: token.address,
        leg: 'supply',
        itemHasBorrows,
        userAddress,
        ...context,
      });
      legs.push({ itemIdx, leg: 'supply', token });
    }
    for (const token of item.borrows) {
      queries.push({
        chainId,
        address: token.address,
        leg: 'borrow',
        itemHasBorrows,
        userAddress,
        ...context,
      });
      legs.push({ itemIdx, leg: 'borrow', token });
    }
  });

  return { queries, legs };
}
