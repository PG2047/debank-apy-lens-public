# 支持的协议与产品

[English](PROTOCOLS.md) · [中文](PROTOCOLS.zh-CN.md)

版本：0.5.15。依据：`utils/adapters/registry.ts`、各 adapter 和部署目录。本文说明代码能力，不代表每个实时市场已验证可用。

**12 条利率路线 + 3 条 LP 路线。** 路线数量不等于协议品牌数量。链识别目录含 73 条 EVM 链（2026-09-21 快照），不代表每个协议在每条链均受支持。

| 路线 ID | 协议 / 产品 | 类型 |
|---|---|---|
| `aave-v3` | Aave V3 | 利率 |
| `aave-v4` | Aave V4 | 利率 |
| `morpho` | Morpho | 利率 |
| `lista` | Lista DAO / Moolah | 利率 |
| `spark` | Spark | 利率 |
| `sky` | Sky / Maker | 利率 |
| `dolomite` | Dolomite | 利率 |
| `compound-v3` | Compound V3 | 利率 |
| `venus` | Venus | 利率 |
| `fluid` | Fluid | 利率 |
| `ethena` | Ethena | 利率 |
| `falcon` | Falcon Finance | 利率 |
| `uniswap-v3` | Uniswap V3 | LP 区间 |
| `uniswap-v4` | Uniswap V4 | LP 区间 |
| `pancake-v3` | PancakeSwap V3 | LP 区间 |

## 逐项支持范围

### Aave V3 — `aave-v3`

- **支持产品:** 存款、借款及循环贷仓位。
- **基础数据:** Aave V3 GraphQL reserve 利率；按链、market、reserve 和存借方向匹配。
- **奖励 / 显示内容:** 官方 reserve incentives；数字 APR/APY 与积分、资格分开显示。
- **边界:** 不支持 Aave V2。只有完整且成功的奖励响应才能证明奖励为零。

### Aave V4 — `aave-v4`

- **支持产品:** 精确 spoke 与 reserve 下的存借仓位。
- **基础数据:** Aave V4 GraphQL spoke reserve 数据；各链独立路由，同地址的不同链 spoke 不混用。
- **奖励 / 显示内容:** 官方 reward union；积分与不可年化权益独立披露。
- **边界:** 流动性统计采用 Hub 级数据，不用 spoke 存款减借款代替。缺少 spoke 身份或来源时保持未知。

### Morpho — `morpho`

- **支持产品:** Blue 直接存借款/抵押、Deposit Proxy 仓位、Vault V1/V2、Midnight 固定期限出借。
- **基础数据:** Blue API 用户市场和金库状态；Deposit Proxy 使用代理地址加完整 market ID。Midnight 使用用户仓位 REST API 的 effective_rate_wad。
- **奖励 / 显示内容:** 市场/金库原生奖励；抵押腿由精确 LIVE Merkl 活动快照补充。Midnight 不套用 Blue/Vault 激励。
- **边界:** 不同金库版本分别处理。Midnight 必须匹配链、用户、市场、出借资产、lend 角色和非零 credit。年化率是固定期限等值，日收益为估算，到期后基础收益为零。不按代币简称猜测身份。

### Lista DAO / Moolah — `lista`

- **支持产品:** 已识别的 Lista ERC-4626 金库、精确 Moolah 借款/抵押市场。DeBank 的 Lista ID 可能为 bsc_helio。
- **基础数据:** 金库份额价格 24 小时变化，Lista API 兜底。Moolah 先按链与资产对筛官方市场，再链上核对钱包仓位。
- **奖励 / 显示内容:** 金库 emission APY；精确市场 borrow/holder emission。积分倍数单独显示。
- **边界:** 同资产对的多个市场必须唯一定位到钱包实际使用的市场。公共 RPC 可能不支持历史查询。非生息 Moolah 抵押品不虚构基础收益。

### Spark — `spark`

- **支持产品:** SparkLend 与已识别的 Spark Savings 产品。
- **基础数据:** Ethereum/Gnosis 的 Block Analitica SparkLend 市场；DeFiLlama 唯一产品证据补缺，并覆盖匹配的储蓄产品。
- **奖励 / 显示内容:** 只纳入有明确证据的奖励组件；基础市场端点不枚举全部奖励。
- **边界:** 基础利率不能证明奖励为零。多个候选池保持未知，不任取 TVL 最高池。

### Sky / Maker — `sky`

- **支持产品:** 精确 sUSDS/stUSDS 储蓄合约及已识别生态奖励 farm；识别 sky、makerdao 两类 DeBank ID。
- **基础数据:** 储蓄链上 ssr/str；Ethereum Chainlog 发现 farm，合约读取验证质押币、奖励币与活动状态。仅旧储蓄产品允许唯一 DeFiLlama 池兜底。
- **奖励 / 显示内容:** 精确 farm 官方 APR，或具有有效价格和池规模分母的链上 emission 计算。
- **边界:** 缺 farm ID 时须以质押币和钱包余额唯一匹配。身份、价格或活动状态不确定时保持未知，不靠 DeFiLlama 名称推断 farm 收益。

### Dolomite — `dolomite`

- **支持产品:** 已识别的存借腿，包括多资产复合仓位。
- **基础数据:** 官方按链 token interest-rates。
- **奖励 / 显示内容:** 明确的 outsideSupplyInterestRateParts 等奖励组件。
- **边界:** 按链、市场 token 和存借方向匹配，不因简称相同合并无关仓位。

### Compound V3 — `compound-v3`

- **支持产品:** Comet 基础资产存借，抵押品按该 Comet 产品规则处理。
- **基础数据:** 官方全链 market summary，按 Comet 与 base asset 匹配。
- **奖励 / 显示内容:** 独立官方 rewards 端点，匹配同一 Comet 和方向。
- **边界:** 不支持 Compound V2。奖励请求失败时保留基础利率，但奖励覆盖不完整。抵押品不套用基础资产存款利率。

### Venus — `venus`

- **支持产品:** 已识别的 Venus 市场、存款及借款。
- **基础数据:** 官方 market base APY，按 comptroller/vToken 与 underlying 匹配。
- **奖励 / 显示内容:** 明确的 distributors/rewardDetails。已披露 intrinsic/YTM 组成归基础收益，积分单列。
- **边界:** 缺 distributor 字段或不支持的权益不能变成奖励零值。

### Fluid — `fluid`

- **支持产品:** fToken 出借及已识别 vault，含类型 2/3/4 的 Smart Collateral/Debt。
- **基础数据:** 官方 fToken/vault 利率及 smart vault 的 token liquidity rate。
- **奖励 / 显示内容:** 精确 fToken/vault rewards；dex.trading 可作为对应 smart collateral/debt 方向的独立收益组件。
- **边界:** 匹配 fToken/vault、资产和方向。此 Fluid 组件不等于支持通用 Uniswap/Pancake LP 手续费 APY。

### Ethena — `ethena`

- **支持产品:** 各链 canonical sUSDe 份额币，以及精确 Ethereum sENA/锁定 ENA 产品。
- **基础数据:** 官方 sUSDe staking yield；精确 sENA 的协议基础利率为 0%。固定 token 表含 21 个 chain ID。
- **奖励 / 显示内容:** 只显示可验证的数字收益。排除 Ethena 积分、Sats、倍数、空投估值和资格元数据。
- **边界:** 不同链上同简称或同地址均不足以匹配。普通 USDe 不等于 sUSDe。token 表有记录不代表新增 DeBank 未收录的链。

### Falcon Finance — `falcon`

- **支持产品:** 精确 Ethereum sUSDf 质押份额币。
- **基础数据:** 官方 sUSDf 7 日 APY。
- **奖励 / 显示内容:** 额外激励未穷尽覆盖，不推断完整奖励总额。
- **边界:** BNB Chain 或 XDC 的 USDf 不套用 sUSDf 收益。

### Uniswap V3 — `uniswap-v3`

- **支持产品:** NFT 集中流动性仓位。
- **基础数据:** 链上 position manager、factory、pool 和 tick 读取。
- **奖励 / 显示内容:** 区间状态、现价/上下界、代币占比及费率档元数据。
- **边界:** 不计算手续费 APY、外部激励 APY，LP 收益不计入每日汇总。目录含 31 条链部署，其中三条不在 DeBank 链目录。

### Uniswap V4 — `uniswap-v4`

- **支持产品:** 具有精确 pool key 和 hooks 的 NFT 集中流动性仓位。
- **基础数据:** 链上 position manager 与 StateView；由完整 pool key 推导 pool ID。
- **奖励 / 显示内容:** 区间状态与价格；目录含 20 条链部署。
- **边界:** 不计算手续费 APY 或外部激励 APY。hooks 是仓位身份的一部分，不表示支持任意 hook 的收益机制。

### PancakeSwap V3 — `pancake-v3`

- **支持产品:** V3 NFT 集中流动性仓位。
- **基础数据:** 链上 manager/factory 读取；zkSync 使用独立部署地址。
- **奖励 / 显示内容:** Ethereum、BNB Chain、Arbitrum、Linea、Base、opBNB、Monad、Robinhood、zkSync Era 的区间状态和价格。
- **边界:** 不支持 Pancake Infinity、V2；不计算手续费 APY 或外部激励 APY。

## 共享规则与不支持项

- 净 APY 以权益（存款减借款）为分母。APY 与 APR 分开标注；日收益为按当前利率的前瞻估算，不是实际到账收益。
- 未知不等于 0%。奖励采用已知数字、确认零、未知、不可年化、不适用五种状态。覆盖不完整时显示“小计”。
- 净资产低于 $100 的独立仓位或协议在查询前忽略。奖励/基础利率未知金额超过存借毛额 1% 时，不显示完整净 APY；协议级覆盖还必须满足每个子仓位。
- LP 手续费 APY 和外部激励 APY 均明确排除，不计入日收益或顶部缺口。Fluid smart vault 的官方 DEX 收益组件是单独的产品逻辑。
- Merkl 是跨协议奖励及待领数据源，DeFiLlama 是受限制的补缺来源；它们不是额外的通用协议适配器。
- 当前没有 Curve、Pendle、Aave V2、Compound V2、Uniswap V2、Pancake V2/Infinity 路线。不支持的协议会跳过，不按 token 简称猜利率。
- 公共 RPC 可能限流或缺少历史状态。官方 API、DeBank DOM 或协议部署变化都可能导致部分数据未知；离线测试不能证明实时可用性。

完整链表见 [EVM 部署覆盖](EVM_DEPLOYMENTS.zh-CN.md)；计算和奖励契约见 [数据来源](DATA_SOURCES.zh-CN.md)。
