// Service worker boundary: validate the shared message contract, then delegate to the testable core.

import { enrichPayload } from '@/utils/enrich';
import {
  isCancelEnrichMessage,
  isEnrichRequestMessage,
  normalizeProfileAddress,
} from '@/utils/message-protocol';
import { EnrichRequestCoordinator, requestSenderKey } from '@/utils/request-coordinator';

export default defineBackground(() => {
  const coordinator = new EnrichRequestCoordinator();

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const senderKey = requestSenderKey(sender);
    if (!senderKey) return undefined;
    if (isCancelEnrichMessage(message)) {
      coordinator.cancel(senderKey, message.requestId);
      return undefined;
    }
    if (!isEnrichRequestMessage(message)) return undefined;
    return coordinator.runLatest(
      senderKey,
      message.requestId,
      (signal) => enrichPayload(message.data, normalizeProfileAddress(message.address), signal),
    ).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return undefined;
      return { error: String(error) };
    });
  });
});
