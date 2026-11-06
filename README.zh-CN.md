# DeBank APY Lens

[English](README.md) · [中文](README.zh-CN.md)

为 DeBank 仓位页面添加收益拆解的 Chrome Manifest V3 扩展。界面和文档均提供英文与简体中文。

本项目独立开发，与 DeBank 无隶属或背书关系。DeBank [服务条款第 4(h) 项](https://debank.com/docs/terms)
限制未经授权的浏览器扩展访问数据或修改页面。MIT 许可证只授权使用本项目代码，不提供 DeBank 服务授权。
本项目尚未提交 Chrome Web Store。

## 语言

打开扩展弹窗，选择「跟随浏览器」「中文」或「English」。默认跟随浏览器：中文语言使用中文，其他语言使用英文。
切换会立即重绘设置页、收益徽章、悬浮详情、状态栏和近期活动面板，不重新查询收益。
选择保存在 Chrome sync storage。扩展管理页中的名称和描述跟随 Chrome 自身的语言。

## 功能

- 基础收益、奖励 APR/APY、借款成本、净收益和杠杆。
- 组合每日收益估算及待领奖励；覆盖不完整时保留“小计”，未知奖励不显示为零。
- Uniswap V3/V4、PancakeSwap V3 的 LP 区间状态；手续费 APY 和外部激励 APY 不计入收益总额。
- 出借流动性提示，以及可刷新、停止的状态栏。
- 隐藏 DeBank 自身明确标为 scam 的交易；其他普通 Failed 交易保持可见。

随包目录识别 73 条 EVM 链（2026-09-21 快照）。19 条利率路线和 3 条 LP 路线只覆盖指定产品，
不代表每个协议在每条链均受支持。逐项产品、数据源、奖励和限制见 [完整协议指南](docs/PROTOCOLS.zh-CN.md)，
计算规则见 [数据来源](docs/DATA_SOURCES.zh-CN.md)，完整链表见 [部署目录](docs/EVM_DEPLOYMENTS.zh-CN.md)。
新增 Pendle PT、Curve 池基础收益、Beefy、Yearn、Lido、Rocket Pool 和 ether.fi，具体产品边界见协议指南。其他主流协议见[覆盖缺口清单](docs/PROTOCOL_GAPS.zh-CN.md)。

## 在另一台电脑安装

安装 Release ZIP 不需要 Node.js 或编译。

1. 从 [最新 Release](https://github.com/PG2047/debank-apy-lens-public/releases/latest)
   下载 `debank-apy-lens-0.6.0-chrome.zip`，不要下载 GitHub 自动生成的 Source code 包。
2. 解压到长期保留的文件夹。
3. 桌面 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
4. 点「加载已解压的扩展程序」，选择直接包含 `manifest.json` 的文件夹。
5. 关闭并重新打开 DeBank 标签页，确认页面状态条显示 `v0.6.0`。

不要删除解压目录。更新时用新版替换该目录中的文件，在扩展卡片点「重新加载」，再关闭并重新打开 DeBank 标签页。
此安装方式需要手动更新；以页面状态条中的版本号判断实际运行版本。

## RPC 设置

公开包不内置开发者 API Key，默认使用公共 RPC。公共端点可能限流或不支持历史状态，因此部分收益或 LP 数据可能未知。

打开扩展弹窗可填写自己的 RPC URL。主机必须在 [`utils/hosts.ts`](utils/hosts.ts) 清单内，且服务商允许浏览器跨域请求。
清单包含常用 Alchemy 主机。多个 URL 用逗号分隔，按请求轮转；「测试」按钮只测试第一个 URL。

RPC URL 保存在 Chrome `storage.sync`。如果 URL 带个人 API Key，该 Key 也是设置的一部分，可能通过 Chrome 账号同步。
不要分享含 Key 的设置或截图。详情见 [隐私说明](PRIVACY.zh-CN.md)。

## 构建与验证

使用 Node.js 22 或更新版本及 npm。

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run verify:bridge-bundle
npm run zip
```

解压产物在 `dist/chrome-mv3/`，安装 ZIP 在 `dist/`。构建不需要 `.env` 或 API Key。
`npm run dev` 启动 WXT 开发模式。部署目录更新方法见 [EVM_DEPLOYMENTS](docs/EVM_DEPLOYMENTS.zh-CN.md)。

## 数据流

扩展读取 DeBank 页面已经请求的 portfolio/history 响应副本，运行时不另行请求 DeBank。
浏览器直接查询协议 API 与 RPC；部分查询需要当前浏览的公开钱包或仓位地址。
项目不运营后端或遥测服务，不连接钱包、不签名交易。接收方、存储和控制方式见 [隐私说明](PRIVACY.zh-CN.md)。

公开仓库从独立源码快照开始，钱包测试使用合成地址，不包含私有开发历史、交接记录、本地配置和旧安装包。

## 文档

| 主题 | 中文 | English |
|---|---|---|
| 协议及产品边界 | [指南](docs/PROTOCOLS.zh-CN.md) | [Guide](docs/PROTOCOLS.md) |
| 73 条链与 LP 部署 | [目录](docs/EVM_DEPLOYMENTS.zh-CN.md) | [Directory](docs/EVM_DEPLOYMENTS.md) |
| 收益与奖励规则 | [契约](docs/DATA_SOURCES.zh-CN.md) | [Contract](docs/DATA_SOURCES.md) |
| 奖励来源链接 | [契约](docs/REWARD_SOURCE_LINKS.zh-CN.md) | [Contract](docs/REWARD_SOURCE_LINKS.md) |
| 交易过滤 | [契约](docs/TRANSACTION_FILTER.zh-CN.md) | [Contract](docs/TRANSACTION_FILTER.md) |
| 隐私 | [说明](PRIVACY.zh-CN.md) | [Notice](PRIVACY.md) |
| 更新历史 | [更新记录](CHANGELOG.zh-CN.md) | [Changelog](CHANGELOG.md) |
| 许可证 | [非正式译文](LICENSE.zh-CN.md) | [MIT](LICENSE) |

## 许可证与限制

许可证为 [MIT](LICENSE)，依赖保留各自许可证。收益为估算，会随时间变化，不构成投资建议。
离线构建成功不能证明所有实时 API、RPC 或 DeBank 页面仍然可用。

[主流协议缺口清单](docs/PROTOCOL_GAPS.zh-CN.md) · [English coverage gaps](docs/PROTOCOL_GAPS.md)
