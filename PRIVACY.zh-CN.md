# 隐私说明

[English](PRIVACY.md) · [中文](PRIVACY.zh-CN.md)

适用于公开版 DeBank APY Lens v0.7.0。更新日期：2026-11-06。

## 扩展读取的数据

扩展在 `debank.com` 读取页面 portfolio/history 响应的副本，可能包含公开钱包地址、仓位和合约标识、
余额、代币数量、价格及交易记录。扩展还读取页面结构，用于放置收益标签和隐藏 DeBank 标记的 scam 行。
扩展不读取无关网站。

扩展不索取助记词或私钥，不连接钱包、不签名或提交交易。公开包没有内置开发者 API Key。

## 请求与接收方

浏览器直接向协议 API 和区块链 RPC 服务商发送请求，以计算收益、奖励和区间。
项目没有自营后端、分析统计或广告端点。

API 来源包括 Aave、Morpho、Merkl、DeFiLlama、Lista、Block Analitica、Sky Chainlog、Dolomite、
Compound、Venus、Fluid、Ethena、Falcon、Pendle、Curve、Beefy、Yearn（yDaemon）、Lido 和 Rocket Pool。
ether.fi 使用公共 Ethereum RPC 读取 weETH 合约。新增的目录/利率端点无需钱包地址；Yearn 请求包含金库合约地址。
默认公共 RPC 与支持用户填写的 Alchemy 主机见
[`utils/rpc-config.ts`](utils/rpc-config.ts)；完整主机权限见 [`utils/hosts.ts`](utils/hosts.ts)。

请求可能包含 chain ID、token/合约地址、market ID、NFT ID 及当前查看的钱包或代理地址。
用户仓位、资格、待领奖励、链上余额和仓位查询需要时会使用公开钱包地址；RPC 服务商以 JSON-RPC 参数接收这些值。
Aave V4 会接收当前查看的公开钱包地址，用于查询风险溢价、奖励资格/净额扣减及实际持仓 reserve ID。
完整 DeBank 组合响应不会被发送到项目服务器。

每个服务商可能接收 IP 地址和常规连接信息，并按自己的政策保留请求日志。点击来源链接会打开该服务商网站。
DeBank 仍处理页面的正常请求；扩展运行时不另行请求 DeBank。可选的开发用部署更新脚本会查询公开链元数据。

## 存储与保留时间

组合数据、历史样本、计算结果和 API 缓存保存在内存中，不写入 Chrome 持久存储。
页面数据随文档结束释放；service worker 缓存按过期或淘汰策略清理，或随 worker 终止释放。

界面语言 `auto`、`zh-CN` 或 `en` 保存在 Chrome `storage.sync` 的 `dal:language`，可能通过 Google 账号同步。
切换语言只重绘现有结果，不增加协议查询。

自定义 RPC URL 保存在 `dal:rpcOverrides`。是否跨设备同步取决于 Chrome 设置和扩展身份。
如果 URL 包含 API Key，保存及同步的设置也包含该 Key；使用时会发送给对应 RPC 服务商，不发送给项目维护者。

扩展会向本地浏览器控制台写运行诊断，不向维护者上传日志。在公开 Issue 中分享日志或截图前，请检查其中的内容。

## 控制与联系

页面「停止」按钮可取消当前收益刷新。清空 RPC 输入可删除该项覆盖设置。禁用扩展可停止其页面处理；
卸载扩展会删除本地扩展设置，Chrome 账号同步及第三方请求日志由相应服务商管理。

问题可提交到仓库 [Issue](https://github.com/PG2047/debank-apy-lens-public/issues)。
Issue 是公开的，请勿包含凭据、私密持仓截图或个人信息。
