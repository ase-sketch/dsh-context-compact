# Phase 4 M2 —— 实现报告与逐条自评（D1–D8 / M2-G1..G7）

> 执行者：实现子代理（本会话内直接执行，**未派生任何子代理/孙代理做验证**）
> 环境：node v26.8.2 / pnpm 11.26.0 / dsh 0.1.5-rc.1（安装产物 `/home/li/.local/lib/node_modules/@deepseek-ai/dsh`）
> **零真实 API**：全程只用确定性 `FakeLlm`；未运行 `record.mjs` / `metrics.mjs`；**未启动 `record-eval` profile**。
> 依据：`docs/phase4-m2-plan.md`（已冻结）；裁决 Q1–Q7 见 §0。

## 0. 与冻结计划的偏离 / 主代理追加裁决

| 条目 | 主代理裁决 | 落实 |
|---|---|---|
| Q1 零已完成边界 | 按字面：`completedBoundaryRequestCounts=[]` + `remainingBoundaries=N`；**追加**要求钉一条单测断死 | `test/gate.test.js` "treats a plan with no completed boundary as an empty sample"：断言 `expectedRemainingRequests===1` 且 reason 走经济判定而非 `horizon_unavailable` |
| Q2 债务口径 | 任何路径 committed 都计债 | `_chargeDebt` 接线到 pressure / overflow / `/compact` / `compactRegion` 四条路径；测试断言 manual 路径也留下债务 |
| Q3 remainingBoundaries | 当前 turn 最近一次 `todo/write` 的 pending+in_progress 条数 | `todo-tracker.js` 实现；`turn/start` 清空后回到「无 todo 数据」 |
| Q4 profile 刷新 | 由主代理提权执行 | 已完成，`diff -r lib` 双 exit 0 |
| Q5 重试中途否决 | 返回**已提交的结果**（不吞掉） | `return result`（非 null）；单测 "reports a compaction that already committed when a later attempt is deferred" 钉死三点 |
| Q6 指纹 | 选项 (b) 重冻结 | dev `58748453…` / held-out `34445eb2…`（§4） |
| Q7 哈希留档 | 新增 `m2-source-hashes.json`，M1 那份不动 | 已产出 |

**无偏离。** 发现计划与现实冲突的两处（见 §3）都是「实现层面的事实」，不涉及裁决改动。

## 1. 改动清单（文件级）

### 新增

| 文件 | 行数 | 作用 |
|---|---|---|
| `lib/todo-tracker.js` | 180 | todo 信号折叠：completed 跃迁候选、边界请求计数、`turn/start` 清空、按表面序解析锚点 |
| `test/todo-tracker.test.js` | 190 | 12 条（M2-G3） |
| `test/gate.test.js` | 600+ | 24 条（M2-G1/G2/G4/G7） |
| `evidence/m2-functional-verification.md` | — | 零 API 功能验证证据 |
| `evidence/m2-regression-arm.md` | — | 回归臂（M2-G6） |
| `evidence/m2-source-hashes.json` | — | M2 收官字节快照（40 项） |

### 修改

| 文件 | 改了什么 |
|---|---|
| `lib/engine.js` (572→657) | 新增 `countCommittedCompactions`（日志推导）与 `recordDeferred`（deferred 审计行）；`gateRecord` 换成真实输入（count/debt/horizon/cacheDebtRepaymentTokens）并把输入全量回写审计；`compactSurfaceRegion` 支持 `todoHint` |
| `lib/index.js` (288→431) | `_evaluate`（选区+对齐+门控+否决判定）、`_chargeDebt`（债务记账）、`_regionGate`（强制路径定价）、`_framedMemoTokens`；pressure 循环接否决；overflow/manual/region 三条路径接定价与债务 |
| `lib/selectors.js` (92→121) | 新增 `alignRangeToHint`（配对检查为唯一授权方） |
| `lib/economics.js` (94→165) | 新增 `incrementalCacheCostRatio` 与 `CompactionDebtLedger`；`evaluateGate` 接受并透传 `cacheDebtRepaymentTokens` |
| `test/helpers.js` | 新增 `appendTodo` / `startTurn` 夹具 |
| `README.md` | §2 注解、§6 审计 schema（deferred 行 + todoHint + gate 全量）、§7 #1/#5 更新、#6 新增、§8 测试数（**全部锚点 edit**） |
| `evidence/functional-verification.mjs` | 新增第 7 节 13 条断言 |
| `evidence/node-test-output.txt`、`functional-verification-output.txt` | 刷新 |

**`lib/vendor/*` 逐字节未动**（sha256 `6f4a3f3a…` / `9de05890…`，与 M1 相同）——SPDX 冻结保持。
**未新增任何 settings 键**，默认值未动（D8）。**profile 未变**：两个 `cordis.patch.yml` 的 sha256 与 M1 记录逐字节相同（`1f1156e9…` / `753e1612…`）。

## 2. 方法

1. **先写测试**：`todo-tracker.js` 与其 12 条测试同批落地；每条新行为先看红/绿。
2. **变异测试当验收**：对 M2 新逻辑注入 19 条变异跑全量 `node --test`，**19/19 被杀**。前几轮留下的存活变异（锚点二分、候选消费、对齐与门控开关耦合）**均先补测试再杀掉**——不把「测试没断言到」当成「不会发生」。
3. **零 API 功能验证**：真 session / 真 surface 折叠 / 真配对检查 / 真 cordis context，只 mock LLM。

## 3. 实测出来的两个真实缺陷（自检发现）

1. **债务摊还永远为 0**：台账 `pending()` 返回键名 `repaymentTokens`，门控输入要的是 `cacheDebtRepaymentTokens`；调用方展开传入 ⇒ vendor 收到 `undefined ?? 0`。**M1 那条只断言 `decision.compact` 的测试发现不了它**（vendor 的 `cacheDebtRepaymentTokens` 只在返回值里回显）。修法：台账改用 vendor 的输入名返回。
2. **表面在压缩后不是 seq 单调的**：checkpoint 追加在日志末尾、插在表面**最前面**，实测 `[3, 39, 12, 13, …]`。按 seq 大小二分/过滤全错：二分求「写事件前最后一个表面节点」在 `target=12` 时返回系统头 `3`（正确是 `12`）。修法：锚点解析与区间定价全部改为**按表面位置**，并加回归测试钉死。

## 4. 验证证据

### 4.1 `node --test`（88/88）

```
ℹ tests 88
ℹ suites 20
ℹ pass 88
ℹ fail 0
```

全文：[node-test-output.txt](node-test-output.txt)。M1 既有 52 条全绿；新增 36 条。

### 4.2 零 API 功能验证（72/72）

```
checks: 72, failures: 0
functional verification PASSED        (exit 0)
```

全文：[functional-verification-output.txt](functional-verification-output.txt)；逐节说明：[m2-functional-verification.md](m2-functional-verification.md)。

### 4.3 重冻结与漂移（M2-G6 前半）

| split | M1 代 | M2 代 | fixtureSetHash | files | check-drift |
|---|---|---|---|---|---|
| dev | `90c9e95a17f31df2…` | `58748453fff04e3c95ef5e0922c9ab56e2cfda011e3884b12ea76978f2a9847f` | `d89fb51d…`（未变） | 66 | **exit 0** |
| held-out | `d44f3d1d619d04…` | `34445eb293fc90955d1ddaeee75026bd07a4c01f7f83b8e3cbe8bde3fb5dc186` | `8870ee32…`（未变） | 41 | **exit 0** |

插件面：已装副本 == 源码面（`5380abacfe4e…`，11 文件），freeze 的「源码=副本」硬门放行。

### 4.4 回归臂 digest（M2-G6 后半）—— 通过

9/9 fixture `exit 0` ×2 遍，`g1Pass`/`faithful`/`allVerified`/`allExitZero` 全 true，
**18/18 digest 与 `baseline-digests.json` 逐字节一致**（实现者直接重算 sha256 逐条比对，未采信自报）：

```
fixture              run1           run1==run2 vs基线#1 vs基线#2 g1Pass faithful verify exit0
sum-csv              b3f2a49d167b   true       true     true     true   true     true   true
read-big-log         177fc3d4e77a   true       true     true     true   true     true   true
revisit-config       33771f7f967e   true       true     true     true   true     true   true
count-active-json    2f52f08761e4   true       true     true     true   true     true   true
fix-parser-test      6827e564bd2d   true       true     true     true   true     true   true
chain-lookup         1a8379f46016   true       true     true     true   true     true   true
failing-test-suite   172e4dc94f41   true       true     true     true   true     true   true
rerun-test-suite     25a71875f5e5   true       true     true     true   true     true   true
fix-stats-tests      78a77fad110b   true       true     true     true   true     true   true

ALL 18 DIGESTS == M1 BASELINE: true
```

完整口径、运维根因与复跑命令见 [m2-regression-arm.md](m2-regression-arm.md)；其中 **§5 记录一个重要运维教训**：
宿主 `~/.dsh/settings.yaml` 的模型配置漂移（删除 kimi、改装 web 专属订阅插件）会让整个 dev 集静默全红，
症状（空 digest + exit 1）与机制回归失败**无法区分**，必须用隔离 home 跑评测。

## 5. 逐条自评（M2-G1..G7）

| Gate | 自评 | 依据 |
|---|---|---|
| **M2-G1** veto 矩阵 | **已完成并已验证** | pressure 否决（零 session 事件 + `status:"deferred"` 审计行 + 返回 null）、pressure 放行、overflow 在 `compact:false` 构造下仍执行、manual/`compactRegion` 不受否决——四条独立单测 + 功能验证第 7 节 |
| **M2-G2** 门控输入真实性 | **已完成并已验证** | priorCompactionCount 事件推导（含 2 次历史压缩用例 + 带 error 的 bracket 不计入）；carriedDebt 精确数值（`170000 → 结转 140096 / 摊还 29904`，功能验证实测）；todo horizon 精确数值（`[1]`/`remainingBoundaries`/`expectedRemainingRequests===2`）；无 todo ⇒ `horizon_unavailable` 且否决；零已完成边界 ⇒ 空样本而非缺 horizon（Q1） |
| **M2-G3** todo tracker | **已完成并已验证** | 12 条单测：completed 跃迁检测、边界 seq 映射（表面序）、请求计数、`turn/start` 清空、content 变更=旧条目消失+新条目、恢复/水位倒退路径、commit 语义 |
| **M2-G4** 候选点对齐 | **已完成并已验证** | 对齐生效（审计 `todoHint.used:true` + 区间结尾落在候选点）、配对不过回退、无候选与现状零差异（`todoHint` 字段缺省 + `shadowedRange` 与未对齐选区逐字段相等）、越界/非表面 seq 忽略 |
| **M2-G5** 全量绿 + 零 API | **已完成并已验证** | 88/88、72/72、exit 0；`FakeLlm` 是唯一模型；未触碰 `record.mjs`/`metrics.mjs` |
| **M2-G6** 回归臂 | **通过（主代理亲跑，实现者独立复核）** | 重冻结 + check-drift 双 0（§4.3）；9/9 `exit 0`×2、`g1Pass`+`faithful`+`allVerified`+`allExitZero` 全 true、**18/18 digest 与 M1 基线逐字节一致**（§4.4，实现者重算比对）。详见 [m2-regression-arm.md](m2-regression-arm.md) |
| **M2-G7** fail-closed 不回退 | **已完成并已验证** | 归档失败仍零写（surface 未变、`replaceGeneration===0`、无 `compaction/summary`、审计 `failed/archive`）；deferred 行不落 session 事件（`snapshotEvents` 长度与类型逐项不变）；`cache_ratio_unavailable` ⇒ 否决 |

## 6. 风险与已知限制

1. **债务是 per-session 内存态**：进程重启后归零。债务描述的是「活着的被改写前缀」，重启后没有可摊还的对象；每次判定实际用的数值都写进审计行，模型仍可事后重建。**M3 可复审是否改为 durable。**
2. **horizon 完全依赖 todo**：模型不写 todo 的会话 ⇒ 一律 `horizon_unavailable` ⇒ 压力路径**永不自动压缩**（只剩 window protection）。这是 D4 的 fail-closed 读法，也与 design.md §3.4「短会话近 no-op 是预期行为」一致；但**对「不维护 todo 的长会话」等于关掉了自动压缩**，M3 长会话 fixture 必须覆盖这一点。
3. **重试中途否决返回的是先前已提交的结果**（Q5 裁决 b）：调用方日志据此打印一次「已压缩」，与「本次调用否决了第二次尝试」并存；审计行两行（committed + deferred）如实区分。
4. **表面非 seq 单调**是宿主既有事实（M1 代码里 `findIndex` 的写法本来就对，但没有任何测试钉过它）。M2 加了回归测试；**其它读 `surface.nodes` 的模块（含第三方）仍可能踩这个坑**——已写入 README §7 之外的实现注释。
5. **强制路径新增了一次 tokenMeter 测量**（`_regionGate`）：手动 `/compact` 与 `compactRegion` 现在会多测一次以免审计无定价。代价是 O(surface) 的一次 fold，可忽略。
6. **宿主 `settings.yaml` 是评测环境的隐式依赖**：本轮实测——用户改了它（删 kimi 配置、改装 web 专属订阅插件）后，
   eval profile 缺对应 adapter ⇒ 9 fixture 全 exit 1、空 digest，**症状与机制回归失败无法区分**。后续跑评测一律用隔离 home
   （`eval/.runtime/dsh-home/`，见 [m2-regression-arm.md](m2-regression-arm.md) §5）；空 digest 永远按「无效运行」处理。
