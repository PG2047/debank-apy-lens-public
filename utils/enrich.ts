import { findAdapter, findLpRoute, type RegisteredLpRoute } from './adapters/registry';
import { intrinsicApy } from './adapters/onchain';
import {
  merklClaimable,
  type ClaimableFailure,
} from './adapters/merkl';
import {
  computeProtocolYield,
  enforceChildCoverage,
  knownAnnualUsd,
  type AssetYield,
  type ProtocolYield,
} from './apy';
import { CHAINS } from './chains';
import { parseProjectListWithCoverage, type ProtocolPosition } from './debank';
import { withDeadline } from './http';
import { DEBANK_INPUT_LIMITS } from './input-limits';
import { normalizeRewardCoverage, type LegRates } from './adapters/types';
import type { CoverageIssue, EnrichResult, ItemYield, ProtocolCard } from './overlay';
import { buildLegQueries } from './queries';
import { uniswapRanges, type DexFamily, type LpRange } from './uniswap';
import { assessLiquidityRisk } from './liquidity-risk';

const CARD_DEADLINE_MS = 10_000;
export const MIN_PROTOCOL_NET_USD = 100;
const CHAIN_LABEL_BY_ID = new Map(
  Object.values(CHAINS).map((chain) => [chain.chainId, chain.label]),
);

function claimFailureReason(failure: ClaimableFailure): string {
  switch (failure.reason) {
    case 'http': return `HTTP ${failure.status ?? '错误'}`;
    case 'timeout': return '超时';
    case 'response-too-large': return '响应过大';
    case 'invalid-json': return 'JSON 无效';
    case 'invalid-shape': return '响应结构无效';
    case 'invalid-reward': return '奖励字段无效';
    case 'network': return '网络错误';
  }
}

type QueryLegs = ReturnType<typeof buildLegQueries>['legs'];
type LpRoute = {
  p: ProtocolPosition;
  version: 3 | 4;
  family: DexFamily;
  incentivePolicy: RegisteredLpRoute['capability']['unsupportedPolicy'];
};
type LpRangeResolver = typeof uniswapRanges;

function itemNetUsd(item: ProtocolPosition['items'][number]): number {
  return item.supplies.reduce((sum, token) => sum + token.usd, 0) -
    item.borrows.reduce((sum, token) => sum + token.usd, 0);
}

function protocolNetUsd(protocol: ProtocolPosition): number {
  return protocol.items.reduce((total, item) => total + itemNetUsd(item), 0);
}

function protocolCoverageDetail(card: ProtocolCard): string {
  const legName = (leg: AssetYield['leg']): string => leg === 'borrow' ? '借款' : '存款/抵押';
  const assetIssues = card.yield.assets.flatMap((asset) => [
    ...(asset.baseApy === null ? [`${asset.token.symbol} ${legName(asset.leg)}基础利率未匹配`] : []),
    ...(
      asset.rewardState === 'unknown' || asset.rewardState === 'non-annualizable'
        ? [`${asset.token.symbol} ${legName(asset.leg)}${asset.rewardState === 'unknown' ? '奖励未匹配' : '奖励不可年化'}`]
        : []
    ),
  ]);
  const details = [...new Set([...assetIssues, ...card.yield.flags])];
  return `${card.title}（${card.chainLabel}）：${details.join('；') || '基础利率或奖励未完整匹配'}`;
}

function enforceInputCoverage(
  computed: ProtocolYield,
  rateInputIncomplete: boolean,
  rewardInputIncomplete: boolean,
  flags: string[],
): ProtocolYield {
  if (!rateInputIncomplete && !rewardInputIncomplete) return computed;
  return {
    ...computed,
    netApy: null,
    estDailyUsd: null,
    rewardCoverageComplete: rewardInputIncomplete ? false : computed.rewardCoverageComplete,
    rateCoverageComplete: rateInputIncomplete ? false : computed.rateCoverageComplete,
    flags: [...computed.flags, ...flags],
  };
}

function rateCard(
  p: ProtocolPosition,
  chainLabel: string,
  legs: QueryLegs,
  assets: AssetYield[],
): ProtocolCard {
  const items = p.items
    .map((item, idx) => {
      const rateInputIncomplete = item.principalInputCoverageComplete === false;
      const rewardInputIncomplete = rateInputIncomplete || item.rewardInputCoverageComplete === false;
      const computed = computeProtocolYield(assets.filter((_, i) => legs[i].itemIdx === idx));
      return {
        name: item.itemName,
        displayName: item.poolDesc,
        yield: enforceInputCoverage(
          computed,
          rateInputIncomplete,
          rewardInputIncomplete,
          [
            ...(rateInputIncomplete ? ['该 item 的 DeBank 本金腿数据不完整'] : []),
            ...(!rateInputIncomplete && rewardInputIncomplete
              ? ['该 item 的 DeBank 奖励腿数据不完整']
              : []),
          ],
        ),
      };
    })
    .filter((item) => item.yield.assets.length > 0);
  const computed = enforceChildCoverage(
    computeProtocolYield(assets),
    items.map((item) => item.yield),
  );
  const rateInputIncomplete = p.itemCoverageComplete === false;
  const rewardInputIncomplete = rateInputIncomplete || p.rewardInputCoverageComplete === false;
  const inputFlags = [
    ...(rateInputIncomplete ? ['DeBank 仓位数据不完整：仅显示已验证 item/资产腿'] : []),
    ...(!rateInputIncomplete && rewardInputIncomplete
      ? ['DeBank 奖励腿数据不完整：奖励总计仅为已知部分小计']
      : []),
  ];
  const protocolYield = enforceInputCoverage(
    computed,
    rateInputIncomplete,
    rewardInputIncomplete,
    inputFlags,
  );
  return {
    key: `${p.chain}:${p.protocolId}`,
    title: p.name,
    chainLabel,
    pageNetUsd: p.items.reduce((sum, item) => sum + item.netUsd, 0),
    kind: 'rates',
    yield: protocolYield,
    items,
  };
}

function lpCard(
  p: ProtocolPosition,
  chainLabel: string,
  ranges: Map<string, LpRange>,
  incentivePolicy: LpRoute['incentivePolicy'],
  failureReason?: string,
): ProtocolCard {
  const incentiveExcluded = incentivePolicy === 'not-applicable';
  const flags = [
    '手续费收益按策略不估算且不计入组合收益',
    ...(p.itemCoverageComplete === false ? ['DeBank 仓位数据不完整'] : []),
    ...(failureReason ? [failureReason] : []),
  ];
  const items: ItemYield[] = p.items
    .map((item) => {
      const rawRange = item.positionIndex ? ranges.get(item.positionIndex) : undefined;
      const range = rawRange && incentiveExcluded
        ? { ...rawRange, incentiveApr: null, incentiveState: 'not-applicable' as const }
        : rawRange;
      const assets: AssetYield[] = item.supplies.map((token) => ({
        leg: 'supply' as const,
        token,
        baseApy: null,
        rewardApr: null,
        rewardState: incentiveExcluded ? 'not-applicable' as const : 'unknown' as const,
        source: failureReason ? 'lp-timeout-or-error' : 'lp',
      }));
      return {
        name: item.itemName,
        positionId: item.positionIndex,
        range,
        yield: {
          equityUsd: item.supplies.reduce((sum, token) => sum + token.usd, 0),
          leverage: null,
          netApy: null,
          estDailyUsd: null,
          knownNetApy: null,
          knownEstDailyUsd: null,
          rewardCoverageComplete: incentiveExcluded,
          rateCoverageComplete: true,
          flags,
          assets,
        },
      };
    })
    .filter((item) => item.yield.assets.length > 0 || item.range);
  return {
    key: `${p.chain}:${p.protocolId}`,
    title: p.name,
    chainLabel,
    pageNetUsd: p.items.reduce((sum, item) => sum + item.netUsd, 0),
    kind: 'lp',
    yield: {
      equityUsd: items.reduce((sum, item) => sum + item.yield.equityUsd, 0),
      leverage: null,
      netApy: null,
      estDailyUsd: null,
      knownNetApy: null,
      knownEstDailyUsd: null,
      rewardCoverageComplete: incentiveExcluded,
      rateCoverageComplete: true,
      flags,
      assets: items.flatMap((item) => item.yield.assets),
    },
    items,
  };
}

/** Every LP card has a whole-card deadline and returns an explicit unknown card on failure. */
export async function resolveLpCard(
  route: LpRoute,
  timeoutMs = CARD_DEADLINE_MS,
  rangeResolver: LpRangeResolver = uniswapRanges,
  upstreamSignal?: AbortSignal,
): Promise<ProtocolCard> {
  const { p, version, family, incentivePolicy } = route;
  const { chainId, label } = CHAINS[p.chain];
  try {
    const ranges = await withDeadline(
      (signal) => rangeResolver(chainId, p.items, version, family, signal),
      timeoutMs,
      `${p.chain}:${p.protocolId} LP`,
      upstreamSignal,
    );
    return lpCard(p, label, ranges, incentivePolicy);
  } catch (error) {
    if (upstreamSignal?.aborted) throw error;
    console.warn(`[APY Lens] ${family} v${version} LP card failed:`, error);
    return lpCard(
      p,
      label,
      new Map(),
      incentivePolicy,
      incentiveExcludedFailureReason(incentivePolicy),
    );
  }
}

function incentiveExcludedFailureReason(policy: LpRoute['incentivePolicy']): string {
  return policy === 'not-applicable'
    ? 'LP 数据源超时或失败：区间未知；手续费收益与外部激励 APY 均按策略排除'
    : 'LP 数据源超时或失败：区间与外部激励未知；手续费收益仍按策略排除';
}

/** Preserve one actionable gap per exact LP position instead of one portfolio-wide label. */
export function lpIncentiveCoverageIssues(cards: ProtocolCard[]): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const card of cards) {
    if (card.yield.rewardCoverageComplete) continue;
    const items = card.items.length > 0 ? card.items : [null];
    items.forEach((item, index) => {
      const positionId = item?.range?.positionIndex ?? item?.positionId;
      const position = positionId ? `#${positionId}` : item?.name || `仓位 ${index + 1}`;
      const symbols = [...new Set(item?.yield.assets.map((asset) => asset.token.symbol) ?? [])];
      const pair = item?.range
        ? `${item.range.quoteSymbol}/${item.range.baseSymbol}`
        : symbols.join('/') || '资产对未知';
      issues.push({
        id: `lp-incentives:${card.key}:${positionId ?? `item-${index}`}`,
        label: `${card.title} ${position} 外部激励未知`,
        detail: `${card.chainLabel} · ${card.title} · ${position} · ${pair}：外部激励没有个人精确 APR 证据；手续费收益已按策略排除。`,
      });
    });
  }
  return issues;
}

/** Actual worker enrichment core, exported so fixtures exercise routing through the real adapters. */
export async function enrichPayload(
  payload: unknown,
  userAddress?: string,
  signal?: AbortSignal,
): Promise<EnrichResult> {
  signal?.throwIfAborted();
  const parsed = parseProjectListWithCoverage(payload);
  let dustItemsDropped = 0;
  const materialProtocols = parsed.protocols.map((protocol) => {
    const items = protocol.items.filter((item) => Math.abs(itemNetUsd(item)) >= MIN_PROTOCOL_NET_USD);
    dustItemsDropped += protocol.items.length - items.length;
    return { ...protocol, items };
  });
  const protocols = materialProtocols.filter(
    (protocol) => Math.abs(protocolNetUsd(protocol)) >= MIN_PROTOCOL_NET_USD,
  );
  const dustProtocolsDropped = materialProtocols.length - protocols.length;
  if (dustItemsDropped > 0 || dustProtocolsDropped > 0) {
    console.info(
      `[APY Lens] 忽略 ${dustItemsDropped} 个独立仓位、${dustProtocolsDropped} 个协议（净资产<$${MIN_PROTOCOL_NET_USD}），未发起 APY 查询`,
    );
  }
  const supported: { p: ProtocolPosition; adapter: NonNullable<ReturnType<typeof findAdapter>> }[] = [];
  const lpProtocols: LpRoute[] = [];
  const skippedIds: string[] = [];
  for (const p of protocols) {
    const chain = CHAINS[p.chain];
    const adapter = findAdapter(p.protocolId, chain ? {
      chainId: chain.chainId,
      poolIds: p.items.map((item) => item.poolId),
    } : undefined);
    const lpRoute = findLpRoute(p.protocolId);
    const chainSupported = Object.hasOwn(CHAINS, p.chain);
    if (adapter && chainSupported) supported.push({ p, adapter });
    else if (lpRoute && chainSupported) {
      lpProtocols.push({
        p,
        version: lpRoute.version,
        family: lpRoute.family,
        incentivePolicy: lpRoute.capability.unsupportedPolicy,
      });
    } else skippedIds.push(`${p.chain}:${p.protocolId}`);
  }
  if (skippedIds.length) {
    console.info('[APY Lens] 未支持的协议（id 供适配用）:', skippedIds.join(', '));
  }

  const rewardChainIds = [
    ...new Set([1, ...[...supported, ...lpProtocols].map(({ p }) => CHAINS[p.chain].chainId)]),
  ];
  const claimPromise = userAddress
    ? withDeadline(
        (claimSignal) => merklClaimable(userAddress, rewardChainIds, claimSignal),
        CARD_DEADLINE_MS,
        'merkl claimable',
        signal,
      ).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      })
    : Promise.resolve(null);

  let adapterWorkCoverageComplete = true;
  let remainingSkyQueries = DEBANK_INPUT_LIMITS.skyQueriesPerEnrichment;
  let skyOffset = 0;
  const prepared = supported.map(({ p, adapter }) => {
    const { chainId, label } = CHAINS[p.chain];
    const { queries, legs } = buildLegQueries(p, chainId, userAddress);
    const perCard = queries.slice(0, DEBANK_INPUT_LIMITS.adapterQueriesPerCard);
    const adapterQueries = adapter.name === 'sky'
      ? perCard.slice(0, Math.max(0, remainingSkyQueries))
      : perCard;
    if (adapter.name === 'sky') remainingSkyQueries -= adapterQueries.length;
    const queryLimitExceeded = adapterQueries.length !== queries.length;
    if (queryLimitExceeded) adapterWorkCoverageComplete = false;
    const cardPosition: ProtocolPosition = queryLimitExceeded
      ? { ...p, itemCoverageComplete: false, rewardInputCoverageComplete: false }
      : p;
    const entry = {
      p,
      adapter,
      chainId,
      label,
      queries,
      legs,
      adapterQueries,
      cardPosition,
      skyOffset: adapter.name === 'sky' ? skyOffset : null,
    };
    if (adapter.name === 'sky') skyOffset += adapterQueries.length;
    return entry;
  });
  const skyEntries = prepared.filter((entry) => entry.adapter.name === 'sky');
  const skyQueries = skyEntries.flatMap((entry) => entry.adapterQueries);
  const skyBatchPromise: Promise<(LegRates | null)[]> | null = skyEntries.length > 0
    ? withDeadline(
        (batchSignal) => skyEntries[0].adapter.resolve(skyQueries, batchSignal),
        CARD_DEADLINE_MS,
        'sky:batch',
        signal,
      ).catch((error) => {
        if (signal?.aborted) throw error;
        console.warn('[APY Lens] sky resolve failed:', error);
        return skyQueries.map(() => null);
      })
    : null;
  const cardsPromise = Promise.all(
    prepared.map(async ({
      p,
      adapter,
      chainId,
      label,
      legs,
      adapterQueries,
      cardPosition,
      skyOffset: cardSkyOffset,
    }): Promise<ProtocolCard> => {
      return withDeadline(async (cardSignal): Promise<ProtocolCard> => {
        const rates = adapter.name === 'sky' && skyBatchPromise && cardSkyOffset !== null
          ? (await skyBatchPromise).slice(cardSkyOffset, cardSkyOffset + adapterQueries.length)
          : await adapter.resolve(adapterQueries, cardSignal).catch((error) => {
              if (cardSignal.aborted) throw error;
              console.warn(`[APY Lens] ${adapter.name} resolve failed:`, error);
              return adapterQueries.map(() => null);
            });
        const assets: AssetYield[] = legs.map((leg, index) => {
          const rate = index < adapterQueries.length ? rates[index] : null;
          const reward = rate
            ? normalizeRewardCoverage(rate)
            : normalizeRewardCoverage({ rewardApr: null, rewardState: 'unknown' });
          return {
            leg: leg.leg,
            token: leg.token,
            baseApy: rate?.baseApy ?? null,
            includesIntrinsicYield: rate?.includesIntrinsicYield,
            ...reward,
            rewardEntitlements: rate?.rewardEntitlements,
            ...(rate?.poolStat ? { poolStat: rate.poolStat } : {}),
            source: rate?.source ?? (index < adapterQueries.length ? 'unmatched' : 'input-limit'),
          };
        });
        await Promise.all(
          assets.map(async (asset, index) => {
            // The unprocessed suffix stays unknown and cannot trigger fallback RPC work.
            if (index >= adapterQueries.length) return;
            if (asset.includesIntrinsicYield) return;
            const intrinsic = await intrinsicApy(chainId, asset.token.address, cardSignal).catch((error) => {
              if (cardSignal.aborted) throw error;
              return null;
            });
            if (!intrinsic) return;
            if (asset.baseApy === null) {
              asset.source = `${asset.source} +${intrinsic.label}内生收益已知（协议基础利率仍未知）`;
              return;
            }
            asset.baseApy += intrinsic.apy;
            asset.source = `${asset.source} +${intrinsic.label}内生${(intrinsic.apy * 100).toFixed(2)}%`;
          }),
        );
        return rateCard(cardPosition, label, legs, assets);
      }, CARD_DEADLINE_MS, `${p.chain}:${p.protocolId}`, signal).catch((error) => {
        if (signal?.aborted) throw error;
        console.warn(`[APY Lens] ${adapter.name} card deadline:`, error);
        return rateCard(
          cardPosition,
          label,
          legs,
          legs.map((leg) => ({
            leg: leg.leg,
            token: leg.token,
            baseApy: null,
            rewardApr: null,
            rewardState: 'unknown',
            rewardComponents: [],
            source: 'source-timeout',
          })),
        );
      });
    }),
  );
  const lpCardsPromise = Promise.all(lpProtocols.map((route) =>
    resolveLpCard(route, CARD_DEADLINE_MS, uniswapRanges, signal)));
  const [cards, lpCards, claim] = await Promise.all([cardsPromise, lpCardsPromise, claimPromise]);
  signal?.throwIfAborted();
  if (claim?.failures.length) {
    console.warn(
      '[APY Lens] Merkl 待领奖励查询失败:',
      claim.failures
        .map((failure) => `${failure.chainId}:${claimFailureReason(failure)}`)
        .join(', '),
    );
  }
  const rateInputCoverageComplete = parsed.rateInputCoverageComplete && adapterWorkCoverageComplete;
  const rewardInputCoverageComplete = parsed.rewardInputCoverageComplete && adapterWorkCoverageComplete;
  const inputCoverageComplete = rateInputCoverageComplete && rewardInputCoverageComplete;
  const inputLimitReasons = adapterWorkCoverageComplete
    ? parsed.inputLimitReasons
    : [...new Set([...parsed.inputLimitReasons, 'adapter-query-limit'])];

  const cardsKept = cards;
  const lpKept = lpCards;

  let estDaily = 0;
  let coveredUsd = 0;
  let uncoveredUsd = 0;
  let excludedUsd = 0;
  let rewardCoverageComplete = rewardInputCoverageComplete;
  let rateCoverageComplete = rateInputCoverageComplete;
  let liquidityRedCount = 0;
  for (const card of cardsKept) {
    rewardCoverageComplete &&= card.yield.rewardCoverageComplete;
    rateCoverageComplete &&= card.yield.rateCoverageComplete;
    for (const asset of card.yield.assets) {
      estDaily += knownAnnualUsd(asset) / 365;
      if (asset.baseApy === null) uncoveredUsd += asset.token.usd;
      else coveredUsd += asset.token.usd;
      if (
        asset.leg === 'supply' &&
        assessLiquidityRisk(
          { usd: asset.token.usd, tokens: asset.token.amount },
          asset.poolStat,
        ).level === 'red'
      ) {
        liquidityRedCount += 1;
      }
    }
  }
  let lpTotal = 0;
  let lpOutOfRange = 0;
  for (const card of lpKept) {
    excludedUsd += card.yield.assets.reduce((sum, asset) => sum + asset.token.usd, 0);
    for (const item of card.items) {
      if (!item.range) continue;
      lpTotal += 1;
      if (!item.range.inRange) lpOutOfRange += 1;
    }
  }

  const coverageIssues: CoverageIssue[] = [];
  if (!inputCoverageComplete) {
    coverageIssues.push({
      id: 'input-coverage',
      label: 'DeBank 输入不完整',
      detail: `DeBank 输入超出安全边界：${inputLimitReasons.join('、') || '结构不完整'}`,
    });
  }
  for (const card of cardsKept) {
    if (card.yield.rateCoverageComplete && card.yield.rewardCoverageComplete) continue;
    coverageIssues.push({
      id: `protocol:${card.key}`,
      label: `${card.title} 数据不完整`,
      detail: protocolCoverageDetail(card),
    });
  }
  coverageIssues.push(...lpIncentiveCoverageIssues(lpKept));
  const claimableState = claim?.coverage ?? 'unknown';
  if (userAddress && claimableState !== 'complete') {
    const failures = (claim?.failures ?? []).map((failure) =>
      `${CHAIN_LABEL_BY_ID.get(failure.chainId) ?? `Chain ${failure.chainId}`}（${claimFailureReason(failure)}）`);
    coverageIssues.push({
      id: 'merkl-claimable',
      label: 'Merkl 待领奖励不完整',
      detail: failures.length > 0
        ? `Merkl 待领奖励查询失败：${failures.join('、')}`
        : 'Merkl 待领奖励查询没有返回完整结果',
    });
  }

  return {
    cards: [...cardsKept, ...lpKept],
    skippedProtocols: skippedIds.length + parsed.droppedProjects,
    inputCoverageComplete,
    inputLimitReasons,
    coverageIssues,
    generatedAt: Date.now(),
    summary: cardsKept.length + lpKept.length > 0 || !inputCoverageComplete
      ? {
          estDailyUsd: estDaily,
          knownEstDailyUsd: estDaily,
          rewardCoverageComplete,
          rateCoverageComplete,
          coveredUsd,
          uncoveredUsd,
          excludedUsd,
          lpTotal,
          lpOutOfRange,
          liquidityRedCount,
          claimableUsd: claim?.coverage === 'unknown' ? null : (claim?.totalUsd ?? null),
          claimableState: claim?.coverage ?? 'unknown',
          claimTop: claim?.top ?? [],
          claimFailures: (claim?.failures ?? []).map((failure) => ({
            chainId: failure.chainId,
            chainLabel: CHAIN_LABEL_BY_ID.get(failure.chainId) ?? `Chain ${failure.chainId}`,
            reason: claimFailureReason(failure),
          })),
        }
      : undefined,
  };
}
