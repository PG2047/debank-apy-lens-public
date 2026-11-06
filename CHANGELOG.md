# Changelog

[English](CHANGELOG.md) · [中文](CHANGELOG.zh-CN.md)


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
