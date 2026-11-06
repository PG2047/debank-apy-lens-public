import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REWARD_CAPABILITIES } from '../utils/adapters/capabilities.ts';
import {
  ADAPTERS,
  LP_ROUTES,
  RATE_ROUTES,
  REGISTERED_ROUTES,
  findLpRoute,
} from '../utils/adapters/registry.ts';

test('every registered rate adapter and LP route has an explicit reward capability', () => {
  const routes = REGISTERED_ROUTES.map((registration) => registration.route);
  assert.equal(new Set(routes).size, routes.length);
  assert.equal(REGISTERED_ROUTES.length, 22);
  assert.equal(RATE_ROUTES.length, 19);
  assert.equal(LP_ROUTES.length, 3);
  assert.deepEqual(ADAPTERS, RATE_ROUTES.map(({ adapter }) => adapter));
  assert.equal(new Set(ADAPTERS).size, ADAPTERS.length);
  assert.ok(RATE_ROUTES.every(({ route, adapter }) => route === adapter.name));
  assert.deepEqual(
    REWARD_CAPABILITIES,
    REGISTERED_ROUTES.map(({ route, kind, capability }) => ({ route, kind, ...capability })),
  );

  const rateRoutes = REWARD_CAPABILITIES
    .filter((capability) => capability.kind === 'rate')
    .map((capability) => capability.route)
    .sort();
  assert.deepEqual(rateRoutes, ADAPTERS.map((adapter) => adapter.name).sort());

  assert.deepEqual(
    REWARD_CAPABILITIES.filter((capability) => capability.kind === 'lp')
      .map((capability) => capability.route)
      .sort(),
    ['pancake-v3', 'uniswap-v3', 'uniswap-v4'],
  );
  assert.deepEqual(
    REWARD_CAPABILITIES.map(({ route, rewardTruth, exactIdentity, zeroProofRoles, unsupportedPolicy }) => ({
      route,
      rewardTruth,
      exactIdentity,
      zeroProofRoles,
      unsupportedPolicy,
    })),
    [
      ['aave-v3', 'AaveKit reserve incentives', 'market address + reserve + leg', ['supply', 'borrow'], 'non-annualizable'],
      ['aave-v4', 'Aave V4 spoke reward union', 'spoke address + reserve + leg', ['supply', 'borrow'], 'non-annualizable'],
      ['morpho', 'Morpho Blue API for market/vault; Merkl for collateral; Midnight fixed yield excludes Blue incentives', 'market id, deposit proxy + market id, vault address, or Midnight market id + role', ['supply', 'borrow', 'vault'], 'unknown'],
      ['lista', 'Lista vault emission API; exact Moolah market detail emissions and points', 'vault address or wallet-active Moolah market id', ['vault', 'borrow', 'collateral'], 'unknown'],
      ['spark', 'Spark base API with unique-product Llama evidence only', 'product + chain + unique reserve', [], 'unknown'],
      ['sky', 'Sky Chainlog + onchain farm identity/active gate + exact-farm official APR', 'share token or farm contract + staking/reward token + wallet balance', ['farm'], 'unknown'],
      ['dolomite', 'Dolomite outside interest reward parts', 'chain + market token + leg', ['supply', 'borrow'], 'unknown'],
      ['compound-v3', 'Compound summary + rewards endpoints', 'Comet address + base asset + leg', ['supply', 'borrow'], 'unknown'],
      ['venus', 'Venus explicit distributors, intrinsic/YTM details, and points', 'comptroller or vToken + underlying + leg', ['supply', 'borrow'], 'non-annualizable'],
      ['fluid', 'Fluid fToken/vault rewards plus Smart Collateral/Debt DEX trading yield', 'fToken or vault address + asset + leg', ['fToken-supply', 'vault-supply', 'vault-borrow'], 'unknown'],
      ['ethena', 'Official sUSDe yield only; Ethena points and eligibility metadata are policy-excluded', 'sUSDe share token or ENA underlying + sENA product identity', [], 'not-applicable'],
      ['falcon', 'Official share-token base yield; extra incentives not exhaustive', 'sUSDf share token', [], 'non-annualizable'],
      ['pendle', 'Official PT current implied APY; LP/YT rewards and points excluded', 'chain + PT token + optional exact market; expiry gate', [], 'not-applicable'],
      ['curve', 'Official pool base APY; personal gauge boost and incentives unknown', 'chain + pool/LP/gauge address + constituent token', [], 'unknown'],
      ['beefy', 'Official net composite vault APY; external boosts unknown', 'chain + active standard vault address', [], 'unknown'],
      ['yearn', 'Official seven-day share growth; external staking rewards unknown', 'chain + vault address + deposit/share/constituent token', [], 'unknown'],
      ['lido', 'Official stETH seven-day APR converted to estimated APY', 'chain + canonical stETH/wstETH token', [], 'not-applicable'],
      ['rocket-pool', 'Official rETH APR converted to estimated APY', 'Ethereum canonical rETH token', [], 'not-applicable'],
      ['etherfi', 'Onchain weETH share growth; additional restaking rewards unknown', 'Ethereum canonical eETH/weETH token', [], 'unknown'],
      ['uniswap-v3', 'Fee APY and external incentive APY are policy-excluded', 'pool + NFT + ticks + fee tier', [], 'not-applicable'],
      ['uniswap-v4', 'Fee APY and external incentive APY are policy-excluded', 'pool id + NFT + ticks + hooks', [], 'not-applicable'],
      ['pancake-v3', 'Fee APY and external incentive APY are policy-excluded', 'pool + NFT + ticks + fee tier', [], 'not-applicable'],
    ].map(([route, rewardTruth, exactIdentity, zeroProofRoles, unsupportedPolicy]) => ({
      route,
      rewardTruth,
      exactIdentity,
      zeroProofRoles,
      unsupportedPolicy,
    })),
  );
});

test('LP protocol ids are routed only through the three registered descriptors', () => {
  assert.equal(findLpRoute('uniswap3')?.route, 'uniswap-v3');
  assert.equal(findLpRoute('arb_uniswap_v3')?.route, 'uniswap-v3');
  assert.equal(findLpRoute('base_uniswapv4')?.route, 'uniswap-v4');
  assert.equal(findLpRoute('bsc_pancake_v3')?.route, 'pancake-v3');
  assert.equal(findLpRoute('pancake4'), undefined);
  assert.equal(findLpRoute('curve'), undefined);
});
