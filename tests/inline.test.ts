import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHTML } from 'linkedom';

test('Morpho Midnight rows with one Yield heading receive their own USDC APY in visual row order', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  const doc = localWindow.document;
  doc.body.innerHTML = [
    '<section id="morpho-card">',
    '<div><span>Morpho</span><span>$188,558.76</span></div>',
    '<div id="yield-panel"><span>Yield</span><div><span>Pool</span><span>Balance</span><span>USD Value</span></div>',
    '<div id="oct-row"><span>Midnight - Oct 30, 2026</span><a>USDC</a><span>97,113.8014 USDC</span><span>$97,133.23</span></div>',
    '<div id="nov-row"><span>Midnight - Nov 27, 2026</span><a>USDC</a><span>91,407.2472 USDC</span><span>$91,425.53</span></div>',
    '</div></section>',
  ].join('');

  const mkYield = (value: number, apy: number) => ({
    equityUsd: value,
    leverage: null,
    netApy: apy,
    estDailyUsd: value * apy / 365,
    knownNetApy: apy,
    knownEstDailyUsd: value * apy / 365,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: [{
      leg: 'supply' as const,
      token: { address: '0xusdc', chain: 'base', symbol: 'USDC', amount: value, priceUsd: 1, usd: value },
      baseApy: apy,
      rewardApr: null,
      rewardState: 'not-applicable' as const,
      source: 'morpho-midnight-api',
    }],
  });
  const nov = mkYield(91_425.53, 0.0618);
  const oct = mkYield(97_133.23, 0.0616);
  renderInline({
    cards: [{
      key: 'base:base_morphoblue', title: 'Morpho', chainLabel: 'Base', kind: 'rates',
      pageNetUsd: 188_558.76,
      yield: { ...mkYield(188_558.76, 0.0617), assets: [...nov.assets, ...oct.assets] },
      // DeBank API order is November then October; page order is October then November.
      items: [
        { name: 'Yield', displayName: 'Midnight - Nov 27, 2026', yield: nov },
        { name: 'Yield', displayName: 'Midnight - Oct 30, 2026', yield: oct },
      ],
    }],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });

  const rowApy = (id: string) => [...(doc.querySelector(id)?.querySelectorAll<HTMLElement>('[data-dal-chip="asset"]') ?? [])]
    .map((host) => host.shadowRoot?.querySelector('.chip')?.textContent ?? '');
  assert.deepEqual(rowApy('#oct-row'), ['APY 6.16%']);
  assert.deepEqual(rowApy('#nov-row'), ['APY 6.18%']);
  assert.equal(doc.querySelectorAll('#oct-row [data-dal-chip="item"]').length, 1);
  assert.equal(doc.querySelectorAll('#nov-row [data-dal-chip="item"]').length, 1);
  clearInline();
});

test('inline tooltip toggles by click and closes with Escape while updating ARIA state', async () => {
  const env = parseHTML('<html><body><span>Data updated</span></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });

  const { clearInline, rangeWidget, renderInline } = await import('../utils/inline.ts');
  renderInline({
    cards: [],
    skippedProtocols: 0,
    generatedAt: Date.now(),
    summary: {
      estDailyUsd: 1,
      knownEstDailyUsd: 1,
      rewardCoverageComplete: true,
      rateCoverageComplete: true,
      coveredUsd: 100,
      uncoveredUsd: 0,
      lpTotal: 0,
      lpOutOfRange: 0,
      liquidityRedCount: 2,
      claimableUsd: 0,
      claimableState: 'complete',
      claimTop: [],
    },
  });

  const host = localWindow.document.querySelector<HTMLElement>('[data-dal-chip="summary"]');
  const chip = host?.shadowRoot?.querySelector<HTMLElement>('.chip');
  const tip = host?.shadowRoot?.querySelector<HTMLElement>('.tip');
  assert.ok(chip && tip);
  assert.match(chip.textContent ?? '', /⚠流动性 2/);
  assert.match(tip.textContent ?? '', /2 个出借资产/);
  assert.equal(chip.getAttribute('role'), 'button');
  assert.equal(chip.getAttribute('aria-expanded'), 'false');
  assert.equal(tip.getAttribute('role'), 'tooltip');

  chip.dispatchEvent(new localWindow.Event('pointerdown'));
  chip.focus();
  chip.click();
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  chip.dispatchEvent(new localWindow.Event('pointerdown'));
  chip.click();
  assert.equal(chip.getAttribute('aria-expanded'), 'false');

  chip.click();
  const escape = new localWindow.Event('keydown');
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  chip.dispatchEvent(escape);
  assert.equal(chip.getAttribute('aria-expanded'), 'false');

  clearInline();
  assert.equal(localWindow.document.querySelector('[data-dal-chip]'), null);

  renderInline({
    cards: [],
    skippedProtocols: 0,
    generatedAt: Date.now(),
    summary: {
      estDailyUsd: 1,
      knownEstDailyUsd: 1,
      rewardCoverageComplete: false,
      rateCoverageComplete: true,
      coveredUsd: 100,
      uncoveredUsd: 0,
      lpTotal: 0,
      lpOutOfRange: 0,
      claimableUsd: 10,
      claimableState: 'partial',
      claimTop: [],
      claimFailures: [{ chainId: 8453, chainLabel: 'Base', reason: 'HTTP 503' }],
    },
  });
  const subtotalHost = localWindow.document.querySelector<HTMLElement>('[data-dal-chip="summary"]');
  const subtotalText = subtotalHost?.shadowRoot?.querySelector('.chip')?.textContent ?? '';
  const subtotalTip = subtotalHost?.shadowRoot?.querySelector('.tip')?.textContent ?? '';
  assert.match(subtotalText, /^今日小计 /);
  assert.doesNotMatch(subtotalText, /已确认|确认/);
  assert.match(subtotalTip, /Base（HTTP 503）/);

  clearInline();

  localWindow.document.body.innerHTML = '<section><span>Morpho</span><span>$100</span><div><span>Lending</span><span>Supplied</span><span>Balance</span><span>USD Value</span><span>USDe</span></div></section>';
  const asset = {
    leg: 'supply' as const,
    token: { address: '0x1', chain: 'base', symbol: 'USDe', amount: 100, priceUsd: 1, usd: 100 },
    baseApy: 0,
    rewardApr: 0.045,
    rewardState: 'numeric-known' as const,
    rewardComponents: [{
      id: 'merkl:8453:campaign',
      value: 0.045,
      rateKind: 'apr' as const,
      source: 'merkl',
      sourceUrl: 'https://app.merkl.xyz/opportunities/15882969063492504801',
      basis: 'collateral' as const,
      label: 'USDe',
    }],
    rewardEntitlements: [{
      id: 'lista-points',
      label: 'Lista Points',
      display: '5x Points',
      source: 'https://lista.org/lending',
      basis: 'collateral' as const,
      verification: 'rule-confirmed' as const,
    }],
    source: 'morpho-api:collateral + merkl:morphocollateral',
  };
  const protocolYield = {
    equityUsd: 100,
    leverage: null,
    netApy: 0.045,
    estDailyUsd: 0.012,
    knownNetApy: 0.045,
    knownEstDailyUsd: 0.012,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: [asset],
  };
  renderInline({
    cards: [{
      key: 'base:base_morphoblue',
      title: 'Morpho',
      chainLabel: 'Base',
      kind: 'rates',
      yield: protocolYield,
      items: [{ name: 'Lending', yield: protocolYield }],
    }],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  const assetHost = localWindow.document.querySelector<HTMLElement>('[data-dal-chip="asset"]');
  const tooltipHost = localWindow.document.querySelector<HTMLElement>('[data-dal-chip="tooltip"]');
  const tooltipText = tooltipHost?.shadowRoot?.querySelector('.tip')?.textContent ?? '';
  const sourceLinks = [...(tooltipHost?.shadowRoot?.querySelectorAll<HTMLAnchorElement>('a.source-link') ?? [])];
  assert.ok(assetHost && tooltipHost);
  assert.equal(assetHost.shadowRoot?.querySelector('.tip'), null);
  assert.equal(tooltipHost.parentElement, localWindow.document.body);
  assert.match(tooltipHost.style.cssText, /position:\s*fixed/i);
  assert.match(tooltipText, /奖励与积分说明/);
  assert.match(tooltipText, /积分只展示倍数或资格，不折算成 APY/);
  assert.equal(sourceLinks.length, 2);
  assert.equal(sourceLinks[0]?.href, 'https://app.merkl.xyz/opportunities/15882969063492504801');
  assert.equal(sourceLinks[0]?.target, '_blank');
  assert.equal(sourceLinks[0]?.rel, 'noopener noreferrer');
  assert.equal(sourceLinks[1]?.href, 'https://lista.org/lending');
  const assetChip = assetHost.shadowRoot?.querySelector<HTMLElement>('.chip');
  assetChip?.click();
  assert.equal(assetChip?.getAttribute('aria-expanded'), 'true');
  assert.equal(tooltipHost.shadowRoot?.querySelector('.tip')?.classList.contains('open'), true);

  clearInline();
  assert.equal(localWindow.document.querySelector('[data-dal-chip="tooltip"]'), null);

  const lpHost = rangeWidget({
    positionIndex: '339010',
    inRange: true,
    fullRange: false,
    feePct: 0.00005,
    feeApy: null,
    incentiveApr: null,
    incentiveState: 'not-applicable',
    lowerPrice: 0.9998,
    upperPrice: 1,
    currentPrice: 0.9999,
    pct: 0.5,
    baseSymbol: 'USDe',
    quoteSymbol: 'USDC',
  }, [
    {
      leg: 'supply',
      token: { address: '0xusde', chain: 'eth', symbol: 'USDe', amount: 1, priceUsd: 1, usd: 444_000 },
      baseApy: null,
      rewardApr: null,
      rewardState: 'not-applicable',
      source: 'lp',
    },
    {
      leg: 'supply',
      token: { address: '0xusdc', chain: 'eth', symbol: 'USDC', amount: 1, priceUsd: 1, usd: 756_000 },
      baseApy: null,
      rewardApr: null,
      rewardState: 'not-applicable',
      source: 'lp',
    },
  ], 'eth:eth_uniswap4:lp0');
  const lpRoot = lpHost.shadowRoot;
  assert.equal(lpRoot?.querySelector('.pid')?.textContent, '#339010');
  assert.equal(lpRoot?.querySelector('.tag')?.textContent, '区间内');
  assert.equal(lpRoot?.querySelector('.cur')?.textContent, '0.9999');
  assert.deepEqual(
    [...(lpRoot?.querySelectorAll('.rw-bounds span') ?? [])].map((node) => node.textContent),
    ['0.9998', '1.000'],
  );
  assert.equal(lpRoot?.querySelector('.rw-ctxt')?.textContent, 'USDe 37% · USDC 63%');
  const lpText = lpRoot?.querySelector('.rw')?.textContent ?? '';
  assert.doesNotMatch(lpText, /\$1\.20M|USDC\/USDe|费率档|手续费|激励|APY/);

  const outHost = rangeWidget({
    positionIndex: '86498',
    inRange: false,
    fullRange: false,
    feePct: 0.0005,
    feeApy: null,
    incentiveApr: null,
    incentiveState: 'not-applicable',
    lowerPrice: 3917,
    upperPrice: 3940,
    currentPrice: 1800,
    pct: -92,
    baseSymbol: 'ETH',
    quoteSymbol: 'USDC',
  }, [], 'arb:arb_uniswap4:lp0');
  const outRoot = outHost.shadowRoot;
  assert.equal(outRoot?.querySelector('.cur')?.textContent, '1,800');
  assert.equal((outRoot?.querySelector<HTMLElement>('.cur'))?.style.left, '0.0%');
  assert.deepEqual(
    [...(outRoot?.querySelectorAll('.rw-bounds span') ?? [])].map((node) => node.textContent),
    ['3,917', '3,940'],
  );

  clearInline();
  localWindow.document.body.innerHTML = '<section><div><span>Uniswap V4</span><span>$32,544</span></div><div><span>Pool</span><span>Balance</span><span>USD Value</span><span>#86498</span><span>ETH</span><span>USDC</span></div></section>';
  const lpAssets = [
    {
      leg: 'supply' as const,
      token: { address: '0xeth', chain: 'arb', symbol: 'ETH', amount: 1, priceUsd: 1_800, usd: 32_544 },
      baseApy: null,
      rewardApr: null,
      rewardState: 'not-applicable' as const,
      source: 'uniswap-v4:policy-excluded',
    },
    {
      leg: 'supply' as const,
      token: { address: '0xusdc', chain: 'arb', symbol: 'USDC', amount: 0, priceUsd: 1, usd: 0 },
      baseApy: null,
      rewardApr: null,
      rewardState: 'not-applicable' as const,
      source: 'uniswap-v4:policy-excluded',
    },
  ];
  const lpYield = {
    equityUsd: 32_544,
    leverage: null,
    netApy: null,
    estDailyUsd: null,
    knownNetApy: null,
    knownEstDailyUsd: null,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: ['手续费收益按策略不估算且不计入组合收益'],
    assets: lpAssets,
  };
  renderInline({
    cards: [{
      key: 'arb:arb_uniswap4',
      title: 'Uniswap V4',
      chainLabel: 'Arbitrum',
      kind: 'lp',
      yield: lpYield,
      items: [{
        name: 'Liquidity Pool',
        yield: lpYield,
        range: {
          positionIndex: '86498',
          inRange: false,
          fullRange: false,
          feePct: 0.0005,
          feeApy: null,
          incentiveApr: null,
          incentiveState: 'not-applicable',
          lowerPrice: 3917,
          upperPrice: 3940,
          currentPrice: 1800,
          pct: -92,
          baseSymbol: 'ETH',
          quoteSymbol: 'USDC',
        },
      }],
    }],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  assert.equal(localWindow.document.querySelector('[data-dal-chip="protocol"]'), null);
  assert.ok(localWindow.document.querySelector('[data-dal-chip="item"]'));
});

test('chain-filtered pages never mis-anchor hidden cards onto strip decoys (第四铁律)', async () => {
  // 事故复刻(2026-07-14,?chain=base):eth/hood 的 Morpho 卡被链筛选藏掉后,标题文本只剩
  // 协议条里的同名 chip;其 fsa 爬进巨型容器,chip 被插进容器内第一个美元金额(链条上的
  // Ethereum $13,799,444),hood 的 USDe 资产 chip 还叠进了 Base 卡的 USDe 行。
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  const { PANEL_HOST_ID } = await import('../utils/overlay.ts');

  // 巨型页面容器:链条(Ethereum $13,799,444)+ 协议条(Morpho $1,404,705)+ 填充文本
  // + 真正的 Base Morpho 卡(小容器,含自己的净值与资产符号)
  localWindow.document.body.innerHTML = [
    '<div id="page">',
    // 真机实锤形态(2026-07-14):条目行本身无符号(fsa 必然爬到聚合层);聚合层(>1600 字符)
    // 里既有「隐藏卡的精确净值」(单协议链场景:链条总额==卡净值,实锤 Robinhood $638,221)
    // 又有精确 USDe 文本节点——「含本卡净值即豁免」会被精确击穿,上限必须绝对、无豁免
    '<div id="chain-strip"><span>Ethereum</span><span id="eth-amount">$13,799,444</span><span>Base</span><span>$1,431,863</span><span>Robinhood</span><span>$13,500,000</span></div>',
    '<div id="proto-strip"><span>Morpho</span><span>$1,404,705</span></div>',
    '<div id="strip-misc"><span>USDe</span></div>',
    `<p>${'滤'.repeat(1800)}</p>`,
    '<section id="real-card"><span>Morpho</span><span id="card-amount">$1,404,705</span>',
    '<div><span>Lending</span><span>Supplied</span><span>Balance</span><span>USD Value</span><span>USDe</span><span>USDC</span></div></section>',
    '</div>',
  ].join('');

  const mkAsset = (symbol: string, usdValue: number) => ({
    leg: 'supply' as const,
    token: { address: `0x${symbol.toLowerCase()}`, chain: 'base', symbol, amount: usdValue, priceUsd: 1, usd: usdValue },
    baseApy: 0,
    rewardApr: 0,
    rewardState: 'confirmed-zero' as const,
    rewardComponents: [],
    source: 'test',
  });
  const mkYield = (equityUsd: number, symbols: string[]) => ({
    equityUsd,
    leverage: null,
    netApy: 0.1,
    estDailyUsd: 1,
    knownNetApy: 0.1,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: symbols.map((symbol) => mkAsset(symbol, equityUsd / symbols.length)),
  });
  const baseYield = mkYield(1_404_705, ['USDe', 'USDC']);
  const ethYield = mkYield(13_500_000, ['USDe', 'USDC']);
  renderInline({
    cards: [
      { key: 'base:base_morphoblue', title: 'Morpho', chainLabel: 'Base', kind: 'rates', yield: baseYield, items: [{ name: 'Lending', yield: baseYield }] },
      { key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: ethYield, items: [{ name: 'Lending', yield: ethYield }] },
    ],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });

  const doc = localWindow.document;
  const protocolChips = [...doc.querySelectorAll('[data-dal-chip="protocol"]')];
  // 只有真卡片能挂协议 chip;被藏掉的 eth 卡必须落面板,绝不能贴到链条/协议条上
  assert.equal(protocolChips.length, 1);
  assert.ok(doc.querySelector('#real-card [data-dal-chip="protocol"]'), '协议 chip 必须在真卡片内');
  assert.equal(doc.querySelector('#chain-strip [data-dal-chip]'), null, '链条金额上绝不能有任何 chip');
  assert.equal(doc.querySelector('#proto-strip [data-dal-chip]'), null, '协议条上绝不能有任何 chip');
  // 资产 chip 只出现在真卡片内(hood/eth 的同名资产不得叠行)
  const assetChips = [...doc.querySelectorAll('[data-dal-chip="asset"]')];
  assert.ok(assetChips.length >= 1);
  for (const chip of assetChips) {
    assert.ok(chip.closest('#real-card'), '资产 chip 只能在真卡片内');
  }
  // 被藏掉的卡降级到悬浮面板(数据不丢)
  assert.ok(doc.getElementById(PANEL_HOST_ID), '未锚定卡片必须落悬浮面板');

  clearInline();
});

// 2026-07-14 二次事故复刻:Robinhood 过滤+渐进渲染半成品态,聚合容器(侧栏+链格+钱包表)
// 合法缩到 1600 字符以下、嵌套 Wallet 表格自带 "USD Value"、还含本卡净值(侧栏协议行)——
// 体量上限/表头标记/净值匹配全部被合法穿透,chip 曾落进链格 Ethereum 总额。
// 唯一挡得住的是聚合区排他特征("Wallet" 文本 / ≥2 链名),以及页面补全后的谓词复检。
test('filtered semi-rendered pages reject aggregate containers and self-heal (二次事故)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline, placedAnchorsStillValid, reinjectNeeded } = await import('../utils/inline.ts');
  const { PANEL_HOST_ID } = await import('../utils/overlay.ts');

  // 半渲染态:真卡片缺席,唯一 "Morpho" 文本在侧栏;fsa 会爬进含钱包表的聚合容器。
  // ⚠️ 结构刻意让聚合容器的**首金额==hood 卡净值**(侧栏协议行 $645,605 排最前):
  // own 数值命中、体量 <1600、含 USD Value 全部合法通过,唯一能拦住的只剩聚合区
  // 特征——否则本测试的聚合守卫会被 wildMismatch 掩护成零咬合(对抗审查 finding 8)
  localWindow.document.body.innerHTML = [
    '<div id="wrap">',
    '<div id="side"><span>Morpho</span><span>$645,605</span><span>Wallet</span></div>',
    '<div id="chains"><span>Ethereum</span><span id="eth-total">$11,422,223</span><span>Base</span><span>$1,430,261</span><span>Robinhood</span><span>$645,614</span></div>',
    '<div id="wallet-card"><span>Token</span><span>USD Value</span><span>USDe</span><span>$9</span></div>',
    '</div>',
  ].join('');

  const mkYield = (equityUsd: number, symbols: string[]) => ({
    equityUsd,
    leverage: 9.53,
    netApy: 0.1393,
    estDailyUsd: 1,
    knownNetApy: 0.1393,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: symbols.map((symbol) => ({
      leg: 'supply' as const,
      token: { address: `0x${symbol.toLowerCase()}`, chain: 'hood', symbol, amount: 1, priceUsd: 1, usd: equityUsd / symbols.length },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    })),
  });
  const hoodYield = mkYield(645_605, ['USDe', 'USDT']);
  const baseYield = mkYield(1_404_705, ['USDe', 'USDC']);
  const cards = [
    { key: 'hood:hood_morphoblue', title: 'Morpho', chainLabel: 'Robinhood', kind: 'rates' as const, yield: hoodYield, items: [{ name: 'Lending', yield: hoodYield }] },
    { key: 'base:base_morphoblue', title: 'Morpho', chainLabel: 'Base', kind: 'rates' as const, yield: baseYield, items: [{ name: 'Lending', yield: baseYield }] },
  ];
  renderInline({ cards, skippedProtocols: 0, generatedAt: Date.now() });

  const doc = localWindow.document;
  // 聚合容器体量/表头/净值全合法,但含 "Wallet"+多链名 → 必须整体拒绝,零 chip 落页
  assert.equal(doc.querySelectorAll('[data-dal-chip="protocol"]').length, 0, '半渲染态绝不允许锚进聚合容器');
  assert.equal(doc.querySelector('#chains [data-dal-chip]'), null, '链格金额上绝不能有任何 chip');
  assert.ok(doc.getElementById(PANEL_HOST_ID), '未锚定卡片必须落面板');

  // 页面补全:真 hood 卡渲染出来 → 重新注入后 chip 必须只在真卡片里
  const hoodCard = doc.createElement('section');
  hoodCard.id = 'hood-card';
  hoodCard.innerHTML = '<span>Morpho</span><span id="hood-amount">$645,605</span><div><span>Supplied</span><span id="hood-marker">USD Value</span><span>USDe</span><span>USDT</span></div>';
  doc.getElementById('wrap')?.appendChild(hoodCard);
  renderInline({ cards, skippedProtocols: 0, generatedAt: Date.now() });
  assert.equal(doc.querySelectorAll('[data-dal-chip="protocol"]').length, 1);
  assert.ok(doc.querySelector('#hood-card [data-dal-chip="protocol"]'), '协议 chip 必须在真卡片内');
  assert.equal(doc.querySelector('#chains [data-dal-chip]'), null);

  // 谓词复检:五个失效分支逐条钉死(对抗审查 finding 10:只测一支=其余四支可删仍绿),
  // 每条 改DOM→断言失效→复原→断言恢复。(本 fixture base 卡常驻 leftover,重试判定
  // 恒为真,reinjectNeeded 对复检分支的独立咬合放在「宽带双向边界」的零 leftover 场景)
  assert.equal(placedAnchorsStillValid(), true);
  assert.ok(reinjectNeeded, '重试判定必须导出可测');

  // ① 聚合特征混入(React 复用节点)
  const intruder = doc.createElement('span');
  intruder.textContent = 'Wallet';
  hoodCard.appendChild(intruder);
  assert.equal(placedAnchorsStillValid(), false, '容器长出聚合特征后复检必须失效');
  intruder.remove();
  assert.equal(placedAnchorsStillValid(), true);

  // ② React 原地互换卡内容:首金额变成**他卡**净值(结构谓词全盲,靠距离裁决抓)
  const hoodAmount = doc.getElementById('hood-amount');
  const amountText = [...(hoodAmount?.childNodes ?? [])].find((n) => n.nodeType === 3);
  assert.ok(amountText, '金额文本节点必须存在');
  amountText.textContent = '$1,404,705';
  assert.equal(placedAnchorsStillValid(), false, '首金额精确等于他卡净值=被原地互换,必须失效');
  amountText.textContent = '$645,605';
  assert.equal(placedAnchorsStillValid(), true);

  // ③ 失去卡片表头标记
  const marker = doc.getElementById('hood-marker');
  const markerParent = marker?.parentElement;
  marker?.remove();
  assert.equal(placedAnchorsStillValid(), false, '失去 USD Value 表头必须失效');
  if (marker && markerParent) markerParent.insertBefore(marker, markerParent.firstChild);
  assert.equal(placedAnchorsStillValid(), true);

  // ④ 容器长大超过体量上限
  const filler = doc.createElement('p');
  filler.textContent = '滤'.repeat(1700);
  hoodCard.appendChild(filler);
  assert.equal(placedAnchorsStillValid(), false, '容器超 1600 字符必须失效');
  filler.remove();
  assert.equal(placedAnchorsStillValid(), true);

  // ⑤ 整卡被 React 摘除(断连)
  hoodCard.remove();
  assert.equal(placedAnchorsStillValid(), false, '容器断连必须失效');

  clearInline();
});

// 渐进渲染下的跨卡抢锚:eth 卡的真卡片还没渲染时,绝不能凭符号评分抢走 base 的真卡片
// (容器里含 base 自己的净值 = 那是别人的卡)。eth 落面板等待,页面补全后自然接回。
test('a card whose own container is absent must not steal a sibling card anchor (防抢锚)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  const { PANEL_HOST_ID } = await import('../utils/overlay.ts');

  localWindow.document.body.innerHTML = [
    '<div id="page2">',
    '<div id="strips"><span>Wallet</span><span>$283,705</span><span>Morpho</span><span>$1,404,705</span><span>Ethereum</span><span>$11,422,223</span><span>USDe</span></div>',
    // 真机实测:每张卡有 2~4 个同名标题节点(桌面/移动变体)——第二个节点是
    // 后续卡在 pass B 再锚进同一容器的入口,已认领容器排除必须挡住
    '<section id="base-card"><span>Morpho</span><span>Morpho</span><span>$1,404,705</span><div><span>Supplied</span><span>USD Value</span><span>USDe</span><span>USDC</span></div></section>',
    '</div>',
  ].join('');

  const mkYield = (equityUsd: number, netApy: number) => ({
    equityUsd,
    leverage: null,
    netApy,
    estDailyUsd: 1,
    knownNetApy: netApy,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: ['USDe', 'USDC'].map((symbol) => ({
      leg: 'supply' as const,
      token: { address: `0x${symbol.toLowerCase()}`, chain: 'eth', symbol, amount: 1, priceUsd: 1, usd: equityUsd / 2 },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    })),
  });
  // 两卡净值相近(±25% 宽带内)但可区分(>2%):这是 foreign 数值守卫的独有防区
  const ethYield = mkYield(1_500_000, 0.2);
  const baseYield = mkYield(1_404_705, 0.1);
  renderInline({
    cards: [
      // eth 卡故意排前:贪心按序认领时它会先抢 base 的真卡片,两段式认领必须挡住
      { key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: ethYield, items: [{ name: 'Lending', yield: ethYield }] },
      { key: 'base:base_morphoblue', title: 'Morpho', chainLabel: 'Base', kind: 'rates', yield: baseYield, items: [{ name: 'Lending', yield: baseYield }] },
    ],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });

  const doc = localWindow.document;
  const chips = [...doc.querySelectorAll<HTMLElement>('[data-dal-chip="protocol"]')];
  assert.equal(chips.length, 1, '只有 base 卡能锚上');
  assert.ok(chips[0]?.closest('#base-card'), 'chip 必须在 base 真卡片内');
  const chipText = chips[0]?.shadowRoot?.querySelector('.chip')?.textContent ?? '';
  assert.match(chipText, /10%/, '贴的必须是 base 卡自己的净APY');
  assert.doesNotMatch(chipText, /20%/, '绝不能是 eth 卡的净APY(抢锚)');
  assert.ok(doc.getElementById(PANEL_HOST_ID), 'eth 卡落面板等待页面补全');

  clearInline();
});

// 被 enrich 跳过的同名仓位不在 foreignEquities 里,数值守卫护不到它的卡——
// 评分认领必须受宽带约束(首金额偏离本卡净值 ±25% 以上不许认领),否则被抢后
// chip 数量稳定、永不自愈(与二次事故同型的冻结死区)。
test('score-based claiming must not take a container whose amount is wildly foreign (宽带约束)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  const { PANEL_HOST_ID } = await import('../utils/overlay.ts');

  // 页面上只有「被跳过的」Morpho 卡($1,404,705);enrich 结果里只有 eth 卡(13.5M)
  localWindow.document.body.innerHTML =
    '<section id="skipped-card"><span>Morpho</span><span>$1,404,705</span><div><span>Supplied</span><span>USD Value</span><span>USDe</span><span>USDC</span></div></section>';

  const ethYield = {
    equityUsd: 13_500_000,
    leverage: null,
    netApy: 0.2,
    estDailyUsd: 1,
    knownNetApy: 0.2,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: ['USDe', 'USDC'].map((symbol) => ({
      leg: 'supply' as const,
      token: { address: `0x${symbol.toLowerCase()}`, chain: 'eth', symbol, amount: 1, priceUsd: 1, usd: 6_750_000 },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    })),
  };
  renderInline({
    cards: [
      { key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: ethYield, items: [{ name: 'Lending', yield: ethYield }] },
    ],
    skippedProtocols: 1,
    generatedAt: Date.now(),
  });

  const doc = localWindow.document;
  assert.equal(doc.querySelectorAll('[data-dal-chip="protocol"]').length, 0, '13.5M 的卡绝不能贴上 1.4M 的卡');
  assert.ok(doc.getElementById(PANEL_HOST_ID), 'eth 卡落面板');

  clearInline();
});

// 数值宽带 ±10% 双向钉死(对抗审查 finding 11:只测 10 倍差=0.25 常数上下回归全不可见):
// 接受侧——页面漂移 8% 的唯一真卡必须仍可评分认领;拒绝侧——漂移 15% 必须落面板。
test('score-claim band accepts 8% drift and rejects 15% drift (宽带双向边界)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline, placedAnchorsStillValid, reinjectNeeded } = await import('../utils/inline.ts');
  const mkCard = (equityUsd: number) => {
    const y = {
      equityUsd,
      leverage: null,
      netApy: 0.1,
      estDailyUsd: 1,
      knownNetApy: 0.1,
      knownEstDailyUsd: 1,
      rewardCoverageComplete: true,
      rateCoverageComplete: true,
      flags: [],
      assets: [{
        leg: 'supply' as const,
        token: { address: '0xusde', chain: 'eth', symbol: 'USDe', amount: 1, priceUsd: 1, usd: equityUsd },
        baseApy: 0,
        rewardApr: 0,
        rewardState: 'confirmed-zero' as const,
        rewardComponents: [],
        source: 'test',
      }],
    };
    return { key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates' as const, yield: y, items: [{ name: 'Lending', yield: y }] };
  };

  // 接受侧:页面 $1,080,000 vs 净值 $1,000,000(8% < 10%)
  localWindow.document.body.innerHTML =
    '<section id="card8"><span>Morpho</span><span>$1,080,000</span><div><span>USD Value</span><span>USDe</span></div></section>';
  renderInline({ cards: [mkCard(1_000_000)], skippedProtocols: 0, generatedAt: Date.now() });
  assert.equal(localWindow.document.querySelectorAll('[data-dal-chip="protocol"]').length, 1, '8% 漂移必须仍可认领');
  // 零 leftover 场景下钉死「复检失效 → 重试判定翻转」的接线(对抗审查 finding 9:
  // observer 自愈闭环此前零咬合;定时器链路测不了,至少把判定函数含复检这一环钉死)
  assert.equal(reinjectNeeded(), false, '全部锚定且谓词健康时不应重锚');
  const walletIntruder = localWindow.document.createElement('span');
  walletIntruder.textContent = 'Wallet';
  localWindow.document.getElementById('card8')?.appendChild(walletIntruder);
  assert.equal(placedAnchorsStillValid(), false);
  assert.equal(reinjectNeeded(), true, '复检失效必须触发重锚判定');
  clearInline();

  // 拒绝侧:页面 $1,150,000 vs 净值 $1,000,000(15% > 10%)
  localWindow.document.body.innerHTML =
    '<section id="card15"><span>Morpho</span><span>$1,150,000</span><div><span>USD Value</span><span>USDe</span></div></section>';
  renderInline({ cards: [mkCard(1_000_000)], skippedProtocols: 0, generatedAt: Date.now() });
  assert.equal(localWindow.document.querySelectorAll('[data-dal-chip="protocol"]').length, 0, '15% 漂移必须拒绝落面板');
  clearInline();
});

// 漂移窗口抢锚回归(对抗审查 finding 13 实测残洞):base 页面金额 +3% 漂移出自身
// ±2% 带,排前的 eth 卡曾凭符号评分把它抢走(带宽前置让 foreign 失守)。
// 纯距离裁决:$1,447,000 离 base(1,404,705)比离 eth(1,500,000)近 → eth 被否决。
test('drifted sibling card is protected by pure-distance foreign adjudication (漂移抢锚)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  const { PANEL_HOST_ID } = await import('../utils/overlay.ts');

  localWindow.document.body.innerHTML =
    '<section id="base-card"><span>Morpho</span><span>$1,447,000</span><div><span>USD Value</span><span>USDe</span><span>USDC</span></div></section>';
  const mkYield = (equityUsd: number, netApy: number) => ({
    equityUsd,
    leverage: null,
    netApy,
    estDailyUsd: 1,
    knownNetApy: netApy,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: ['USDe', 'USDC'].map((symbol) => ({
      leg: 'supply' as const,
      token: { address: `0x${symbol.toLowerCase()}`, chain: 'eth', symbol, amount: 1, priceUsd: 1, usd: equityUsd / 2 },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    })),
  });
  const ethYield = mkYield(1_500_000, 0.2);
  const baseYield = mkYield(1_404_705, 0.1);
  renderInline({
    cards: [
      { key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: ethYield, items: [{ name: 'Lending', yield: ethYield }] },
      { key: 'base:base_morphoblue', title: 'Morpho', chainLabel: 'Base', kind: 'rates', yield: baseYield, items: [{ name: 'Lending', yield: baseYield }] },
    ],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  const doc = localWindow.document;
  const chips = [...doc.querySelectorAll<HTMLElement>('[data-dal-chip="protocol"]')];
  assert.equal(chips.length, 1);
  const chipText = chips[0]?.shadowRoot?.querySelector('.chip')?.textContent ?? '';
  assert.match(chipText, /10%/, '漂移中的容器必须归属数值上更近的 base 卡');
  assert.doesNotMatch(chipText, /20%/, '绝不能被排前的 eth 卡抢走');
  assert.ok(doc.getElementById(PANEL_HOST_ID), 'eth 卡落面板');
  clearInline();
});

// 近值双卡回归(Codex finding 2 + 对抗审查 finding 1/5/7,全部 CONFIRMED):
// 等额跨链分仓($1,000,000/$1,010,000,差 1%)是常态持仓,旧的无条件 ±2% foreign
// 否决让两张真卡互杀双双落面板;纯距离裁决下各自容器离自己净值最近,必须都锚上。
test('near-equal twin cards both anchor to their own containers (近值双卡)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');

  localWindow.document.body.innerHTML = [
    '<section id="twin-a"><span>Morpho</span><span>$1,000,000</span><div><span>USD Value</span><span>USDe</span></div></section>',
    '<section id="twin-b"><span>Morpho</span><span>$1,010,000</span><div><span>USD Value</span><span>USDe</span></div></section>',
  ].join('');
  const mkYield = (equityUsd: number, netApy: number) => ({
    equityUsd,
    leverage: null,
    netApy,
    estDailyUsd: 1,
    knownNetApy: netApy,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: [{
      leg: 'supply' as const,
      token: { address: '0xusde', chain: 'eth', symbol: 'USDe', amount: 1, priceUsd: 1, usd: equityUsd },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    }],
  });
  const aYield = mkYield(1_000_000, 0.3);
  const bYield = mkYield(1_010_000, 0.1);
  renderInline({
    cards: [
      { key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: aYield, items: [{ name: 'Lending', yield: aYield }] },
      { key: 'base:base_morphoblue', title: 'Morpho', chainLabel: 'Base', kind: 'rates', yield: bYield, items: [{ name: 'Lending', yield: bYield }] },
    ],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  const doc = localWindow.document;
  assert.equal(doc.querySelectorAll('[data-dal-chip="protocol"]').length, 2, '近值双卡必须都锚上');
  const aChip = doc.querySelector<HTMLElement>('#twin-a [data-dal-chip="protocol"]');
  const bChip = doc.querySelector<HTMLElement>('#twin-b [data-dal-chip="protocol"]');
  assert.match(aChip?.shadowRoot?.querySelector('.chip')?.textContent ?? '', /30%/, 'A 卡贴 A 的净APY');
  assert.match(bChip?.shadowRoot?.querySelector('.chip')?.textContent ?? '', /10%/, 'B 卡贴 B 的净APY');

  // 复检 foreign-closer 独立咬合:A 卡首金额被原地换成 B 的净值(差 1%,own ±25%
  // 结构带完全拦不住)——只有「离他卡更近」的距离裁决能发现互换(对抗审查 finding 4)
  const { placedAnchorsStillValid } = await import('../utils/inline.ts');
  assert.equal(placedAnchorsStillValid(), true);
  const twinAAmount = [...(doc.querySelector('#twin-a span:nth-of-type(2)')?.childNodes ?? [])]
    .find((n) => n.nodeType === 3);
  assert.ok(twinAAmount, 'A 卡金额文本节点必须存在');
  twinAAmount.textContent = '$1,010,000';
  assert.equal(placedAnchorsStillValid(), false, 'A 卡首金额精确等于 B 净值=被互换,复检必须失效');
  clearInline();
});

// 无首金额容器(渲染半成品)绝不许凭符号裸认领——错认后金额补上也不重分配
// (Codex 独立盲审 finding 1a 复现路径)。
test('a container without any dollar amount is never claimed at protocol level (无金额不认领)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  const { PANEL_HOST_ID } = await import('../utils/overlay.ts');
  localWindow.document.body.innerHTML =
    '<section id="half-card"><span>Morpho</span><div><span>USD Value</span><span>USDe</span></div></section>';
  const y = {
    equityUsd: 1_000_000,
    leverage: null,
    netApy: 0.1,
    estDailyUsd: 1,
    knownNetApy: 0.1,
    knownEstDailyUsd: 1,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: [{
      leg: 'supply' as const,
      token: { address: '0xusde', chain: 'eth', symbol: 'USDe', amount: 1, priceUsd: 1, usd: 1_000_000 },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    }],
  };
  renderInline({
    cards: [{ key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: y, items: [{ name: 'Lending', yield: y }] }],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  const doc = localWindow.document;
  assert.equal(doc.querySelectorAll('[data-dal-chip="protocol"]').length, 0, '无金额容器必须落面板等待渲染补全');
  assert.ok(doc.getElementById(PANEL_HOST_ID));
  clearInline();
});

// 负净值卡(借>存)的卡头是 "-$1,234":正则不认负号时 walker 会把下一个资产行金额
// 错当 header,数值身份判定建立在错的数字上(对抗审查 finding 6)。
test('negative net value card header is recognized and anchors (负净值卡头)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline } = await import('../utils/inline.ts');
  localWindow.document.body.innerHTML =
    '<section id="neg-card"><span>Morpho</span><span>-$1,234</span><div><span>USD Value</span><span>USDe</span><span>$5,000</span></div></section>';
  const y = {
    equityUsd: -1234,
    leverage: null,
    netApy: null,
    estDailyUsd: null,
    knownNetApy: null,
    knownEstDailyUsd: null,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: ['权益≤0（满杠杆或坏账），净APY在此无定义'],
    assets: [{
      leg: 'supply' as const,
      token: { address: '0xusde', chain: 'eth', symbol: 'USDe', amount: 1, priceUsd: 1, usd: 5000 },
      baseApy: 0,
      rewardApr: 0,
      rewardState: 'confirmed-zero' as const,
      rewardComponents: [],
      source: 'test',
    }],
  };
  renderInline({
    cards: [{ key: 'eth:morphoblue', title: 'Morpho', chainLabel: 'Ethereum', kind: 'rates', yield: y, items: [{ name: 'Lending', yield: y }] }],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  const doc = localWindow.document;
  assert.equal(doc.querySelectorAll('#neg-card [data-dal-chip="protocol"]').length, 1, '负净值卡必须按 -$ 头部金额锚上');
  clearInline();
});

// LP 卡先渲染标题/金额/表头、#编号稍后:卡已计入 anchored、leftovers=0,旧重试
// 条件永不触发,widget 永缺(Codex finding 4)。缺失子锚点必须让重试判定保持开启。
test('missing LP position sub-anchor keeps reinject pending (子锚点缺失重试)', async () => {
  const env = parseHTML('<html><body></body></html>');
  const localWindow = env.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: localWindow,
    document: localWindow.document,
    Node: localWindow.Node,
    HTMLElement: localWindow.HTMLElement,
    MutationObserver: localWindow.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ position: 'static' }),
  });
  const { clearInline, renderInline, reinjectNeeded } = await import('../utils/inline.ts');
  // 无 #86498 文本(编号未渲染),其余卡片结构完整
  localWindow.document.body.innerHTML =
    '<section><div><span>Uniswap V4</span><span>$32,544</span></div><div><span>Pool</span><span>USD Value</span><span>ETH</span><span>USDC</span></div></section>';
  const lpYield = {
    equityUsd: 32_544,
    leverage: null,
    netApy: null,
    estDailyUsd: null,
    knownNetApy: null,
    knownEstDailyUsd: null,
    rewardCoverageComplete: true,
    rateCoverageComplete: true,
    flags: [],
    assets: [{
      leg: 'supply' as const,
      token: { address: '0xeth', chain: 'arb', symbol: 'ETH', amount: 1, priceUsd: 1_800, usd: 32_544 },
      baseApy: null,
      rewardApr: null,
      rewardState: 'not-applicable' as const,
      source: 'uniswap-v4:policy-excluded',
    }],
  };
  renderInline({
    cards: [{
      key: 'arb:arb_uniswap4',
      title: 'Uniswap V4',
      chainLabel: 'Arbitrum',
      kind: 'lp',
      yield: lpYield,
      items: [{
        name: 'Liquidity Pool',
        yield: lpYield,
        range: {
          positionIndex: '86498',
          inRange: false,
          fullRange: false,
          feePct: 0.0005,
          feeApy: null,
          incentiveApr: null,
          incentiveState: 'not-applicable',
          lowerPrice: 3917,
          upperPrice: 3940,
          currentPrice: 1800,
          pct: -92,
          baseSymbol: 'ETH',
          quoteSymbol: 'USDC',
        },
      }],
    }],
    skippedProtocols: 0,
    generatedAt: Date.now(),
  });
  assert.equal(localWindow.document.querySelector('[data-dal-chip="item"]'), null, '编号缺席时 widget 不可能已放置');
  assert.equal(reinjectNeeded(), true, '缺失的 LP 子锚点必须让重试保持开启,等编号渲染后自愈');
  clearInline();
});

// React 原地更新文本节点(characterData)必须算实质变化,否则复检永远等不到时机
// (Codex finding 3:childList-only 观察对文本演化全盲)。
test('isMeaningfulMutation counts page characterData but ignores chip-origin records', async () => {
  const { isMeaningfulMutation } = await import('../utils/inline.ts');
  const env = parseHTML('<html><body><div id="page-el">Status</div></body></html>');
  const pageEl = env.document.getElementById('page-el');
  assert.ok(pageEl?.firstChild);
  const chipHost = env.document.createElement('span');
  chipHost.setAttribute('data-dal-chip', 'protocol');
  const mkRecord = (over: Partial<MutationRecord>): MutationRecord =>
    ({ type: 'childList', target: pageEl, addedNodes: [], removedNodes: [], ...over }) as unknown as MutationRecord;
  assert.equal(
    isMeaningfulMutation([mkRecord({ type: 'characterData', target: pageEl.firstChild })]),
    true,
    '页面文本原地更新=实质变化',
  );
  assert.equal(
    isMeaningfulMutation([mkRecord({ type: 'childList', addedNodes: [chipHost] as unknown as NodeList })]),
    false,
    '我们自己的 chip 增删不算',
  );
  assert.equal(
    isMeaningfulMutation([mkRecord({ type: 'childList', addedNodes: [pageEl] as unknown as NodeList })]),
    true,
    '页面节点增删=实质变化',
  );
});

test('makeAggregateTextCheck flags Wallet text and multi-chain labels only', async () => {
  const { makeAggregateTextCheck } = await import('../utils/inline.ts');
  const mk = (chainLabel: string) =>
    ({ chainLabel }) as unknown as Parameters<typeof makeAggregateTextCheck>[0][number];
  const check = makeAggregateTextCheck([mk('Robinhood'), mk('Base'), mk('OP')]);
  assert.equal(check('sidebar Wallet $9'), true, 'Wallet 文本=聚合区');
  assert.equal(check('RobinhoodBase chain grid'), true, '≥2 链名=聚合区');
  assert.equal(check('Robinhood only card text'), false, '单链名不误杀(协议名可等于链名)');
  assert.equal(check('OPOPOP short labels ignored'), false, '<4 字符链名不参与匹配');
});
