import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { EN_MESSAGES } from '../utils/messages.ts';
import { getLocale, resolveLocale, setLocale, tr } from '../utils/i18n.ts';
import { assetRatePresentation, portfolioDailyHeadline, renderPanel } from '../utils/overlay.ts';
import { computeProtocolYield, type AssetYield } from '../utils/apy.ts';
import { rewardComponentSource } from '../utils/reward-sources.ts';

test('automatic language follows the browser and explicit selection takes priority', () => {
  assert.equal(resolveLocale('auto', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'en-GB'), 'en');
  assert.equal(resolveLocale('auto', 'de-DE'), 'en');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
});

test('all messages preserve parameters in English, including cached worker messages', () => {
  setLocale('en');
  try {
    for (const [source, english] of Object.entries(EN_MESSAGES)) {
      const parameters = (value: string) => [...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
      assert.deepEqual(parameters(english), parameters(source), source);
      const values = ['valueA', 'valueB', 'valueC', 'valueD'];
      const rendered = source.replace(/\{(\d+)\}/g, (_, n) => values[Number(n)]);
      assert.doesNotMatch(tr(rendered), /\p{Script=Han}/u, source);
      for (const parameter of parameters(source)) {
        assert.ok(tr(rendered).includes(values[Number(parameter.slice(1, -1))]), source);
      }
    }
    assert.equal(tr('⚠ 奖励覆盖不完整：仅显示已知收益小计'), '⚠ Reward coverage is incomplete: showing the known yield subtotal');
    assert.equal(tr('Merkl 待领奖励查询失败：Base（超时）'), 'Merkl claimable reward query failed: Base (Timeout)');
    assert.equal(tr('数据源：{0}', 'aave-v3官方'), 'Data source: aave-v3 official');
    assert.equal(tr('Aave V3 数据不完整：USDC 存款/抵押基础利率未匹配'), 'Aave V3 data incomplete: USDC Supply/collateral base rate missing');
    assert.equal(tr('Unlisted third-party product'), 'Unlisted third-party product');
  } finally { setLocale('zh-CN'); }
});

const asset: AssetYield = {
  leg: 'supply',
  token: { address: '0x0000000000000000000000000000000000000001', chain: 'eth', symbol: 'USDC', amount: 1000, priceUsd: 1, usd: 1000 },
  baseApy: 0.04, rewardApr: null, rewardState: 'unknown', source: 'aave-v3官方',
};

test('switching presentation language leaves yield numbers and cached source messages unchanged', () => {
  const result = computeProtocolYield([asset]);
  const snapshot = JSON.stringify(result);
  assert.equal(assetRatePresentation(asset).details[0], '基础 APY 4%');
  setLocale('en');
  try {
    assert.deepEqual(assetRatePresentation(asset).details, ['Base APY 4%', 'Rewards unknown']);
    assert.match(tr(result.flags[0]), /Reward coverage is incomplete/);
    assert.equal(JSON.stringify(result), snapshot);
    assert.equal(portfolioDailyHeadline({ estDailyUsd: 1, coveredUsd: 1000, uncoveredUsd: 0, lpTotal: 0, lpOutOfRange: 0, claimableUsd: 0, claimableState: 'complete', claimTop: [] }).label, 'Daily estimate');
    const source = rewardComponentSource({ id: 'test', value: 0.02, rateKind: 'apr', source: 'aave-v3官方', basis: 'supply' });
    assert.equal(source?.linkLabel, 'View Aave markets');
    assert.doesNotMatch(source?.description ?? '', /\p{Script=Han}/u);
  } finally { setLocale('zh-CN'); }
  assert.equal(assetRatePresentation(asset).details[0], '基础 APY 4%');
});

test('a saved language change updates subscribers and cleanup removes the listener', async () => {
  const listeners = new Set<(changes: Record<string, { newValue: unknown }>, area: string) => void>();
  const prior = (globalThis as any).browser;
  (globalThis as any).browser = { storage: {
    sync: { get: async () => ({ 'dal:language': 'en' }), set: async (values: Record<string, unknown>) => {
      for (const listener of listeners) listener({ 'dal:language': { newValue: values['dal:language'] } }, 'sync');
    } },
    onChanged: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
  } };
  try {
    const { watchLanguage, saveLanguage } = await import('../utils/language.ts');
    const seen: string[] = [];
    const stop = await watchLanguage(() => seen.push(getLocale()));
    await saveLanguage('zh-CN');
    await saveLanguage('en');
    assert.deepEqual(seen, ['en', 'zh-CN', 'en']);
    stop();
    await saveLanguage('zh-CN');
    assert.equal(seen.length, 3);
  } finally { (globalThis as any).browser = prior; setLocale('zh-CN'); }
});

test('the same cached status and panel repaint in English and Chinese without fetching', async () => {
  const env = parseHTML('<html><body><span>Data updated</span></body></html>');
  const w = env.window;
  Object.assign(globalThis, { window: w, document: w.document, Node: w.Node, HTMLElement: w.HTMLElement,
    MutationObserver: w.MutationObserver, NodeFilter: { SHOW_TEXT: 4 } });
  const { renderStatusBar, redrawStatusBar, destroyStatusBar } = await import('../utils/status-bar.ts');
  const result = { cards: [], skippedProtocols: 2, generatedAt: 0 };
  renderStatusBar({ phase: 'ready', coverage: 'partial', gapCount: 2,
    gapDetails: ['Merkl 待领奖励查询失败：Base（超时）'], hasData: true, canRefresh: true }, { refresh() {}, stop() {} });
  renderPanel(result);
  const root = () => w.document.querySelector('[data-dal-status]')!.shadowRoot!;
  assert.equal(root().querySelector('.label')?.textContent, '载入完成 · 2项缺口');
  setLocale('en');
  try {
    redrawStatusBar();
    renderPanel(result);
    assert.equal(root().querySelector('.label')?.textContent, 'Loaded · 2 gaps');
    assert.equal(root().querySelector('button')?.textContent, 'Refresh');
    assert.match(root().querySelector('.status-tip')?.textContent ?? '', /Base \(Timeout\)/);
    // The actual host ID is stable in the renderer, independent of language.
    const hosts = [...w.document.querySelectorAll('*')].filter((e) => e.shadowRoot);
    assert.ok(hosts.some((e) => e.shadowRoot?.querySelector('.empty')?.textContent?.includes('2 other protocols skipped')));
  } finally { setLocale('zh-CN'); redrawStatusBar(); destroyStatusBar(); }
});
