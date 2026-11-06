import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProjectList, parseProjectListWithCoverage } from '../utils/debank.ts';
import { DEBANK_INPUT_LIMITS } from '../utils/input-limits.ts';

const token = (id: string, symbol: string, amount: number, price = 1) => ({
  id,
  chain: 'eth',
  symbol,
  optimized_symbol: symbol,
  amount,
  price,
  decimals: 18,
});

test('project parser preserves every item leg and routing field', () => {
  const payload = {
    data: [
      {
        id: 'eth_example',
        chain: 'eth',
        name: 'Example',
        portfolio_item_list: [
          {
            name: 'Lending',
            position_index: '42',
            pool: {
              id: '0x1111111111111111111111111111111111111111',
              adapter_id: 'example_lending',
            },
            stats: { net_usd_value: 150 },
            detail: {
              description: 'Example market',
              supply_token_list: [
                token('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'AAA', 100),
                token('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'BBB', 100),
              ],
              borrow_token_list: [
                token('0xcccccccccccccccccccccccccccccccccccccccc', 'CCC', 25),
                token('0xdddddddddddddddddddddddddddddddddddddddd', 'DDD', 25),
              ],
              reward_token_list: [token('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'RWD', 1)],
            },
          },
        ],
      },
    ],
  };

  const [project] = parseProjectList(payload);
  assert.equal(project.protocolId, 'eth_example');
  assert.equal(project.items.length, 1);
  assert.equal(project.itemCoverageComplete, true);
  assert.equal(project.items[0].principalInputCoverageComplete, true);
  assert.equal(project.items[0].rewardInputCoverageComplete, true);
  assert.deepEqual(
    project.items[0].supplies.map((leg) => leg.symbol),
    ['AAA', 'BBB'],
  );
  assert.deepEqual(
    project.items[0].borrows.map((leg) => leg.symbol),
    ['CCC', 'DDD'],
  );
  assert.deepEqual(project.items[0].rewards.map((leg) => leg.symbol), ['RWD']);
  assert.equal(project.items[0].poolId, '0x1111111111111111111111111111111111111111');
  assert.equal(project.items[0].adapterId, 'example_lending');
  assert.equal(project.items[0].positionIndex, '42');
  assert.equal(project.items[0].poolDesc, 'Example market');
});

test('opaque DeBank position identities may exceed a uint256 token id without losing coverage', () => {
  const compositePositionIndex =
    '0x4992b11a44ccdae37936da8098afd86427bad833_' + '9'.repeat(77);
  assert.equal(compositePositionIndex.length, 120);

  const parsed = parseProjectListWithCoverage({
    data: [{
      id: 'dolomite',
      chain: 'eth',
      name: 'Dolomite',
      portfolio_item_list: [boundedItem({
        position_index: compositePositionIndex,
        pool: {
          id: '0x67567fce98a44745820069c37c395426f1c30ba6',
          adapter_id: 'dolomite_lending',
        },
      })],
    }],
  });

  assert.equal(parsed.inputCoverageComplete, true);
  assert.deepEqual(parsed.inputLimitReasons, []);
  assert.equal(parsed.protocols[0]?.itemCoverageComplete, true);
  assert.equal(parsed.protocols[0]?.rewardInputCoverageComplete, true);
  assert.equal(parsed.protocols[0]?.items[0]?.positionIndex, compositePositionIndex);
});

test('opaque DeBank position identities remain bounded independently of LP token ids', () => {
  const parsed = parseProjectListWithCoverage({
    data: [boundedProject([boundedItem({
      position_index: 'x'.repeat(DEBANK_INPUT_LIMITS.positionIdentityChars + 1),
    })])],
  });

  assert.equal(parsed.inputCoverageComplete, false);
  assert.equal(parsed.protocols[0]?.itemCoverageComplete, false);
  assert.equal(parsed.protocols[0]?.rewardInputCoverageComplete, false);
  assert.ok(parsed.inputLimitReasons.includes('principal-leg-or-identity-limit'));
  assert.ok(parsed.inputLimitReasons.includes('reward-leg-or-identity-limit'));
});

test('project parser preserves protocol-level incomplete coverage when a principal leg is malformed', () => {
  const payload = {
    data: [
      {
        id: 'eth_example',
        chain: 'eth',
        portfolio_item_list: [
          {
            name: 'Lending',
            detail: {
              supply_token_list: [{ chain: 'eth', symbol: 'BROKEN', amount: 1, price: 1 }],
              borrow_token_list: [],
            },
          },
        ],
      },
    ],
  };

  const [project] = parseProjectList(payload);
  assert.equal(project.itemCoverageComplete, false);
  assert.deepEqual(project.items, []);
});

function boundedItem(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Lending',
    detail: {
      supply_token_list: [token('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'AAA', 1)],
      borrow_token_list: [],
      reward_token_list: [],
    },
    ...overrides,
  };
}

function boundedProject(items: unknown[]) {
  return {
    id: 'eth_example',
    chain: 'eth',
    name: 'Example',
    portfolio_item_list: items,
  };
}

test('normal project payload remains fully covered under every structural budget', () => {
  const parsed = parseProjectListWithCoverage({ data: [boundedProject([boundedItem()])] });
  assert.equal(parsed.inputCoverageComplete, true);
  assert.equal(parsed.rateInputCoverageComplete, true);
  assert.equal(parsed.rewardInputCoverageComplete, true);
  assert.deepEqual(parsed.inputLimitReasons, []);
  assert.equal(parsed.protocols[0]?.itemCoverageComplete, true);
  assert.equal(parsed.protocols[0]?.rewardInputCoverageComplete, true);
});

test('principal and reward leg overflows keep only bounded prefixes and mark coverage incomplete', () => {
  const supplies = Array.from(
    { length: DEBANK_INPUT_LIMITS.principalLegsPerItem + 1 },
    (_, index) => token(`asset-${index}`, `S${index}`, 1),
  );
  const rewards = Array.from(
    { length: DEBANK_INPUT_LIMITS.rewardLegsPerItem + 1 },
    (_, index) => token(`reward-${index}`, `R${index}`, 1),
  );
  const parsed = parseProjectListWithCoverage({
    data: [boundedProject([boundedItem({
      detail: { supply_token_list: supplies, borrow_token_list: [], reward_token_list: rewards },
    })])],
  });
  const project = parsed.protocols[0];
  assert.equal(project.items[0]?.supplies.length, DEBANK_INPUT_LIMITS.principalLegsPerItem);
  assert.equal(project.items[0]?.rewards.length, DEBANK_INPUT_LIMITS.rewardLegsPerItem);
  assert.equal(project.itemCoverageComplete, false);
  assert.equal(project.rewardInputCoverageComplete, false);
  assert.equal(parsed.inputCoverageComplete, false);
  assert.ok(parsed.inputLimitReasons.includes('principal-leg-or-identity-limit'));
  assert.ok(parsed.inputLimitReasons.includes('reward-leg-or-identity-limit'));
});

test('item and project overflows are bounded without treating omitted positions as zero', () => {
  const tooManyItems = Array.from(
    { length: DEBANK_INPUT_LIMITS.itemsPerProject + 1 },
    () => boundedItem(),
  );
  const projects = Array.from(
    { length: DEBANK_INPUT_LIMITS.projects + 1 },
    () => boundedProject(tooManyItems),
  );
  const parsed = parseProjectListWithCoverage({ data: projects });
  assert.equal(parsed.protocols.length, DEBANK_INPUT_LIMITS.projects);
  assert.equal(parsed.protocols[0]?.items.length, DEBANK_INPUT_LIMITS.itemsPerProject);
  assert.equal(
    parsed.protocols.reduce((total, project) => total + project.items.length, 0),
    DEBANK_INPUT_LIMITS.totalItems,
  );
  assert.equal(parsed.droppedProjects, 1);
  assert.equal(parsed.inputCoverageComplete, false);
  assert.ok(parsed.inputLimitReasons.includes('project-limit'));
  assert.ok(parsed.inputLimitReasons.includes('item-limit'));
});

test('a 96-project multi-chain portfolio retains late Morpho vault projects', () => {
  const projects = Array.from({ length: 96 }, (_, index) => ({
    ...boundedProject([boundedItem()]),
    id: `eth_example_${index}`,
  }));
  projects[77] = {
    ...boundedProject([boundedItem()]),
    id: 'monad_morphoblue',
    chain: 'monad',
    name: 'Morpho',
  };
  projects[93] = {
    ...boundedProject([boundedItem()]),
    id: 'stable_morphoblue',
    chain: 'stable',
    name: 'Morpho',
  };

  const parsed = parseProjectListWithCoverage({ data: projects });
  assert.equal(parsed.droppedProjects, 0);
  assert.equal(parsed.inputCoverageComplete, true);
  assert.deepEqual(
    parsed.protocols.filter((project) => project.name === 'Morpho').map((project) => project.protocolId),
    ['monad_morphoblue', 'stable_morphoblue'],
  );
});

test('global leg budgets bound aggregate parser work across otherwise valid items', () => {
  const fullLegSet = (prefix: string) => Array.from(
    { length: DEBANK_INPUT_LIMITS.principalLegsPerItem },
    (_, index) => token(`${prefix}-${index}`, `${prefix}${index}`, 1),
  );
  const items = Array.from({ length: DEBANK_INPUT_LIMITS.itemsPerProject }, (_, itemIndex) =>
    boundedItem({
      detail: {
        supply_token_list: fullLegSet(`S${itemIndex}`),
        borrow_token_list: [],
        reward_token_list: fullLegSet(`R${itemIndex}`),
      },
    }));
  const parsed = parseProjectListWithCoverage({ data: [boundedProject(items)] });
  const project = parsed.protocols[0];
  assert.equal(
    project.items.reduce((total, item) => total + item.supplies.length, 0),
    DEBANK_INPUT_LIMITS.totalPrincipalLegs,
  );
  assert.equal(
    project.items.reduce((total, item) => total + item.rewards.length, 0),
    DEBANK_INPUT_LIMITS.totalRewardLegs,
  );
  assert.equal(project.itemCoverageComplete, false);
  assert.equal(project.rewardInputCoverageComplete, false);
});

test('malicious sparse project scale performs work only on the bounded prefix', () => {
  const projects = new Array<unknown>(1_000_000);
  projects[0] = boundedProject([boundedItem()]);
  const parsed = parseProjectListWithCoverage({ data: projects });
  assert.equal(parsed.protocols.length, 1);
  assert.equal(parsed.droppedProjects, 1_000_000 - DEBANK_INPUT_LIMITS.projects);
  assert.equal(parsed.inputCoverageComplete, false);
});

test('only missing or null leg lists are valid empty lists', () => {
  const parsed = parseProjectListWithCoverage({
    data: [boundedProject([
      boundedItem({ detail: {} }),
      boundedItem({
        detail: {
          supply_token_list: null,
          borrow_token_list: null,
          reward_token_list: null,
        },
      }),
    ])],
  });
  assert.equal(parsed.inputCoverageComplete, true);
  assert.equal(parsed.protocols[0]?.items.length, 2);
  for (const item of parsed.protocols[0]?.items ?? []) {
    assert.equal(item.principalInputCoverageComplete, true);
    assert.equal(item.rewardInputCoverageComplete, true);
  }
});

test('non-array supply, borrow, and reward lists fail their corresponding item coverage', () => {
  for (const field of ['supply_token_list', 'borrow_token_list', 'reward_token_list'] as const) {
    const detail: Record<string, unknown> = {
      supply_token_list: [token('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'AAA', 100)],
      borrow_token_list: [],
      reward_token_list: [],
      [field]: { forged: true },
    };
    const parsed = parseProjectListWithCoverage({
      data: [boundedProject([boundedItem({ detail })])],
    });
    const item = parsed.protocols[0]?.items[0];
    assert.ok(item, field);
    assert.equal(parsed.inputCoverageComplete, false, field);
    if (field === 'reward_token_list') {
      assert.equal(item.principalInputCoverageComplete, true, field);
      assert.equal(item.rewardInputCoverageComplete, false, field);
      assert.equal(parsed.rateInputCoverageComplete, true, field);
      assert.equal(parsed.rewardInputCoverageComplete, false, field);
    } else {
      assert.equal(item.principalInputCoverageComplete, false, field);
      assert.equal(item.rewardInputCoverageComplete, true, field);
      assert.equal(parsed.rateInputCoverageComplete, false, field);
      assert.equal(parsed.rewardInputCoverageComplete, false, field);
    }
  }
});

test('array-shaped detail is rejected rather than interpreted as an empty item', () => {
  const parsed = parseProjectListWithCoverage({
    data: [boundedProject([boundedItem({ detail: [] })])],
  });
  assert.deepEqual(parsed.protocols[0]?.items, []);
  assert.equal(parsed.protocols[0]?.itemCoverageComplete, false);
  assert.equal(parsed.inputCoverageComplete, false);
});

test('negative, non-finite, and overflowing principal token values invalidate the item', () => {
  const invalidTokens = [
    token('negative-amount', 'NEG', -1),
    token('negative-price', 'NEG', 1, -1),
    token('nan-amount', 'NAN', Number.NaN),
    token('infinite-price', 'INF', 1, Number.POSITIVE_INFINITY),
    token('overflow-product', 'BIG', Number.MAX_VALUE, 2),
  ];
  for (const invalid of invalidTokens) {
    const parsed = parseProjectListWithCoverage({
      data: [boundedProject([boundedItem({
        detail: { supply_token_list: [invalid], borrow_token_list: [], reward_token_list: [] },
      })])],
    });
    assert.deepEqual(parsed.protocols[0]?.items, [], invalid.id);
    assert.equal(parsed.protocols[0]?.itemCoverageComplete, false, invalid.id);
    assert.equal(parsed.inputCoverageComplete, false, invalid.id);
  }
});

test('invalid reward token values preserve principal data but mark reward coverage incomplete', () => {
  const parsed = parseProjectListWithCoverage({
    data: [boundedProject([boundedItem({
      detail: {
        supply_token_list: [token('principal', 'P', 100)],
        borrow_token_list: [],
        reward_token_list: [token('bad-reward', 'BAD', -1)],
      },
    })])],
  });
  const item = parsed.protocols[0]?.items[0];
  assert.ok(item);
  assert.equal(item.supplies.length, 1);
  assert.deepEqual(item.rewards, []);
  assert.equal(item.principalInputCoverageComplete, true);
  assert.equal(item.rewardInputCoverageComplete, false);
  assert.equal(parsed.protocols[0]?.itemCoverageComplete, true);
  assert.equal(parsed.protocols[0]?.rewardInputCoverageComplete, false);
  assert.equal(parsed.rateInputCoverageComplete, true);
  assert.equal(parsed.rewardInputCoverageComplete, false);
});
