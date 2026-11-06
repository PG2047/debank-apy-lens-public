# DeBank Transactions scam 过滤契约

版本：v0.3.5
状态：生产契约
代码真相：`entrypoints/bridge.content.ts`、`utils/transaction-filter.ts`

## 1. 目标与边界

插件在 DeBank profile 的 Transactions（history）页面隐藏 **DeBank 自身明确标记为 scam** 的单条交易。
它不判断链上交易是否恶意，也不扩展 DeBank 的分类：缺少完整阳性证据时必须保留该行。

该功能是独立 DOM engine，由已知真机正常执行的 ISOLATED-world `bridge.content.ts` 在独立错误边界启动。
它与以下 APY 数据路径完全解耦；安装异常只写有限状态 `install-error`，不能中断 bridge 后续初始化：

- 不 patch `fetch` / XHR；
- 不读取 APY 捕获消息；
- 不向 service worker 发消息；
- 不请求 DeBank 或任何第三方 API；
- 不读写钱包、交易或设置存储。

## 2. DOM 结构

过滤器使用 `HistoryContainer_historyContainer__`、`History_table__`、`History_tableLine__`、
`History_txStatus__` 与 `History_scam__` 的语义前缀，不依赖 CSS 哈希后缀。
颜色、透明度、Failed/error 状态不能证明交易是 scam。

## 3. 唯一阳性判定

只有以下条件 **全部成立** 才给 row 添加 `data-dal-scam-hidden="true"`：

1. 当前 pathname 精确匹配 `/profile/<单个非空且不超过 256 字符的 segment>/history`（尾 `/` 可选）；
2. 全页恰有一个语义 history container 和一个语义 history table，且 table 的最近语义 container 就是该唯一 container；
3. row 是 table 的直接子节点，且 class token 以 `History_tableLine__` 开头；
4. row 恰有一个 **直接** status 子节点，其 class token 以 `History_txStatus__` 开头；
5. row 恰有一个 `History_scam__` marker；
6. marker 位于该直接 status 内，且 marker 的最近 status 和最近 row 分别就是上述 status、row；
7. row 恰有一个 `/tx/` 链接；
8. 链接位于同一直接 status 内，且链接的最近 status 和最近 row 也分别就是上述 status、row。

任一条件不成立即 fail-open。无害的额外列不影响判定，因为列数不是稳定语义契约。

## 4. 明确禁止的信号

下列信息永不参与判定：

- `color`、`opacity`、灰色外观或任何 computed style；
- `History_error__`、Failed 文案或失败图标；
- 包含 `scam` 单词但不具备精确语义 marker 的普通文案；
- CSS module 的构建 hash 后缀；
- 金额、token、链、交易 hash、钱包地址或当前样本特例；
- 日期分组、列表容器、空状态或 row 之外的相邻 marker。

## 5. SPA、虚拟列表与扩展重载

扩展重载后关闭并重新打开 DeBank 标签页，避免旧 content script 继续运行。

生命周期状态机：

1. ISOLATED bridge 在所有 `debank.com` 页面加载并托管 engine；非 history 路由只进行低频 pathname 检查；
2. 进入 history 后，每秒以两个精确语义 selector 重新确认唯一列表根；
3. 只有唯一根成立后才标记 verified list、注入 scoped stylesheet，并观察该 list root；
4. MutationObserver 只处理 list 内的 `childList` 与 `class` / `href` 变化，40ms 去抖；
5. React/虚拟列表复用 row 时，每次重新执行完整阳性判定；不再匹配会无条件移除旧隐藏属性；
6. 离开 history、列表根消失/歧义、超出工作预算或 cleanup 时，断开 observer、移除 style/verified 标记并恢复行；
7. 扩展重载遗留的旧 style 与 row 属性会在新 verified root 接管前清理，普通 row 不会继承旧隐藏状态；
8. BFCache `pagehide.persisted=true` 不永久卸载，避免返回页面后 engine 失效。
9. WXT HMR/重注入创建新 context 时，旧 context 的 `onInvalidated` 会调用与 non-persisted pagehide 共用的
   幂等安全 cleanup，先移除 observer、raw timer/listener、style、verified/hidden 属性，再允许新实例接管。

启动状态写入 documentElement 的单一 `data-dal-scam-filter-state` 属性，值仅限 `entry-started`、
`inactive-route`、`waiting-root`、`attached`、`budget-detached`、`install-error`、`stopped`。它不含钱包、
路径、交易数量或其他页面数据；写入失败也会被吞掉，不能成为过滤或 APY 的运行依赖。
ISOLATED 日志也只输出固定 module/main build sentinel 与上述有限状态，不输出异常对象、钱包、路径或 DOM 内容。

隐藏由以下同域 scoped 规则完成，绝不覆写 DeBank inline style：

```css
[data-dal-transaction-list="true"][class*="History_table__"]
  > [data-dal-scam-hidden="true"][class*="History_tableLine__"] {
  display: none !important;
}
```

规则同时要求 verified list、直接 row、DeBank row 语义和扩展阳性属性；不能隐藏日期组、容器或空状态。

## 6. 性能与失败策略

- 不扫描 `body.innerText`，不做全页模糊文本搜索；
- root discovery 仅使用两个精确语义 selector，每秒一次；
- 成功绑定后只观察唯一 list root；
- 单列表最多处理 500 个直接子节点；
- 单次 mutation batch 最多处理 250 条记录；
- removed row 会同步从待处理集合删除；root-target mutation 会先清空旧集合、再只排当前直接子节点；
- 两次去抖 flush 之间若待处理集合仍达到 500 且出现新的唯一 row，立即 detach，禁止静默丢弃恢复任务；
- 超出任一预算立即 detach 并恢复全部行；后续低频 poll 只在结构重新回到预算内时接管；
- observer 的 `attributeFilter` 只有 `class`、`href`，不观察扩展自身属性，避免自激；
- 重复安装按 document 幂等，只存在一个 observer/style 所有者。

这些限制优先保证“可见但未过滤”，而不是在结构未知或负载异常时误隐藏。

## 7. 隐私与权限

v0.3.5 不新增 manifest permission 或 host permission。交易过滤只读取 DeBank 已渲染到当前标签页的结构，数据不离开
页面、不写入日志或 storage，也不改变或提交任何交易。

## 8. 验证

离线契约测试：

```bash
./node_modules/.bin/tsx --test tests/transaction-filter.test.ts
npm test
npm run typecheck
npm run build
npm run verify:bridge-bundle
npm audit --omit=dev
git diff --check
```

测试覆盖：无 innerText 且内含 inline SVG 的语义 wrapper/marker 阳性、普通灰色与 error-without-scam 阴性、模糊 scam 文案阴性、root/row/
status/marker/link 歧义 fail-open、无害额外列、mutation 新增、虚拟 row 恢复、旧属性/style 接管、SPA 离开、
500-row、250-record 与跨 callback pending-row 预算恢复、重复安装和 cleanup。

DeBank DOM 改版后若契约不再成立，所有行保持可见，待更新选择器与测试后恢复过滤。

## 9. 唯一真相

公开仓库 `main` 上的代码、测试与本文档定义当前行为。
