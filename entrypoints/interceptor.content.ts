// MAIN world 拦截器：在页面世界里旁听 DeBank 自身的 fetch/XHR 响应。
// 页面的请求已由 DeBank 前端签名，我们不发任何独立请求，只读副本。
// 约束：绝不能影响页面本身——所有捕获逻辑包在 try/catch 里，失败静默。

import {
  captureDeBankRequest,
  createDeBankCaptureRejectedMessage,
  createDeBankResponseMessage,
  isDeBankReplayRequestMessage,
  replayCacheKey,
  replayCacheKeysForAddress,
  resolveRequestUrl,
  type DeBankRequestCapture,
} from '@/utils/message-protocol';
import {
  captureRejectionReason,
  parseBoundedJsonText,
  readBoundedJsonResponse,
} from '@/utils/input-boundary';
import { CaptureSequenceIssuer } from '@/utils/capture-sequence';

export default defineContentScript({
  matches: ['*://debank.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const sequenceIssuer = new CaptureSequenceIssuer();
    // 键 = 身份(URL 声明优先)× 端点分槽;上限 = 8 地址 × 2 端点
    const replayCache = new Map<string, { url: string; data: unknown }>();
    const MAX_REPLAY_ENTRIES = 16;
    const post = (capture: DeBankRequestCapture, data: unknown) => {
      try {
        const message = createDeBankResponseMessage(capture, data);
        const cacheKey = replayCacheKey(capture);
        if (cacheKey) {
          replayCache.delete(cacheKey);
          replayCache.set(cacheKey, { url: capture.url, data });
          while (replayCache.size > MAX_REPLAY_ENTRIES) {
            const oldest = replayCache.keys().next().value;
            if (typeof oldest !== 'string') break;
            replayCache.delete(oldest);
          }
        }
        window.postMessage(
          message,
          location.origin,
        );
      } catch {
        /* ignore */
      }
    };

    // The isolated bridge can start after a fast DeBank response or return from bfcache.
    // Re-emit only a same-document, request-time-address snapshot with a fresh sequence.
    window.addEventListener('message', (event) => {
      try {
        if (event.source !== window || event.origin !== location.origin) return;
        if (!isDeBankReplayRequestMessage(event.data)) return;
        const requestAddress = event.data.requestAddress;
        for (const key of replayCacheKeysForAddress(requestAddress)) {
          const cached = replayCache.get(key);
          if (!cached) continue;
          post({
            url: cached.url,
            requestAddress,
            captureSequence: sequenceIssuer.next(),
          }, cached.data);
        }
      } catch {
        /* replay must never affect the page */
      }
    });

    const postRejected = (capture: DeBankRequestCapture, error: unknown) => {
      try {
        window.postMessage(
          createDeBankCaptureRejectedMessage(capture, captureRejectionReason(error)),
          location.origin,
        );
      } catch {
        /* ignore */
      }
    };

    const captureFetchResponse = async (capture: DeBankRequestCapture, response: Response) => {
      try {
        post(capture, await readBoundedJsonResponse(response));
      } catch (error) {
        postRejected(capture, error);
      }
    };

    // ── fetch ──
    const origFetch = window.fetch;
    window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      // Must be captured before the network request starts; location may change before its response resolves.
      let capture: DeBankRequestCapture | undefined;
      try {
        capture = captureDeBankRequest(
          args[0],
          location.href,
          location.pathname,
          sequenceIssuer.next(),
        );
      } catch {
        /* 绝不打断页面 */
      }
      const res = await origFetch.apply(this, args);
      try {
        if (capture) {
          // clone() 避免消费页面自己要读的 body
          void captureFetchResponse(capture, res.clone());
        }
      } catch (error) {
        if (capture) postRejected(capture, error);
      }
      return res;
    };

    // ── XHR ──
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        xhrUrls.set(this, resolveRequestUrl(args[1], location.href));
      } catch {
        /* ignore */
      }
      // @ts-expect-error 透传原始参数
      return origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        // XHR starts at send(), so bind the current profile here rather than at open() or load time.
        const capture = captureDeBankRequest(
          xhrUrls.get(this),
          location.href,
          location.pathname,
          sequenceIssuer.next(),
        );
        if (capture) {
          this.addEventListener('load', () => {
            try {
              post(capture, parseBoundedJsonText(this.responseText));
            } catch (error) {
              postRejected(capture, error);
            }
          });
        }
      } catch {
        /* ignore */
      }
      // @ts-expect-error 透传原始参数
      return origSend.apply(this, args);
    };
  },
});
