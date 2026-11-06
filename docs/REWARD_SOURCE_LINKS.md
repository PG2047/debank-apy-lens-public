# Reward, points, and eligibility source links

[English](REWARD_SOURCE_LINKS.md) · [中文](REWARD_SOURCE_LINKS.zh-CN.md)

All protocols use the same source-description format. The source catalog,
types, tests, and this document define it in both interface languages.

## Tooltip structure

1. Base APY or borrowing cost.
2. APR/APY of each numeric reward.
3. Names and verification states of points, multipliers, or ecosystem rights.
4. A short explanation and clickable source for each numeric reward.
5. The non-annualizable boundary and official rules for points/eligibility.
6. Evidence notes and the internal data-source identifier.

A shared introduction explains that rewards and base yield are separate, and
points are not APY. Each source gets its own lines. Asset tooltips use a top-level
Shadow DOM portal to avoid table clipping and allow the pointer to enter and click.
Links open in a new tab with `noopener noreferrer`. Data uses `textContent` and
validated HTTPS URLs, never `innerHTML`.

## Link precision

| Source | Destination and rule |
|---|---|
| Merkl numeric rewards | Exact `https://app.merkl.xyz/opportunities/{id}` from a validated opportunity ID. |
| Aave V3/V4 | Official Aave or Aave V4 market. |
| Morpho native rewards | Official Morpho markets; Merkl collateral keeps the exact Merkl campaign. |
| Lista / Moolah | Exact market/rules link when supplied; otherwise the official product. |
| Spark, Sky, Dolomite, Compound | Official product or market. |
| Venus | Official distributors; Merkl sources prefer the Merkl campaign. |
| Fluid | Official product. |
| DeFiLlama | DeFiLlama Yields, labeled as a supplemental source. |
| Ethena / Falcon | Official documentation/product for numeric yield. No excluded Ethena points or eligibility entries. |

If a source has no catalog rule or safe `sourceUrl`, keep its name without
inventing a link. Adding a source requires catalog and test updates.

## Historical Merkl example

A 2026-07-11 Base USDe/USDC collateral observation used opportunity
`15882969063492504801` and 4.5% APR. This is a historical example, not a current
rate or campaign promise. The ID came from the API. Do not hard-code it into a
market adapter; generate links from current responses. Numeric Merkl rewards
do not prove Ethena points eligibility.

## Verification

Check all source families, exact Merkl opportunity propagation, non-Ethena
points/eligibility links, rejected unsafe URLs, and missing catalog rules. In the
browser, check that tooltips remain open under the pointer, links work, and each
description stays on its own line in Chinese and English.
