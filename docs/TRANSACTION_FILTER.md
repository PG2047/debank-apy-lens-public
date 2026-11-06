# DeBank transaction scam filter contract

[English](TRANSACTION_FILTER.md) · [中文](TRANSACTION_FILTER.zh-CN.md)

Filter contract: v0.3.5, retained in extension v0.7.0.
Sources: `entrypoints/bridge.content.ts` and `utils/transaction-filter.ts`.

## Purpose and boundaries

Hide a transaction only when DeBank itself marks it as scam. The extension does
not judge blockchain transactions or extend DeBank's classification. Uncertain
rows remain visible. An independent error boundary in the isolated-world bridge
keeps filter failure from interrupting APY.

The filter does not patch fetch/XHR, read APY messages, send worker messages,
request APIs, or store wallet/transaction/settings data. The separate APY
interceptor has its own response-reading behavior.

## DOM evidence and matching

Use semantic prefixes `HistoryContainer_historyContainer__`, `History_table__`,
`History_tableLine__`, `History_txStatus__`, and `History_scam__`. Ignore CSS hash
suffixes. Color, opacity, failed status, and error icons are not scam evidence.

All conditions must hold before adding `data-dal-scam-hidden="true"`:

1. Path is `/profile/<one nonempty segment>/history`, optional trailing slash; the segment is at most 256 characters.
2. Exactly one history container/table exists; the table belongs to that container.
3. The row is a direct table child with the transaction-row prefix.
4. Exactly one direct status child has the transaction-status prefix.
5. Exactly one scam marker exists in the row.
6. The marker belongs to that status and row.
7. Exactly one `/tx/` link exists in the row.
8. The link belongs to the same direct status and row.

Otherwise leave the row visible. Extra harmless columns are allowed. Never use
computed colors, opacity, `History_error__`, Failed text, vague scam text, class
hashes, amounts, symbols, chains, transaction hashes, wallet addresses,
sample-specific data, date groups, or adjacent markers as evidence.

## Lifecycle and navigation

After reloading the extension, close and reopen DeBank tabs to end old content
scripts. The filter runs from the isolated bridge on `debank.com`.

1. Outside history, perform only low-frequency path checks.
2. In history, check the two exact root selectors once per second.
3. Attach a scoped stylesheet/observer only after finding a unique valid root.
4. Observe `childList`, `class`, and `href`; debounce for 40 ms.
5. Recheck reused React/virtual rows and remove markers that no longer match.
6. On route exit, root loss/ambiguity, budget exhaustion, or cleanup, disconnect and restore visible rows.
7. Remove stale styles/markers before a new verified root takes over.
8. BFCache `pagehide.persisted=true` does not permanently stop the filter.
9. WXT invalidation and non-BFCache pagehide share cleanup for observers, timers, listeners, styles, and markers.

`data-dal-scam-filter-state` contains only `entry-started`, `inactive-route`,
`waiting-root`, `attached`, `budget-detached`, `install-error`, or `stopped`.
It contains no addresses, paths, counts, or page data. Fixed build markers and
finite states are local diagnostics. Diagnostic failure does not stop APY.

Only this scoped relationship hides a row; DeBank inline styles are not changed:

```css
[data-dal-transaction-list="true"][class*="History_table__"]
  > [data-dal-scam-hidden="true"][class*="History_tableLine__"] {
  display: none !important;
}
```

## Work limits

No full-body text scan. Limits: 500 rows per list, 250 mutation records per batch,
and 500 pending rows across callbacks. Removed rows leave the queue; root changes
reset it. Budget exhaustion detaches and restores rows. Polling can reattach when
the structure/load is valid. Observe only required attributes, not extension
markers. Repeat installation has one observer/style owner.

## Privacy and verification

Filtering adds no manifest permissions. It reads the current DeBank DOM; filter
data does not leave the page or enter storage/logs. It never changes or submits
transactions. See the [privacy notice](../PRIVACY.md) for separate APY queries.

```sh
npm test
npm run typecheck
npm run build
npm run verify:bridge-bundle
git diff --check
```

Tests cover markers without inner text, ordinary grey/failed rows, ambiguous
roots/status/links, extra columns, added/reused rows, stale markers, SPA navigation,
work limits, repeat installation, and cleanup. A DeBank DOM change that breaks the
contract leaves all rows visible until selectors/tests are updated. Public code,
tests, and this contract define current behavior.
