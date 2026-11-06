# Changelog

[English](CHANGELOG.md) · [中文](CHANGELOG.zh-CN.md)


## 0.6.0 — 2026-11-06

- Add seven rate routes: Pendle V2 PT, Curve pool base yield, Beefy standard vaults,
  Yearn V2/V3 vaults, Lido, Rocket Pool, and ether.fi base staking yield.
- Expand the registry from 12 to 19 rate routes; retain the three NFT LP range routes.
- Match chain and product addresses. Preserve expiry handling, unknown rewards,
  failed-chain isolation, and composite-yield accounting without double counting.
- Add six exact API hosts. No personal keys, backend, or wallet connection is required.
- Add English/Chinese protocol details, formulas, mainnet coverage, and a remaining
  mainstream-gap inventory. New source labels work in both interface languages.

Validation: 257 tests and type checking passed. Fresh public responses were replayed
through the real adapters for 40 protocol/chain samples across 17 mainnets. Synthetic
DeBank input also passed the real parsing, routing, and aggregation path. This is not
an acceptance test against every live DeBank page.

Production packaging and bridge-bundle checks passed. The bilingual ZIP contains
no dummy build key, configured credential patterns, or personal filesystem paths.

The ether.fi adapter passed mocked RPC tests, but the live default public RPC returned
HTTP 403 on a contract read; no live ether.fi yield was verified in this environment.
A working historical Ethereum RPC is required. Additional restaking rewards remain
unknown. Euler remains unsupported: its public API returned HTTP 403 here as well.

## 0.5.15 — 2026-11-06

- Add English and Simplified Chinese across settings, yield badges, tooltips,
  status/error details, liquidity warnings, reward sources, and activity panels.
- Add a saved language selector: follow browser, Chinese, or English. Switching
  repaints cached results without fetching rates again.
- Localize Chrome extension metadata and add matching English/Chinese documentation.
- Document all 12 rate routes and 3 LP routes, exact products and data sources,
  reward limits, unsupported products, and the full 73-chain deployment directory.
- Keep all yield calculations and keyless default RPC behavior unchanged.

Validation: 248 tests, TypeScript checking, and a local Chromium preview covering
English → Chinese → English, saved preference after reload, layout, and translated
status/tooltip text. Production packaging and the bridge bundle check passed.
The ZIP contains both locale catalogs and license versions; a dummy build key,
configured credential patterns, and personal filesystem paths were absent.
Browser previews use synthetic data, not live DeBank positions.

## 0.5.14 — 2026-11-06

- Publish a separate source snapshot under the MIT license.
- Remove build-time API-key injection. Default RPC endpoints require no key;
  user-supplied RPC URLs remain available in the popup.
- Add English and Chinese installation instructions and a privacy notice.
- Replace non-synthetic wallet fixtures with synthetic addresses and omit private
  development history and historical portfolio observations.
- Keep the APY adapters, LP range display, and transaction filter from 0.5.13.

Validation: 243 tests passed. TypeScript checking, production packaging, and the
bridge bundle check passed. A dummy build key was absent from the generated ZIP.
A scan of the public source files and ZIP found no configured credential patterns
or personal filesystem paths. The ZIP includes the MIT license.

This release was checked offline. It has not been tested in a fresh live DeBank
session and has not been submitted to the Chrome Web Store. Public RPC limits can
leave some data unavailable.

Download the extension ZIP from the assets below, extract it, and use
`chrome://extensions` → Developer mode → Load unpacked. Select the folder that
contains `manifest.json`. Close and reopen DeBank tabs, then check for `v0.5.14`
in the page status bar. See the repository README for full installation steps.
