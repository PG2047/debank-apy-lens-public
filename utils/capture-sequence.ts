export type CaptureSequence = number;

export function isCaptureSequence(value: unknown): value is CaptureSequence {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** One issuer is shared by fetch and XHR so request-start order has one total ordering. */
export class CaptureSequenceIssuer {
  #lastIssued = 0;

  next(): CaptureSequence {
    if (this.#lastIssued >= Number.MAX_SAFE_INTEGER) throw new RangeError('Capture sequence exhausted');
    this.#lastIssued += 1;
    return this.#lastIssued;
  }
}

/** Accepts each newer request-start sequence once, independent of response completion order. */
export class CaptureSequenceCoordinator {
  #latestAccepted = 0;

  accept(sequence: unknown): sequence is CaptureSequence {
    if (!isCaptureSequence(sequence) || sequence <= this.#latestAccepted) return false;
    this.#latestAccepted = sequence;
    return true;
  }

  get latestAccepted(): number {
    return this.#latestAccepted;
  }
}
