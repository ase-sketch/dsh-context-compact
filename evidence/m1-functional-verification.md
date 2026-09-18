# Phase 4 M1 —— 零 API 功能验证

> 执行者：实现子代理（**未派生任何孙代理**）；产物：`evidence/functional-verification.mjs` +
> 全文 `functional-verification-output.txt`（**59 checks / 0 failures / PASSED**）、
> `node-test-output.txt`（**52/52 测试全绿**）。
> 零网络、零模型调用：唯一的 LLM 是确定性 `FakeLlm`（`StreamChunk` 序列），
> 而 session / surface 折叠 / `surfaceOp{op:"replace"}` 原子替换 / `compaction/*` 括号 /
> 工具配对校验 / cordis Context 全部是**真实宿主代码**。

## 1. 覆盖的场景与实测事实

| # | 场景 | 关键实测事实 |
|---|---|---|
| 1 | 默认全关 | `compactIfNeeded` 返 null、`measureCalls=0`、`resolveCalls=0`；真 `waterfall("agent/pre-step")` 与 `waterfall("agent/request-error")` 派发**都到不了引擎**（零监听器）；无 compaction 事件、无审计文件 |
| 2 | 完整一次压缩 | 事件序列 `compaction/start → compaction/summary → user/message → compaction/end`；start/end 同一 `compactionId`、end 无 error、手动括号 `turn:null`；替换是 `surfaceOp{op:"replace",3,11}` 且带 `compactCheckpointSource`；surface `2,3,…,12 → 2,16,12`（system 头 + checkpoint + 保留尾部），`replaceGeneration 0→1`；被压区间是连续且两端配平的跨度 |
| 2 | 归档 | 1 次 `saveText`：头行 + 每个被 shadow 事件一行；locator 与 `bytes` 落审计行；归档内容可用会话日志词汇逐字节复原 |
| 2 | 摘要调用（KV cache） | 调用消息第 0 条是会话 `system`、末尾是本插件指令、`purpose="compaction"`、`maxTokens=512`；`compaction/summary` 带 `llmStreamCall:true` + 完整 `rawOutput` + `usage` |
| 3 | 压力触发 + pruner 接线 | 越过 80% 阈值即压缩；`pruneSession` 被**显式**调用 1 次（它从不监听事件）；自动括号 `turn:1`；低于阈值零动作、零审计行 |
| 4 | context-overflow 恢复 | 首次 overflow ⇒ `{kind:"retry"}` 且真的落了一次替换；第二次被 `maxOverflowRetries=1` 预算拒绝（`next`，无第二次替换） |
| 5 | 证据保全 fail-closed | 后端 `saveText` 抛错 ⇒ 请求失败（`ManualCompactionError.code="summary"`）、**零 surface 写**、无 summary、end 带 error、审计 `failed/archive + archive.status=refused`；缺 `spillStore` 同样拒绝 |
| 6 | llm-replay 兼容（C6） | 见 §2 |

## 2. llm-replay 回放兼容性（本期的关键未知项）

把 **scenario 2 的真实压缩会话**用 `dsh-session-format-catalog` 的 `encodeCurrentHeader` /
`encodeCurrentEvent` 编成物理 v3 JSONL（6432 B，29 个事件，含 `compaction/*` 与 checkpoint），
再用 `llm-replay` 自己的公开入口读它：

| 检查 | 结果 |
|---|---|
| `parseSessionHeader(text)` | PASS，`id=session-manual` |
| `parseSessionLog(text)` | PASS，**29/29 事件**全部解析（含 `compaction/summary`） |
| `deriveReplayScript(events)` | PASS，重建出 **1 次模型调用**，chunk 序列 `block-start,block-end,usage,finish` |
| 重建块 == 录制 `rawOutput` | PASS（逐字节 JSON 相同） |
| 重建 usage == 录制 `usage` | PASS |
| `loadReplayScript({file})` | PASS，与直接派生结果逐字节相同 |
| **端到端**：`installLlmReplay(ctx,{file})` + 真 `waterfall("llm/stream")` | PASS，拦截到 1 次调用并原样吐出记录 chunk；`handle.assertConsumed()`（fixture 被完整消费）通过 |

⇒ **结论（C6）**：压缩产生的 `compaction/summary`（`llmStreamCall:true` + `rawOutput` + `usage`）正是
llm-replay 在日志位置上重建该次调用的依据；**含压缩记录的会话件可以被零网络回放**。
录制纪律仍然成立：压缩臂必须「录制时就开着压缩」，不能用未压缩录制件在回放时触发压缩（详见 README §7 / eval/README §12）。

## 3. 单元测试（`node --test`，52/52）

| 文件 | 覆盖 |
|---|---|
| `test/engine.test.js`（27） | 事务括号/start·end 配对/stale start/配对平衡拒绝/取消（中途与预先）保留精确 abort reason/归档 fail-closed（两例）/非空闲 busy/锁 busy/摘要不缩小/compactRegion 拒绝与强制/溢出恢复（预算·无进展·有进展但失败·其他失败码·已取消）/压力（阈值·pruner 降压力·无 contextWindow 的一发告警·重试预算耗尽）/摘要前缀复用与 rawOutput·usage 溯源 |
| `test/plugin.test.js`（10） | 命名导出（无 default）、`ctx.compaction` 单槽位、默认全关（waterfall 结构证明）、`/compact` 在关态仍可用、settings 三层与命名空间、策略归一化/钳制 |
| `test/economics.test.js`（6） | 上游 `compact-economics.test.ts` 逐条移植（断言不变） |
| `test/plan.test.js`（4） | 上游 `compact-plan.test.ts` 逐条移植（断言不变） |
| `test/audit.test.js`（4） | JSONL schema/顺序/0600/并发串行化/失败一次性告警/默认路径 |

测试用的 session 是**真 `Session.create()`**（含 `turn/start`、`step/start|end`、`tool/call`、
`tool/result`、`request/header` 的完整信封），因此所有断言都跑在真实 surface 折叠与真实
`toolPairingBalancedBefore/After` 之上；套件同时校验**开发者本机真实审计文件从未被写入**。

## 4. 遗留与风险（如实）

1. **经济门控 M1 只记录不介入**：`economics.enabled=true` 会评估 vendored 算法并写入审计（`gate` 字段），
   但**不否决触发**；触发策略接入 + todo 信号消费属 M2。`gate.memoTokens` 是调用前下界（只含框架开销）。
2. **`priorCompactionCount` / `carriedDebtTokens` 暂无来源**（传 0），跨轮债务模型属 M2。
3. 归档失败在人工路径映射为 `ManualCompactionError("summary")`（封闭错误集合没有 archive 成员），
   真实原因在 `error.message` 与审计行。
4. `enabled` 需要重启生效（与 spill-cas 的 `spillReadTool` 同类已知行为）。
5. 本轮**没有真实长会话**：dev/held-out 最短会话远低于 80% 阈值，自动触发在真实评测里近 no-op 是预期
   （计划 §7.4）；真实触发与收益判定留待 M3。
