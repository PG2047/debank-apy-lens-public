# EVM deployment coverage — v0.7.0

[English](EVM_DEPLOYMENTS.md) · [中文](EVM_DEPLOYMENTS.zh-CN.md)

The bundled 2026-09-21 snapshot identifies 73 DeBank EVM mainnets. X Layer uses
DeBank ID `xlayer` and chain ID `196`. Chain identification enables routing; it
does not prove support for every protocol on that chain.

## Scope

| Route | Coverage rule |
|---|---|
| Aave V3 | 21 current official mainnets and 24 markets, verified 2026-11-06; native assets and wallet/chain isolation. |
| Aave V4 / Pro | Ethereum, Arc, Base, Avalanche; 24 spokes. User premiums, effective rewards, and multi-hub identity. See [full Aave scope](AAVE_NETWORKS.md). |
| Morpho | `userByAddress` with chain ID; the snapshot's 14 official mainnets can be routed, including World Chain, Tempo, and Arc. |
| Dolomite, Compound V3, Venus, Fluid | Official sources by chain and exact market/container identity; no TVL shortlist. |
| Lista | Official chain names use the common directory; wallet markets are verified onchain. |
| Spark / Sky | SparkLend Ethereum/Gnosis; matching Spark Savings fallback data; exact Sky savings/farm reads. |
| Ethena | Token table with 21 chain IDs, including OFT, zkSync, and Tempo variants; sENA is an exact Ethereum product. |
| Falcon | Exact Ethereum sUSDf only. BNB/XDC USDf is not a substitute. |
| Pendle | PT markets in the paginated official catalog; 13 chain IDs observed, including expired markets. |
| Curve | Pool base-yield route on 16 EVM mainnets; exact pool/LP/gauge and token required. |
| Beefy | Active standard vaults from the official catalog and known DeBank chains; 12 active chains observed. |
| Yearn | Exact vaults on Ethereum, Optimism, Polygon, Base, Arbitrum, Katana. |
| Lido | Exact stETH/wstETH products on Ethereum, Optimism, Arbitrum, Base. |
| Rocket Pool / ether.fi | Ethereum rETH / eETH and weETH, respectively. |
| Uniswap V3 / V4 | Complete manager/factory or manager/StateView pairs for 31 / 20 mainnets in the snapshot. |
| Pancake V3 | Nine mainnets, including separate zkSync addresses, opBNB, Monad, and Robinhood. |

Boba, Filecoin, and Moonbeam Uniswap deployments and RPCs are retained, but those
chains are absent from the bundled DeBank directory. They cannot appear through
its current page route. Movement is a Move network, not EVM. Aave V2 and Pancake
Infinity have no adapter. NFT LP routes show ranges and fee-tier metadata; their
fee and incentive APY are excluded. Curve pool yield and Pendle PT are separate
rate routes. See [product limits](PROTOCOLS.md) and [remaining gaps](PROTOCOL_GAPS.md).

## Sources and updates

- Chains: [DeBank](https://api.debank.com/chain/list), [Rabby](https://github.com/RabbyHub/Rabby/blob/master/src/constant/default-support-chains.json).
- LP contracts: [Uniswap](https://developers.uniswap.org/deployments.json), [Pancake V3](https://developer.pancakeswap.finance/contracts/v3/addresses).
- Tokens: [Ethena](https://docs.ethena.fi/technical-design/key-addresses), [Falcon](https://docs.falcon.finance/resources/smart-contracts).
- Public RPC candidates: [Ethereum Lists](https://chainid.network/chains.json). Check each with `eth_chainId`; HyperEVM uses its official endpoint because chain ID 999 has a legacy collision.

```sh
npm run sync:deployments   # Update public metadata; review the diff.
npm run check:deployments  # Detect upstream changes without writing files.
npm test
npm run typecheck
npm run build
npm run verify:bridge-bundle
```

The update script supports `HTTPS_PROXY`. It does not read `.env`, wallet data,
or credentials, and runs only during development. At runtime, the extension
reads DeBank responses that the page already requested. Add a chain-verified
public RPC in `utils/rpc-config.ts` for each new chain. Exact host permissions are
derived from that file and checked by tests. Check Pancake and share-token entries
against official addresses, not symbols.

## Validation limits

This is a dated snapshot. Offline tests check routing, permissions, and decoding;
they do not prove that all current endpoints work. Public RPC limits or missing
historical state can leave data unknown. Reload the extension, reopen DeBank,
and check the `v0.7.0` status marker for live verification.

## Full chain directory

Generated from the bundled directory. ✓ means an LP deployment is present, not that its RPC was checked live. — means no bundled LP deployment. Rate routes still require exact product/market matching.

| DeBank ID | Chain | Chain ID | Uniswap V3 | Uniswap V4 | Pancake V3 |
|---|---|---:|:---:|:---:|:---:|
| `eth` | Ethereum | 1 | ✓ | ✓ | ✓ |
| `op` | OP | 10 | ✓ | ✓ | — |
| `flr` | Flare | 14 | — | — | — |
| `cro` | Cronos | 25 | — | — | — |
| `rsk` | Rootstock | 30 | — | — | — |
| `xdc` | XDC | 50 | — | — | — |
| `bsc` | BNB Chain | 56 | ✓ | ✓ | ✓ |
| `xdai` | Gnosis Chain | 100 | ✓ | — | — |
| `fuse` | Fuse | 122 | — | — | — |
| `uni` | Unichain | 130 | ✓ | ✓ | — |
| `matic` | Polygon | 137 | ✓ | ✓ | — |
| `monad` | Monad | 143 | ✓ | ✓ | ✓ |
| `sonic` | Sonic | 146 | ✓ | — | — |
| `manta` | Manta Pacific | 169 | — | — | — |
| `xlayer` | X Layer | 196 | ✓ | ✓ | — |
| `opbnb` | opBNB | 204 | — | — | ✓ |
| `b2` | B² | 223 | — | — | — |
| `lens` | Lens | 232 | ✓ | — | — |
| `frax` | Fraxtal | 252 | — | — | — |
| `era` | zkSync Era | 324 | ✓ | — | ✓ |
| `world` | World Chain | 480 | ✓ | ✓ | — |
| `stable` | Stable | 988 | — | — | — |
| `hyper` | HyperEVM | 999 | — | — | — |
| `cfx` | Conflux | 1030 | — | — | — |
| `metis` | Metis | 1088 | — | — | — |
| `wemix` | WEMIX | 1111 | — | — | — |
| `core` | CORE | 1116 | — | — | — |
| `lisk` | Lisk | 1135 | — | — | — |
| `sei` | Sei | 1329 | ✓ | — | — |
| `story` | DATA Network | 1514 | — | — | — |
| `gravity` | Gravity | 1625 | — | — | — |
| `soneium` | Soneium | 1868 | ✓ | ✓ | — |
| `ron` | Ronin | 2020 | — | — | — |
| `kava` | Kava | 2222 | — | — | — |
| `kite` | KiteAI | 2366 | — | — | — |
| `abs` | Abstract | 2741 | — | — | — |
| `morph` | Morph | 2818 | — | — | — |
| `citrea` | Citrea | 4114 | — | — | — |
| `merlin` | Merlin | 4200 | — | — | — |
| `tempo` | Tempo | 4217 | ✓ | ✓ | — |
| `megaeth` | MegaETH | 4326 | ✓ | ✓ | — |
| `hood` | Robinhood | 4663 | ✓ | ✓ | ✓ |
| `mnt` | Mantle | 5000 | ✓ | — | — |
| `arc` | Arc | 5042 | ✓ | ✓ | — |
| `zeta` | ZetaChain | 7000 | — | — | — |
| `cyber` | Cyber | 7560 | — | — | — |
| `klay` | Kaia | 8217 | — | — | — |
| `base` | Base | 8453 | ✓ | ✓ | ✓ |
| `plasma` | Plasma | 9745 | — | — | — |
| `itze` | Immutable zkEVM | 13371 | — | — | — |
| `g0` | 0G | 16661 | — | — | — |
| `ape` | ApeChain | 33139 | — | — | — |
| `mode` | Mode | 34443 | — | — | — |
| `arb` | Arbitrum | 42161 | ✓ | ✓ | ✓ |
| `celo` | Celo | 42220 | ✓ | ✓ | — |
| `ethlink` | Etherlink | 42793 | — | — | — |
| `hemi` | Hemi | 43111 | — | — | — |
| `avax` | Avalanche | 43114 | ✓ | ✓ | — |
| `zircuit` | Zircuit | 48900 | — | — | — |
| `sophon` | Sophon | 50104 | — | — | — |
| `ink` | Ink | 57073 | ✓ | ✓ | — |
| `linea` | Linea | 59144 | ✓ | ✓ | ✓ |
| `bob` | BOB | 60808 | — | — | — |
| `bera` | Berachain | 80094 | — | — | — |
| `blast` | Blast | 81457 | — | — | — |
| `chiliz` | Chiliz | 88888 | — | — | — |
| `plume` | Plume | 98866 | — | — | — |
| `taiko` | Taiko | 167000 | ✓ | — | — |
| `btr` | Bitlayer | 200901 | — | — | — |
| `scrl` | Scroll | 534352 | ✓ | — | — |
| `katana` | Katana | 747474 | — | — | — |
| `zora` | Zora | 7777777 | ✓ | ✓ | — |
| `dbk` | DBK Chain | 20240603 | — | — | — |
