# EVM 部署覆盖（v0.5.14）

2026-09-21：链识别覆盖 DeBank 官方 `/chain/list` 的全部 **73 条 EVM 主网**。
X Layer 的官方 ID 是 `xlayer`，EVM chainId 是 `196`。旧版没有该映射，导致
`xlayer_aave3` 在协议查询前被跳过。

## 范围与来源

| 路线 | 当前接入方式 |
|---|---|
| Aave V3 | 官方 GraphQL 按实际 chainId 查询；当日官方目录的 21 条主网全部能路由 |
| Aave V4 | 每链独立 GraphQL 查询、LRU 缓存和可取消共享加载；去除仅 Ethereum 限制；同地址跨链隔离 |
| Morpho | 官方 userByAddress 按 chainId 查询；当日官方目录 14 条主网全部能路由，包括 World Chain、Tempo、Arc |
| Dolomite、Compound V3、Venus、Fluid | 继续用官方 API 按 chainId 和精确容器身份匹配，不另设主网名单 |
| Lista | 官方市场目录的链名由统一链目录解析，不再只识别 Ethereum/BNB；链上复核钱包实际市场 |
| Spark / Sky | SparkLend 官方 Ethereum/Gnosis 来源、全链 Spark Savings Llama 数据；Sky exact share-token/farm 链上读取；已有来源未发布的产品保持未知 |
| Ethena | 官方 Key Addresses 中的 21 条 EVM 链 sUSDe 地址；覆盖通用 OFT、zkSync 与 Tempo 特例；sENA 仍限 Ethereum 的精确产品 |
| Falcon | 官方目前只列 Ethereum 的 sUSDf；BNB/XDC 的 USDf 不套用 sUSDf 质押 APY |
| Uniswap V3 / V4 | 官方部署 feed 中全部 31 / 20 条主网的成对合约地址 |
| Pancake V3 | 官方地址页的全部 9 条 EVM 主网，含 zkSync 特例、opBNB、Monad、Robinhood |

这表示支持已有产品类型在各 EVM 部署上的查询与显示，不表示每个协议都部署在每条链上。
仍不新增 Aave V2、Pancake Infinity、Curve 或 Pendle 适配器；LP 仍只显示区间与费率档，
不估算手续费 APY。来源失败、缺失奖励字段和身份不明仍显示 `unknown`，不当作 0%。

Uniswap 的 Boba、Filecoin、Moonbeam 三条历史部署仍保留完整地址与 RPC；DeBank 当前目录
没有这三条链，因此当前页面无法展示它们。不能为此猜测 DeBank 内部 ID。
Movement 使用 Move VM，移除旧表将其列为 EVM 的错误条目。

- 链目录：[DeBank](https://api.debank.com/chain/list)、[Rabby](https://github.com/RabbyHub/Rabby/blob/master/src/constant/default-support-chains.json)
- LP：[Uniswap feed](https://developers.uniswap.org/deployments.json)、[Pancake V3](https://developer.pancakeswap.finance/contracts/v3/addresses)
- Token：[Ethena](https://docs.ethena.fi/technical-design/key-addresses)、[Falcon](https://docs.falcon.finance/resources/smart-contracts)
- 公共 RPC 候选：[Ethereum Lists](https://chainid.network/chains.json)；每个入选端点均以 `eth_chainId` 复核。HyperEVM 的 999 与旧测试网存在 ID 碰撞，显式使用 Hyperliquid 官方端点。

## 可重复更新

```sh
npm run sync:deployments   # 公共元数据 -> utils/deployments.json，审查 diff
npm run check:deployments  # 检测链目录/Uniswap feed 漂移，不修改文件
npm test
npm run typecheck
npm run build
npm run verify:bridge-bundle
```

网络受限时可给同步命令配置标准 `HTTPS_PROXY`。脚本不读取 `.env`，不使用钱包数据或凭据；
同步只在开发时运行。安装后的扩展仍仅旁听 DeBank 页面自己的 portfolio 响应。
新链必须补上经过链 ID 验证的 `utils/rpc-config.ts` 公共端点，测试会检查遗漏。
MV3 精确主机权限从该 RPC 配置派生，避免链支持与网络权限漂移；不使用通配域名。
Pancake 和固定 share-token 产品从各自官方地址页核对后更新，不从 symbol 推断。

## 验证边界

链与合约目录是 2026-09-21 的快照。离线测试验证路由、权限与解码逻辑，不能证明每个公共 RPC 当前可用。
公开版不含个人 API Key。公共 RPC 的限流或历史查询限制会使部分数据保持未知。
构建后在普通 Chrome 标签页重载扩展并重新打开 DeBank，确认状态条显示 `v0.5.14`。
