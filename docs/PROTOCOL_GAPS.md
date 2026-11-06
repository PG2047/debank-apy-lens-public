# Mainstream EVM protocol coverage review

[English](PROTOCOL_GAPS.md) · [中文](PROTOCOL_GAPS.zh-CN.md)

Reviewed on 2026-11-06 for v0.6.0. The inventory uses the
[DeFiLlama protocol dataset](https://api.llama.fi/protocols), official protocol
documentation, and live public API responses. TVL is a discovery signal, not a
safety score. Historical deployments in a TVL dataset do not prove an active
product or an available rate API.

## Added in this release

| Protocol | New coverage | Mainnet coverage |
|---|---|---|
| Pendle V2 | Exact PT current yield to maturity; expiry handling | Official catalog contains 13 chain IDs; only exact PT markets returned by it are supported |
| Curve | Exact pool/LP/gauge base yield; personal incentives unknown | 16 configured EVM mainnets |
| Beefy | Active standard vault net composite yield | Dynamic catalog; 12 chains with active standard vaults at review time |
| Yearn | Exact vault seven-day net share growth | Ethereum, Optimism, Polygon, Base, Arbitrum, Katana |
| Lido | Canonical stETH/wstETH staking yield | Ethereum, Optimism, Arbitrum, Base |
| Rocket Pool | Canonical rETH staking yield | Ethereum |
| ether.fi | eETH/weETH base share growth | Ethereum |

These additions bring the registry to **19 rate routes and 3 NFT LP range
routes**. They do not cover every product of each brand. See the
[protocol guide](PROTOCOLS.md) for formulas, chain lists, identity rules, and
reward exclusions. Curve and vault yield routes do not change the existing
Uniswap/Pancake NFT fee-APY exclusion.

## Remaining mainstream gaps

The following are explicit gaps, not enabled adapters. The chain examples come
from the reviewed protocol inventory; each product still needs official
deployment and rate verification before implementation.

| Protocol / family | EVM mainnets to prioritize | Work still needed |
|---|---|---|
| Euler V2 / EulerEarn | Ethereum, Base, Arbitrum, Avalanche, Monad, Plasma, HyperEVM | Exact EVK/Earn vault and account/subaccount mapping; separate interest, intrinsic yield, and incentives. The documented [public V3 API](https://docs.euler.finance/build/data-querying/euler-v3-api/) returned HTTP 403 in this development environment; this is not proof it fails everywhere. |
| Maple / syrup | Ethereum, HyperEVM | Exact pool/share identity, fee and redemption terms, current versus historical yield, and syrup reward eligibility. |
| Convex | Ethereum, Arbitrum, Fraxtal, Polygon | Exact staking wrapper and Curve pool, CRV/CVX reward accounting, boost and separate reward contracts. Curve support does not enable Convex. |
| StakeWise V3 | Ethereum, Gnosis | Per-vault share yield, osETH exposure, and operator/vault fees. |
| Kelp / other restaking vaults | Ethereum and verified bridged deployments | Canonical share tokens, fee-adjusted exchange rates, and separate restaking distributions. |
| Kinetiq / stHYPE | HyperEVM | Canonical staking shares, HYPE-denominated yield, and any separately funded incentives. |
| BENQI Lending / sAVAX | Avalanche | Exact lending markets plus supply/borrow incentives; sAVAX exchange-rate history is a separate product. |
| Silo V2 | Sonic, Avalanche, Arbitrum, Ethereum | Silo configuration, per-asset vault identity, collateral modes, and rewards. A token-only rate lookup is insufficient. |
| HyperLend / HypurrFi | HyperEVM | Exact reserve markets, lending/borrowing rates, and incentive distributions. |
| Balancer V2/V3 | Ethereum, Base, Arbitrum, Gnosis, Avalanche and verified deployments | Pool version, BPT composition, composable pools, gauge rewards, and user boost. |
| Aerodrome / Velodrome | Base; Optimism and Superchain deployments | Distinguish ordinary pools from Slipstream NFT positions; calculate fee share, gauge staking, and reward eligibility. |
| Aave V2 / Compound V2 | Verified legacy mainnets | Legacy market identity and rate/reward interfaces; V3 support does not imply V2 support. |

## Remaining gaps within newly added brands

- Pendle: YT, LP, Boros, points, and entry-price locked yield.
- Curve: personal CRV boost/rewards, Curve Lending, crvUSD borrowing, and Curve Core-only chains outside the configured list.
- Beefy/Yearn: separate staking/Boost wrappers, governance vaults, retired products, and externally claimed incentives.
- Lido: additional bridges, stVault-owner economics, and withdrawals.
- Rocket Pool: bridged rETH, node/minipool/megapool operator returns, and RPL rewards.
- ether.fi: bridged weETH, eBTC, Liquid vaults, withdrawals, points, and additional restaking rewards.

## Validation scope

Tests cover exact identities, cross-chain collisions, expiry, failed-source
isolation, reward uncertainty, annualization, and composite-yield accounting.
Public API samples are checked separately from synthetic DeBank fixtures. Neither
check proves that every current DeBank page shape or every live market works.
RPC and API failures continue to produce unknown values rather than zero.
