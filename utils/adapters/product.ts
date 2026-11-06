import type { LegQuery } from './types';

/** 只用 DeBank 的产品身份字段分类；纯存款本身不能证明是 savings。 */
export function classifyLendingProduct(query: LegQuery): 'lending' | 'savings' | null {
  if (query.itemHasBorrows) return 'lending';
  const identity = `${query.itemAdapterId ?? ''} ${query.itemName ?? ''}`.toLowerCase();
  if (/saving|savings|vault|redeemable|tokenized/.test(identity)) return 'savings';
  if (/lend|borrow|aave/.test(identity)) return 'lending';
  return null;
}
