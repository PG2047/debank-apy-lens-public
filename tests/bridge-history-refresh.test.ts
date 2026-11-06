import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHTML } from 'linkedom';

import {
  captureDeBankRequest,
  createDeBankResponseMessage,
} from '../utils/message-protocol.ts';

const ADDRESS = '0x000000000000000000000000000000000000f002';
const PATH = `/profile/${ADDRESS}/history`;
const ORIGIN = 'https://debank.com';
const HISTORY_API = `https://api.debank.com/history/list?user_addr=${ADDRESS}`;
const PROJECT_API = `https://api.debank.com/portfolio/project_list?id=${ADDRESS}`;

test('project_list first, history later, and no page DOM mutation still renders the timeline', async () => {
  const page = parseHTML('<html><head></head><body></body></html>');
  const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const installGlobal = (key: PropertyKey, value: unknown) => {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const originalConsoleInfo = console.info;

  installGlobal('window', page.window);
  installGlobal('document', page.document);
  installGlobal('location', { origin: ORIGIN, pathname: PATH });
  installGlobal('Node', page.window.Node);
  installGlobal('HTMLElement', page.window.HTMLElement);
  installGlobal('NodeFilter', { SHOW_TEXT: 4 });
  installGlobal('MutationObserver', page.window.MutationObserver);
  installGlobal('getComputedStyle', () => ({ position: 'static' }));
  installGlobal('browser', {
    runtime: {
      sendMessage: async (message: unknown) => (message as { type?: string }).type === 'dal:enrich'
        ? { cards: [], skippedProtocols: 0, generatedAt: 1 }
        : undefined,
    },
  });
  installGlobal('defineContentScript', (definition: unknown) => definition);
  Object.defineProperty(page.window, 'setInterval', { configurable: true, value: () => 1 });
  Object.defineProperty(page.window, 'clearInterval', { configurable: true, value: () => undefined });
  console.info = () => {};

  try {
    const bridge = await import('../entrypoints/bridge.content.ts');
    const definition = bridge.default as {
      main(context: { onInvalidated(callback: () => void): void }): void;
    };
    definition.main({ onInvalidated() {} });

    let sequence = 1;
    const dispatch = async (url: string, data: unknown) => {
      const capture = captureDeBankRequest(url, `${ORIGIN}${PATH}`, PATH, sequence++);
      assert.ok(capture);
      const event = new page.window.Event('message');
      Object.defineProperties(event, {
        data: { value: createDeBankResponseMessage(capture, data) },
        origin: { value: ORIGIN },
        source: { value: page.window },
      });
      page.window.dispatchEvent(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    await dispatch(PROJECT_API, { data: [] });
    const host = page.document.getElementById('debank-apy-lens-host');
    assert.ok(host);
    assert.equal(host.shadowRoot?.querySelector('details.timeline'), null);

    await dispatch(HISTORY_API, {
      data: {
        history_list: [{
          id: 'late-history',
          chain: 'eth',
          project_id: 'uniswap4',
          cate_id: 'receive',
          is_scam: false,
          time_at: 1,
          tx: { name: 'deposit' },
          sends: [],
          receives: [],
        }],
      },
    });

    assert.ok(
      host.shadowRoot?.querySelector('details.timeline'),
      'late history explicitly refreshes the existing panel',
    );
  } finally {
    console.info = originalConsoleInfo;
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
