import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHTML } from 'linkedom';

import { DEBANK_INPUT_LIMITS } from '../utils/input-limits.ts';
import {
  captureDeBankRequest,
  createDeBankCaptureRejectedMessage,
  createDeBankResponseMessage,
} from '../utils/message-protocol.ts';

const ADDRESS = '0x000000000000000000000000000000000000f002';
const PATH = `/profile/${ADDRESS}/history`;
const ORIGIN = 'https://debank.com';
const HISTORY_API = `https://api.debank.com/history/list?user_addr=${ADDRESS}`;
const PROJECT_API = `https://api.debank.com/portfolio/project_list?id=${ADDRESS}`;

const validRow = (id: string, timeAt: number) => ({
  id,
  chain: 'eth',
  project_id: 'uniswap4',
  cate_id: 'send',
  is_scam: false,
  time_at: timeAt,
  tx: { name: 'swap' },
  sends: [],
  receives: [],
});

test('history success, rejection, failure, and burst stay local and preserve the APY rate budget', async () => {
  const page = parseHTML('<html><head></head><body></body></html>');
  const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const installGlobal = (key: PropertyKey, value: unknown) => {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const sent: unknown[] = [];
  const originalConsoleInfo = console.info;

  installGlobal('window', page.window);
  installGlobal('document', page.document);
  installGlobal('location', { origin: ORIGIN, pathname: PATH });
  installGlobal('Node', page.window.Node);
  installGlobal('HTMLElement', page.window.HTMLElement);
  installGlobal('NodeFilter', { SHOW_TEXT: 4 });
  installGlobal('MutationObserver', page.window.MutationObserver);
  installGlobal('browser', {
    storage: {
      sync: { get: async () => ({ 'dal:language': 'zh-CN' }) },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        sent.push(message);
        return undefined;
      },
    },
  });
  installGlobal('defineContentScript', (definition: unknown) => definition);
  Object.defineProperty(page.window, 'setInterval', {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(page.window, 'clearInterval', {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(page.window, 'setTimeout', {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(page.window, 'clearTimeout', {
    configurable: true,
    value: () => undefined,
  });
  console.info = () => {};

  try {
    const bridge = await import('../entrypoints/bridge.content.ts');
    const definition = bridge.default as {
      main(context: { onInvalidated(callback: () => void): void }): void;
    };
    definition.main({ onInvalidated() {} });

    const dispatch = async (data: unknown) => {
      const event = new page.window.Event('message');
      Object.defineProperties(event, {
        data: { value: data },
        origin: { value: ORIGIN },
        source: { value: page.window },
      });
      page.window.dispatchEvent(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    let sequence = 1;
    const historyCapture = () => {
      const capture = captureDeBankRequest(
        HISTORY_API,
        `${ORIGIN}${PATH}`,
        PATH,
        sequence++,
      );
      assert.ok(capture);
      return capture;
    };

    await dispatch(createDeBankResponseMessage(historyCapture(), {
      data: { history_list: [validRow('success', 1)] },
    }));
    assert.equal(sent.length, 0);
    assert.deepEqual(bridge.getHistoryEntries(ADDRESS).entries.map(({ id }) => id), ['success']);

    await dispatch(createDeBankCaptureRejectedMessage(historyCapture(), 'malformed-payload'));
    assert.equal(sent.length, 0);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await dispatch(createDeBankResponseMessage(historyCapture(), cyclic));
    assert.equal(sent.length, 0);

    for (let index = 0; index < DEBANK_INPUT_LIMITS.historyMessagesPerWindow + 2; index += 1) {
      await dispatch(createDeBankResponseMessage(historyCapture(), {
        data: { history_list: [validRow(`burst-${index}`, index + 2)] },
      }));
    }
    assert.equal(sent.length, 0);

    // A full APY budget remains available after the history burst. Each accepted
    // project response reaches runtime.sendMessage; the 21st is APY-rate-limited.
    for (let index = 0; index < 21; index += 1) {
      const capture = captureDeBankRequest(
        PROJECT_API,
        `${ORIGIN}${PATH}`,
        PATH,
        sequence++,
      );
      assert.ok(capture);
      await dispatch(createDeBankResponseMessage(capture, { data: [{ index }] }));
    }
    assert.equal(sent.length, 20);
  } finally {
    console.info = originalConsoleInfo;
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
