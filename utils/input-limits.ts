/**
 * Hard work budgets for page-controlled DeBank payloads.
 *
 * The page bridge has a byte limit, but bytes alone do not bound collection
 * fan-out or privileged RPC work. These limits are deliberately shared by the
 * parser and the worker/RPC boundaries so every accepted payload has a finite
 * worst-case cost.
 */
export const DEBANK_INPUT_LIMITS = Object.freeze({
  // A live 33-chain wallet returned 96 projects. Keep the project scan bounded,
  // but let the stricter global item/leg budgets remain the actual work ceiling.
  projects: 128,
  itemsPerProject: 32,
  totalItems: 256,
  principalLegsPerItem: 32,
  totalPrincipalLegs: 512,
  rewardLegsPerItem: 32,
  totalRewardLegs: 512,
  /** Raw history rows inspected before structural validation. */
  historyInputRows: 1_000,
  historyRows: 200,
  historyEntriesPerAddress: 100,
  historyAddresses: 8,
  historyMessagesPerWindow: 5,
  historyRateWindowMs: 5_000,
  /** token_dict entries scanned for symbol lookup. */
  historyTokenDictEntries: 2_000,
  adapterQueriesPerCard: 128,
  skyQueriesPerEnrichment: 128,
  /** Sky farm contracts admitted across one batched enrichment. */
  skyExactFarmsPerEnrichment: 32,
  skyInventoryFarmsPerChain: 64,
  lpPositionsPerCard: 32,
  rpcCallsPerBatch: 256,
  identifierChars: 256,
  /** Opaque DeBank position identity; protocol adapters may use composite keys. */
  positionIdentityChars: 256,
  labelChars: 512,
  /** Numeric LP token ids remain independently restricted to uint256 decimal form. */
  uint256DecimalChars: 78,
} as const);

export class InputLimitError extends Error {
  constructor(readonly boundary: string, readonly limit: number) {
    super(`${boundary} exceeds hard limit ${limit}`);
    this.name = 'InputLimitError';
  }
}
