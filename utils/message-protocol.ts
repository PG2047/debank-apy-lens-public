/** Shared, versioned boundary between MAIN-world capture, the isolated bridge, and the worker. */
import type { CaptureRejectionReason } from './input-boundary';
import { isCaptureSequence, type CaptureSequence } from './capture-sequence';

export const DAL_MESSAGE_MARK = '__debank_apy_lens__' as const;
export const DAL_MESSAGE_VERSION = 5 as const;

export type EnrichRequestId = string;

export interface DeBankRequestCapture {
  readonly url: string;
  readonly requestAddress: string | undefined;
  readonly captureSequence: CaptureSequence;
}

export interface DeBankResponseMessage {
  readonly [DAL_MESSAGE_MARK]: true;
  readonly version: typeof DAL_MESSAGE_VERSION;
  readonly kind: 'debank-response';
  readonly url: string;
  readonly requestAddress: string | undefined;
  readonly captureSequence: CaptureSequence;
  readonly data: unknown;
}

export interface DeBankCaptureRejectedMessage {
  readonly [DAL_MESSAGE_MARK]: true;
  readonly version: typeof DAL_MESSAGE_VERSION;
  readonly kind: 'debank-response-rejected';
  readonly url: string;
  readonly requestAddress: string | undefined;
  readonly captureSequence: CaptureSequence;
  readonly reason: CaptureRejectionReason;
}

export interface DeBankReplayRequestMessage {
  readonly [DAL_MESSAGE_MARK]: true;
  readonly version: typeof DAL_MESSAGE_VERSION;
  readonly kind: 'debank-replay-request';
  readonly requestAddress: string;
}

export interface EnrichRequestMessage {
  readonly type: 'dal:enrich';
  readonly version: typeof DAL_MESSAGE_VERSION;
  readonly requestId: EnrichRequestId;
  readonly url: string;
  readonly data: unknown;
  readonly address: string;
}

export interface CancelEnrichMessage {
  readonly type: 'dal:cancel';
  readonly version: typeof DAL_MESSAGE_VERSION;
  readonly requestId: EnrichRequestId;
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isEnrichRequestId(value: unknown): value is EnrichRequestId {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function normalizeProfileAddress(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function profileAddressFromPath(pathname: string): string | undefined {
  return normalizeProfileAddress((pathname.match(/(?:^|\/)profile\/(0x[0-9a-fA-F]{40})(?:\/|$)/) ?? [])[1]);
}

export function resolveRequestUrl(input: unknown, baseUrl: string): string {
  try {
    if (typeof input === 'string') return new URL(input, baseUrl).href;
    if (input instanceof Request) return input.url;
    if (input instanceof URL) return input.href;
  } catch {
    /* invalid input */
  }
  return '';
}

/** 请求时快照 pathname 身份(仅当响应 URL 不带地址参数时作回退;归属裁决见 capturedMessageAddressForProfile)。 */
export function captureDeBankRequest(
  input: unknown,
  baseUrl: string,
  pathname: string,
  captureSequence: unknown,
): DeBankRequestCapture | undefined {
  const url = resolveRequestUrl(input, baseUrl);
  if (!isAcceptedDeBankApiUrl(url) || !isCaptureSequence(captureSequence)) return undefined;
  return Object.freeze({
    url,
    requestAddress: profileAddressFromPath(pathname),
    captureSequence,
  });
}

export function createDeBankResponseMessage(
  capture: DeBankRequestCapture,
  data: unknown,
): DeBankResponseMessage {
  return Object.freeze({
    [DAL_MESSAGE_MARK]: true,
    version: DAL_MESSAGE_VERSION,
    kind: 'debank-response',
    url: capture.url,
    requestAddress: capture.requestAddress,
    captureSequence: capture.captureSequence,
    data,
  });
}

export function createDeBankCaptureRejectedMessage(
  capture: DeBankRequestCapture,
  reason: CaptureRejectionReason,
): DeBankCaptureRejectedMessage {
  return Object.freeze({
    [DAL_MESSAGE_MARK]: true,
    version: DAL_MESSAGE_VERSION,
    kind: 'debank-response-rejected',
    url: capture.url,
    requestAddress: capture.requestAddress,
    captureSequence: capture.captureSequence,
    reason,
  });
}

export function createDeBankReplayRequestMessage(
  requestAddress: unknown,
): DeBankReplayRequestMessage | undefined {
  const normalized = normalizeProfileAddress(requestAddress);
  if (!normalized) return undefined;
  return Object.freeze({
    [DAL_MESSAGE_MARK]: true,
    version: DAL_MESSAGE_VERSION,
    kind: 'debank-replay-request',
    requestAddress: normalized,
  });
}

export function isAcceptedDeBankApiUrl(raw: unknown): raw is string {
  return isProjectListUrl(raw) || isHistoryListUrl(raw);
}

function isProjectListUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'api.debank.com' &&
      url.pathname === '/portfolio/project_list';
  } catch {
    return false;
  }
}

export function isHistoryListUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'api.debank.com' &&
      url.pathname === '/history/list';
  } catch {
    return false;
  }
}

export function isDeBankResponseMessage(value: unknown): value is DeBankResponseMessage {
  const message = value as Partial<DeBankResponseMessage> | null;
  return Boolean(
    message &&
    (message as Record<string, unknown>)[DAL_MESSAGE_MARK] === true &&
    message.version === DAL_MESSAGE_VERSION &&
    message.kind === 'debank-response' &&
    isAcceptedDeBankApiUrl(message.url) &&
    isCaptureSequence(message.captureSequence) &&
    Object.prototype.hasOwnProperty.call(message, 'requestAddress') &&
    (message.requestAddress === undefined || normalizeProfileAddress(message.requestAddress) !== undefined),
  );
}

export function isDeBankCaptureRejectedMessage(value: unknown): value is DeBankCaptureRejectedMessage {
  const message = value as Partial<DeBankCaptureRejectedMessage> | null;
  return Boolean(
    message &&
    (message as Record<string, unknown>)[DAL_MESSAGE_MARK] === true &&
    message.version === DAL_MESSAGE_VERSION &&
    message.kind === 'debank-response-rejected' &&
    isAcceptedDeBankApiUrl(message.url) &&
    isCaptureSequence(message.captureSequence) &&
    Object.prototype.hasOwnProperty.call(message, 'requestAddress') &&
    (message.requestAddress === undefined || normalizeProfileAddress(message.requestAddress) !== undefined) &&
    (message.reason === 'payload-too-large' || message.reason === 'malformed-payload'),
  );
}

export function isDeBankReplayRequestMessage(value: unknown): value is DeBankReplayRequestMessage {
  const message = value as Partial<DeBankReplayRequestMessage> | null;
  return Boolean(
    message &&
    (message as Record<string, unknown>)[DAL_MESSAGE_MARK] === true &&
    message.version === DAL_MESSAGE_VERSION &&
    message.kind === 'debank-replay-request' &&
    normalizeProfileAddress(message.requestAddress) === message.requestAddress,
  );
}

export type DeclaredUrlIdentity =
  | { state: 'absent' }
  | { state: 'valid'; address: string }
  | { state: 'invalid' };

const IDENTITY_KEYS = new Set(['id', 'user_addr']);

/**
 * 三态解析请求 URL 的身份声明(codex-review 2026-07-12 中危 finding 的修复):
 *   absent  = URL 完全不含身份参数(且无任何身份别名键)→ 允许回退 pathname 快照
 *   valid   = 恰好通过标准键(id/user_addr)声明了唯一合法地址
 *   invalid = 存在身份参数但非法/互相矛盾,或出现别名键(ID、id[]、User_Addr…)
 * invalid 一律拒收、绝不回退——「存在但非法」若被当成「不存在」,解析差异就可能把
 * A 的数据归属到 B(?id=垃圾 会退回旧 pathname 快照)。别名键单独判 invalid 是为了
 * 消除与服务端参数解析的差异面:我们不猜服务端认不认 ID=/id[]=。
 */
export function declaredRequestUrlAddress(raw: string): DeclaredUrlIdentity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { state: 'invalid' };
  }
  const values: string[] = [];
  let present = false;
  for (const [key, value] of url.searchParams) {
    if (IDENTITY_KEYS.has(key)) {
      present = true;
      values.push(value);
      continue;
    }
    // 别名形态:身份词后跟任意 bracket 段(id[0]、id[][]、user_addr[wallet]…)或大小写变体。
    // 只要参数名去掉 bracket 修饰后命中身份词,一律 invalid(复核 2026-07-12 补钉:剥一次 [] 不够)
    if (/^(id|user_addr)(\[[^\]]*\])*$/i.test(key)) return { state: 'invalid' };
  }
  if (!present) return { state: 'absent' };
  const normalized = values.map((value) => normalizeProfileAddress(value));
  const first = normalized[0];
  if (!first || normalized.some((address) => address !== first)) return { state: 'invalid' };
  return { state: 'valid', address: first };
}

/**
 * 重放缓存键:身份沿用与归属裁决同一套规则(URL 声明优先,absent 才用请求时快照;
 * invalid 不缓存),并按端点分槽——防止 history 响应覆盖同地址的 project_list
 * (codex-review 2026-07-12 高危 finding:单槽缓存下 BFCache 重放只能拿到 history,
 * APY 永久停在等待)。
 */
export function replayCacheKey(
  entry: { url: string; requestAddress: string | undefined },
): string | undefined {
  const declared = declaredRequestUrlAddress(entry.url);
  const identity = declared.state === 'valid'
    ? declared.address
    : declared.state === 'absent'
      ? normalizeProfileAddress(entry.requestAddress)
      : undefined;
  if (!identity) return undefined;
  return `${identity}:${isHistoryListUrl(entry.url) ? 'history' : 'project'}`;
}

/** 桥接按地址请求重放时的全部候选槽(project 优先,history 随后)。 */
export function replayCacheKeysForAddress(address: string): string[] {
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return [];
  return [`${normalized}:project`, `${normalized}:history`];
}

/**
 * 响应归属裁决:数据只能渲染给「它自己声明的地址」,且该地址必须等于用户此刻正在看的地址。
 * 身份优先级:
 *   ① 请求 URL 中唯一且一致的 id/user_addr 参数(响应自带身份)——对 SPA 竞态免疫;
 *   ② URL 不带身份参数时,退回请求发出时的 pathname 快照(requestAddress)。
 * 为什么这样改(2026-07-12 真机破案):DeBank 在 SPA 切换地址时,project_list 常在路由更新
 * pathname **之前**发出——请求时快照还是旧地址(或搜索页上根本没有地址),旧规则一律拒收;
 * 而同一地址本会话不会再自发重发,状态栏从此永远停在「等待页面数据」。
 * 以「URL 声明身份 === 当前视图地址」作准,安全性质不变:A 地址的数据绝不会渲染到 B 地址
 * 的页面上(声明身份与当前视图不等即拒收);URL 携带多个互相矛盾的地址参数视为可疑,直接
 * 拒收、不回退快照。
 */
export function capturedMessageAddressForProfile(
  message: Pick<DeBankResponseMessage | DeBankCaptureRejectedMessage, 'url' | 'requestAddress'>,
  viewedAddress: unknown,
): string | undefined {
  const currentAddress = normalizeProfileAddress(viewedAddress);
  if (!currentAddress) return undefined;
  const declared = declaredRequestUrlAddress(message.url);
  if (declared.state === 'invalid') return undefined; // 存在但非法/歧义/别名键 → 拒收,绝不回退
  if (declared.state === 'valid') {
    return declared.address === currentAddress ? currentAddress : undefined;
  }
  const requestAddress = normalizeProfileAddress(message.requestAddress);
  if (!requestAddress || requestAddress !== currentAddress) return undefined;
  return requestAddress;
}

/**
 * Build the worker request only when the response's declared wallet equals the currently viewed
 * wallet(见 capturedMessageAddressForProfile:URL 身份优先,pathname 快照仅作无参数时的回退)。
 */
export function createEnrichRequestForProfile(
  message: DeBankResponseMessage,
  viewedAddress: unknown,
  requestId: unknown,
  safeData: unknown = message.data,
): EnrichRequestMessage | undefined {
  const requestAddress = capturedMessageAddressForProfile(message, viewedAddress);
  if (!requestAddress || !isEnrichRequestId(requestId) || !isProjectListUrl(message.url)) return undefined;
  return {
    type: 'dal:enrich',
    version: DAL_MESSAGE_VERSION,
    requestId,
    url: message.url,
    data: safeData,
    address: requestAddress,
  };
}

export function createCancelEnrichMessage(requestId: EnrichRequestId): CancelEnrichMessage {
  return {
    type: 'dal:cancel',
    version: DAL_MESSAGE_VERSION,
    requestId,
  };
}

/** Post-worker guard for both a newer message and an SPA address transition. */
export function isCurrentEnrichRequest(
  requestGeneration: number,
  currentGeneration: number,
  requestAddress: unknown,
  viewedAddress: unknown,
): boolean {
  const request = normalizeProfileAddress(requestAddress);
  const current = normalizeProfileAddress(viewedAddress);
  return requestGeneration === currentGeneration && request !== undefined && request === current;
}

export function isEnrichRequestMessage(value: unknown): value is EnrichRequestMessage {
  const message = value as Partial<EnrichRequestMessage> | null;
  return Boolean(
    message &&
    message.type === 'dal:enrich' &&
    message.version === DAL_MESSAGE_VERSION &&
    isEnrichRequestId(message.requestId) &&
    isProjectListUrl(message.url) &&
    normalizeProfileAddress(message.address) !== undefined,
  );
}

export function isCancelEnrichMessage(value: unknown): value is CancelEnrichMessage {
  const message = value as Partial<CancelEnrichMessage> | null;
  return Boolean(
    message &&
    message.type === 'dal:cancel' &&
    message.version === DAL_MESSAGE_VERSION &&
    isEnrichRequestId(message.requestId),
  );
}
