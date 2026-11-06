import { watchLanguage } from '@/utils/language';
// ISOLATED world 桥接：project_list 交给 service worker 富化并渲染，
// history/list 严格解析后只写入本模块内存，两个数据流互不影响。

import type { EnrichResult } from '@/utils/overlay';
import { clearInline, renderInline, redrawInline, scheduleInlineSync } from '@/utils/inline';
import { cloneBoundedJson } from '@/utils/input-boundary';
import { CaptureSequenceCoordinator } from '@/utils/capture-sequence';
import { HistoryStore, parseHistoryList, type HistoryListResult } from '@/utils/history';
import { DEBANK_INPUT_LIMITS } from '@/utils/input-limits';
import {
  destroyStatusBar,
  redrawStatusBar,
  formatCoverageIssue,
  renderStatusBar,
  type LensCoverage,
  type LensPhase,
} from '@/utils/status-bar';
import {
  registerTransactionScamFilterCleanup,
  startTransactionScamFilterSafely,
} from '@/utils/transaction-filter';
import {
  capturedMessageAddressForProfile,
  createCancelEnrichMessage,
  createDeBankReplayRequestMessage,
  createEnrichRequestForProfile,
  type DeBankResponseMessage,
  type EnrichRequestId,
  isCurrentEnrichRequest,
  isDeBankCaptureRejectedMessage,
  isDeBankResponseMessage,
  isHistoryListUrl,
  profileAddressFromPath,
} from '@/utils/message-protocol';

const historyStore = new HistoryStore();

/** Slice 3 UI 的只读入口；返回防御性副本，不暴露可写 store。 */
export function getHistoryEntries(address: string): HistoryListResult {
  return historyStore.get(address);
}

const BRIDGE_MODULE_BUILD_ATTR = 'data-dal-bridge-module-build';
const BRIDGE_MODULE_BUILD = '0.6.0';

try {
  console.info('[APY Lens] bridge module build 0.6.0: evaluated');
} catch {
  /* module diagnostics must not block content-script definition */
}

const writeBridgeModuleBuild = () => {
  try {
    document.documentElement?.setAttribute(BRIDGE_MODULE_BUILD_ATTR, BRIDGE_MODULE_BUILD);
  } catch {
    /* module diagnostics must not mutate bridge control flow */
  }
};
writeBridgeModuleBuild();
if (!document.documentElement) {
  try {
    document.addEventListener('readystatechange', writeBridgeModuleBuild, { once: true });
  } catch {
    /* module diagnostics are best-effort */
  }
}

const APY_RATE_WINDOW_MS = 10_000;
const MAX_APY_MESSAGES_PER_WINDOW = 20;

function viewedAddress(): string | undefined {
  return profileAddressFromPath(location.pathname);
}

export default defineContentScript({
  matches: ['*://debank.com/*'],
  runAt: 'document_start',
  main(ctx) {
    // 独立 DOM engine；其内部异常被隔离，绝不能阻断下面的 APY bridge 初始化。
    try {
      console.info('[APY Lens] scam filter build 0.3.5: bridge-enter');
    } catch {
      /* diagnostics must not block bridge startup */
    }
    const transactionFilter = startTransactionScamFilterSafely();
    const cleanupTransactionFilter = registerTransactionScamFilterCleanup(
      transactionFilter,
      ctx,
    );
    let lastPayloadKey = '';
    let generation = 0;
    let recentApyMessages: number[] = [];
    let recentHistoryMessages: number[] = [];
    let currentAddress = viewedAddress();
    let activeRequestId: EnrichRequestId | undefined;
    let refreshSnapshot: { message: DeBankResponseMessage; data: unknown } | undefined;
    let hasRenderedResult = false;
    let coverage: LensCoverage = 'none';
    let gapCount = 0;
    let gapDetails: string[] = [];
    let lastUpdatedAt: number | undefined;
    const captureSequences = new CaptureSequenceCoordinator();
    const replayTimers = new Set<number>();

    const clearReplayTimers = () => {
      for (const timer of replayTimers) window.clearTimeout(timer);
      replayTimers.clear();
    };

    const requestReplay = () => {
      const message = createDeBankReplayRequestMessage(currentAddress);
      if (message) window.postMessage(message, location.origin);
    };

    const scheduleReplay = () => {
      clearReplayTimers();
      for (const delay of [0, 250, 1_000]) {
        const timer = window.setTimeout(() => {
          replayTimers.delete(timer);
          requestReplay();
        }, delay);
        replayTimers.add(timer);
      }
    };

    const cancelActiveRequest = (): EnrichRequestId | undefined => {
      const requestId = activeRequestId;
      if (!requestId) return undefined;
      activeRequestId = undefined;
      void browser.runtime.sendMessage(createCancelEnrichMessage(requestId)).catch(() => {});
      return requestId;
    };

    const resultCoverage = (result: EnrichResult): {
      coverage: LensCoverage;
      gapCount: number;
      gapDetails: string[];
    } => {
      if (result.cards.length === 0 && !result.summary) {
        return { coverage: 'empty', gapCount: 0, gapDetails: [] };
      }
      if (result.coverageIssues) {
        return {
          coverage: result.coverageIssues.length > 0 ? 'partial' : 'complete',
          gapCount: result.coverageIssues.length,
          gapDetails: result.coverageIssues.map(formatCoverageIssue),
        };
      }
      const summary = result.summary;
      const complete =
        result.inputCoverageComplete !== false &&
        (summary?.rewardCoverageComplete ?? true) &&
        (summary?.rateCoverageComplete ?? true) &&
        (summary?.claimableState ?? 'complete') === 'complete';
      return {
        coverage: complete ? 'complete' : 'partial',
        gapCount: complete ? 0 : 1,
        gapDetails: complete ? [] : ['至少一个数据源、协议或奖励覆盖不完整'],
      };
    };

    const setStatus = (phase: LensPhase, detail?: string) => {
      renderStatusBar(
        {
          phase,
          coverage,
          gapCount,
          gapDetails,
          hasData: hasRenderedResult,
          canRefresh: refreshSnapshot !== undefined,
          lastUpdatedAt,
          detail,
        },
        {
          refresh: () => {
            if (refreshSnapshot) void startEnrichment(refreshSnapshot);
          },
          stop: () => stopEnrichment(),
        },
      );
    };

    const stopEnrichment = () => {
      if (!activeRequestId) return;
      const stoppedGeneration = ++generation;
      setStatus('stopping', '正在中止当前 APY 请求');
      cancelActiveRequest();
      queueMicrotask(() => {
        if (generation === stoppedGeneration && !activeRequestId) {
          setStatus('stopped', '当前 APY 请求已停止；页面与诈骗交易过滤仍正常运行');
        }
      });
    };

    const startEnrichment = async (snapshot: { message: DeBankResponseMessage; data: unknown }) => {
      const request = createEnrichRequestForProfile(
        snapshot.message,
        currentAddress,
        crypto.randomUUID(),
        snapshot.data,
      );
      if (!request) {
        setStatus('error', '当前地址与缓存的 DeBank 仓位数据不一致');
        return;
      }

      cancelActiveRequest();
      const requestGeneration = ++generation;
      activeRequestId = request.requestId;
      setStatus(hasRenderedResult ? 'refreshing' : 'loading');

      try {
        const result = (await browser.runtime.sendMessage(request)) as EnrichResult | undefined;
        invalidateAddress();
        if (!isCurrentEnrichRequest(requestGeneration, generation, request.address, currentAddress)) return;
        if (result && !('error' in result)) {
          // history 只读快照按需读取；晚到数据由 history 分支显式调度刷新。
          renderInline(result, () => getHistoryEntries(request.address));
          hasRenderedResult = true;
          const coverageResult = resultCoverage(result);
          coverage = coverageResult.coverage;
          gapCount = coverageResult.gapCount;
          gapDetails = coverageResult.gapDetails;
          lastUpdatedAt = result.generatedAt;
          setStatus(
            'ready',
            coverage === 'partial'
              ? 'APY 已载入，但至少一个数据源、协议或奖励覆盖不完整'
              : coverage === 'empty'
                ? '当前页面没有可解析仓位'
                : 'APY 与奖励数据载入完成',
          );
        } else if (result && 'error' in result) {
          console.warn('[APY Lens] enrich failed:', result.error);
          setStatus('error', result.error);
        } else {
          setStatus('error', '未收到 APY Lens service worker 的有效响应');
        }
      } catch (error) {
        if (!isCurrentEnrichRequest(requestGeneration, generation, request.address, currentAddress)) return;
        const message = String(error);
        if (!/Extension context invalidated|message port closed|Receiving end does not exist/i.test(message)) {
          console.warn('[APY Lens] bridge error:', error);
          setStatus('error', message);
        }
      } finally {
        if (activeRequestId === request.requestId) activeRequestId = undefined;
      }
    };

    const invalidateCapturedResult = () => {
      generation += 1;
      cancelActiveRequest();
      lastPayloadKey = '';
      refreshSnapshot = undefined;
      hasRenderedResult = false;
      coverage = 'none';
      gapCount = 0;
      gapDetails = [];
      lastUpdatedAt = undefined;
      clearInline();
      setStatus('waiting', '等待当前地址的 DeBank 仓位数据');
      scheduleReplay();
    };

    const invalidateAddress = () => {
      const nextAddress = viewedAddress();
      if (nextAddress === currentAddress) return;
      currentAddress = nextAddress;
      invalidateCapturedResult();
    };
    window.addEventListener('popstate', invalidateAddress);
    window.setInterval(invalidateAddress, 250);
    window.addEventListener('message', async (event) => {
      invalidateAddress();
      if (event.source !== window || event.origin !== location.origin) return;
      const msg = event.data;
      if (isDeBankCaptureRejectedMessage(msg)) {
        // History 旁听失败与 APY 状态无关，不能清空现有富化结果。
        if (isHistoryListUrl(msg.url)) return;
        if (
          capturedMessageAddressForProfile(msg, currentAddress) &&
          captureSequences.accept(msg.captureSequence)
        ) {
          invalidateCapturedResult();
          setStatus('error', `DeBank 仓位数据被拒绝：${msg.reason}`);
        }
        return;
      }
      if (!isDeBankResponseMessage(msg)) return;

      // The MAIN-world interceptor owns identity. Never reinterpret an old or identity-less payload as current.
      const requestAddress = capturedMessageAddressForProfile(msg, currentAddress);
      if (!requestAddress) return;

      if (isHistoryListUrl(msg.url)) {
        // 独立错误边界：历史解析失败静默，绝不进入 enrich/SW 或影响 APY 流。
        const now = Date.now();
        recentHistoryMessages = recentHistoryMessages.filter(
          (at) => now - at < DEBANK_INPUT_LIMITS.historyRateWindowMs,
        );
        if (recentHistoryMessages.length >= DEBANK_INPUT_LIMITS.historyMessagesPerWindow) return;
        recentHistoryMessages.push(now);
        try {
          const bounded = cloneBoundedJson(msg.data);
          historyStore.append(requestAddress, parseHistoryList(bounded.value));
          // history 不经过 SW；写入后显式走 inline 的互斥/去抖入口刷新当前地址。
          scheduleInlineSync();
        } catch {
          /* fail open */
        }
        return;
      }
      // Completion order is irrelevant: only a newer request-start sequence may update or invalidate the UI.
      if (!captureSequences.accept(msg.captureSequence)) return;

      const now = Date.now();
      recentApyMessages = recentApyMessages.filter((at) => now - at < APY_RATE_WINDOW_MS);
      if (recentApyMessages.length >= MAX_APY_MESSAGES_PER_WINDOW) {
        invalidateCapturedResult();
        setStatus('error', 'DeBank 仓位消息频率超过安全上限');
        return;
      }
      recentApyMessages.push(now);

      let bounded: ReturnType<typeof cloneBoundedJson>;
      try {
        bounded = cloneBoundedJson(msg.data);
      } catch {
        invalidateCapturedResult();
        setStatus('error', 'DeBank 仓位数据无法安全复制');
        return;
      }
      const request = createEnrichRequestForProfile(
        msg,
        currentAddress,
        crypto.randomUUID(),
        bounded.value,
      );
      if (!request) {
        invalidateCapturedResult();
        setStatus('error', 'DeBank 仓位数据与当前地址不一致');
        return;
      }

      // 只去重内容完全相同的响应；相同长度不代表相同仓位。
      const key = `${request.address}:${msg.url}:${bounded.serialized}`;
      if (key === lastPayloadKey) return;
      lastPayloadKey = key;
      refreshSnapshot = { message: { ...msg, data: bounded.value }, data: bounded.value };
      clearReplayTimers();
      await startEnrichment(refreshSnapshot);
    });

    setStatus('waiting', '等待当前地址的 DeBank 仓位数据');
    void watchLanguage(() => { redrawInline(); redrawStatusBar(); }).then((cleanup) => ctx.onInvalidated(cleanup));
    scheduleReplay();
    window.addEventListener('pageshow', requestReplay);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !hasRenderedResult) requestReplay();
    });

    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) {
        cleanupTransactionFilter();
        destroyStatusBar();
      }
      generation += 1;
      cancelActiveRequest();
      clearReplayTimers();
    });
  },
});
