# Phase 4 M2 —— 零 API 功能验证（D1–D7）

> 执行者：实现子代理（本会话内直接执行，**未派生任何孙代理**）
> 环境：node v26.8.2 / pnpm 11.26.0 / dsh 0.1.5-rc.1（安装产物 /home/li/.local/bin/node_modules/@deepseek-ai/dsh）
> **零网络、零真实 API 调用**：唯一的 LLM 是确定性 `FakeLlm`；全程**未运行 `record.mjs` / `metrics.mjs`**，
> **未启动 `record-eval` profile**。会话、surface 折叠、`surfaceOp{op:"replace"}`、`compaction/*` 事件括号、
> 工具配对检查、cordis context 全部是真宿主代码。

## 0. 复现命令

```bash
cd plugins/dsh-context-compact
node --test                                  # 88/88
node evidence/functional-verification.mjs    # 72/72 checks
```

原始输出：[node-test-output.txt](node-test-output.txt)、[functional-verification-output.txt](functional-verification-output.txt)。
被验证字节的 sha256：[m2-source-hashes.json](m2-source-hashes.json)（M1 那份 `source-hashes.json` 留档不动）。

## 1. `node --test`（88/88）

M1 既有 52 条全部保持绿；M2 新增 36 条：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/todo-tracker.test.js` | 12 | completed 跃迁检测、边界 seq 映射（表面序）、请求计数、`turn/start` 清空、content 变更=旧条目消失+新条目、恢复路径、水位倒退重折叠、commit 只清候选 |
| `test/gate.test.js` | 24 | 债务台账数值摊还、日志推导计数、否决矩阵（pressure 否决/放行、overflow 不否决、manual/compactRegion 不受影响、重试中途否决仍返回已提交结果）、门控输入真实性（horizon 精确数值、零已完成边界=空样本而非缺 horizon、债务精确数值）、候选点对齐（生效/回退/零差异/配对拒绝/越界忽略/不依赖门控开关）、fail-closed |

覆盖矩阵对 M2-G1..G4/G7 的映射见 `evidence/m2-regression-arm.md` 的收口表（回归臂数据由主代理独立复核）。

## 2. 变异测试（证明新测试真的活着）

对 M2 新增逻辑逐条注入变异、跑全量 `node --test`，**18/18 全部被杀**（每条变异都还原并复核）：

| 变异 | 结果 |
|---|---|
| pressure 否决被关掉 | KILLED (fail=3) |
| deferred 分支吞掉已提交结果（返回 null 而非 result） | KILLED (fail=1) |
| `priorCompactionCount` 硬编码回 0 | KILLED (fail=2) |
| 债务投影从门控输入里去掉 | KILLED (fail=2) |
| todo horizon 两项输入被丢掉 | KILLED (fail=8) |
| 候选点对齐被忽略 | KILLED (fail=2) |
| committed 后不记债务 | KILLED (fail=2) |
| 带 `error` 的 `compaction/end` 也算已提交压缩 | KILLED (fail=1) |
| deferred 行改写成 committed（=落 session 事件） | KILLED (fail=3) |
| `todoHint` 不写审计 | KILLED (fail=1) |
| 对齐跳过配对检查 | KILLED (fail=1) |
| 对齐允许放宽区间（越界 hint 被采纳） | KILLED (fail=1) |
| `turn/start` 不再清空计划 | KILLED (fail=1) |
| 无 todo 数据也报 horizon（不再 fail-closed） | KILLED (fail=3) |
| 债务摊还恒为 0 | KILLED (fail=3) |
| 未知 cache 比率折算为 0（而非 null） | KILLED (fail=1) |
| 边界锚点用「有序 seq 二分」解析（表面已非单调） | KILLED (fail=1) |
| committed 后不消费候选点 / 强制路径不记定价 | KILLED (fail=1) / KILLED (fail=1) |

其中前两轮各留下 1 个「存活」的变异，都**先补测试再杀掉**，没有把「测试没断言到」当成「不可能发生」：
(1) 锚点二分搜索、(2) 候选点消费与强制路径定价——对应新增 2 条用例。

## 3. 实测出来的两个真实缺陷（自检发现，已修 + 已钉测试）

M2 不是「照着计划写完就绿」。跑功能验证时审计行暴露了两个只有真跑才会显形的错误：

1. **门控读到的修复债务是错的**：债务台账 `pending()` 返回的键名是 `repaymentTokens`，而门控输入要的是
   `cacheDebtRepaymentTokens`；调用方用展开语法传入，于是 vendor 收到的摊还额恒为 0（`undefined ?? 0`）。
   修法：台账改用 vendor 自己的输入名返回，调用方可直接展开。**症状是「摊还看起来永远不发生」**，而
   M1 那条只断言 `decision.compact` 的测试**不会发现**它——这正是「测行为、不测实现」的反面教材。
2. **表面在压缩后不是 seq 单调的**：宿主把 checkpoint 追加在日志末尾、插在**表面最前面**，所以
   `session.surface.nodes` 出现 `[3, 39, 12, 13, …]` 这种序。所有「按 seq 大小过滤/二分」的读法都会错：
   用二分求「写事件之前最后一个表面节点」会返回系统头（实测 `target=12 → binary=3`，正确答案是 12）。
   修法：锚点解析与区间定价都改为**按表面位置**（后者 M1 的 `findIndex` 本来就是对的，已加回归测试钉死）。

## 4. 功能验证新增场景（第 7 节，13 条断言）

```
### 7. the economic gate decides the pressure trigger (M2: veto + real inputs)
  gate: horizon_unavailable (compact=false, horizon=null)
  PASS  no todo signal means no horizon, and the pressure compaction is refused
  PASS  the refusal writes a deferred audit line instead of a transaction
  PASS  the refusal appends no session event at all   [23 -> 23]
  PASS  the refusal never pays for a summarization call
  PASS  nothing was replaced or archived
  gate: economic; horizon input [1] / 5 open; breakeven 5.68
  PASS  a todo boundary opens a horizon and the compaction runs
  PASS  the gate inputs are the tracker's real observations
  PASS  the sub-sequence HINT aligned the cut to the plan boundary
  PASS  priorCompactionCount comes from the durable log
  debt: 170000 written tokens at ratio 2 -> 140096 carried, 29904 retired this step
  PASS  the committed compaction's cache-write becomes carried debt   [{"carriedDebtTokens":140096,"cacheDebtRepaymentTokens":29904}]
  PASS  one step retires exactly the compaction's per-step saving   [29904 vs 29904]
  PASS  the gate's 'no' has no authority over overflow recovery
  PASS  and the refusal verdict is still recorded verbatim
```

关键数值可独立复核：`170000 × max(0, 2-1) = 170000` token 债务，当步按 `archiveTokens(30000) - memoTokens(96) = 29904`
摊还 ⇒ 结转 `140096`。这正是 M2-G2 要求的「carriedDebt 精确数值摊还」。

## 5. 未做 / 边界（如实登记）

1. **`averageContextTokenIncrement` 保持 `null`**（计划 §0 明示）：因此 `windowRequestUpperBound` 恒为 `null`，
   horizon 只用 todo 边界样本估计，不做窗口推算。
2. **不合成剩余步数固定常数**（D4）：无 todo 数据就是 `horizon_unavailable`，不猜。
3. **债务是 per-session 内存态**：重启归零，见 README §7 #5 与 §6 报告的风险节。
4. **真 API 一次未跑**：M2 的验收全是零 API；双臂真实录制属 M3。
