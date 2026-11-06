import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAINS } from '../utils/chains.ts';

test('DeBank chain ids cover every Morpho API mainnet', () => {
  assert.deepEqual(
    {
      eth: CHAINS.eth?.chainId,
      arb: CHAINS.arb?.chainId,
      base: CHAINS.base?.chainId,
      hyper: CHAINS.hyper?.chainId,
      katana: CHAINS.katana?.chainId,
      monad: CHAINS.monad?.chainId,
      op: CHAINS.op?.chainId,
      matic: CHAINS.matic?.chainId,
      hood: CHAINS.hood?.chainId,
      uni: CHAINS.uni?.chainId,
      stable: CHAINS.stable?.chainId,
    },
    {
      eth: 1,
      arb: 42161,
      base: 8453,
      hyper: 999,
      katana: 747474,
      monad: 143,
      op: 10,
      matic: 137,
      hood: 4663,
      uni: 130,
      stable: 988,
    },
  );
});
