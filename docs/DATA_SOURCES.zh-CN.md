# 数据源、奖励覆盖与显示契约（v0.7.0 · 2026-11-06）

[English](DATA_SOURCES.md) · [中文](DATA_SOURCES.zh-CN.md)

本文件与公开仓库的代码、测试共同定义当前行为。完整产品范围见 [协议指南](PROTOCOLS.zh-CN.md)。

## Aave 更新 — v0.7.0

[Aave 全部主网与市场范围](AAVE_NETWORKS.zh-CN.md)：V3 为 21 条当前 EVM 主网，V4/Pro 为 4 条。
两个适配器均按钱包和链隔离缓存/共享加载，原生币别名使用官方资产信息。
V4 用户借款使用包含风险溢价的 `userState.borrowApy`；Merkl 使用资格与净额扣减后的用户有效 APY。
同 Spoke、同资产的多个 Hub 储备按用户实际存借 reserve ID 区分；多个候选都有持仓时保持未知。

## EVM 部署范围

链识别使用 DeBank 官方全量目录，而非 TVL 前 20 名。Aave V3、Morpho、Compound、
Dolomite、Venus、Fluid 按实际仓位的 chainId 请求官方来源；Aave V4 按 chainId 查询、
隔离缓存与共享加载，单链失败不影响其他链。Lista 的官方链名使用统一目录解析。
Llama 和 Sky 的链名解析接受官方 ID、展示名与已确认别名，避免大小写/空格导致遗漏。

LP 合约、公共 RPC 与 MV3 主机权限分别有完整性测试；Ethena 使用每链 canonical sUSDe 地址，
不能把 Ethereum 的同地址或仅同名资产识别成其他链上的 sUSDe。新增链不改变奖励零证明规则。
部署数量、来源与维护步骤见 [EVM_DEPLOYMENTS.md](EVM_DEPLOYMENTS.zh-CN.md)。

## 不变量

1. 基础收益与奖励独立建模；APY、APR、annual-USD 不互相冒充。
2. `0%` 只表示权威且穷尽的来源成功返回该角色没有适用奖励。
3. HTTP 失败、字段缺失、分页不完整、身份歧义、非穷尽来源均为 `unknown`。
4. 奖励必须绑定 market、spoke、vault、Comet、vToken、fToken 或 LP position；禁止只按 token、首个池、最大 TVL 或最大借款规模猜测。
5. points、multiplier、白名单、私有补贴和缺少公开年化公式的奖励通过 `rewardEntitlements` 独立披露；其验证等级不覆盖数字奖励的 `rewardState`，不换算成 APR，也不进入净 APY、今日收益或 Portfolio 汇总。
6. 已知组件始终保留；物料性未知组件存在时只显示“小计”，不得称为完整净 APY。

## 奖励五态

| 状态 | 含义 | 数值贡献 |
|---|---|---|
| `numeric-known` | 已证明适用、年化口径与基数明确 | 计入 |
| `confirmed-zero` | 精确角色的穷尽查询成功且无适用奖励 | 计 0 |
| `unknown` | 来源失败、不完整、非穷尽或身份歧义 | 不计；阻断完整总数 |
| `non-annualizable` | 奖励存在但无可靠公开年化合约 | 不计；阻断完整总数 |
| `not-applicable` | 奖励类别在结构上不适用于该仓位 | 覆盖视为完整，计 0 |

同一 item 中 `unknown/non-annualizable` 腿合计超过存借毛额 1% 时，完整净 APY 与完整今日预估不可用；更小的未知腿作为尘埃披露。净资产低于 $100 的独立仓位与协议在 adapter/API/RPC 查询前过滤，不渲染、不汇总也不产生缺口。

## DeBank history/list 旁听

- 端点：`https://api.debank.com/history/list`；响应主形状为 `{ data: { history_list: [...] }, error_code }`，同时宽容 `data` 直接为数组的形状。
- 数据只来自 DeBank 页面已签名请求的 fetch/XHR 响应副本；插件不独立请求该端点，也不增加 host 权限。
- `is_scam` 是 DeBank 服务端标记；严格解析层直接丢弃 `is_scam === true` 的记录，不把它解释为本地启发式判断。
- 合法记录仅按地址保存在内存中，按交易哈希去重并保留时间最新的 100 条，不落盘、不进入 APY enrich/service worker 通道。

## 全路线能力矩阵

代码级矩阵在 `utils/adapters/capabilities.ts`，`tests/capabilities.test.ts` 强制覆盖全部 19 个 rate adapters 与 3 个 LP routes。

| 路线 | 基础收益来源 | 奖励来源与优先级 | 精确身份 | 无法证明时 |
|---|---|---|---|---|
| Aave V3 | AaveKit `api.v3.aave.com/graphql` market reserve | 同一 reserve 的官方 incentive union；Merkl/Aave/Merit 数字奖励保留，points 单独披露 | market address + reserve + leg | `unknown` / `non-annualizable` |
| Aave V4 | `api.v4.aave.com/graphql` spoke reserve；8 秒传输预算、10 秒 card deadline；每链冷加载 subscriber-aware single-flight | 官方 `summary.rewards`；数字奖励与 points 可同时存在 | spoke + reserve + leg；无 asset fallback | `unknown` / `non-annualizable` |
| Morpho Market | Blue API `userByAddress`；Deposit Proxy 使用 DeBank `position_index` 的代理地址查询 | native supply/borrow；Merkl 完整 LIVE 快照补 native API 缺失的 collateral role；完整快照无精确市场时为 `confirmed-zero`；不附加 Ethena 积分或资格 | 完整 market ID；Deposit Proxy 须精确匹配 `proxy:marketId`、loan asset 与代理非零 supply；其他缺 ID 时须由用户仓位中的完整资产集合唯一定位 | Merkl 传输/完整性失败为 `unknown`；完整精确市场无匹配为 `confirmed-zero` |
| Morpho Vault V1/V2 | Blue API vault state | native `allRewards/rewards`；两代分开 | vault address + generation | `unknown` |
| Morpho Midnight Yield | 官方 REST `/v0/midnight/users/{address}/positions` 的 `effective_rate_wad`；固定期限的年化有效利率，今日收益是等值估算 | Blue/Vault 的原生及 Merkl 活动不套用到 Midnight，标记 `not-applicable`，不声称所有外部激励为零 | chain + user + 完整 Midnight market ID + loan token + `lend` + 非零 credit | API 失败、分页未完成、利率缺失或身份不符为 `unknown`；到期后基础利率为 0 |
| Spark | Block Analitica markets；Llama 仅作缺失基础腿补充 | 官方 markets 不穷尽奖励；只有唯一产品证据才保留已知 Llama 组件 | product + chain + unique reserve | `unknown`，不能给出 0 |
| Sky / Maker | exact share-token 合约 `ssr/str`；legacy savings 才降级 `sky-lending` | Sky Chainlog 发现，链上验证 farm 身份/活动期，Sky exact-farm BA APR 或链上公式为数字源；farm 禁用 Llama UUID 降级 | share token；或 exact farm；缺 pool 时以 staking token + wallet balance/amount 唯一定位，DeBank reward token 若存在必须一致 | `unknown` / `non-annualizable` |
| Dolomite | `api.dolomite.io/tokens/{chain}/interest-rates` | `outsideSupplyInterestRateParts` / `outsideBorrowInterestRateParts` 中 `category=rewards` | chain + market token + leg | `unknown` |
| Compound V3 | 官方 summary | 官方 rewards endpoint；以 Comet join | Comet + base asset + leg | `unknown` |
| Venus | `api.venus.io/markets` base fields | 显式 `rewardsDistributors` / `rewardDetails`；intrinsic/YTM 按基础收益处理，points 不数值化 | comptroller 或 vToken + underlying + leg | `unknown` / `non-annualizable` |
| Fluid fToken | `/v2/lending/{chain}/tokens` | `/v2/lending/{chain}/rewards` 仅用于 exact fToken supply | fToken + underlying | `unknown` |
| Fluid Vault | `/v2/{chain}/vaults` | exact `rewards[]`；type 2/3/4 Smart Collateral/Debt 按 token liquidity rate，并把对应侧 `dex.trading` 保留为独立 APY 组件 | vault address + asset + leg | `unknown` |
| Lista Vault | ERC-4626 24h share-price 差分，Lista API 降级 | Lista `emissionApy` 与基础收益独立合并 | vault address | `unknown` |
| Lista Moolah | Lista 官方 `allMarkets` 按 chain + loan/collateral 预筛，链上复核 market/IRM，再读官方 exact market detail | 官方 `borrowEmissionApy`/`holderBorrowEmissionApy`；points 独立为 entitlement | 预筛后的同资产对多市场读取 `position(marketId,wallet)`，仅接受唯一非零 market id；禁止把全市场目录直接发进 RPC batch | 完整 market detail 的数字零为 `confirmed-zero`；points 不年化 |
| Ethena | 官方 sUSDe staking yield；exact sENA Locked ENA 的协议利率为 0% | 所有 Ethena points、Sats、multiplier、空投和资格元数据均策略排除 | exact sUSDe share token；或 ENA underlying + `sENA` 产品身份 | `not-applicable`；只显示数字收益率 |
| Falcon | 官方 sUSDf 7-day APY | 额外活动无公开穷尽源 | exact sUSDf share token | `non-annualizable` |
| Uniswap V3/V4、Pancake V3 | 链上 NFT、pool、tick 与费率档 | 手续费 APY 与外部激励 APY 均明确不跟踪 | pool + NFT + range；V4 另含 hooks | 两类 APY 均为 `not-applicable` 策略排除，不进入收益或顶部缺口 |

## 流动性风险口径

流动性风险只评估借贷/金库的供给腿，不作用于借款腿、Morpho 隔离市场 collateral 腿或 LP 卡：

1. 当前可提流动性 `≤ 我仓位 × 110%` 时为红色“⚠流动性紧张”。
2. 我仓位占池子总规模 `≥ 10%` 时为黄色“占比 N%”；两条同时命中时红色优先。

| 来源 | 总规模 | 当前可提 | 口径 |
|---|---|---|---|
| Aave V3 | `supplyInfo.total.value`(DecimalValue,token 数)× `availableLiquidity.usdPerToken` 换算 USD;无 `borrowInfo`(不可借资产)时无价格可换算 → 降级 token 口径 | `borrowInfo.availableLiquidity.usd`;`borrowInfo=null` 时未知 | USD(降级时 token) |
| Aave V4 | **Hub 级** `asset.summary.supplied.amount.value`(reserve.asset 即 HubAsset) | **Hub 级** `asset.summary.availableLiquidity.amount.value`;缺失时未知。**禁止 spoke 级 supplied−borrowed 自行相减**——V4 流动性由 Hub 统一持有、跨 Spoke 共享,spoke 差值会高/低估(实测 USDG:spoke 差值 33.6M vs Hub 19.36M) | token 数量 |
| Morpho Market / Vault V1/V2 | market `state.supplyAssetsUsd`；vault `state.totalAssetsUsd` | market `state.liquidityAssetsUsd`；vault `liquidity.usd` | USD |

池子统计、总规模或仓位口径缺失/无效时 fail-open，不显示风险；当前可提未知时仍可按有效总规模计算黄色占比。token 口径在 tooltip 中使用 token 数量与 symbol，不与 USD 混算。

## Ethena 积分排除策略

插件不再计算、推断或展示任何 Ethena points、Sats、multiplier、空投或资格元数据。Morpho 的 native/Merkl 数字奖励与 Ethena 积分是不同来源，数字 APR 继续按精确 market 和活动显示；sUSDe 官方数字收益率与 exact sENA 的 0% 协议利率也继续保留。

## Sky / Maker 多池解析

Sky 的 USDS 底层同时存在 savings share token 与多个 Ecosystem Rewards farm；底层 token 相同不代表产品相同。

### Savings

- 对 exact share-token 合约同时探测 `asset()` 与 `ssr()` / `str()`；仅一个速率接口有效时才采用。
- `ssr/str` 是 RAY 每秒速率，按 `APY = expm1(log1p((rate−1e27)/1e27) × 31,536,000)` 年化。
- 2026-07-11 实时链上结果：sUSDS `0xa393…7fbD` 为 3.60% APY；stUSDS `0x99CD…EEB9` 为 6.99% APY。两者都以 USDS 为 `asset()`，因此禁止按 underlying-only 合并。

### Ecosystem Rewards farms

1. 从 `https://chainlog.skyeco.com/api/mainnet/active.json` 读取 `REWARDS_*`，排除 distributor key；最多保留 64 个合法地址。
2. 逐 farm 链上读取 `stakingToken/rewardsToken/rewardRate/periodFinish/totalSupply/decimals`，缓存原始合约状态，不把某个 query 的匹配失败写入全局缓存。
3. DeBank `pool.id` 存在时必须精确等于 farm 地址并通过链上 staking/reward token 校验；校验失败立即 `unknown`，不得再搜索另一 farm。DeBank reward list 若存在必须与链上 reward token 一致；列表为空不否定 exact farm，奖励名称改由链上 ERC-20 `symbol()` 读取。
4. `pool.id` 缺失时要求 adapter 类型、staking token 与 `balanceOf(wallet)>0` 同时匹配；DeBank reward list 若存在仍必须一致。多余额候选再用 DeBank item amount 对齐；仍不唯一则 `unknown`。
5. `periodFinish` 已过或 `rewardRate=0` 才能证明奖励 0；零地址 reward token 表示 points，状态为 `non-annualizable`。
6. 数字优先使用 Sky 前端同源 exact-farm BA `/historic/?p_size=1` 的 `apr`；它已是小数且当前只用于 Ethereum。该可选源有独立 1.5 秒子预算，失败/超时不丢弃已加载的链上状态，而是按 emission、总质押量与 DeBank token price 计算简单 APR；没有自动复投，不标为 APY。
7. DeFiLlama 的 pool UUID/文本 metadata 无法与 farm 合约建立一手映射，因此完全不用于 farm 数字；BA 与链上公式都失败时保持 `unknown`。

目标 Maker/Sky 仓位已验证为 USDS → GROVE farm `0x4E414…c86a`，奖励 token 为 GROVE `0xb30F…9406`。2026-07-11 09:50:55 最终 Chrome 验收显示 `APY 0% + 9.79%`，详情为“基础 APY 0%”“奖励 GROVE 9.79% APR”，来源为 `sky:official-farm-api + onchain-identity`；协议标题为 `净APY 9.79%`。同一次实现期较早的 BA 快照为 10.275126%，说明该值会随价格与总质押量变化，不能把文档快照当常数。

## Merkl 契约

- `/v4/opportunities` 分页最多 5 页、500 项、全页累计 2 MiB；单请求 5 秒、总计 10 秒。
- 只接受 `LIVE`、HTTPS URL、allowlisted opportunity type/action、有限数值和可验证 reward token 的记录。
- campaign ID 去重；同 ID 不同数值视为冲突并返回 `unknown`。
- 完整 no-match 默认仍是 `unknown`；只有调用方明确拥有该角色的 zero-proof 才可成为 `confirmed-zero`。
- 机会缓存按 `chain + protocol`，同 key 使用 subscriber-aware single-flight，失败刷新不得覆盖 TTL 内的 complete 快照；个人 claimable 缓存按 `wallet + sorted chains`，仅内存保存、单链 4 秒，整个 service worker 跨 wallet/tab 最多 2 个在途请求，为协议/APY 源保留至少 2 个共享 HTTP slot；同 key 同样 single-flight，并按 TTL/LRU 上限 128 项。
- claimable 的单链 HTTP、超时、响应过大、JSON、结构和奖励字段失败分别保留；Portfolio tooltip 显示具体链名与原因，不再只有笼统的“部分链”提示。
- claimable 内部总预算为 9 秒；预算结束返回已成功链的小计，并把正在执行与尚未开始的链标为 `timeout`。外层 10 秒卡片 deadline 只作为最后保险，不再吞掉已知小计。
- 共享 HTTP 的单源超时从“取得全局 slot 后”才开始计时；排队时间由上层 9/10 秒总 deadline 约束。这样 4 秒 Merkl 单链预算全部用于真实传输和 body 读取，不会在冷启动队列中尚未发出请求就耗尽。
- 单链响应只接受空数组或一个 `chain.id` 与请求一致的对象；每条 reward 的 `recipient/distributionChainId` 必须等于请求 wallet/chain，`root + token address` 必须唯一。amount/claimed 按 uint256 解析，token price / 单行 USD / 总 USD 上限分别为 `$1e12 / $1e15 / $1e16`，重复 chain/reward 行或非有限算术均为 `invalid-shape/invalid-reward`。并发 partial/unknown 不得覆盖尚在 TTL 内的 complete 快照。

2026-07-11 对目标钱包的诊断分三步：独立请求 Ethereum、Base、Robinhood 均为 HTTP 200 且字段校验通过，排除 Robinhood 不支持；启用逐链诊断后的浏览器运行曾明确显示 Base、Arbitrum 为 `timeout`，证明 partial 来自瞬时请求超时；把 claimable 限制为 service-worker-wide 最多 2 个在途请求、为协议利率源保留 2 个共享 HTTP slot 后，09:50:55 最终同页返回 `complete`，Portfolio 为 `今日小计 +$2.4k · LP 2/2在区间 · 待领 $19.0k`，不再显示 Merkl 警告。若未来再 partial，tooltip 与 SW 日志会直接保留失败链和原因。

15:07 冷启动再次出现 Ethereum、Optimism timeout；随后两次同页刷新均完整返回。独立 `curl` 三轮分别为 Ethereum 1.30–2.08 秒、Optimism 1.29–1.94 秒，排除 Merkl 持续宕机。回归测试进一步证明：共享四 slot 被占满时，第五个 5ms 请求在旧实现中会在发出前超时。根因是单源计时器错误包含排队时间，不是 Merkl API 不支持这些链。

## 计算与展示

对 `E = ΣS − ΣB`：

```text
已知净年化 ≈ [Σ存款基础收益 + Σ已知存款奖励 − Σ借款基础成本 + Σ已知借款补贴] / E
```

- 组件存在时以 `rewardComponents` 为真相，并按 campaign ID 去重；旧 scalar `rewardApr` 只作兼容显示。
- material unknown 存在时，`knownNetApy/knownEstDailyUsd` 保留，但 `netApy/estDailyUsd` 为空。
- asset、item、protocol、portfolio 使用同一组件集合与覆盖判断。
- LP 的 fee tier 不是 fee APY；手续费收益不估算、不进入 `coveredUsd/uncoveredUsd`、净 APY 或今日收益，单独进入 `excludedUsd`；pool incentive metadata 也不是个人 incentive APR。
- tooltip 支持 hover、键盘 focus、点击开关与 Escape；外部字符串只通过 `textContent` 渲染。

### 显示契约

所有奖励 APY、积分和生态资格的 hover 统一使用 [`REWARD_SOURCE_LINKS.md`](REWARD_SOURCE_LINKS.zh-CN.md) 的来源说明组件；基础 APY 仍只显示数值与数据源。Merkl 数字奖励使用运行时 opportunity ID 生成精确活动页，积分/资格使用 adapter 中的官方规则原文 URL。

| 场景 | 默认 chip | tooltip / 详情 |
|---|---|---|
| 存款 + 数字奖励 | `APY 0% + 4.5%` | `基础 APY 0%`、`奖励 USDe 4.5% APR`、来源 |
| 借款 + 零奖励 | `APY -2.69% + 0%` | `借款成本 -2.69%`、`奖励 0%`、来源 |
| 未知奖励 | `APY x% + --` | `奖励 未知`及覆盖原因 |
| Ethena | 只显示数字 APY/APR | 不出现 points、Sats、multiplier、空投或资格文案 |
| DEX LP | `#仓位号 · 区间状态 · 当前/上下界 · 代币占比` | 不显示净值、交易对、费率档、手续费 APY 或外部激励 APY |
| 完整协议 | `净APY x%` | 组件、权益、日收益、时间 |
| 不完整协议 | `小计 x%` | 明示不代表完整净 APY |
| Portfolio | `今日预估` / `今日小计` | 覆盖金额、待领与失败链原因 |
| 状态栏有缺口 | `载入完成 · N项缺口` | 仅统计需要且应当获得的数据；所有 DEX 手续费与外部激励 APY 不参与计数 |

百分比最多两位小数并删除尾零。用户界面不添加覆盖状态前缀；内部 `confirmed-zero` 枚举不改名，因为它是零证明安全边界。

## 网络与数据边界

- MV3 host permissions 的唯一清单在 `utils/hosts.ts`；协议 API 与内置 RPC 均使用精确 hostname，不使用子域通配符。Sky 新增的唯一主机是 `chainlog.skyeco.com` 与 `info-sky.blockanalitica.com`。
- 共享 HTTP 边界最多并发 4 个请求；取得 slot 后才启动单源 timeout，并持续到 body EOF/cancel，排队由 card/claimable 总 deadline 约束。默认响应上限 2 MiB 且最多 4,096 个 stream chunks，`/pools` 实际约 11 MiB 的 DeFiLlama 是唯一显式放宽到 16 MiB 的来源。
- 每张协议卡 10 秒 deadline 通过 `AbortSignal` 传至 adapter、RPC 与 HTTP body；Aave/Morpho 钱包缓存分别按 TTL/LRU 上限 64 项，Merkl claimable 上限 128 项。
- MAIN-world 捕获在解析前限制 fetch clone 为 2 MiB/4096 chunks，XHR 在 `JSON.parse` 前检查 2 MiB 文本上限；超限或畸形响应通过版本化 rejection 消息使当前结果失效。
- 页面桥只接受当前 `debank.com` origin、版本化消息和合法 DeBank `portfolio/project_list` 或 `history/list` URL；page-controlled 对象按 2 MiB 字符、5 万节点、每容器 1 万项和 64 层深度生成安全副本，并限制频率。
- DeBank parser 最多处理 128 projects、单 project 32 items、全局 256 items、单 item 32 principal/reward legs、全局各 512 legs；不透明 `position_index` 最多 256 字符，LP 路径另行强制纯十进制 uint256（最多 78 位且 `<2^256`）。adapter card、LP position 与 RPC batch 另有 128/32/256 上限。RPC response 行数不得超过 call 数，id 必须唯一且位于 batch 范围内。任何截断逐 item、protocol、portfolio 传播为 incomplete/unknown。
- 异步响应绑定当前地址、跨 fetch/XHR 的 request-start sequence 与 enrich request generation；旧请求即使更晚完成也不能覆盖或清除新结果，导航后迟到结果同样丢弃。
- Portfolio 头部状态栏只重跑最近一次经过安全复制和地址校验的 enrichment payload；它不重载页面、不主动请求 DeBank。MAIN interceptor 另按 request-time 地址保留最多 8 份同文档有界快照，bridge 在启动/SPA/BFCache 恢复时以版本化同地址消息请求重放，使用新 capture sequence 且禁止跨地址，从而消除响应早于 listener 的永久等待竞态。停止会取消当前 request 并递增 generation，刷新失败保留旧渲染结果；状态节点使用 Shadow DOM，页面重绘后可自愈。partial 不再显示笼统“部分数据”，而显示 `N项缺口`；每条 hover 明细必须包含协议名称、链和未匹配资产腿，同一协议的基础/奖励问题合并为一项，全部 Merkl 失败链合并为一项；不把未支持协议、净资产低于 $100 的独立仓位/协议或任何 DEX 的手续费 APY、外部激励 APY 计作运行失败。
- DeFiLlama/Lista/Aave V3/V4 的共享冷加载按订阅者独立取消；一个 tab 离开不会误杀其他 tab，最后一个订阅者离开才中止底层请求。Aave V4 的成功快照缓存 5 分钟，冷启动期间多个 tab 只共享一次官方 GraphQL 请求。LP 区间缓存为 120 秒 TTL、最多 128 项 LRU。Sky farm inventory/state/APR 成功缓存 5 分钟、错误缓存 30 秒，farm 上限 64。
- 同一次 enrichment 的全部 Sky cards 合并为一次 adapter batch，最多处理 128 条 Sky query、32 个 page-supplied exact farm；Chainlog 每链最多发现 64 个 farm。每条 query 的非取消错误独立退化为 `unknown`，不得清空其他 Sky card。inventory、farm state、wallet balance、BA APR 与 savings state 使用跨 card 的 subscriber-aware single-flight；一个 tab 取消不会中止其他订阅者，所有订阅者离开后才取消底层工作，旧 generation 也不能删除正在运行的新 generation。
- 市场级请求不发送余额。Aave 与 Morpho 仅在用户级资格/仓位查询需要时发送当前公开钱包地址；Sky 仅在 DeBank 缺少 exact farm id 时，把公开钱包地址作为链上 `balanceOf` 的 calldata 发给所选 Ethereum RPC，不发送给 Chainlog 或 BA。
- 钱包、仓位图和 API 响应不写入持久缓存或日志。

## DeFiLlama 的边界

- `apyReward` 缺失或为 0 不能证明生态无奖励，因此为 `unknown`，不是 confirmed zero。
- 同一 project/chain/token 多池时返回歧义，不取第一项。
- Sky 的 legacy savings 可在唯一产品行时降级；farm 不使用 Llama 数字，因为 UUID/文本 metadata 不能绑定合约。其余官方协议不允许 Llama 绕过 Comet/vToken/vault 身份。

## 链上与 RPC

- Lista ERC-4626 与生息资产修正需要历史 `eth_call`；用户配置 RPC 优先，公开版默认使用无需 Key 的公共 RPC。公共端点不一定支持历史查询；失败时保持未知。
- Uniswap V3/V4 与 Pancake V3 只读取 position、pool 和 tick 状态，不声称计算手续费 APY。
- 默认 RPC 表在 `utils/rpc-config.ts`；manifest 对应精确主机在 `utils/hosts.ts`。

## 新路线接入门槛

1. 在 `capabilities.ts` 写明基础源、奖励真相、精确 join key、zero-proof 角色与 unsupported policy。
2. fixture 必须覆盖：数字奖励、zero-proof、来源失败、同 token 多容器、points/私有奖励。
3. 缺 container identity 时返回 `unknown/null`，不能增加 token-only fallback。
4. 新 host 同步加入精确权限清单与测试。
5. README、本文件、测试与代码在同一个 GitHub commit/PR 中落地。

## 运维验证

1. `npm test`
2. `npm run typecheck`
3. `npm run build`
4. 在 `chrome://extensions` 重新加载 unpacked extension。
5. 刷新 DeBank tab，核对状态栏的载入/刷新/停止/重试、默认简写、悬浮详情、小计/完整净 APY、Ethena 无积分/资格文案、Merkl 失败链诊断与更新时间。

Chrome 会缓存 MV3 service worker；只刷新页面不足以换掉旧 worker。验证必须先重载扩展，再刷新目标 tab。

## 主要上游参考

- Morpho rewards resources: https://docs.morpho.org/build/rewards/resources/all/
- Morpho borrow/collateral rewards: https://docs.morpho.org/build/borrow/tutorials/rewards/
- Ethena official yield endpoint: https://ethena.fi/api/yields/protocol-and-staking-yield
- Merkl integration: https://docs.merkl.xyz/integrate-merkl/app
- Reward source-link UI contract: [REWARD_SOURCE_LINKS.md](REWARD_SOURCE_LINKS.zh-CN.md)
- Aave V4 schema: https://github.com/aave/aave-v4-sdk/blob/main/packages/graphql/schema.graphql
- Sky GROVE governance initialization: https://github.com/sky-ecosystem/executive-votes/blob/8c444a7281a88e5e3cf690f438be3553c026d098/2026/executive-vote-2026-07-02-grove-token-rewards.md#initialize-grove-token-rewards
- Sky active Chainlog: https://chainlog.skyeco.com/api/mainnet/active.json
- Sky StakingRewards contract: https://github.com/sky-ecosystem/endgame-toolkit/blob/4f238f9b23298190150d49482bad56c00f0af825/src/synthetix/StakingRewards.sol
- Sky app exact-farm APR source: https://github.com/jetstreamgg/tarmac/blob/8f96bb5c0cb0bd189ca13696dc9924bd7c0295b2/apps/webapp/src/hooks/rewards/useRewardsChartInfo.ts
- Sky app farm token identity source: https://github.com/jetstreamgg/tarmac/blob/8f96bb5c0cb0bd189ca13696dc9924bd7c0295b2/apps/webapp/src/hooks/rewards/useRewardContractTokens.ts

## 中英文展示

中英文使用相同数值和计算规则。语言选择保存在 Chrome sync storage。切换只重绘缓存结果，不重新请求收益。
来源、错误、奖励说明在展示层翻译；数据缓存和协议身份保持稳定。新增文案与协议路线必须同步更新两种语言。

## v0.6.0 新增协议

- Pendle：官方分页市场目录；精确 PT 身份、当前到期 APY 和到期处理。排除 LP/YT 及积分。
- Curve：精确 pool/LP/gauge 及组成币；官方七日池基础 APY。个人 gauge 奖励保持未知。
- Beefy：精确活跃 standard 金库；官方净综合 APY，不重复叠加策略奖励或底层收益。
- Yearn：精确金库及资产；七日净份额增长按 `(今日 / 七日前)^(365/7) - 1` 年化。
- Lido/Rocket Pool：精确 canonical 份额币及链；官方 APR 按每日复投折算，并标注为估算值。
- ether.fi：精确 Ethereum eETH/weETH；使用已有 24 小时 RPC 引擎读取 weETH `getRate()` 的当前与历史值。额外再质押奖励保持未知。

新增 API 目录只在内存缓存五分钟，最多 64 项。Pendle 读取全部分页，市场请求预算为 2,000。
Curve 与 Beefy 全目录明确使用 8 MiB 响应预算，其余新增端点沿用 2 MiB 限制。
现有请求并发数和卡片超时限制继续生效。链和产品边界以[协议指南](PROTOCOLS.zh-CN.md)为准。
