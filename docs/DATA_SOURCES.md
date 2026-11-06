# Data sources, reward coverage, and display contract

[English](DATA_SOURCES.md) · [中文](DATA_SOURCES.zh-CN.md)

This document, the public code, and tests define behavior. See
[protocol coverage](PROTOCOLS.md) for all 19 rate adapters and 3 LP routes, and
[EVM deployments](EVM_DEPLOYMENTS.md) for the full chain directory.

## EVM routing and invariants

Use DeBank's full bundled EVM directory, not a top-TVL list. Aave V3, Morpho,
Compound, Dolomite, Venus, and Fluid query the position's actual chain and exact
market. Aave V4 isolates per-chain requests, caches, and shared work. Lista,
DeFiLlama, and Sky resolve supported IDs/names through the common chain directory.
LP contracts, RPCs, and permissions are tested together. Share-token identity is
chain-specific; a ticker or an address from another chain is insufficient.

1. Model base yield and rewards separately. APY, APR, and annual USD are distinct.
2. Zero requires an authoritative, exhaustive, successful response for that role.
3. Failed requests, missing fields, incomplete pagination, ambiguous identity, or non-exhaustive sources stay unknown.
4. Bind rewards to an exact market, spoke, vault, Comet, vToken, fToken, or LP position. Do not choose the first, largest, or highest-TVL same-token pool.
5. Non-Ethena points, multipliers, and ecosystem rights remain separate from rates. They never enter net APY or daily yield. All Ethena points/eligibility metadata is excluded.
6. Keep known components when coverage is incomplete, but call their total a subtotal.

## Five reward states

| State | Meaning | Contribution |
|---|---|---|
| `numeric-known` | Verified numeric rate and calculation basis | Included |
| `confirmed-zero` | Exhaustive response proves no reward for this role | Zero |
| `unknown` | Missing, failed, ambiguous, or incomplete data | Blocks a complete total when material |
| `non-annualizable` | Rights exist without a reliable annualized rate | Blocks a complete total when material |
| `not-applicable` | Reward category does not apply or is explicitly excluded | No contribution; coverage is complete for that category |

Within a position, unknown/non-annualizable exposure above 1% of gross supply plus
borrowing prevents a complete total. Smaller amounts are disclosed as dust. An
independent position or protocol below $100 net value is skipped before queries,
rendering, aggregation, and gap counting. Parent coverage must also include every
child; a large complete position cannot dilute a different incomplete position.

## DeBank history input

Read only copies of the page's signed fetch/XHR `history/list` responses. Accept
`{ data: { history_list: [...] }, error_code }` or the supported array form. The
extension does not independently request this endpoint or add host permissions.
Drop server-marked `is_scam === true` records. Keep the latest 100 valid entries
per address in memory, deduplicated by transaction hash. History does not enter
APY enrichment or the worker channel and is not persisted.

## Protocol identities and reward rules

The executable registry carries each route's reward truth, exact identity,
zero-proof roles, and unsupported policy. The [full protocol guide](PROTOCOLS.md)
lists products and limits. Key source bindings are:

| Route | Identity and source |
|---|---|
| Aave V3 | Market + reserve + supply/borrow; AaveKit base rates and reserve incentives. |
| Aave V4 | Spoke + reserve + leg; official summary/reward union, no asset-only fallback. |
| Morpho Blue | Full market ID; Deposit Proxy additionally needs the exact proxy and nonzero supply. Missing IDs require a unique full-asset match in user positions. Native rewards plus complete LIVE Merkl collateral evidence. |
| Morpho Vaults | Vault address + V1/V2 generation; native `allRewards/rewards`. |
| Morpho Midnight | Chain + user + market ID + loan token + lend role + nonzero credit. `effective_rate_wad` is a fixed-term equivalent; daily income is estimated. After maturity, base yield is zero. Blue/Vault incentives do not apply. |
| Spark | Product + chain + unique reserve. Official markets prove base rates, not exhaustive rewards. |
| Sky / Maker | Exact savings share token or verified farm + staking/reward tokens; wallet balance can resolve a missing farm ID. |
| Dolomite | Chain + market token + leg; explicit outside-interest components. |
| Compound V3 | Comet + base asset + leg; summary and separate rewards endpoints. |
| Venus | Comptroller/vToken + underlying + leg; explicit distributors/details, with intrinsic/YTM separated from reward rates. |
| Fluid | fToken/vault + asset + leg. Smart Collateral/Debt types 2/3/4 can include the correct side's official DEX trading component. |
| Lista / Moolah | Exact vault or unique wallet-active market. Filter official chain/asset pairs before onchain verification; do not batch the entire market directory. |
| Ethena / Falcon | Exact share-token products. Ethena points are excluded; Falcon extra incentives are not exhaustive. |
| Uniswap V3/V4, Pancake V3 | Exact pool/NFT/range, plus V4 hooks. Fee and incentive APY are excluded from yield and gap totals. |

## Liquidity risk

Only lending/vault supply legs are assessed. Borrowing, Morpho isolated collateral,
and LP cards are excluded. Red: available liquidity ≤ 110% of the position.
Yellow: position ≥ 10% of pool size. Red takes priority. Missing inputs produce no
risk label; unknown available liquidity can still permit a valid yellow share label.
Token and USD units are kept separate.

| Source | Total / available |
|---|---|
| Aave V3 | `supplyInfo.total.value` times available-liquidity USD-per-token; `borrowInfo.availableLiquidity.usd`. Fall back to token units when USD pricing is absent; missing borrow info means availability is unknown. |
| Aave V4 | Hub-level `asset.summary.supplied.amount.value` and `availableLiquidity.amount.value`, in tokens. Never use spoke supply minus borrowing. |
| Morpho | Market `state.supplyAssetsUsd` / `state.liquidityAssetsUsd`; vault `state.totalAssetsUsd` / `liquidity.usd`. |

## Sky savings and farms

Exact savings contracts use onchain `ssr/str`. Chainlog discovers Ethereum reward
farms; verify staking/reward tokens, balances, and active reward periods. A supplied
farm ID must match exactly. Without one, require a unique staking-token and wallet
balance/amount match, including the DeBank reward token when present. Prefer the
exact official farm APR; an onchain calculation requires reward emissions, valid
pricing, and a valid denominator. Identity or rate uncertainty remains unknown.
Only an unambiguous legacy savings product can use DeFiLlama fallback; farm names
and Llama UUIDs are not proof of farm identity.

## Merkl

Use exact chain, market, token, role, and campaign evidence. Only a complete LIVE
snapshot can prove that no matching collateral campaign exists. Keep pagination,
transport, and field failures unknown. Preserve exact opportunity IDs in source
links. Numeric Merkl APR does not establish points eligibility. Claimable rewards
are a separate per-chain query with complete/partial/unknown states; preserve known
amounts and list failed chains instead of showing a fabricated zero.

## Calculation and display

For supply S, borrowing B, and equity E = S − B:

```text
Known annual USD = sum(supply × known base yield + known reward USD)
                 − sum(borrow × known borrowing rate − known reward USD)
Known net rate = known annual USD / E
Daily estimate = known annual USD / 365
Leverage = S / E
```

APY and APR stay separately labeled even though the combined net estimate is an
approximation. Borrowed yield-bearing assets do not earn intrinsic yield for the
borrower. A supplied yield-bearing collateral leg can include verified intrinsic
yield without double-counting it. Equity ≤ 0, equity below 1% of supply, or equity
below $50 prevents a net APY. Leverage display is capped at 50x.

| Area | Display |
|---|---|
| Supply / borrowing | Compact base APY plus rewards; hover separates base/cost, reward token, APR/APY, and source. |
| Complete protocol | Net APY and complete daily estimate. |
| Incomplete protocol | Known subtotal, explicit missing components, no complete total. |
| Portfolio | Daily estimate or daily subtotal; covered/uncovered positions, claimable amounts, and source failures. |
| LP | NFT ID, range status, current/lower/upper price, token composition; no fee/incentive APY. |
| Status bar | Waiting, loading, refreshing, stopping, stopped, retry, and a deduplicated gap count. |

Percentages have at most two decimals without trailing zeros. Protocol net APY
is next to net value; multi-position cards keep per-position values. English and
Chinese use the same numeric data and rules. Language changes repaint cached
results and do not restart queries. Source notes and reward links are localized
at presentation time; caches retain stable source messages.

## Network and input boundaries

- Exact hostnames are listed in `utils/hosts.ts`; no wildcard domains. Defaults use keyless RPCs in `utils/rpc-config.ts`. Custom RPC settings take priority. Historical `eth_call` may need a provider with historical state.
- Shared HTTP concurrency is 4. Source timeouts start after a queue slot is acquired and include body reading. Default response limits are 2 MiB / 4096 chunks; DeFiLlama `/pools` alone permits 16 MiB.
- A card has a 10-second deadline propagated to adapters/RPC/body reads. Aave V4 has an 8-second transport budget independent of queue time.
- Aave/Morpho wallet caches hold up to 64 entries; Merkl claimables up to 128. Main-world fetch/XHR capture uses a 2 MiB limit; fetch also limits chunks.
- The bridge accepts only same-origin, versioned messages for recognized portfolio/history endpoints. Bounded copies allow 2 MiB of characters, 50,000 nodes, 10,000 entries per container, and depth 64.
- Parsing limits: 128 projects, 32 items per project, 256 items overall, 32 principal/reward legs per item, 512 of each overall. Position indexes are at most 256 characters; LP token IDs must be decimal uint256 strings of at most 78 digits. Card/LP/RPC-batch limits are 128/32/256. RPC IDs must be unique and within the batch; truncation propagates incomplete coverage.
- Bind results to address, request-start capture sequence, and enrichment generation. Late results cannot overwrite a new address/request. Refresh reuses the last bounded payload and never independently requests DeBank.
- The main interceptor retains at most 8 bounded per-address snapshots in the same document. Startup/SPA/BFCache replay uses versioned same-address messages with new sequences. Stop cancels work; failed refresh keeps old results. Shadow DOM status nodes recover after page redraws.
- Gap details identify chain, protocol, and missing asset legs. Deduplicate protocol issues and combine failed Merkl chains. Unsupported protocols, sub-$100 positions, and excluded LP APYs do not count as failures.
- DeFiLlama/Lista/Aave V4 shared requests cancel per subscriber; abort the underlying request only when all subscribers leave. Aave V4 caches successful data for 5 minutes. LP range cache: 120 seconds, 128 entries.
- Sky success/error cache: 5 minutes / 30 seconds, at most 64 farms. Batch at most 128 queries and 32 page-supplied exact farms; discover at most 64 farms per chain. Identity/state/balance/APR reads share cancellable work; one failed query must not clear other cards.
- Market requests do not send portfolio balances. Required user queries can send the public wallet/proxy address to APIs or RPC calldata. Wallets, position graphs, and API responses are not persisted.

## DeFiLlama and new routes

Missing or zero `apyReward` does not prove zero ecosystem rewards. Multiple
same-project/chain/token pools are ambiguous. Spark can fill missing components
from unique product evidence. Other official adapters must not bypass their
Comet/vToken/vault identity with token-only fallback.

A new route must declare its identity, reward source, zero-proof roles, and
unsupported policy in the registry/capability inventory. Tests must cover numeric
rewards, proven zero, failure, same-token ambiguity, and points/private rewards.
Update exact hosts, both language catalogs, both protocol guides, and tests in
the same change. Missing identity stays unknown.

## Verification and references

Run tests, typecheck, production build, and the bridge bundle check. Reload the
extension, close/reopen DeBank tabs, then check loading/stop/retry states, reward
subtotals, source links, failure details, and both languages. Reloading only the
page may leave an old worker active.

- [Morpho rewards](https://docs.morpho.org/build/rewards/resources/all/)
- [Morpho collateral rewards](https://docs.morpho.org/build/borrow/tutorials/rewards/)
- [Ethena yield endpoint](https://ethena.fi/api/yields/protocol-and-staking-yield)
- [Merkl integration](https://docs.merkl.xyz/integrate-merkl/app)
- [Reward source-link contract](REWARD_SOURCE_LINKS.md)
- [Aave V4 schema](https://github.com/aave/aave-v4-sdk/blob/main/packages/graphql/schema.graphql)
- [Sky active Chainlog](https://chainlog.skyeco.com/api/mainnet/active.json)
- [Sky reward contract](https://github.com/sky-ecosystem/endgame-toolkit/blob/4f238f9b23298190150d49482bad56c00f0af825/src/synthetix/StakingRewards.sol)

## v0.6.0 protocol additions

- Pendle: official paginated market catalog; exact PT identity, current implied APY, and expiry handling. LP/YT and points are excluded.
- Curve: exact pool/LP/gauge plus constituent; official seven-day pool base APY. Personal gauge rewards remain unknown.
- Beefy: exact active standard vault; official net composite APY, without re-adding strategy rewards or intrinsic yield.
- Yearn: exact vault and asset; seven-day net share-price growth annualized as `(today / weekAgo)^(365/7) - 1`.
- Lido/Rocket Pool: exact canonical share token and chain; provider APR converted with daily compounding and labeled as an estimate.
- ether.fi: exact Ethereum eETH/weETH; current versus historical weETH `getRate()` through the existing 24-hour RPC engine. Extra restaking rewards remain unknown.

New API catalogs are cached in memory for five minutes, with at most 64 entries.
Pendle reads all pages up to a 2,000-market budget. Full Curve and Beefy catalogs
have an explicit 8 MiB response budget; other new endpoints retain the shared
2 MiB limit. Existing request concurrency and card deadlines still apply. The
[protocol guide](PROTOCOLS.md) defines the chain and product limits.
