// Every EVM network in DeBank's official chain directory, refreshed at build time.
// DeBank internal IDs come from the directory, never guessed from protocol names.
import deployments from './deployments.json';

export interface ChainInfo {
  chainId: number;
  label: string;
  llama: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

export const CHAINS: Record<string, ChainInfo> = Object.fromEntries(
  deployments.chains.map(({ id, ...chain }) => [id, chain]),
);
// Preserve previously accepted aliases; the canonical IDs are mnt and rsk.
CHAINS.mantle = CHAINS.mnt;
CHAINS.rootstock = CHAINS.rsk;

export const CHAIN_BY_ID = new Map(Object.values(CHAINS).map((chain) => [chain.chainId, chain]));

/** Protocol APIs use names as well as numeric IDs. Ambiguous names never resolve. */
const normalizedName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const nameIds = new Map<string, number | null>();
for (const [id, chain] of Object.entries(CHAINS)) {
  for (const name of [id, chain.label, chain.llama]) {
    const key = normalizedName(name);
    const existing = nameIds.get(key);
    nameIds.set(key, existing === undefined || existing === chain.chainId ? chain.chainId : null);
  }
}
for (const [name, id] of [['binance', 56], ['bnb', 56], ['arbitrumone', 42161], ['optimism', 10], ['zksync', 324]] as const) {
  nameIds.set(name, id);
}
export function chainIdFromName(name: unknown): number | undefined {
  if (typeof name !== 'string') return undefined;
  if (/^[1-9]\d*$/.test(name)) {
    const id = Number(name);
    return CHAIN_BY_ID.has(id) ? id : undefined;
  }
  return nameIds.get(normalizedName(name)) ?? undefined;
}
