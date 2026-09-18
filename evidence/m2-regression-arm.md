# Phase 4 M2 —— 回归臂（C5 / M2-G6）

> 执行者：**主代理独立执行并独立复核**（M2-G6 刻意不由实现者自证）；**本文件由实现子代理据主代理提供的产物整理**，
> 并由实现者**不采信自报、直接重算 18 份 digest** 与 M1 基线逐条比对（见 §2 末）。
> 环境：node v26.8.2 / pnpm 11.26.0 / dsh 0.1.5-rc.1。
> **零 API**：9 个 fixture 全部走 llm-replay 位置化回放；未运行 `record.mjs` / `metrics.mjs`，**未启动 `record-eval`**。

## 0. 前提（实现者已核实）

| 项 | 值 |
|---|---|
| profile 已装副本 vs 源码 | `diff -r plugins/dsh-context-compact/lib ~/.dsh/profiles/{eval,record-eval}/node_modules/@sol-pi-port/dsh-context-compact/lib` ⇒ **双 exit 0、零输出**（逐字节一致） |
| 机制状态 | **全关**（两个 profile 的 patch 里 `context-compact` 条目**不带 config** ⇒ `enabled` 取默认 false） |

## 1. 重冻结（M2 裁决 Q6 = 选项 b）

插件源码面变了（新增 `lib/todo-tracker.js` + 改 4 个 lib 文件）⇒ 指纹按设计换代。

| split | M1 代 | **M2 代（本轮）** | fixtureSetHash | files |
|---|---|---|---|---|
| dev | `90c9e95a17f31df2…` | `58748453fff04e3c95ef5e0922c9ab56e2cfda011e3884b12ea76978f2a9847f` | `d89fb51d…`（**未变**） | 66 |
| held-out | `d44f3d1d619d04…` | `34445eb293fc90955d1ddaeee75026bd07a4c01f7f83b8e3cbe8bde3fb5dc186` | `8870ee32…`（**未变**） | 41 |

两个 `fixtureSetHash` **逐字节未变** ⇒ `eval/fixtures/**` 与 `eval/recordings/**` 没被动过（dev/held-out 纪律不受损）。
插件面折值：**已装副本 == 源码面**（`5380abacfe4e…`，11 文件），freeze 的「源码=副本」硬门放行。

```
check-drift --split dev        exit 0   OK fingerprint=58748453… files=66
check-drift --split held-out   exit 0   OK fingerprint=34445eb2… files=41
```

## 2. dev 全 9 fixture 回归（`replay.mjs --runs 2`）

**基线** = M1 回归臂跑之前自行采集的 18 份规范化 digest 的 sha256（`evidence/baseline-digests.json`）。

| fixture | run1 digest | run2 | run1==run2 | 与基线#1 | 与基线#2 | g1Pass | faithful | verify | exit |
|---|---|---|---|---|---|---|---|---|---|
| dev/sum-csv | `b3f2a49d167b1221…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/read-big-log | `177fc3d4e77a440b…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/revisit-config | `33771f7f967e8754…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/count-active-json | `2f52f08761e47213…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/fix-parser-test | `6827e564bd2dd892…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/chain-lookup | `1a8379f46016ddd2…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/failing-test-suite | `172e4dc94f41e1f9…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/rerun-test-suite | `25a71875f5e500fb…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |
| dev/fix-stats-tests | `78a77fad110b5fc2…` | 同 | 相同 | **MATCH** | **MATCH** | true | true | true | 0 |

机器可读：`eval/.runtime/replay-results/dev-*.json`（含 run1/run2 digest、`verdict` 全字段）。

**实现者的独立复核**（不采信报告，直接读上面的产物重算）：9 个 fixture 的 canonical 文件均**非空**
（6 771 / 5 390 / 11 467 / 7 450 / 16 402 / 13 515 / 36 311 / 26 423 / 16 725 字节），run1==run2，
18/18 sha256 与 `baseline-digests.json` **逐字节相等**，`g1Pass`/`faithful`/`allVerified`/`allExitZero` 全 true。

## 3. 口径与判定规则（供独立复核复用）

1. **每个 fixture 必须有 2 份非空 canonical digest**（`eval/.runtime/digests/dev-<id>-run{1,2}.canonical.txt`），
   run1 == run2（G1 逐字节）。
2. **与 `plugins/dsh-context-compact/evidence/baseline-digests.json` 的 `<fixture>#1`/`#2` 逐字节相等**。
   该基线是 M1 回归臂在跑之前自行采集的 18 份规范化 digest 的 sha256。
3. `verdict` 必须 `g1Pass + faithful + allVerified + allExitZero` 全 true。
4. **空 digest（`e3b0c44298fc1c14…`，即空字符串的 sha256）= 无效运行**，不得当作通过。
   （本任务首轮尝试因 `EROFS: read-only file system, open ~/.dsh/profiles/eval/cordis.yml` 全部失败，
   在 `eval/.runtime/**` 留下过空 digest 残骸，已被本轮真实运行覆盖。）

## 4. 结论

**结论：M2-G6 通过。** 9/9 fixture `exit 0` ×2 遍、`g1Pass`+`faithful`+`allVerified`+`allExitZero` 全 true，
**18/18 digest 与 M1 基线逐字节一致**，`check-drift` 双 0 ⇒ 装上本插件（机制全关）对回放**零副作用**（C5 成立）。

证据链：主代理亲跑（`/tmp/replay-*.txt`、`eval/.runtime/replay-results/dev-*.json`）→ 实现者独立重算 18 份 digest
与基线逐条比对（不采信自报）→ 两边结论一致。

## 5. 环境运维教训（本轮最重要的排障记录）

M2-G6 第一次执行**全部失败**，两层原因叠加，第二层才是根因：

### 5.1 表层：profile 目录只读（实现者会话）

```
Error: EROFS: read-only file system, open '/home/li/.dsh/profiles/eval/cordis.yml'
    at prepareProfile (dsh/lib/profile-boot-Dk-7KqJc.js:209:2)
```

`dsh` 启动时要写 profile 目录（`prepareProfile` 生成 `cordis.yml`）。实现者会话的 file sandbox 是 `workspace-write`，
工作区外只读 ⇒ 无法运行任何 profile。已按纪律停下报告、未提权绕行；由主代理接管执行。

### 5.2 根因：宿主 settings.yaml 的模型配置漂移（与 M2 代码无关）

主代理在可写环境重跑后撞到真正的根因：**用户当日 23:25 改了 `~/.dsh/settings.yaml`** —— 删除 kimi 模型配置，
改装 web profile 专属的 `@eddyskywalker/dsh-chatgpt-subscription` 订阅插件（provider `kimi-code` 的 adapter 只存在于 web profile）。
eval profile 的 composition 里**没有任何 kimi-code adapter** ⇒ 回放 bootstrap 报：

```
no adapter registered for provider "kimi-code"
```

⇒ 9 个 fixture 全部 `exit=1`、产出**空 digest**。**这不是 M2 的回归失败**，是宿主配置与 eval profile 的适配缺口。

### 5.3 修复（零 eval 脚本改动、零 profile 变更）

1. 建**隔离 home** `eval/.runtime/dsh-home/`：其 `settings.yaml` 只声明
   `agent-default-model: { provider: deepseek-official, model: deepseek-flash }`
   （`dsh-llm-deepseek` 的 `PROVIDER` 常量即 `deepseek-official`，adapter 无条件注册、key 惰性解析 ⇒ 回放期零网络）；
   其 `profiles` 软链到 `~/.dsh/profiles`（复用真实 profile，不改动它们）。
2. 跑法（`EVAL_PROFILE_DIR` 必须显式钉回真实路径——drift 指纹含 `patchFile` 绝对路径，否则会算出不同指纹被拒跑）：

```bash
DSH_HOME=/mnt/e/sol-pi-port/eval/.runtime/dsh-home \
EVAL_PROFILE_DIR=/home/li/.dsh/profiles/eval \
DEEPSEEK_API_KEY=eval-replay-placeholder-no-network \
node eval/scripts/replay.mjs --fixture dev/sum-csv --runs 2
```

3. **可比性已实测成立**：digest 比较面（`stream-digest` 只取 assistant 流与工具调用）**不含 provider 字段**，
   因此与 M1 基线可逐字节比对（§2 的 18/18 MATCH 就是证据）。

### 5.4 沉淀（对后续里程碑的约束）

- **宿主 `settings.yaml` 是评测环境的隐式依赖**：它漂移会让整个 dev 集静默全红，且症状（空 digest）与机制回归失败**长得一样**。
  凡跑 `record.mjs` / `replay.mjs` / `metrics.mjs`，一律用隔离 home（或至少先确认 `agent-default-model` 指向的 provider 在 eval profile 里有 adapter）。
- **判读规矩**：空 digest（`e3b0c442…`）**永远是无效运行**，先查 bootstrap 日志再谈回归；只有「非空 + run1==run2 + 与基线逐字节相等」才算通过。
- 该隔离 home 位于 `eval/.runtime/`（`.gitignore` 内），不进漂移面、不影响 `check-drift`。
