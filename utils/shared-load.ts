interface ActiveLoad<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  readonly subscribers: Set<symbol>;
  settled: boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/**
 * Deduplicates a cold load without making its lifetime belong to the first caller.
 * Each subscriber can stop waiting independently; the shared work is aborted only
 * after its final subscriber leaves.
 */
export class SharedAbortableLoad<T> {
  private active: ActiveLoad<T> | null = null;

  isActive(): boolean {
    return this.active !== null;
  }

  run(loader: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    let active = this.active;
    if (!active) {
      const controller = new AbortController();
      const subscribers = new Set<symbol>();
      let entry: ActiveLoad<T>;
      const promise = Promise.resolve()
        .then(() => loader(controller.signal))
        .finally(() => {
          entry.settled = true;
          if (this.active === entry) this.active = null;
        });
      entry = { controller, promise, subscribers, settled: false };
      this.active = entry;
      active = entry;
    }

    const subscriber = Symbol('shared-load-subscriber');
    active.subscribers.add(subscriber);

    return new Promise<T>((resolve, reject) => {
      let finished = false;

      const release = (cancelled: boolean): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        active.subscribers.delete(subscriber);
        if (cancelled && !active.settled && active.subscribers.size === 0) {
          // Detach first so a new caller never joins work that is already doomed.
          if (this.active === active) this.active = null;
          active.controller.abort(new DOMException('All shared load subscribers cancelled', 'AbortError'));
        }
      };

      const onAbort = (): void => {
        const reason = signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError');
        release(true);
        reject(reason);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      active.promise.then(
        (value) => {
          if (finished) return;
          release(false);
          resolve(value);
        },
        (error) => {
          if (finished) return;
          release(false);
          reject(error);
        },
      );
    });
  }

  reset(): void {
    const active = this.active;
    this.active = null;
    if (active && !active.settled) {
      active.controller.abort(new DOMException('Shared load reset', 'AbortError'));
    }
  }
}
