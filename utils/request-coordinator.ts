import type { EnrichRequestId } from './message-protocol';

export interface RequestSenderIdentity {
  readonly tab?: { readonly id?: number };
  readonly frameId?: number;
}

interface ActiveRequest {
  readonly requestId: EnrichRequestId;
  readonly controller: AbortController;
}

/** Isolate active work by the content-script sender that owns it. */
export function requestSenderKey(sender: RequestSenderIdentity): string | undefined {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (!Number.isSafeInteger(tabId) || (tabId as number) < 0) return undefined;
  if (!Number.isSafeInteger(frameId) || frameId < 0) return undefined;
  return `tab:${tabId}:frame:${frameId}`;
}

/** Owns one abortable enrichment per tab/frame and guards against stale finally blocks. */
export class EnrichRequestCoordinator {
  readonly #active = new Map<string, ActiveRequest>();

  async runLatest<T>(
    senderKey: string,
    requestId: EnrichRequestId,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = this.#active.get(senderKey);
    previous?.controller.abort(new DOMException('Superseded by a newer enrichment', 'AbortError'));

    const controller = new AbortController();
    const active = { requestId, controller };
    this.#active.set(senderKey, active);
    try {
      return await work(controller.signal);
    } finally {
      // An older request may finish after a replacement starts; it must not delete the replacement.
      if (this.#active.get(senderKey) === active) this.#active.delete(senderKey);
    }
  }

  cancel(senderKey: string, requestId: EnrichRequestId): boolean {
    const active = this.#active.get(senderKey);
    if (!active || active.requestId !== requestId) return false;
    this.#active.delete(senderKey);
    active.controller.abort(new DOMException('Enrichment cancelled by navigation', 'AbortError'));
    return true;
  }
}
