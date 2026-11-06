# 奖励 APY、积分与资格来源链接契约

[English](REWARD_SOURCE_LINKS.md) · [中文](REWARD_SOURCE_LINKS.zh-CN.md)

本文定义所有协议共用的 hover 来源说明，不允许某个协议自行拼接一套不可点击或无法核验的文案。GitHub 中的类型、来源目录、测试和本文档是唯一真相。

## 展示结构

资产 APY chip 的悬浮层按以下顺序逐句分行：

1. 基础 APY 或借款成本。
2. 每个数字奖励组件的 APR/APY。
3. 每个积分、倍数或生态资格的名称与验证状态。
4. 每个数字奖励的“奖励来源说明”：奖励机制的一句话介绍、可点击来源链接。
5. 每个积分或资格的“积分/资格来源说明”：不可年化边界、可点击官方规则链接。
6. 证据备注和插件内部数据源。

上述内容先显示一个统一的“奖励与积分说明”：奖励 APY 与基础 APY 分开，积分只显示倍数或资格且不折算 APY；其后再逐项列出来源说明和链接。asset tooltip 使用挂载到页面顶层的独立 Shadow DOM 浮层，避免被 DeBank 表格的 `overflow:hidden` 裁剪，并允许鼠标进入浮层点击链接。

链接在新标签页打开，使用 `noopener noreferrer`。页面/API 字符串只通过 `textContent` 和经过 HTTPS 校验的 `href` 写入，不使用 `innerHTML`。

## 来源精度

| 来源 | 链接精度 | 规则 |
|---|---|---|
| Merkl 数字奖励 | 精确活动 | 从已校验 opportunity ID 生成 `https://app.merkl.xyz/opportunities/{id}` |
| Aave V3/V4 | 官方产品 | 指向 Aave 或 Aave V4 官方市场 |
| Morpho native reward | 官方产品 | 指向 Morpho 官方市场；Merkl collateral 奖励仍使用精确 Merkl 活动页 |
| Lista / Moolah | exact market API + 官方产品 | 数字 emission 组件指向精确 market detail；points entitlement 指向 Lista Lending |
| Spark | 官方产品 | 指向 Spark 官方市场；明确的 DeFiLlama 补充组件单独指向 DeFiLlama Yields |
| Sky | 官方产品 | 指向 Sky 官方奖励产品 |
| Dolomite | 官方产品 | 指向 Dolomite 官方市场 |
| Compound V3 | 官方产品 | 指向 Compound 官方市场 |
| Venus | 官方产品或 Merkl | 原生 distributor 指向 Venus；Merkl 来源优先指向 Merkl |
| Fluid | 官方产品 | 指向 Fluid 官方产品 |
| DeFiLlama pool component | 明确数据源 | 指向 DeFiLlama Yields，不伪装成协议官方值 |
| Ethena / Falcon 数字收益 | 官方产品 | 指向对应官方文档/产品；Ethena 积分与资格元数据不生成来源项 |

若未来 adapter 产生无法匹配来源目录、且没有安全 `sourceUrl` 的数字奖励，UI 保留原始来源名称，但不得制造链接。新增奖励源必须同步更新来源目录和测试。

## Base Morpho 实例

2026-07-11 实测 Merkl API 中，Base `USDe/USDC 91.5%` collateral opportunity 为 `15882969063492504801`，APR 为 4.5%，活动页为：

<https://app.merkl.xyz/opportunities/15882969063492504801>

该 ID 来自运行时 opportunity 响应，不应硬编码到 Base market 适配逻辑。活动结束或替换后，插件必须使用新响应中的 ID 自动生成新链接。

Ethena 积分与资格元数据不进入插件；Merkl 数字 APR 只能由本次精确活动响应证明，不能用于推断任何积分资格。

## 验证门槛

- 来源目录覆盖所有当前生产 reward source family。
- Merkl normalization 测试必须证明 opportunity ID 进入精确 `sourceUrl`。
- 非 Ethena points 与 ecosystem entitlement 测试必须证明使用各自官方 URL。
- 非 HTTPS、格式错误或无目录映射的 URL 不得渲染为链接。
- Chrome 验收必须确认 hover 可停留、链接可点击、每条说明独占一行。
