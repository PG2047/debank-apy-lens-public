# Privacy notice

[English](PRIVACY.md) · [中文](PRIVACY.zh-CN.md)

Applies to the public DeBank APY Lens extension, version 0.5.15.
Last updated: 2026-11-06.

## Data read by the extension

On `debank.com`, the extension reads copies of the page's portfolio and history
responses. These can include public wallet addresses, position and contract
identifiers, balances, token amounts, prices, and transaction records. It also
reads the page structure to place yield labels and hide rows that DeBank marks
as scam. It does not read unrelated websites.

It does not ask for a seed phrase or private key, connect a wallet, sign a
transaction, or submit a transaction. The public package has no embedded
developer API key.

## Requests and recipients

The extension sends requests directly from the browser to protocol APIs and
blockchain RPC providers to calculate yields, rewards, and position ranges.
It has no project-operated backend and no analytics or advertising endpoint.

The configured API providers include Aave, Morpho, Merkl, DeFiLlama, Lista,
Block Analitica, Sky Chainlog, Dolomite, Compound, Venus, Fluid, Ethena, and Falcon.
Default public RPC hosts and supported user-configured Alchemy hosts are listed
in [`utils/rpc-config.ts`](utils/rpc-config.ts). The full host permission list is
[`utils/hosts.ts`](utils/hosts.ts).

Requests can include chain IDs, token and contract addresses, market IDs, NFT
IDs, and the public wallet or proxy address being viewed. Wallet addresses are
used where an API needs user positions, eligibility, claimable rewards, or an
onchain balance/position lookup. RPC providers receive these values as JSON-RPC
parameters. The entire DeBank portfolio response is not sent to a project server.

Each provider can receive your IP address and ordinary connection metadata, and
can retain request logs under its own policy. Clicking a source link opens that
provider's site. DeBank itself continues to process the page's normal requests.
The extension does not make separate DeBank requests at runtime. The optional
development-only deployment update script requests public chain metadata.

## Storage and retention

Portfolio data, history samples, calculated results, and API caches are held in
memory. The extension does not persist them in Chrome storage. Page data is
released when its document ends; service-worker caches expire, are evicted, or
end when the worker stops.

The interface language preference (`auto`, `zh-CN`, or `en`) is saved under
`dal:language` in Chrome `storage.sync`. It may sync through your Google account.
Language changes only repaint existing results; they do not send extra protocol requests.

Custom RPC URLs are saved under `dal:rpcOverrides` in Chrome `storage.sync`.
Depending on your Chrome settings and extension identity, Chrome can sync them
through your Google account. If you enter a URL that contains an API key, the
saved and synced setting includes that key. That key is sent to its RPC provider
when the URL is used. It is not sent to the project maintainer.

The extension writes operational diagnostics to the local browser console. It
does not send console logs to the maintainer. Review any logs or screenshots
before you choose to share them in a public issue.

## Controls and contact

Use the page's Stop control to cancel the current yield refresh. Clear a custom
RPC field to remove that override from extension settings. Disable the extension
to stop its page processing. Uninstall it to remove its local extension settings;
Chrome account sync and third-party request logs are managed by their providers.

Questions can be posted in the repository's
[issue tracker](https://github.com/PG2047/debank-apy-lens-public/issues).
Issues are public: do not include credentials, private portfolio screenshots, or
personal information.
