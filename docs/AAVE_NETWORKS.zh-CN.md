# Aave V3、V4 与 Aave Pro 主网覆盖

[English](AAVE_NETWORKS.md) · [中文](AAVE_NETWORKS.zh-CN.md)

版本：0.7.0。核对日期：2026-11-06。范围：当前 Aave 官方 API 列出的全部 EVM 主网。
V3 为 **21 条主网、24 个市场、314 个储备**；V4 为 **4 条主网、24 个有储备的 Spoke、120 个储备**。
两版合计覆盖 22 条不同的 EVM 主网。

[Aave Pro](https://aave.com/pro) 是 Aave V4 的界面，使用同一条 `aave-v4` 适配路线。
扩展在 DeBank 持仓页显示相关收益；它不向 `pro.aave.com` 或 Aave V3 网站注入界面。

## V3 全部当前主网

| 主网 | Chain ID | DeBank ID | 市场 | 储备数 |
|---|---:|---|---|---:|
| Ethereum | 1 | `eth` | Core, Prime (Lido), EtherFi, Horizon | 91 |
| Optimism | 10 | `op` | AaveV3Optimism | 14 |
| BSC | 56 | `bsc` | AaveV3BNB | 8 |
| Gnosis | 100 | `xdai` | AaveV3Gnosis | 9 |
| Polygon | 137 | `matic` | AaveV3Polygon | 21 |
| Monad | 143 | `monad` | AaveV3Monad | 14 |
| Sonic | 146 | `sonic` | AaveV3Sonic | 4 |
| X Layer | 196 | `xlayer` | AaveV3XLayer | 13 |
| zkSync | 324 | `era` | AaveV3ZkSync | 8 |
| Metis | 1088 | `metis` | AaveV3Metis | 5 |
| Soneium | 1868 | `soneium` | AaveV3Soneium | 3 |
| MegaETH | 4326 | `megaeth` | AaveV3MegaETH | 9 |
| Mantle | 5000 | `mnt` | AaveV3Mantle | 10 |
| Base | 8453 | `base` | AaveV3Base | 15 |
| Plasma | 9745 | `plasma` | AaveV3Plasma | 18 |
| Arbitrum | 42161 | `arb` | AaveV3Arbitrum | 20 |
| Celo | 42220 | `celo` | AaveV3Celo | 6 |
| Avalanche | 43114 | `avax` | AaveV3Avalanche | 18 |
| Ink | 57073 | `ink` | AaveV3Ink | 14 |
| Linea | 59144 | `linea` | AaveV3Linea | 9 |
| Scroll | 534352 | `scrl` | AaveV3Scroll | 5 |

Ethereum 的四个官方市场标识为 `AaveV3Ethereum`、`AaveV3EthereumLido`（Prime）、
`AaveV3EthereumEtherFi`、`AaveV3EthereumHorizon`。独立市场的同名资产不会混用利率。
Horizon 的 RWA 抵押与借款资格仍由协议和资产发行方决定；显示利率不代表取得使用资格。

## V4 / Aave Pro 全部当前主网

| 主网 | Chain ID | DeBank ID | Spoke 数 | 储备数 |
|---|---:|---|---:|---:|
| Ethereum | 1 | `eth` | 16 | 89 |
| Arc | 5042 | `arc` | 3 | 8 |
| Base | 8453 | `base` | 1 | 9 |
| Avalanche | 43114 | `avax` | 4 | 14 |

本次 API 返回的 Spoke 名称：

- **Ethereum:** Bluechip（两个合约）, Ethena Correlated, Ethena Ecosystem, Etherfi, Forex, Gold, Kelp, Lido, Lombard, Main, Maple SyrupUSDG, OUSD Yield, PAXG Gold, RLUSD Yield, USDG Pendle.
- **Arc:** Forex, Main, Maple SyrupUSDC.
- **Base:** Coinbase Stocks.
- **Avalanche:** AVAX Correlated, Ethena Ecosystem, Forex, Main.

完整合约地址和每个市场的储备数见 [`utils/aave-markets.json`](../utils/aave-markets.json)。
相同名称可能对应不同合约；匹配使用 chain ID 与地址，不使用名称。

## 计算与匹配

- V3：按链、market 地址、underlying 资产和存借方向匹配，读取官方基础 APY 与 incentive union。
  Aave/Merkl/Merit 数字奖励保留原始 APR 口径；积分和条件奖励单独披露。
- V4：按链、Spoke、资产和存借方向匹配。用户借款读取 `userState.borrowApy`，包含风险溢价。
  Merkl 使用 `userEffectiveExtraApy` / `userEffectiveDiscountApy`，包含资格和净额扣减，口径为 APY。
  没有用户地址时，借款仅为市场报价，用户专属奖励保持未知。
- 同一 Spoke 与资产如果跨多个 Hub，使用官方 `userSupplies` / `userBorrows` 的 reserve ID 区分存借腿。
  同一腿只在一个候选储备有持仓时可匹配；若多个候选均有持仓，或缺少用户身份，保持未知，不按返回顺序取值。
- 原生币按官方 `nativeWrappedToken`（V3）或 `nativeAsset`（V4）映射，包含 Arc 的共享余额 USDC。
  DeBank 原生币 ID 只在所属链上生效，不按 ticker 猜测。映射只改变身份，不改变人类可读 token 数量。
- 正常 `aave3` / `aave4` 路线按实际 chain ID 查询。DeBank 使用独立子品牌时，当前快照的 market/Spoke 地址可补充识别；
  仍须逐腿匹配储备。新增独立品牌地址需要更新快照。
- 两版均按钱包与链分开缓存，成功结果保留 5 分钟、最多 64 项；并发请求共享加载并可分别取消。
  单链失败不会清除其他链的成功结果。
- V3 流动性来自市场储备；V4 来自共享 Hub 的资产统计，不能把 Spoke 的存款减借款当作可提款。

## 范围限制

全部网络指以上官方 API 当前主网。测试网、Aptos（非 EVM）、Aave V1/V2 不在本版本范围内。
Fantom 和 Harmony 虽出现在旧部署资料中，但不在当前 V3 API 主网目录，未作为已支持的现行市场列出。
仅当 DeBank 提供相关持仓、正确链和可匹配 market/Spoke 身份时才会显示；未知身份与 API 失败保留为未知。
扩展仍使用现有的 $100 独立仓位/协议净值过滤。范围覆盖不保证每个实时页面、每个钱包或未来新增部署均可用。

## 验证与更新

本次匿名实时 API 响应覆盖全部 25 个版本/主网组合，并交给实际适配器回放：926 次存借匹配检查通过。
其中 24 次检查涉及 Ethereum 的 6 组同 Spoke、同资产、多 Hub 储备，匿名状态正确返回未知。
测试样例另行覆盖逐市场 DeBank 解析、原生币、用户风险溢价/净额奖励、多个 Hub 的存借区分及缓存/取消。
带用户字段的 API 查询已用公开合成地址验证结构；未验证真实个人钱包的利率或实时 DeBank 页面。

```sh
npm run check:aave                  # 查询官方目录并验证现有覆盖
npm run check:aave -- --write       # 更新合约快照；检查差异
npm run check:aave -- --output /path/to/report
```

命令无需 Key，不读取本地凭据。若当前终端的网络需要代理，可使用支持环境代理的 Node 版本及其代理选项。

## 官方来源

- [V3 市场模型与查询](https://www.aave.com/docs/aave-v3/markets/data)
- [V4 主网目录与原生资产](https://www.aave.com/docs/aave-v4/liquidity/chains)
- [V4 GraphQL schema](https://github.com/aave/aave-v4-sdk/blob/main/packages/graphql/schema.graphql)
- [Aave Pro 用户指南](https://aave.com/blog/aave-pro-user-guide)
- [V3 API](https://api.v3.aave.com/graphql) · [V4 API](https://api.v4.aave.com/graphql)
