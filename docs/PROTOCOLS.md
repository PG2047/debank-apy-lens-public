# Supported protocols and products

[English](PROTOCOLS.md) · [中文](PROTOCOLS.zh-CN.md)

Version: 0.5.15. Source: `utils/adapters/registry.ts`, its adapters, and the deployment directory. This is code coverage, not a claim that every live market has been verified.

**12 rate routes + 3 LP routes.** Routes are not protocol brands. The chain directory contains 73 EVM chains (2026-09-21 snapshot); this does not mean that every protocol is supported on every chain.

| Route ID | Protocol / product | Type |
|---|---|---|
| `aave-v3` | Aave V3 | Rate |
| `aave-v4` | Aave V4 | Rate |
| `morpho` | Morpho | Rate |
| `lista` | Lista DAO / Moolah | Rate |
| `spark` | Spark | Rate |
| `sky` | Sky / Maker | Rate |
| `dolomite` | Dolomite | Rate |
| `compound-v3` | Compound V3 | Rate |
| `venus` | Venus | Rate |
| `fluid` | Fluid | Rate |
| `ethena` | Ethena | Rate |
| `falcon` | Falcon Finance | Rate |
| `uniswap-v3` | Uniswap V3 | LP range |
| `uniswap-v4` | Uniswap V4 | LP range |
| `pancake-v3` | PancakeSwap V3 | LP range |

## Scope by route

### Aave V3 — `aave-v3`

- **Products:** Supply, borrow, and leveraged lending positions.
- **Base data:** Aave V3 GraphQL reserve rates, matched by chain, market, reserve, and leg.
- **Rewards / display:** Official reserve incentives; numeric APR/APY stays separate from points or eligibility.
- **Limits:** Aave V2 is not supported. Only an exhaustive successful reward response can prove zero rewards.

### Aave V4 — `aave-v4`

- **Products:** Supply and borrow positions on an exact spoke and reserve.
- **Base data:** Aave V4 GraphQL spoke reserve data. Chain IDs are routed separately; same-address spokes on different chains remain separate.
- **Rewards / display:** Official reward union; points and non-annualizable rights remain separate.
- **Limits:** Liquidity statistics are hub-level, not spoke supply minus spoke borrowing. A missing spoke or source stays unknown.

### Morpho — `morpho`

- **Products:** Blue direct supply/borrow/collateral, Deposit Proxy positions, Vault V1/V2, and Midnight fixed-term lending.
- **Base data:** Blue API user markets and vault state; Deposit Proxy uses the proxy address plus full market ID. Midnight uses the user positions REST API and effective_rate_wad.
- **Rewards / display:** Native market/vault rewards, plus an exact LIVE Merkl campaign snapshot for collateral. Midnight does not inherit Blue/Vault incentives.
- **Limits:** Vault versions are separate. Midnight requires matching chain, user, market, loan asset, lend role, and nonzero credit. Its annualized rate is a fixed-term equivalent; daily yield is an estimate and base yield becomes zero after maturity. Missing identity is never guessed by ticker.

### Lista DAO / Moolah — `lista`

- **Products:** Recognized Lista ERC-4626 vaults and exact Moolah borrowing/collateral markets. DeBank may name Lista bsc_helio.
- **Base data:** Vault share-price change over 24 hours, with Lista API fallback. Moolah filters official markets by chain and asset pair, then checks the wallet onchain.
- **Rewards / display:** Vault emission APY; exact market borrow/holder emissions. Points multipliers are shown separately.
- **Limits:** Multiple same-pair markets must resolve to one active wallet market. Historical RPC calls can fail on public nodes. Non-yielding Moolah collateral does not receive a fabricated base yield.

### Spark — `spark`

- **Products:** SparkLend and recognized Spark Savings products.
- **Base data:** Block Analitica SparkLend markets for Ethereum and Gnosis; unique-product DeFiLlama evidence fills missing components and covers matching savings products.
- **Rewards / display:** Only explicitly known components are included. The base markets endpoint does not enumerate all rewards.
- **Limits:** A base rate is not proof of zero rewards. Multiple candidate pools stay unknown. No arbitrary highest-TVL pool selection.

### Sky / Maker — `sky`

- **Products:** Exact sUSDS/stUSDS savings contracts and identified ecosystem reward farms. DeBank IDs sky and makerdao are recognized.
- **Base data:** Onchain ssr/str for savings. Ethereum Chainlog discovers farms; contract reads verify staking/reward tokens and activity. Legacy savings alone can use an unambiguous DeFiLlama fallback.
- **Rewards / display:** Exact-farm official APR or an onchain emission calculation with a valid price and pool denominator.
- **Limits:** A missing farm ID requires a unique staking-token and wallet-balance match. Farm identity, price, or activity uncertainty stays unknown. No farm yield inferred from a DeFiLlama name.

### Dolomite — `dolomite`

- **Products:** Recognized supply and borrow legs, including positions with multiple assets.
- **Base data:** Official per-chain token interest rates.
- **Rewards / display:** Explicit outsideSupplyInterestRateParts and reward components.
- **Limits:** Match chain, market token, and leg. Do not merge unrelated positions just because they share a token symbol.

### Compound V3 — `compound-v3`

- **Products:** Comet base-asset supply and borrowing, with collateral handled according to the Comet product.
- **Base data:** Official all-network market summary, matched by Comet and base asset.
- **Rewards / display:** Separate official rewards endpoint, joined to the same Comet and leg.
- **Limits:** Compound V2 is not supported. A reward endpoint failure keeps known base rates but makes reward coverage incomplete. Collateral does not inherit the base-asset supply rate.

### Venus — `venus`

- **Products:** Recognized Venus markets, supply and borrowing.
- **Base data:** Official market base APY, matched by comptroller/vToken and underlying asset.
- **Rewards / display:** Explicit distributors/rewardDetails. Published intrinsic/YTM components stay in base yield; points remain separate.
- **Limits:** Missing distributor fields or unsupported rights do not become zero rewards.

### Fluid — `fluid`

- **Products:** fToken lending and recognized vaults, including Smart Collateral/Debt vault types 2/3/4.
- **Base data:** Official fToken/vault rates and token liquidity rates for smart vaults.
- **Rewards / display:** Exact fToken/vault rewards; dex.trading can be a separate component for the relevant smart collateral/debt side.
- **Limits:** Match fToken/vault, asset, and leg. This Fluid component is not generic Uniswap/Pancake LP fee APY support.

### Ethena — `ethena`

- **Products:** Canonical sUSDe share tokens and exact Ethereum sENA/locked ENA product identity.
- **Base data:** Official sUSDe staking yield; exact sENA has a protocol base rate of 0%. The fixed token table contains 21 chain IDs.
- **Rewards / display:** Only verifiable numeric yield. Ethena points, Sats, multipliers, airdrop estimates, and eligibility metadata are excluded.
- **Limits:** A same-ticker or same-address token on another chain is insufficient. Plain USDe is not sUSDe. A token-table entry does not add a missing DeBank chain.

### Falcon Finance — `falcon`

- **Products:** Exact Ethereum sUSDf staking share token.
- **Base data:** Official sUSDf 7-day APY.
- **Rewards / display:** Extra incentives are not exhaustively covered; no inferred all-rewards total.
- **Limits:** USDf on BNB Chain or XDC does not inherit sUSDf yield.

### Uniswap V3 — `uniswap-v3`

- **Products:** NFT concentrated-liquidity positions.
- **Base data:** Onchain position manager, factory, pool, and tick reads.
- **Rewards / display:** Range status, current/lower/upper prices, token composition, and fee-tier metadata.
- **Limits:** No fee APY, no external incentive APY, and no LP yield contribution to daily totals. The directory contains 31 chain deployments, including three absent from the DeBank chain list.

### Uniswap V4 — `uniswap-v4`

- **Products:** NFT concentrated-liquidity positions with exact pool key and hooks.
- **Base data:** Onchain position manager and StateView; derive the pool ID from the full pool key.
- **Rewards / display:** Range status and prices; the directory contains 20 chain deployments.
- **Limits:** No fee APY or external incentive APY. Hooks are part of position identity, not a promise of support for arbitrary hook yield mechanisms.

### PancakeSwap V3 — `pancake-v3`

- **Products:** V3 NFT concentrated-liquidity positions.
- **Base data:** Onchain manager/factory reads; zkSync uses its own deployment addresses.
- **Rewards / display:** Range status and prices on Ethereum, BNB Chain, Arbitrum, Linea, Base, opBNB, Monad, Robinhood, and zkSync Era.
- **Limits:** Pancake Infinity and V2 are not supported. No fee APY or external incentive APY.

## Shared rules and exclusions

- Net APY uses equity (supply minus borrowing) as its denominator. APY and APR are labeled separately. Daily yield is an estimate at current rates, not realized income.
- Unknown is not zero. Rewards use five states: numeric-known, confirmed-zero, unknown, non-annualizable, and not-applicable. Incomplete coverage is shown as a subtotal.
- Independent positions or protocols below $100 net value are skipped before queries. Unknown base/reward exposure above 1% of gross supply plus borrowing prevents a complete net APY; every child position must also satisfy coverage.
- LP fee APY and external incentive APY are excluded from daily yield and the top-level gap count. Official DEX yield components in Fluid smart vaults use separate product logic.
- Merkl supplies cross-protocol reward and claimable data. DeFiLlama supplies limited fallback data. Neither adds a generic protocol adapter.
- No routes exist for Curve, Pendle, Aave V2, Compound V2, Uniswap V2, or Pancake V2/Infinity. Unsupported protocols are skipped; rates are not guessed from ticker symbols.
- Public RPCs can rate-limit or lack historical state. API, DeBank DOM, or deployment changes can leave data unknown. Offline tests do not prove live availability.

See [EVM deployments](EVM_DEPLOYMENTS.md) for the full chain list and [data sources](DATA_SOURCES.md) for calculation and reward rules.
