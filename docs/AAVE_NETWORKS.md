# Aave V3, V4, and Aave Pro mainnet coverage

[English](AAVE_NETWORKS.md) · [中文](AAVE_NETWORKS.zh-CN.md)

Version: 0.7.0. Checked: 2026-11-06. Scope: all EVM mainnets currently listed by the official Aave APIs.
V3: **21 mainnets, 24 markets, 314 reserves**. V4: **4 mainnets, 24 spokes with reserves, 120 reserves**.
The two versions cover 22 distinct EVM mainnets.

[Aave Pro](https://aave.com/pro) is the Aave V4 interface. It uses the same `aave-v4` adapter.
The extension shows these yields on DeBank portfolio pages. It does not inject a UI into `pro.aave.com` or the Aave V3 site.

## All current V3 mainnets

| Mainnet | Chain ID | DeBank ID | Markets | Reserves |
|---|---:|---|---|---:|
| Ethereum | 1 | `eth` | Core, Prime (Lido), EtherFi, Horizon | 91 |
| Optimism | 10 | `op` | AaveV3Optimism | 14 |
| BSC | 56 | `bsc` | AaveV3BNB | 8 |
| Gnosis | 100 | `xdai` | AaveV3Gnosis | 9 |
| Polygon | 137 | `matic` | AaveV3Polygon | 21 |
| Monad | 143 | `monad` | AaveV3Monad | 14 |
| Sonic | 146 | `sonic` | AaveV3Sonic | 4 |
| X Layer | 196 | `xlayer` | AaveV3XLayer | 13 |
| zkSync | 324 | `era` | AaveV3ZkSync | 8 |
| Metis | 1088 | `metis` | AaveV3Metis | 5 |
| Soneium | 1868 | `soneium` | AaveV3Soneium | 3 |
| MegaETH | 4326 | `megaeth` | AaveV3MegaETH | 9 |
| Mantle | 5000 | `mnt` | AaveV3Mantle | 10 |
| Base | 8453 | `base` | AaveV3Base | 15 |
| Plasma | 9745 | `plasma` | AaveV3Plasma | 18 |
| Arbitrum | 42161 | `arb` | AaveV3Arbitrum | 20 |
| Celo | 42220 | `celo` | AaveV3Celo | 6 |
| Avalanche | 43114 | `avax` | AaveV3Avalanche | 18 |
| Ink | 57073 | `ink` | AaveV3Ink | 14 |
| Linea | 59144 | `linea` | AaveV3Linea | 9 |
| Scroll | 534352 | `scrl` | AaveV3Scroll | 5 |

The four Ethereum market identifiers are `AaveV3Ethereum`, `AaveV3EthereumLido` (Prime),
`AaveV3EthereumEtherFi`, and `AaveV3EthereumHorizon`. Assets with the same name in different markets do not share rates.
Horizon RWA collateral and borrowing eligibility remain subject to the protocol and asset issuer. Displaying a rate does not grant eligibility.

## All current V4 / Aave Pro mainnets

| Mainnet | Chain ID | DeBank ID | Spokes | Reserves |
|---|---:|---|---:|---:|
| Ethereum | 1 | `eth` | 16 | 89 |
| Arc | 5042 | `arc` | 3 | 8 |
| Base | 8453 | `base` | 1 | 9 |
| Avalanche | 43114 | `avax` | 4 | 14 |

Spoke names returned by the API in this check:

- **Ethereum:** Bluechip (two contracts), Ethena Correlated, Ethena Ecosystem, Etherfi, Forex, Gold, Kelp, Lido, Lombard, Main, Maple SyrupUSDG, OUSD Yield, PAXG Gold, RLUSD Yield, USDG Pendle.
- **Arc:** Forex, Main, Maple SyrupUSDC.
- **Base:** Coinbase Stocks.
- **Avalanche:** AVAX Correlated, Ethena Ecosystem, Forex, Main.

Full contract addresses and reserve counts are in [`utils/aave-markets.json`](../utils/aave-markets.json).
A name can refer to more than one contract. Matching uses the chain ID and address.

## Calculation and matching

- V3 matches chain, market address, underlying asset, and supply/borrow role. It reads official base APY and the incentive union.
  Numeric Aave/Merkl/Merit rewards retain their APR basis. Points and conditional rewards remain separate.
- V4 matches chain, spoke, asset, and role. User borrowing uses `userState.borrowApy`, which includes the risk premium.
  Merkl uses `userEffectiveExtraApy` / `userEffectiveDiscountApy`, including eligibility and balance netting, on an APY basis.
  Without a user address, borrowing is a market quote and user-specific rewards stay unknown.
- When a spoke has the same asset through several hubs, official `userSupplies` / `userBorrows` reserve IDs identify the active leg.
  One active candidate can resolve the rate. Multiple active candidates or missing user identity stay unknown; response order never selects a rate.
- Native assets use official `nativeWrappedToken` (V3) or `nativeAsset` (V4), including Arc shared-balance USDC.
  DeBank native token IDs only resolve on their own chain. No ticker matching is used. The mapping does not change human-readable token amounts.
- Standard `aave3` / `aave4` routes query the actual chain ID. When DeBank uses a separate submarket brand, verified market/spoke addresses
  in the snapshot can identify the route. Each reserve must still match. New submarket addresses require an inventory update.
- Both versions isolate caches by wallet and chain. Successful data has a five-minute TTL and a 64-entry limit. Shared loads support independent cancellation.
  One chain failure does not erase another chain's results.
- V3 liquidity uses market reserve data. V4 uses the shared hub asset totals and available liquidity. Spoke supply minus debt is not available liquidity.

## Limits

“All networks” means the current official API mainnets above. Testnets, Aptos (non-EVM), and Aave V1/V2 are outside this release.
Fantom and Harmony appear in older deployment material but are absent from the current V3 API mainnet list. They are not listed as supported current markets.
DeBank must provide the position, correct chain, and a matching market/spoke identity. Unknown identity and API failures remain unknown.
The existing $100 position/protocol net-value filter still applies. Coverage does not prove that every live page, wallet, or future deployment works.

## Verification and updates

Fresh anonymous API responses covered all 25 version/mainnet combinations and were replayed through the production adapters: 926 supply/borrow checks passed.
Of these, 24 checks covered six Ethereum spoke/asset groups with multiple hubs; they correctly stayed unknown without a user identity.
Fixtures also cover DeBank parsing for every reviewed market, native assets, user premiums/net rewards, hub leg selection, cache isolation, and cancellation.
The personalized API query schema was checked with a public synthetic address. Real personal-wallet rates and live DeBank pages were not verified.

```sh
npm run check:aave                  # Query official catalogs and check current coverage
npm run check:aave -- --write       # Update the contract snapshot; review the diff
npm run check:aave -- --output /path/to/report
```

The command needs no key and does not read local credentials. If your terminal needs a network proxy, use a Node version and options that support environment proxies.

## Official sources

- [V3 market model and queries](https://www.aave.com/docs/aave-v3/markets/data)
- [V4 mainnet catalog and native assets](https://www.aave.com/docs/aave-v4/liquidity/chains)
- [V4 GraphQL schema](https://github.com/aave/aave-v4-sdk/blob/main/packages/graphql/schema.graphql)
- [Aave Pro user guide](https://aave.com/blog/aave-pro-user-guide)
- [V3 API](https://api.v3.aave.com/graphql) · [V4 API](https://api.v4.aave.com/graphql)
