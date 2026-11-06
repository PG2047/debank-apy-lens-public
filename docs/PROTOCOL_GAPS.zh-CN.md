# 主流 EVM 协议覆盖缺口

[English](PROTOCOL_GAPS.md) · [中文](PROTOCOL_GAPS.zh-CN.md)

核对日期：2026-11-06；对应版本：v0.6.0。依据为
[DeFiLlama 协议数据集](https://api.llama.fi/protocols)、协议官方文档和实时公开 API 响应。
TVL 用于发现遗漏，不是安全评分。TVL 数据集中的历史部署，不代表产品仍活跃或利率 API 可用。

## 本版新增

| 协议 | 新增范围 | 主网范围 |
|---|---|---|
| Pendle V2 | 精确 PT 的当前到期收益率及到期处理 | 官方目录含 13 个 chain ID；只支持目录内精确 PT 市场 |
| Curve | 精确池/LP/gauge 的基础收益；个人激励保持未知 | 配置了 16 条 EVM 主网 |
| Beefy | 活跃 standard 金库净综合收益 | 动态目录；本次核对有 12 条链存在活跃 standard 金库 |
| Yearn | 精确金库的七日净份额增长 | Ethereum、Optimism、Polygon、Base、Arbitrum、Katana |
| Lido | canonical stETH/wstETH 质押收益 | Ethereum、Optimism、Arbitrum、Base |
| Rocket Pool | canonical rETH 质押收益 | Ethereum |
| ether.fi | eETH/weETH 基础份额增长 | Ethereum |

注册表现有 **19 条利率路线及 3 条 NFT LP 区间路线**。这不代表各品牌全部产品均已支持。
公式、完整链表、身份匹配和奖励边界见[协议指南](PROTOCOLS.zh-CN.md)。
新增 Curve 和金库收益路线，不改变原有 Uniswap/Pancake NFT 手续费 APY 的排除规则。

## 仍未接入的主流协议

以下均为明确缺口，尚未启用适配器。链示例来自本次协议清单；实施前仍须核对各产品的官方部署和利率来源。

| 协议 / 类别 | 优先核对的 EVM 主网 | 尚需完成的部分 |
|---|---|---|
| Euler V2 / EulerEarn | Ethereum、Base、Arbitrum、Avalanche、Monad、Plasma、HyperEVM | 精确 EVK/Earn 金库与账户/子账户匹配，区分利息、内生收益及激励。官方[公开 V3 API](https://docs.euler.finance/build/data-querying/euler-v3-api/) 在当前开发环境返回 HTTP 403；这不代表其他环境均不可用。 |
| Maple / syrup | Ethereum、HyperEVM | 精确池/份额身份、费用与赎回条款、当前及历史收益、syrup 奖励资格。 |
| Convex | Ethereum、Arbitrum、Fraxtal、Polygon | 精确质押包装与 Curve 池、CRV/CVX 奖励、boost 及独立奖励合约。支持 Curve 不等于支持 Convex。 |
| StakeWise V3 | Ethereum、Gnosis | 各金库份额收益、osETH 敞口、运营者/金库费用。 |
| Kelp 等再质押金库 | Ethereum 及经核对的桥接部署 | canonical 份额币、扣费后汇率、独立再质押分配。 |
| Kinetiq / stHYPE | HyperEVM | 精确质押份额、HYPE 本位收益、额外激励。 |
| BENQI Lending / sAVAX | Avalanche | 精确借贷市场、存借激励；sAVAX 汇率历史需单独接入。 |
| Silo V2 | Sonic、Avalanche、Arbitrum、Ethereum | Silo 配置、逐资产金库、抵押模式和奖励。仅按 token 查利率不足以定位市场。 |
| HyperLend / HypurrFi | HyperEVM | 精确 reserve 市场、存借利率和奖励分配。 |
| Balancer V2/V3 | Ethereum、Base、Arbitrum、Gnosis、Avalanche 等经核对部署 | 池版本、BPT 组成、可组合池、gauge 奖励和用户 boost。 |
| Aerodrome / Velodrome | Base；Optimism 及 Superchain 部署 | 区分普通池与 Slipstream NFT，计算手续费份额、gauge 质押及奖励资格。 |
| Aave V2 / Compound V2 | 经核对的历史部署主网 | 旧市场身份、利率和奖励接口；支持 V3 不等于支持 V2。 |

## 新增品牌内仍有的缺口

- Pendle：YT、LP、Boros、积分，以及用户买入价对应的锁定收益率。
- Curve：个人 CRV boost/奖励、Curve Lending、crvUSD 借款及配置范围外的 Curve Core 新链。
- Beefy/Yearn：独立 staking/Boost 包装、治理金库、已停用产品及需额外领取的激励。
- Lido：更多桥接部署、stVault 所有者收益及提款。
- Rocket Pool：桥接 rETH、node/minipool/megapool 运营收益和 RPL 奖励。
- ether.fi：桥接 weETH、eBTC、Liquid 金库、提款、积分及额外再质押奖励。

## 验证范围

测试覆盖精确身份、跨链同地址、到期、单源失败隔离、奖励未知状态、年化和综合收益计算。
实时公开 API 样本与合成 DeBank 仓位分别检查。这些检查不证明所有当前 DeBank 页面结构或市场均可用。
RPC/API 失败时继续显示未知，不会当成零。
