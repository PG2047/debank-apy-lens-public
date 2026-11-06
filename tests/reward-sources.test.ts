import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rewardComponentSource,
  rewardEntitlementSource,
} from '../utils/reward-sources.ts';

test('every production reward source family resolves to an HTTPS explanation link', () => {
  const sources = [
    'merkl',
    'aave-v4官方',
    'aave-v3官方',
    'morpho-api',
    'lista-api',
    'moolah链上',
    'spark官方',
    'sky:official-farm-api + onchain-identity',
    'dolomite官方',
    'compound官方',
    'venus官方',
    'fluid-rewards-api',
    'defillama:spark',
    'ethena官方(周更)',
    'falcon官方(7日均)',
  ];
  for (const source of sources) {
    const presentation = rewardComponentSource({
      id: source,
      value: 0.01,
      rateKind: 'apr',
      source,
      basis: 'supply',
    });
    assert.ok(presentation, source);
    assert.match(presentation.url, /^https:\/\//);
    assert.ok(presentation.description.length > 10);
  }
});

test('an exact Merkl activity URL overrides the catalog homepage', () => {
  const source = rewardComponentSource({
    id: 'merkl:8453:campaign',
    value: 0.045,
    rateKind: 'apr',
    source: 'merkl',
    sourceUrl: 'https://app.merkl.xyz/opportunities/15882969063492504801',
    basis: 'collateral',
    label: 'USDe',
  });
  assert.equal(source?.title, '奖励 USDe 来源说明');
  assert.equal(source?.linkLabel, '查看本次 Merkl 奖励活动');
  assert.equal(source?.url, 'https://app.merkl.xyz/opportunities/15882969063492504801');
});

test('points and ecosystem entitlements use their exact HTTPS rule URLs', () => {
  const points = rewardEntitlementSource({
    id: 'lista-points',
    label: 'Lista Points',
    display: '5x Points',
    source: 'https://lista.org/lending',
    basis: 'collateral',
    verification: 'rule-confirmed',
  });
  const ecosystem = rewardEntitlementSource({
    id: 'partner-reward',
    label: 'Partner Reward',
    display: '生态奖励资格',
    source: 'https://lista.org/',
    basis: 'supply',
    verification: 'rule-confirmed',
    category: 'ecosystem-reward',
  });
  assert.equal(points?.title, '积分来源说明');
  assert.equal(points?.url, 'https://lista.org/lending');
  assert.equal(ecosystem?.title, '资格来源说明');
  assert.equal(ecosystem?.url, 'https://lista.org/');
});

test('unsafe source URLs are not rendered when no trusted catalog rule exists', () => {
  assert.equal(rewardComponentSource({
    id: 'unsafe',
    value: 0.01,
    rateKind: 'apr',
    source: 'unknown',
    sourceUrl: 'javascript:alert(1)',
    basis: 'supply',
  }), null);
});
