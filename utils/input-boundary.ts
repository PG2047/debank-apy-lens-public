export const CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const CAPTURE_MAX_JSON_CHARS = 2 * 1024 * 1024;
export const CAPTURE_MAX_STREAM_CHUNKS = 4_096;
export const CAPTURE_MAX_NODES = 50_000;
export const CAPTURE_MAX_CONTAINER_ENTRIES = 10_000;
export const CAPTURE_MAX_DEPTH = 64;

export type CaptureRejectionReason = 'payload-too-large' | 'malformed-payload';

export class CaptureBoundaryError extends Error {
  constructor(
    readonly reason: CaptureRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureBoundaryError';
  }
}

function reject(reason: CaptureRejectionReason, message: string): never {
  throw new CaptureBoundaryError(reason, message);
}

export function captureRejectionReason(error: unknown): CaptureRejectionReason {
  return error instanceof CaptureBoundaryError ? error.reason : 'malformed-payload';
}

/** XHR boundary: reject by string length before JSON.parse can allocate a large object graph. */
export function parseBoundedJsonText(text: string, maxChars = CAPTURE_MAX_JSON_CHARS): unknown {
  if (text.length > maxChars) reject('payload-too-large', `JSON text exceeds ${maxChars} characters`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return reject('malformed-payload', 'Response is not valid JSON');
  }
}

/** Fetch boundary: keep the clone reader bounded through EOF instead of calling unbounded json()/text(). */
export async function readBoundedJsonResponse(
  response: Response,
  maxBytes = CAPTURE_MAX_BYTES,
  maxChunks = CAPTURE_MAX_STREAM_CHUNKS,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    const error = new CaptureBoundaryError('payload-too-large', `Content-Length exceeds ${maxBytes} bytes`);
    try {
      await response.body?.cancel(error);
    } catch {
      /* cancellation is best-effort */
    }
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) reject('malformed-payload', 'Response body is unavailable');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let chunkCount = 0;
  const textChunks: string[] = [];
  let reachedEof = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      if (!value?.byteLength) continue;
      chunkCount += 1;
      if (chunkCount > maxChunks) reject('payload-too-large', `Response exceeds ${maxChunks} stream chunks`);
      bytes += value.byteLength;
      if (bytes > maxBytes) reject('payload-too-large', `Response exceeds ${maxBytes} bytes`);
      const decoded = decoder.decode(value, { stream: true });
      if (decoded) textChunks.push(decoded);
    }
    const tail = decoder.decode();
    if (tail) textChunks.push(tail);
    return parseBoundedJsonText(textChunks.join(''), maxBytes);
  } catch (error) {
    if (!reachedEof) {
      try {
        await reader.cancel(error);
      } catch {
        /* cancellation is best-effort */
      }
    }
    if (error instanceof CaptureBoundaryError) throw error;
    return reject('malformed-payload', 'Response body could not be decoded');
  } finally {
    reader.releaseLock();
  }
}

export interface BoundedJsonResult {
  readonly value: unknown;
  readonly serialized: string;
}

export interface BoundedJsonOptions {
  readonly maxChars?: number;
  readonly maxNodes?: number;
  readonly maxContainerEntries?: number;
  readonly maxDepth?: number;
}

/**
 * Serialize into a detached JSON value while stopping at bounded depth, nodes, entries, and characters.
 * This avoids JSON.stringify's up-front enumeration of an arbitrarily large page-controlled object.
 */
export function cloneBoundedJson(value: unknown, options: BoundedJsonOptions = {}): BoundedJsonResult {
  const maxChars = options.maxChars ?? CAPTURE_MAX_JSON_CHARS;
  const maxNodes = options.maxNodes ?? CAPTURE_MAX_NODES;
  const maxContainerEntries = options.maxContainerEntries ?? CAPTURE_MAX_CONTAINER_ENTRIES;
  const maxDepth = options.maxDepth ?? CAPTURE_MAX_DEPTH;
  const chunks: string[] = [];
  const ancestors = new WeakSet<object>();
  let chars = 0;
  let nodes = 0;

  const append = (chunk: string) => {
    if (chars + chunk.length > maxChars) reject('payload-too-large', `Serialized JSON exceeds ${maxChars} characters`);
    chunks.push(chunk);
    chars += chunk.length;
  };

  const appendString = (input: string) => {
    let encodedLength = 2;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
          code === 0x0a || code === 0x0c || code === 0x0d) {
        encodedLength += 2;
      } else if (code <= 0x1f) {
        encodedLength += 6;
      } else if (code >= 0xd800 && code <= 0xdbff &&
          index + 1 < input.length && input.charCodeAt(index + 1) >= 0xdc00 &&
          input.charCodeAt(index + 1) <= 0xdfff) {
        encodedLength += 2;
        index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        encodedLength += 6;
      } else {
        encodedLength += 1;
      }
      if (chars + encodedLength > maxChars) {
        reject('payload-too-large', `Serialized JSON exceeds ${maxChars} characters`);
      }
    }
    const encoded = JSON.stringify(input);
    if (encoded.length !== encodedLength) reject('malformed-payload', 'String encoding was not stable');
    append(encoded);
  };

  const write = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) reject('payload-too-large', `JSON node count exceeds ${maxNodes}`);
    if (depth > maxDepth) reject('payload-too-large', `JSON depth exceeds ${maxDepth}`);

    if (current === null) {
      append('null');
      return;
    }
    if (typeof current === 'string') {
      appendString(current);
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) reject('malformed-payload', 'Non-finite number is not accepted');
      append(JSON.stringify(current));
      return;
    }
    if (typeof current === 'boolean') {
      append(current ? 'true' : 'false');
      return;
    }
    if (typeof current !== 'object') reject('malformed-payload', `Unsupported JSON value: ${typeof current}`);
    if (ancestors.has(current)) reject('malformed-payload', 'Cyclic JSON value is not accepted');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > maxContainerEntries) {
          reject('payload-too-large', `Array length exceeds ${maxContainerEntries}`);
        }
        append('[');
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0) append(',');
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor)) reject('malformed-payload', 'Sparse or accessor array is not accepted');
          write(descriptor.value, depth + 1);
        }
        append(']');
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      // Cross-world structured clones can have another realm's Object.prototype.
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
        reject('malformed-payload', 'Only plain JSON objects are accepted');
      }
      append('{');
      let entries = 0;
      let first = true;
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        entries += 1;
        if (entries > maxContainerEntries) {
          reject('payload-too-large', `Object entry count exceeds ${maxContainerEntries}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) reject('malformed-payload', 'Accessor property is not accepted');
        if (!first) append(',');
        first = false;
        appendString(key);
        append(':');
        write(descriptor.value, depth + 1);
      }
      append('}');
    } finally {
      ancestors.delete(current);
    }
  };

  write(value, 0);
  const serialized = chunks.join('');
  return { serialized, value: JSON.parse(serialized) as unknown };
}
