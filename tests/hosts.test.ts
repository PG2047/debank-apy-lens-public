import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPROVED_HOST_PERMISSIONS } from '../utils/hosts.ts';

test('MV3 host permissions use an exact hostname allowlist', () => {
  assert.ok(APPROVED_HOST_PERMISSIONS.length > 0);
  assert.equal(new Set(APPROVED_HOST_PERMISSIONS).size, APPROVED_HOST_PERMISSIONS.length);
  for (const permission of APPROVED_HOST_PERMISSIONS) {
    const url = new URL(permission.replace(/\*$/, 'sentinel'));
    assert.equal(url.protocol, 'https:');
    assert.ok(!url.hostname.includes('*'), `wildcard hostname is forbidden: ${permission}`);
  }
});

test('every protocol data origin used by adapters is explicitly approved', () => {
  const origins = new Set(APPROVED_HOST_PERMISSIONS.map((permission) => new URL(permission).origin));
  for (const origin of [
    'https://api.v3.aave.com',
    'https://api.v4.aave.com',
    'https://api.merkl.xyz',
    'https://blue-api.morpho.org',
    'https://api.morpho.org',
    'https://yields.llama.fi',
    'https://api.lista.org',
    'https://spark-api.blockanalitica.com',
    'https://chainlog.skyeco.com',
    'https://info-sky.blockanalitica.com',
    'https://api.dolomite.io',
    'https://v3-api.compound.finance',
    'https://api.venus.io',
    'https://api.fluid.instadapp.io',
    'https://ethena.fi',
    'https://api.falcon.finance',
    'https://api-v2.pendle.finance',
    'https://api.curve.finance',
    'https://api.beefy.finance',
    'https://ydaemon.yearn.fi',
    'https://eth-api.lido.fi',
    'https://api.rocketpool.net',
  ]) {
    assert.ok(origins.has(origin), `missing host permission for ${origin}`);
  }
});
