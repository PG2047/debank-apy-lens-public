import { PUBLIC_RPC, ALCHEMY_NETWORKS } from './rpc-config';

/** MV3 网络权限唯一清单：协议 API 使用精确主机；RPC 仅列出内置网络主机。 */
export const APPROVED_HOST_PERMISSIONS = [
  'https://api.v3.aave.com/*',
  'https://api.v4.aave.com/*',
  'https://api.merkl.xyz/*',
  'https://blue-api.morpho.org/*',
  'https://api.morpho.org/*',
  'https://yields.llama.fi/*',
  'https://api.lista.org/*',
  'https://spark-api.blockanalitica.com/*',
  'https://chainlog.skyeco.com/*',
  'https://info-sky.blockanalitica.com/*',
  'https://api.dolomite.io/*',
  'https://v3-api.compound.finance/*',
  'https://api.venus.io/*',
  'https://api.fluid.instadapp.io/*',
  'https://ethena.fi/*',
  'https://api.falcon.finance/*',
  'https://api-v2.pendle.finance/*',
  'https://api.curve.finance/*',
  'https://api.beefy.finance/*',
  'https://ydaemon.yearn.fi/*',
  'https://eth-api.lido.fi/*',
  'https://api.rocketpool.net/*',

  ...new Set([
    ...Object.values(PUBLIC_RPC).map((url) => `${new URL(url).origin}/*`),
    ...Object.values(ALCHEMY_NETWORKS).map((network) => `https://${network}.g.alchemy.com/*`),
    // Preserve the old Celo default origin for existing saved RPC overrides.
    'https://celo-rpc.publicnode.com/*',
  ]),
] as const;
