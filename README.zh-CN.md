# DeBank APY Lens

在 DeBank 仓位页面显示基础收益、奖励、借款成本、循环贷净 APY、杠杆和 LP 区间。
公开版为 `v0.5.14`，使用公共 RPC，不内置开发者的 API Key。

本项目独立开发，与 DeBank 无隶属或背书关系。DeBank [服务条款第 4(h) 项](https://debank.com/docs/terms)
限制未经授权的浏览器扩展访问数据或修改页面。MIT 许可证只授权使用本项目代码，不提供 DeBank 服务授权。
本项目尚未提交 Chrome Web Store。

## 安装

1. 打开 [最新 Release](https://github.com/PG2047/debank-apy-lens-public/releases/latest)，
   下载 `debank-apy-lens-0.5.14-chrome.zip`，不要下载自动生成的 Source code 包。
2. 解压到长期保留的文件夹。
3. Chrome 打开 `chrome://extensions`，开启「开发者模式」。
4. 点「加载已解压的扩展程序」，选择直接包含 `manifest.json` 的文件夹。
5. 关闭并重新打开 DeBank 标签页，确认页面状态条显示 `v0.5.14`。

安装不需要 Node.js 或编译。不要删除解压目录。更新时，将新版文件放回同一目录，在扩展卡片点「重新加载」，
再关闭并重新打开 DeBank 标签页。此安装方式需要手动更新。

## RPC 与覆盖范围

默认公共 RPC 可能限流或不支持历史查询；这时部分收益或 LP 数据会保持未知。
可以在扩展弹窗填写自己的 RPC URL。当前版本支持的主机见 [`utils/hosts.ts`](utils/hosts.ts)，
包括常用 Alchemy 主机。RPC 服务需允许浏览器跨域请求。

设置保存在 Chrome `storage.sync`，可能通过 Chrome 账号同步。若 URL 带个人 API Key，该 Key 也是设置的一部分。
详情见 [隐私说明](PRIVACY.md)。

链目录为 2026-09-21 的 73 条 EVM 链快照；12 个利率适配器和 3 个 LP 路由只覆盖指定产品。
Curve、Pendle 尚未支持。LP 手续费和外部激励 APY 不进入收益总额。未知数据不会显示成 0%。

源码构建、功能边界和数据流见 [README](README.md)。许可证为 [MIT](LICENSE)。
