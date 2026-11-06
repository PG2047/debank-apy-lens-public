// DeBank /history/list 旁听响应解析与内存存储。
// 页面数据只在通过严格结构校验后进入时间线；失败静默、绝不补猜。

import { DEBANK_INPUT_LIMITS } from './input-limits';

export interface HistoryTransfer {
  amount: number;
  tokenId: string;
  price: number | null;
  /** 顶层 token_dict 提供的符号;缺失为 null(展示层回落地址缩写) */
  symbol: string | null;
}

export interface HistoryEntry {
  id: string;
  chain: string;
  projectId: string | null;
  cateId: string | null;
  txName: string | null;
  timeAt: number;
  isScam: boolean;
  sends: HistoryTransfer[];
  receives: HistoryTransfer[];
}

export interface HistoryListResult {
  entries: HistoryEntry[];
  /** Rows rejected or omitted by parser work/output limits. */
  droppedRows: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const nonNegativeNumber = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};

const boundedString = (
  value: unknown,
  max: number = DEBANK_INPUT_LIMITS.identifierChars,
): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

function nullableString(value: unknown, max?: number): string | null | undefined {
  // DeBank 对未命名调用会给空串(真机 2026-07-12),等价于无值,不作为整行畸形
  if (value === null || value === '') return null;
  return boundedString(value, max) ?? undefined;
}

function parseTransfer(raw: unknown, symbols: ReadonlyMap<string, string>): HistoryTransfer | null {
  const item = record(raw);
  if (!item) return null;
  const amount = nonNegativeNumber(item.amount);
  const tokenId = boundedString(item.token_id);
  if (amount === null || !tokenId) return null;

  let price: number | null;
  if (item.price === undefined || item.price === null) {
    price = null;
  } else {
    const parsedPrice = finiteNumber(item.price);
    if (parsedPrice === null) return null;
    price = parsedPrice > 0 ? parsedPrice : null;
  }
  return { amount, tokenId, price, symbol: symbols.get(tokenId) ?? null };
}

function parseTransfers(value: unknown, symbols: ReadonlyMap<string, string>): HistoryTransfer[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item) => parseTransfer(item, symbols));
  return parsed.some((item) => item === null)
    ? null
    : parsed as HistoryTransfer[];
}

/** 顶层 data.token_dict(token_id → 元数据)只取 symbol;扫描量有界防 DoS。 */
function parseTokenSymbols(payload: unknown): ReadonlyMap<string, string> {
  const symbols = new Map<string, string>();
  const data = record(record(payload)?.data);
  const dict = data ? record(data.token_dict) : null;
  if (!dict) return symbols;
  let scanned = 0;
  for (const [tokenId, rawToken] of Object.entries(dict)) {
    if (scanned >= DEBANK_INPUT_LIMITS.historyTokenDictEntries) break;
    scanned += 1;
    const token = record(rawToken);
    const symbol = token ? boundedString(token.symbol, DEBANK_INPUT_LIMITS.labelChars) : null;
    if (boundedString(tokenId) && symbol) symbols.set(tokenId, symbol);
  }
  return symbols;
}

function parseEntry(raw: unknown, symbols: ReadonlyMap<string, string>): HistoryEntry | null {
  const item = record(raw);
  if (!item || typeof item.is_scam !== 'boolean' || item.is_scam) return null;

  const id = boundedString(item.id);
  const chain = boundedString(item.chain);
  const projectId = nullableString(item.project_id);
  const cateId = nullableString(item.cate_id);
  const timeAt = nonNegativeNumber(item.time_at);
  const tx = record(item.tx);
  const txName = tx ? nullableString(tx.name, DEBANK_INPUT_LIMITS.labelChars) : undefined;
  const sends = parseTransfers(item.sends, symbols);
  const receives = parseTransfers(item.receives, symbols);
  if (
    !id ||
    !chain ||
    projectId === undefined ||
    cateId === undefined ||
    timeAt === null ||
    txName === undefined ||
    !sends ||
    !receives
  ) return null;

  return {
    id,
    chain,
    projectId,
    cateId,
    txName,
    timeAt,
    isScam: false,
    sends,
    receives,
  };
}

function responseRows(payload: unknown): unknown[] | null {
  const outer = record(payload);
  if (!outer) return null;
  if (Array.isArray(outer.data)) return outer.data;
  const data = record(outer.data);
  return data && Array.isArray(data.history_list) ? data.history_list : null;
}

/** Compatible with both {data:{history_list:[...]}} and {data:[...]}. */
export function parseHistoryList(payload: unknown): HistoryListResult {
  const rows = responseRows(payload);
  const symbols = parseTokenSymbols(payload);
  if (!rows) return { entries: [], droppedRows: 0 };

  // 先在有界原始前缀内完成严格解析，再按时间选出最新合法行；畸形行不能占输出配额。
  const validEntries: Array<{ entry: HistoryEntry; index: number }> = [];
  const inspectedRows = Math.min(rows.length, DEBANK_INPUT_LIMITS.historyInputRows);
  for (let index = 0; index < inspectedRows; index += 1) {
    const entry = parseEntry(rows[index], symbols);
    if (entry) validEntries.push({ entry, index });
  }
  const entries = validEntries
    .sort((a, b) => b.entry.timeAt - a.entry.timeAt || a.index - b.index)
    .slice(0, DEBANK_INPUT_LIMITS.historyRows)
    .map(({ entry }) => entry);
  return {
    entries,
    droppedRows: rows.length - entries.length,
  };
}

function copyEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    sends: entry.sends.map((transfer) => ({ ...transfer })),
    receives: entry.receives.map((transfer) => ({ ...transfer })),
  };
}

export class HistoryStore {
  readonly #entriesByAddress = new Map<string, HistoryListResult>();

  append(address: string, result: Readonly<HistoryListResult>): void {
    const key = address.toLowerCase();
    const current = this.#entriesByAddress.get(key);
    const byId = new Map<string, HistoryEntry>();
    for (const entry of current?.entries ?? []) byId.set(entry.id, entry);
    for (const entry of result.entries) {
      const existing = byId.get(entry.id);
      if (!existing || entry.timeAt > existing.timeAt) byId.set(entry.id, copyEntry(entry));
    }
    const snapshot: HistoryListResult = {
      entries: [...byId.values()]
        .sort((a, b) => b.timeAt - a.timeAt)
        .slice(0, DEBANK_INPUT_LIMITS.historyEntriesPerAddress),
      // This count describes the latest response parse, not the merged timeline;
      // repeated captures must not inflate the same omissions indefinitely.
      droppedRows: result.droppedRows,
    };

    // Refresh insertion order on write, then evict the least-recently-used address.
    this.#entriesByAddress.delete(key);
    this.#entriesByAddress.set(key, snapshot);
    while (this.#entriesByAddress.size > DEBANK_INPUT_LIMITS.historyAddresses) {
      const oldest = this.#entriesByAddress.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entriesByAddress.delete(oldest);
    }
  }

  get(address: string): HistoryListResult {
    const key = address.toLowerCase();
    const snapshot = this.#entriesByAddress.get(key);
    if (!snapshot) return { entries: [], droppedRows: 0 };
    // Reads refresh LRU order without exposing the mutable stored value.
    this.#entriesByAddress.delete(key);
    this.#entriesByAddress.set(key, snapshot);
    return {
      entries: snapshot.entries.map(copyEntry),
      droppedRows: snapshot.droppedRows,
    };
  }
}
