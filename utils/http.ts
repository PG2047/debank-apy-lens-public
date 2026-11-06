const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_RESPONSE_CHUNKS = 4_096;

let activeRequests = 0;
const waiters: Array<() => void> = [];

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function releaseSlot(): void {
  activeRequests -= 1;
  waiters.shift()?.();
}

async function acquireSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      signal.removeEventListener('abort', aborted);
      activeRequests += 1;
      resolve();
    };
    const aborted = () => {
      const index = waiters.indexOf(ready);
      if (index >= 0) waiters.splice(index, 1);
      reject(abortReason(signal));
    };
    waiters.push(ready);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function abortRace(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

function byteLimitError(maxBytes: number): RangeError {
  return new RangeError(`Response body exceeds ${maxBytes} byte limit`);
}

async function consumeBoundedResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  aborted: Promise<never>,
): Promise<Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Invalid response byte limit');
  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = byteLimitError(maxBytes);
    void response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  const cancelReader = () => {
    void reader.cancel(abortReason(signal)).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      chunkCount += 1;
      if (chunkCount > MAX_RESPONSE_CHUNKS) {
        const error = new RangeError(`Response body exceeds ${MAX_RESPONSE_CHUNKS} chunk limit`);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        const error = byteLimitError(maxBytes);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream may keep read() pending after cancel; the request
      // boundary still releases its slot because the underlying fetch was aborted.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(total === 0 ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Shared source boundary. The four-request slot and timeout remain active until
 * the complete response body has been consumed within the byte budget.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  const forwardAbort = () => controller.abort(upstream ? abortReason(upstream) : undefined);
  if (upstream?.aborted) forwardAbort();
  else upstream?.addEventListener('abort', forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortBoundary: ReturnType<typeof abortRace> | undefined;
  let acquired = false;
  try {
    await acquireSlot(controller.signal);
    acquired = true;
    // Queue time is governed by the caller/card deadline. Give every source its
    // full transport/body budget only after it owns a shared HTTP slot.
    timer = setTimeout(
      () => controller.abort(new DOMException(`Source timed out after ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs,
    );
    abortBoundary = abortRace(controller.signal);
    const response = await Promise.race([
      globalThis.fetch(input, { ...init, signal: controller.signal }),
      abortBoundary.promise,
    ]);
    return await consumeBoundedResponse(response, controller.signal, maxBytes, abortBoundary.promise);
  } finally {
    if (timer) clearTimeout(timer);
    abortBoundary?.dispose();
    upstream?.removeEventListener('abort', forwardAbort);
    if (acquired) releaseSlot();
  }
}

export type DeadlineWork<T> = Promise<T> | ((signal: AbortSignal) => Promise<T>);

/**
 * Bound a whole enrichment unit. Callback form is cancellable and is required
 * for source/card/navigation work; Promise form remains only for compatibility.
 */
export async function withDeadline<T>(
  work: DeadlineWork<T>,
  timeoutMs: number,
  label: string,
  upstream?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(upstream ? abortReason(upstream) : undefined);
  if (upstream?.aborted) forwardAbort();
  else upstream?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException(`${label} timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  );
  const abortBoundary = abortRace(controller.signal);
  try {
    const promise = typeof work === 'function' ? work(controller.signal) : work;
    return await Promise.race([promise, abortBoundary.promise]);
  } finally {
    clearTimeout(timer);
    abortBoundary.dispose();
    upstream?.removeEventListener('abort', forwardAbort);
  }
}
