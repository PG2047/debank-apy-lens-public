// 用户设置：自定义 RPC 端点（chrome.storage.sync，跨设备同步）。
// 空/非法 URL → 回落内置 publicnode 默认。所有链上读取（Uniswap 区间等）统一走这里解析。

export type RpcOverrides = Record<string, string>; // chainId(字符串) → RPC URL

const KEY = 'dal:rpcOverrides';
let cache: { at: number; v: RpcOverrides } | null = null;
const TTL_MS = 30 * 1000;

export function validRpcUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 校验设置值：允许单个 URL 或逗号分隔多个（轮转） */
export function validRpcValue(v: string): boolean {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(validRpcUrl);
}

export async function getRpcOverrides(): Promise<RpcOverrides> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v;
  try {
    const o = await browser.storage.sync.get(KEY);
    const raw = (o?.[KEY] ?? {}) as Record<string, unknown>;
    const v: RpcOverrides = {};
    for (const [k, u] of Object.entries(raw)) {
      if (typeof u === 'string' && validRpcUrl(u)) v[k] = u;
    }
    cache = { at: Date.now(), v };
    return v;
  } catch {
    return {}; // storage 不可用（如测试环境）→ 全部走默认
  }
}

export async function setRpcOverride(chainId: number, url: string): Promise<void> {
  const cur = await getRpcOverrides();
  const next: RpcOverrides = { ...cur };
  const trimmed = url.trim();
  if (trimmed) next[String(chainId)] = trimmed;
  else delete next[String(chainId)];
  await browser.storage.sync.set({ [KEY]: next });
  cache = null;
}

// 轮转计数器（每链独立）：设置里可填逗号分隔的多个 RPC，逐请求轮换分摊配额
const rrCounter = new Map<string, number>();

/** 解析某链的 RPC：用户覆盖（支持逗号分隔多个，轮转）→ 无则 undefined 由调用方回落默认 */
export async function pickRpc(chainId: number): Promise<string | undefined> {
  const overrides = await getRpcOverrides();
  const raw = overrides[String(chainId)];
  if (!raw) return undefined;
  const urls = raw.split(',').map((s) => s.trim()).filter((s) => validRpcUrl(s));
  if (urls.length === 0) return undefined;
  const n = rrCounter.get(String(chainId)) ?? 0;
  rrCounter.set(String(chainId), n + 1);
  return urls[n % urls.length];
}
