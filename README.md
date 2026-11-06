# DeBank APY Lens

A Chrome Manifest V3 extension that adds yield breakdowns to DeBank portfolio pages.
[English](README.md) · [中文](README.zh-CN.md)

The interface and documentation are available in English and Simplified Chinese.

This is an independent project. It is not affiliated with or endorsed by DeBank.
DeBank's [Terms of Service, section 4(h)](https://debank.com/docs/terms) restrict
unauthorized browser extensions that access data or modify its pages. The MIT
license covers this code; it does not grant permission to use DeBank's services.
This project has not been submitted to the Chrome Web Store.

## Language

Open the extension popup and select **Follow browser**, **中文**, or **English**.
The default follows the browser language (Chinese for `zh`, English otherwise).
Switching repaints the popup, badges, tooltips, status bar, and activity panel
without fetching yields again. The choice is saved in Chrome sync storage.
Browser extension metadata follows Chrome’s own language.

## Features

- Base yield, reward APR/APY, borrowing costs, net yield, and leverage.
- A portfolio estimate for daily yield and claimable rewards. Incomplete data
  stays incomplete; an unknown reward is not shown as zero.
- Range status for Uniswap V3/V4 and PancakeSwap V3 positions. LP fee yield and
  external LP incentive APY are excluded from yield totals.
- Supply liquidity indicators and a refresh/stop status bar.
- Hide transactions that DeBank itself marks as scam. Other failed transactions
  remain visible.

The bundled directory identifies 73 EVM chains as of 2026-09-21. Nineteen rate
adapters and three LP routes cover selected products, not every protocol on
every chain. See [full protocol guide](docs/PROTOCOLS.md), [data sources](docs/DATA_SOURCES.md), and
[deployment coverage](docs/EVM_DEPLOYMENTS.md). Pendle PT, Curve pool base yield, Beefy, Yearn, Lido, Rocket Pool, and ether.fi are now supported within the product limits in that guide. See the [remaining protocol gaps](docs/PROTOCOL_GAPS.md).

Aave V3 now covers all 21 current official EVM mainnets; Aave V4 / Aave Pro covers Ethereum, Arc, Base, and Avalanche. See the [complete Aave network and market list](docs/AAVE_NETWORKS.md).

## Install on another computer

No Node.js installation or compilation is needed for a release ZIP.

1. Download `debank-apy-lens-0.7.0-chrome.zip` from
   [Releases](https://github.com/PG2047/debank-apy-lens-public/releases/latest).
   Use the extension ZIP, not GitHub's automatic source-code archive.
2. Extract it to a folder you will keep.
3. Open `chrome://extensions` in desktop Chrome and enable **Developer mode**.
4. Select **Load unpacked**, then select the folder that directly contains
   `manifest.json`.
5. Close any existing DeBank tabs and open a portfolio page again. The extension
   status bar should show `v0.7.0`.

Keep the extracted folder. Unpacked extensions need manual updates. For an
update, replace the files in that folder with the new release, click **Reload**
on the extension card, then close and reopen DeBank tabs. Check the version in
the page status bar.

## RPC settings

The public build contains no developer API key. It uses public RPC endpoints.
They can have rate limits or lack historical state. Those limits can leave
some yields or LP details unknown.

Open the extension popup to set your own RPC URLs. A custom URL must use a host
listed in [`utils/hosts.ts`](utils/hosts.ts), and the provider must permit browser
requests. Common Alchemy hosts are included for user-supplied URLs. Several URLs
can be separated by commas for request rotation. The **Test** button tests the
first URL.

RPC URLs are saved with Chrome's `storage.sync`. If a URL contains your own API
key, that value is included in the saved setting and may sync through your Chrome
account. Do not share your browser settings or screenshots of keyed URLs.
See the [privacy notice](PRIVACY.md).

## Build and verify

Use Node.js 22 or newer and npm.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run verify:bridge-bundle
npm run zip
```

The unpacked extension is in `dist/chrome-mv3/`; the installation ZIP is in
`dist/`. Builds do not need an `.env` file or an API key. `npm run dev` starts WXT
development mode. Deployment refresh commands are documented in
[EVM_DEPLOYMENTS.md](docs/EVM_DEPLOYMENTS.md).

## Data flow

The extension reads copies of portfolio and history responses that the DeBank
page already requested. It does not make separate DeBank requests at runtime.
It queries protocol APIs and RPC endpoints directly from the browser. Some
queries include the public wallet or position address being viewed. There is
no project-operated server, telemetry service, wallet connection, or transaction
signing. See [PRIVACY.md](PRIVACY.md) for recipients, storage, and controls.

The public repository starts with a source snapshot and synthetic wallet test
fixtures. Private development history, handoffs, local configuration, and old
installation packages are not included.

## Documentation

| Topic | English | 中文 |
|---|---|---|
| Protocols and product limits | [Guide](docs/PROTOCOLS.md) | [指南](docs/PROTOCOLS.zh-CN.md) |
| All 73 chains and LP deployments | [Directory](docs/EVM_DEPLOYMENTS.md) | [目录](docs/EVM_DEPLOYMENTS.zh-CN.md) |
| Yield and reward rules | [Contract](docs/DATA_SOURCES.md) | [契约](docs/DATA_SOURCES.zh-CN.md) |
| Reward source links | [Contract](docs/REWARD_SOURCE_LINKS.md) | [契约](docs/REWARD_SOURCE_LINKS.zh-CN.md) |
| Transaction filter | [Contract](docs/TRANSACTION_FILTER.md) | [契约](docs/TRANSACTION_FILTER.zh-CN.md) |
| Privacy | [Notice](PRIVACY.md) | [说明](PRIVACY.zh-CN.md) |
| Release history | [Changelog](CHANGELOG.md) | [更新记录](CHANGELOG.zh-CN.md) |
| License | [MIT](LICENSE) | [非正式译文](LICENSE.zh-CN.md) |

## License and limits

[MIT](LICENSE). Dependencies retain their own licenses. Estimated yields can
change and are not investment advice. A successful offline build does not prove
that every live API, RPC endpoint, or DeBank page still works.

[Mainstream protocol gaps](docs/PROTOCOL_GAPS.md) · [中文缺口清单](docs/PROTOCOL_GAPS.zh-CN.md)
