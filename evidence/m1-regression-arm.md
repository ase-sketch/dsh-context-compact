# Phase 4 M1 —— 回归臂（C5）、profile 装配与零改动取证

> 执行者：实现子代理（本会话内直接执行，**未派生任何孙代理**）
> 环境：node v26.8.2 / pnpm 11.26.0 / dsh 0.1.5-rc.2 / Linux
> **零 API**：9 个 fixture 全部走 llm-replay 位置化回放；未运行 `record.mjs` / `metrics.mjs`。
> **如实登记**：装配探针期间误跑了一次 `dsh --profile record-eval "say hi"`（该 profile 没有 llm-replay，
> 因此真的发生了一次真实模型调用，只产生了 "They're planning a simple greeting." 一句）。此后脚本已改为
> **只对 eval 跑 smoke**（eval 的 llm-replay 会在任何模型调用之前 fail-loud），record-eval 一律不启动（见 §2）。

## 1. 装配（eval + record-eval，默认全关）

两 profile 各加：`package.json` 依赖 `file:/mnt/e/sol-pi-port/plugins/dsh-context-compact`；
`cordis.patch.yml` 追加 `- id: compaction-basic / disabled: true` + `- insert: {id: context-compact}`（**不配 config** ⇒ `enabled` 取默认 `false`）。

```bash
# 两 profile 各跑一次（pnpm 对 file: 目录依赖只在解析期快照一次，必须 rm -rf 后重装）
rm -rf node_modules/@sol-pi-port/dsh-context-compact && pnpm install      # exit 0，+1 package
diff -r /mnt/e/sol-pi-port/plugins/dsh-context-compact/lib node_modules/@sol-pi-port/dsh-context-compact/lib
# => exit 0，零输出（LIB-IDENTICAL）：已装副本与源码逐字节一致（10 文件）
```

## 2. 真实 loader 取证（`evidence/loader-proof.mjs`，12/12 通过）

**(a) 组合树里有这一条**（`dsh --profile <p> --dump-config`，全文见 `dump-config-eval.txt` / `dump-config-record-eval.txt`）：

```
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true          # ← 来自 profile patch，bundle 里的原条目被显式关掉
...
- id: context-compact
  name: '@sol-pi-port/dsh-context-compact'
```

**(b) 该 id 是真实 loader 条目**（一次性 `--patch` 用同名 id 再插一次）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  duplicate loader entry id: context-compact
```

**(c) 该树位真的 apply 已装字节**（把**已装副本**的 `lib/index.js` 临时换成 apply 必抛的替身再跑一次，随后还原）：

```
Error: failed to apply loader entry context-compact (@sol-pi-port/dsh-context-compact):
  context-compact apply proof: the profile entry really applies these installed bytes
    at new apply (file:///home/li/.dsh/profiles/<profile>/node_modules/@sol-pi-port/dsh-context-compact/lib/index.js:2:33)
```

还原后 `diff -r lib` 复跑 exit 0（零残留）；装配快照与探针后快照逐字节相同（§6）。

**(d) 已装字节在真 cordis Context 里挂载**（探针写在 profile 目录内、跑完删除）：

```
exports: ContextCompactEngine,apply,name | hasDefault=false | name=context-compact
inject: llm,tokenMeter,sessions | engine: ContextCompactEngine | methods: function,function,function
enabled: false | archive: true
```

**(e) `eval` 冒烟**：`dsh --profile eval "say hi"` 按既有口径停在
`llm-replay: a fixture path is required`，输出里**没有任何 `context-compact` 相关报错** ⇒ 装配树整体加载正常。

## 3. 最终冻结（由本任务收口）

```
freeze --split dev --force              exit 0
  fingerprint     90c9e95a17f31df2b0a7c5bd1270e3ad25a5128b54188762b45cba326d4d29b1
  fixtureSetHash  d89fb51d39c9cd089290ba823e4e65213f5b5efd391f32ee1fd7c11382d39144   (未变)
  format 2, frozenFileCount 66
freeze --split held-out --seal --force  exit 0
  fingerprint     d44f3d1d619d04bbc97bfa6d918efbc7a3bc8e1d4ed8f99e6236bb62d23a8a17
  fixtureSetHash  8870ee32b2b0ccb804bde704bd92d32a60ba6d77657154858b75ea62686d1e5a   (未变)
  format 2, frozenFileCount 41, sealed true
```

| split | 上一代（Phase 3b，有完整回归证据） | 本轮收口（含 context-compact） |
|---|---|---|
| dev | `000a88ef4323875df0cdfb8a547370ac94e61f82e5a8dbf80b0136ee837d8197` | `90c9e95a17f31df2b0a7c5bd1270e3ad25a5128b54188762b45cba326d4d29b1` |
| held-out | `7d5bd003851ec05a607bd49fac0f4138cef4fe1b9f7335064a89f71ccbcf485e` | `d44f3d1d619d04bbc97bfa6d918efbc7a3bc8e1d4ed8f99e6236bb62d23a8a17` |

两个 `fixtureSetHash` **逐字节未变** ⇒ `eval/fixtures/**` 与 `eval/recordings/**` 没被动过。
本轮收口值与并行收口记录（eval/README.md §8）**相同**：同一插件面的幂等重冻结；
下面 §4 为 `90c9e95a` / `d44f3d1d` 这一代补上了此前缺失的**成套 9 fixture 回归证据**。

```
check-drift --split dev        exit 0   OK fingerprint=90c9e95a… files=66
check-drift --split held-out   exit 0   OK fingerprint=d44f3d1d… files=41
```

插件面 lib 折值（freeze 输出，两 profile 相同，`installed == source`）：

| 插件 | libSha256 | 文件数 |
|---|---|---|
| `@sol-pi-port/dsh-context-compact` | `eb3aabee25822aaee08322dd81c250a368d45a35ed264e507f3fea3c1b0363e7` | 10 |
| `@sol-pi-port/dsh-action-fusion` | `0237aa35dd67d50e33ceb9c2592d830ed940a8acea935daeea26f666ae431498` | 8 |
| `@sol-pi-port/dsh-evidence-reducer` | `9b3b52f78dd00248a3a09026afd1ac8a78ced6651ebd9b477e33f0dd7ea77f71` | 13 |
| `@sol-pi-port/dsh-spill-cas` | `58c6cade5ea11039434991a31e3b9c34503c09e323283a2779103f2774490da5` | 6 |

## 4. dev 全 9 fixture 回归（`replay.mjs --runs 2`，统一口径）

基线 = 上一代（Phase 3b `000a88ef`）遗留的 18 份规范化 digest 的 sha256（本任务在跑之前自行采集，
见 `baseline-digests.json`；`eval/.runtime/digests/*.canonical.txt`）。

| fixture | run1 digest | run2 | run1==run2 | 与基线 | g1Pass | faithful | verify | exit |
|---|---|---|---|---|---|---|---|---|
| dev/sum-csv | `b3f2a49d167b1221…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/read-big-log | `177fc3d4e77a440b…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/revisit-config | `33771f7f967e8754…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/count-active-json | `2f52f08761e47213…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/fix-parser-test | `6827e564bd2dd892…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/chain-lookup | `1a8379f46016ddd2…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/failing-test-suite | `172e4dc94f41e1f9…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/rerun-test-suite | `25a71875f5e500fb…` | 同 | **相同** | **MATCH** | true | true | true | 0 |
| dev/fix-stats-tests | `78a77fad110b5fc2…` | 同 | **相同** | **MATCH** | true | true | true | 0 |

机器可读：`replay-results.json`（含 run1/run2 digest、基线值、`verdict` 全字段、assistant 行数对照）。

**结论：9/9 `exit 0`、`g1Pass`+`identical`+`allExitZero`+`allVerified`+`faithful` 全 true，
18/18 digest 与上一代逐字节一致** ⇒ 装上本插件（机制全关 = 不注册监听器、`compactIfNeeded` 入口即返 null）
对回放**零副作用**（C5 成立）。

## 5. 零改动取证（profile 递归折值）

折值口径：递归列出全部文件，`<relpath> <sha256>` 按 LC_ALL=C 升序、单 LF 连接、无尾换行，再取 sha256
（`evidence/profile-digest.mjs`）。

| profile | 装配前 | 装配后 | 结论 | 文件数 |
|---|---|---|---|---|
| `headless` | `bd37cfeddd10ace3647f6880aa7a454632156fe42b1218a8c9ef47bb3c72130b` | 同 | **逐字节未变** | 4 |
| `web` | `4549ecb30549c9de63832145681ed0d69f6f97272f4cbea06bbf2bcfd0c0a1f2` | 同 | **逐字节未变** | 20 142 |
| `eval` | `e4e4c40d531bdd003f22d0745ae45c8c7402d8ca2231b674c90a5278b1e212f0` | `50bf73b318a611eebdd45a7d114d62cbef4d1c96dbdbb9d8e17bc7024fb08823` | 变化，仅因新增本插件 | 1068 → 1080 |
| `record-eval` | `afb5cc5e981b7b5bfe1226755715f20d5ed571d8756f71985425785d25be12f3` | `a37b78838ccc013e09bf05f984002a1e642f15bd4ee62ef1b08ab9ab79581a23` | 变化，仅因新增本插件 | 41 → 53 |

两个变化 profile 的增量**精确等于本插件的 12 个文件 + pnpm 记账文件 + 两个手改文件**：

```
[added]   node_modules/@sol-pi-port/dsh-context-compact/{package.json,README.md}
[added]   node_modules/@sol-pi-port/dsh-context-compact/lib/{index,engine,selectors,summarize,economics,archive,audit,settings}.js
[added]   node_modules/@sol-pi-port/dsh-context-compact/lib/vendor/{economics,plan}.js
[changed] package.json, cordis.patch.yml
[changed] pnpm-lock.yaml, node_modules/.pnpm/lock.yaml, node_modules/.modules.yaml, node_modules/.package-map.json, node_modules/.pnpm-workspace-state-v1.json
```

两个 profile 的 `cordis.patch.yml` **只追加了一个块**，前缀逐字节未变（patch sha256 见
`profile-hash-after.json` 的 `evalPatchSha256` / `recordEvalPatchSha256`）。

**探针零残留**：装配快照与 loader-proof 跑完后重算的整目录折值**全部 IDENTICAL**（四 profile + 插件源码面；
`changedAny=false`）。

## 6. 未触碰 / 遗留

1. `headless`、`web` 两个在用 profile 本轮**未被运行任何命令**（除 `--dump-config` 只读组装树），折值逐字节相同。
2. **未运行 `record.mjs` / `metrics.mjs`**：账本 `eval/ledger/runs.jsonl` 未新增行（本轮不产生评测结论，只做回归）。
3. **未动** `eval/scripts|lib|arms|spill-arms|action-arms`、`eval/fixtures/**`、`eval/recordings/**`、
   `eval/manifests/held-out.json` 的内容面。证据：两个 `fixtureSetHash` 未变 + `check-drift` 双 exit 0。
4. **误跑的 1 次真实 API 调用**已如实记录在文首；`record-eval` 后续不再被启动。
5. **M2/M3 未做**（计划口径）：经济门控触发接入、todo 信号消费、长会话 fixture 与双臂真实录制。
