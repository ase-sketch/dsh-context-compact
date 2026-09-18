# @sol-pi-port/dsh-context-compact

DeepSeek Harness 的 **Online Context Compact**：一份全新的 `ctx.compaction` 实现（不继承 `compaction-basic`），
在 basic 的义务面上补齐**证据保全归档**、**经济门控明细**与**独立审计 sink**。**默认全关**。

> 权威依据：`docs/phase4-plan.md`（Phase 4 唯一执行依据，已冻结）、`docs/design.md` §1.3 / §3.4。
> 本文件记录实现层面的契约与偏离；里程碑状态以 `evidence/m1-*.md` 为准。

## 0. 一句话

把「历史区间换成一条摘要」的压缩流程做成一个可审计、可取消、证据先落盘的事务：**原文先归档，归档失败就不压缩**；
关掉时**一个监听器都不注册**，所以「不装/不开 = 现状逐字节一致」是结构事实而不是运行期侥幸。

## 1. 装配（profile 侧）

`CompactionEngine` 是**单槽位 Service**（`ctx.compaction`），一个 context 只能加载一个实现：
bundle 里的 `compaction-basic` 必须显式 `disabled`，再 `insert` 本插件（与 `spill-local`/`spill-cas` 的替换同构）。

```yaml
# <profile>/cordis.patch.yml
- id: compaction-basic
  disabled: true

- insert:
    - id: context-compact
      name: '@sol-pi-port/dsh-context-compact'
```

`@deepseek-ai/dsh-command-compact` 只依赖 `ctx.compaction.compactNow`，因此 **零改动复用**：本插件替换后端后，
人类的 `/compact` 仍然工作（见 §3）。

**注意**：`compaction-basic` 的自动压力触发随之消失。本插件默认 `enabled: false`，所以自动触发在默认装配下**同样是关的**——
两者都关。实测口径见 `evidence/m1-regression-arm.md`（dev/held-out 短会话本就不触发 basic 的 80% 阈值）。

## 2. settings schema（`efficiency-context-compact`）

```yaml
# $DSH_HOME/settings.yaml（或 profile 的 config: 组合入口）
efficiency-context-compact:
  enabled: false               # 自动触发总开关（加载期生效），默认 false
  thresholdRatio: 0.8          # 压力阈值 = contextWindow × 该比例
  retainRatio: 0.16            # 保留的最近尾部预算占 contextWindow 的比例（恒 < thresholdRatio）
  summarizationProvider: ''    # 空 = 用最近一次路由；两者必须同时给
  summarizationModel: ''
  maxTokens: 8192              # 摘要调用生成上限
  compactionRetries: 1         # 同一触发事件内允许的压缩次数（首压之外的重试预算）
  maxOverflowRetries: 1        # context-overflow 恢复的每 agent 重试预算
  archive: true                # 压缩前归档原文；关掉即放弃证据保全，需显式声明
  auditPath: ''                # 空 = $DSH_HOME/state/context-compact/context-compact-audit.jsonl
  economics:
    enabled: false             # true ⇒ 评估并**否决** pressure 触发（对 overflow/手动/强制区间只评估不否决）
    remainingRequestScale: 1
    windowReserveTokens: 16384
    firstCompactionRequestScale: 2
    subsequentCompactionMargin: 1.5
    cacheWriteReadRatio: null  # null = 无缓存定价 ⇒ 门控不授权（fail-closed），绝不折算为 0
```

- `enabled` 是**加载期**开关：false ⇒ 不注册任何 `agent/pre-step`、`agent/request-error` 监听器。
  其余键每次调用即时读取（评估臂可以在不重启的情况下改阈值）；`economics.enabled` 同样即时生效。
- **本里程碑（M2）未新增任何 settings 键**，也未改动默认值：默认仍是全关（计划 §0 的「不做」项）。
- 组合入口（`config:`）是 settings 的 `base` 层，不是第二个权威：没有 settings provider 时它就是唯一来源。

## 3. 与 `compaction-basic` 的义务对齐（C2）

| 义务 | 本实现 |
|---|---|
| `/compact` 人类命令 | `compactNow` 走宿主 `runMaintenance` 空闲闸门；预期失败分类为 `ManualCompactionError`（`busy`/`cancelled`/`changed`/`summary`/`commit`/`persistence`）。**同步**抛出的只有「agent 不空闲」；取消保留调用方**原样**的 abort reason |
| overflow 恢复重试 | `agent/request-error` + `CONTEXT_WINDOW_EXCEEDED` ⇒ 每 agent 的持久预算 `maxOverflowRetries`，且**只在 `surface.replaceGeneration` 前进后**才 retry |
| `compaction/start` 锁 | 只读校验与 `compaction/start` **同步相邻**；未闭合的 start 就是「busy」标记；早于最新 `session/end-seed` 的 start 视为陈旧（跨生命周期） |
| 可取消 | signal 贯穿归档、摘要调用与每个 await 之后；失败也**必然**产生一次 `compaction/end`（带 `error`） |
| 工具配对平衡 | 直接复用 `@deepseek-ai/dsh-compaction` 导出的 `toolPairingBalancedBefore/After` 检查两端；越界/缺失/反向区间在写任何字节前拒绝 |
| `toolResultPruner` 接线 | pruner **不监听事件**。basic 曾显式调用它；本实现同样显式 `ctx.get("toolResultPruner")?.pruneSession(session)` 并在剪枝后重新测量（否则它会静默永不执行） |
| 摘要复用会话前缀 | 摘要调用 = 会话自己的 `system` 消息 + header 的 tools + 被压区间派生的消息 + 末尾一条指令 user 消息 ⇒ 是上次路由请求的真实前缀，复用 provider KV cache |

## 4. 证据保全（C4，本项目不变式）

被压段的**原文**在任何替换之前写入 `ctx.spillStore`：

- 归档内容 = 一行 provenance 头（`schema`/`compactionId`/`sessionId`/`shadowedRange`/`shadowedSeqs`）+ 每个被 shadow 事件一行
  （`{seq, type, data}`），可用会话日志自身的词汇逐字节复原。
- **缺 `spillStore`、序列化失败或后端 `saveText` 拒绝 ⇒ 事务中止且零 surface 写入**（`archive: false` 才跳过归档，审计记为 `skipped`）。
- 归档发生在锁内、摘要之前：既保住不变式，也不放宽「锁在第一个 await 之前就已落盘」的时序。

## 5. 事件与回放兼容（C6）

压缩事务只使用**官方** `compaction/start|summary|end` 事件 + 一条带 `surfaceOp {op:"replace"}` 的
`user/message` checkpoint（`compactCheckpointSource(compactionId)`）。没有自定义 session 事件类型。

`compaction/summary` 带 `llmStreamCall: true` + 完整 `rawOutput` + `usage`，这正是 `llm-replay` 在日志位置上重建这次调用的依据
（`dsh-llm-replay/lib/index.js` `deriveReplayScript` 对 `compaction/summary` 的处理）。因此：

- **录制时就必须开着压缩**，回放才能按位置弹流（与 action-arms 的纪律同源，见 `eval/README.md` §12）。
- 零 API 兼容性自检见 `evidence/m1-functional-verification.md`（用 `llm-replay` 自己的 `loadReplayScript` 直接读含
  `compaction/summary` 的会话件，核对派生的模型调用序列）。

## 6. 审计（JSONL）

默认 `$DSH_HOME/state/context-compact/context-compact-audit.jsonl`，schema 标签
`sol-pi-port/dsh-context-compact-audit/1`；一次压缩尝试一行（机制开启时不可关闭审计）：

```json
{ "schema": "…", "time": "…", "event": "compaction", "status": "committed|deferred|failed|refused",
  "trigger": "manual|pressure|context-overflow|compactRegion", "sessionId": "…", "turn": 1,
  "compactionId": "…", "shadowedRange": {"start":3,"end":11}, "shadowedSeqs": [3,…],
  "archive": {"status":"ok|skipped|refused","locator":"…","bytes":2489,"reason":"…"},
  "gate": {"enabled":true,"evaluated":true,"compact":true,"reason":"economic",
           "archiveTokens":…,"memoTokens":…,"writeTokens":…,"breakevenRequests":…,
           "expectedRemainingRequests":…,"priorCompactionCount":0,
           "carriedDebtTokens":0,"cacheDebtRepaymentTokens":0,
           "completedBoundaryRequestCounts":[…]|null,"remainingBoundaries":…},
  "todoHint": {"used":true,"content":"…","todoSeq":…,"endSeq":…,"selectedEnd":…,"alignedEnd":…},
  "status":"committed", "shadowedTokenCount": 4500,
  "summary": {"provider":"…","model":"…","maxTokens":8192,"framedTokenCount":112,"usage":{…}},
  "events": {"startSeq":14,"summarySeq":15,"endSeq":17} }
```

- `status: refused` 对应「进事务之前就被拒」（`busy` / 区间不平衡 / 没有开着的 turn），此时没有 `compactionId`。
- `status: deferred` 有两种来源，靠 `reason` 区分：
  1. **M2 的经济门控否决**：`reason` 取 vendored 原因码（`horizon_unavailable` / `cache_ratio_unavailable` / `deferred_*` / `non_positive_saving`）。
  2. **M4-D 的失败范围退避**：`reason:"failed_region_backoff"`，额外带一个 `backoff` 字段
     （`{start,end,totalTokens,margin,growthCapTokens}`：它匹配的失败键 + 释放阈值的两个半边）。见 §7.8。
  两种都**不追加任何 session 事件**，字段与 committed 行同形（含 `gate` 明细与候选区间）。
  仅 `trigger="pressure"` 会被否决或被退避；`context-overflow` 仍评估并记录判定但**永不否决**（overflow 恢复是正确性义务），
  手动 `/compact` 与 `compactRegion` 既不否决也不退避。
- `status: failed` 带 `stage`（`archive`/`summary`/`commit`/`persistence`）与 `error`；取消的尝试额外带 `cancelled: true`。
- `gate` 是判定明细，输入全部来自活的事实：`priorCompactionCount` 由 session 日志推导（无 `error` 的 `compaction/end` 计数）、
  `carriedDebtTokens`/`cacheDebtRepaymentTokens` 来自引擎的 per-session 债务台账、horizon 两项来自 todo tracker。
  `economics.enabled=false` 时为 `{enabled:false,evaluated:false}`；手动/强制区间为 `{…,evaluated:false,reason:"explicit-manual"|"forced-region"}`，
  **仍带完整定价**——cacheWrite 成本与触发方式无关，必须计入后续债务（M2 裁决 Q2）。
- `todoHint` 在存在候选点时才出现（`used:true` 表示候选真的移动了区间结尾）；无 todo 信号 ⇒ 字段缺省，审计行与 M1 同形。
- 写入串行化在一个 promise 链上，失败仅一次性告警；事务返回前会 `await` 该行（审计不会与它记录的结果竞争）。

## 7. 已知偏离与遗留风险

1. **经济门控已接入触发策略（M2 完成）**：`economics.enabled: true` 时，`trigger="pressure"` 的自动压缩现在会被判定**否决**——
   否决 = 不追加任何 session 事件 + 审计写 `status:"deferred"` + `compactIfNeeded` 返回 `null`（不抛「still above threshold」）。
   否决范围仅限 pressure：`context-overflow` 仍评估+记录但永不否决（正确性义务），手动 `/compact` 与 `compactRegion` 不评估不否决。
   `gate.memoTokens` 仍是**调用前下界**（只含框架开销，因为必须在付摘要调用之前决策），不是最终 framed 价（后者见 `summary.framedTokenCount`）。
   证据：`evidence/m2-functional-verification.md`、`evidence/m2-regression-arm.md`。
2. **归档失败的错误分类**：`ManualCompactionErrorCode` 是封闭集合且没有 archive 成员，人工路径映射到 `summary`
   （其文案是「未能产出有用摘要；会话未改变，尝试已记录」，事实正确），真实原因在 `error.message` 与审计行里。
3. **`compaction-basic` 被替换后其默认自动触发随之关闭**：默认装配下两者都是关的；若将来要在同一 profile 里保留 basic 的自动压缩，
   必须显式裁决（互斥是 C1 的硬约束）。
4. **`enabled` 需要重启生效**：与 spill-cas 的 `spillReadTool` 同类已知行为（settings 用户层在加载期可能尚未合成完）。
5. **`gate` 的 `priorCompactionCount`/`carriedDebtTokens` 已换为真实来源（M2）**：前者由 session 日志推导（无 `error` 的
   `compaction/end` 计数，durable、回放安全），后者是引擎内 **per-session 内存台账**（`WeakMap`）：每次 committed 压缩
   `+= writeTokens × max(0, cacheWriteReadRatio-1)`，每个后续步按最近一次 committed 的 savingTokens 摊还一步。
   **已知限制：重启后债务归零**——债务描述的是活着的被改写前缀，进程重启后没有可摊还的前缀；每次判定实际用的数值都写进
   审计行，因此模型仍可事后重建。`averageContextTokenIncrement` 保持 `null`（计划 §0 明示不合成）。
   todo horizon 同理：无 todo 数据 ⇒ `completedBoundaryRequestCounts=null` ⇒ vendor 给 `horizon_unavailable` ⇒ 否决（fail-closed）。
6. **todo 信号只是提示**：候选点仅用于 (a) 供门控 horizon 输入、(b) 在**配对检查通过**时把压力选区的结尾对齐到计划边界；
   配对检查永远是唯一授权方，无 todo 时选区与不带该信号的现状**逐字节零差异**。宿主 `todos` 投影的语义（整表替换、无稳定 ID、
   `turn/start` 清空）被如实继承：content 变更 = 旧条目消失 + 新条目，不是「同一条目改名」。
7. **回放纪律**：绝不能用「未压缩录制件」在回放时触发压缩（`eval/README.md` §12 同纪律）；压缩臂需要专属 fixture/arms（M3）。
8. **失败范围退避（M4-D）**：`trigger="pressure"` 的一次尝试若**在 `stage:"summary"` 上失败**（即已经付过 summarizer 调用、
   产出被守卫拒绝），引擎记下这次选区的键 `{start,end,totalTokens}`（`totalTokens` = 决策时 `measurement.totalTokens`）。
   后续 pressure 评估若选出**同一选区**且 surface **未增长过释放阈值**，本次直接退避：
   **不付 summarizer 调用、不归档、不追加任何 session 事件**，只写一行 `status:"deferred"` / `reason:"failed_region_backoff"` 审计行
   （与 M2 的 deferred 同 schema，额外带 `backoff`）。surface 增长过阈值后同一选区**允许重试**——内容变了就可能压得动。
   三条边界（都由单测钉住）：(a) 仅 `pressure` 设键与退避——手动 `/compact`、`compactRegion`、`context-overflow` **零行为变化**，
   尤其 overflow 恢复是正确性义务，绝不能因一次 pressure 失败而被退避挡掉；(b) 键**只被新的失败覆盖**，提交不清键，
   因此一个陈旧键必须同时满足「同选区」+「未显著增长」才生效，不会永久封死某个区间；(c) 记忆是**会话级内存态**
   （`WeakMap`），重启即清零——与 M4-B 的债务重建互不冲突（那是日志推导，这是进程内节流）。
   `enabled:false` 时该逻辑根本不被触达（压力路径在测量之前就返回 `null`）。
   零 API 静态重演（今天 19:02 的 compact 臂录制件 `16` 次失败尝试）：`node eval/compact-arms/m4d-backoff-replay.mjs`
   —— 忠实段（首次退避掉一次**原本成功**的压缩之前）**确定省下 1 次**（#21 `287-287`）；
   其后的外推段再省 5 次，共 `16 → 10`（上界估计，非实测）。

   **释放阈值 = `min(10% × 失败时 totalTokens, 4096 tokens)`**（`FAILED_RANGE_GROWTH_MARGIN` 与
   `FAILED_RANGE_GROWTH_CAP_TOKENS`，两个半边以 `Math.min` 合成，2026-09-16 审查⑤ 修订）。
   小 surface 上比例半边更小 ⇒ **与修订前逐字节等价**：`28_003` 的失败键在 `30_803`（+2_800）仍退避、`30_804`（+2_801）释放，边界与修订前同一处；
   实现上比例臂**沿用修订前的原表达式** `totalTokens * (1 + margin)`（而不是代数等价的 `price + min(...)`）——
   两者在边界处差一个 ULP（50 tokens 的阈值是 55.00000000000001，`55` 应判退避），「小 surface 行为不变」这句话必须是字面为真；
   大 surface 上绝对上限半边生效 ⇒ 抑制期不再随 surface 价格无限变长。
   修订动机（实据）：旧公式是**单一比例阈值**——surface 到 1M tokens 时，同一选区要被重试需要先长出 **100k tokens** 新内容，
   长会话后段事实上等于永久封印，M4-D 的「重试一次」设计意图落空。
   审计行的 `backoff` 现在带 `{start,end,totalTokens,margin,growthCapTokens}`，两个半边都落盘，事后可复算这一次判定。
   证据：`test/backoff.test.js` 新增 3 条（小 surface 保持比例边界 / 大 surface 在 `+4_096` 释放而旧公式要求 `+100_000` /
   真会话大 surface 上 `+8%`（4_400 tokens）释放一个比例半边仍会封印的字节同形选区）+ `evidence/functional-verification.mjs` scenario 8b（9 checks）。

## 8. 测试

```bash
cd plugins/dsh-context-compact
pnpm install
node --test                          # 120/120（M4 基线 108 + M4-D 新增 9 + 双重门限审查修订新增 3）
node evidence/functional-verification.mjs   # 104/104 checks（零 API，M4 基线 86 + M4-D 新增 9 + 双重门限 9）
```

- 真 `Session.create()` + 真 cordis `Context`；**只 mock LLM**（`FakeLlm` 产出确定性 `StreamChunk`，零 API 调用）。
- `test/engine.test.js` —— 事务/锁/取消/归档 fail-closed/pruner 接线/两种自动触发/摘要前缀复用；
- `test/plugin.test.js` —— 命名导出、单槽位 service、默认全关（含 waterfall 结构证明）、settings 三层、策略归一化；
- `test/gate.test.js`（M2 新增 24 条）—— 否决矩阵、门控输入真实性（日志计数/债务数值/horizon 数值）、候选点对齐、fail-closed；
- `test/todo-tracker.test.js`（M2 新增 12 条）—— completed 跃迁、边界 seq 映射、请求计数、`turn/start` 清空、content 变更、恢复路径；
- `test/economics.test.js`、`test/plan.test.js` —— 上游 NVIDIA MIT 两个测试文件的逐条移植（断言不变）；
- `test/backoff.test.js`（M4-D 新增 9 条 + 双重门限修订新增 3 条）—— 失败键纯函数语义、同选区零增长退避、增长释放、异选区不误伤、
  overflow 恢复不被挡、手动 `/compact` 不被封、关闭路径零变化；双重门限三条钉住「小 surface 走比例、大 surface 走 4096 上限」；含 3 个变异反向验证（见下）。
- `test/audit.test.js` —— 审计 sink 的顺序/权限/失败包含。
