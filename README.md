# dsh-context-compact

DeepSeek Harness 的自动上下文压缩插件：长对话快塞满模型窗口时，把旧内容压成摘要，让对话能一直继续。

比内置压缩多的东西：**压缩前先把原文完整存到硬盘，存失败就宁可不压**；每次压缩都写审计日志，可查可对账。

> ⚠️ 仍在实测阶段，接口和默认值可能调整。

## 安装

```bash
dsh plugin add github:ase-sketch/dsh-context-compact
```

然后在 profile 的 `cordis.patch.yml` 里接管内置压缩：

```yaml
- id: compaction-basic
  disabled: true

- insert:
    - id: context-compact
      name: '@sol-pi-port/dsh-context-compact'
```

`settings.yaml` 里打开开关（默认全关，不开 = 零行为变化）：

```yaml
efficiency-context-compact:
  enabled: true          # 总开关
  thresholdRatio: 0.8    # 窗口用到 80% 才压
  retainRatio: 0.16      # 最近 16% 对话永远保留原文
```

改完重启 dsh 生效。手动压缩随时可用 `/compact`。

## 它做什么

- 上下文到阈值 → 旧工作记录交给模型写成摘要，原文先归档再替换（失败不压）
- 压缩失败的区段会退避，不反复白烧 token
- 每次压缩在 `~/.dsh/state/context-compact/` 留审计行和归档原文

## 实测结果（单机双臂对照，样本小，仅供参考）

上下文峰值降 42–55%，主循环 token 降 33–55%；**但费用反而略升**——压缩本身要花一次摘要调用。它省的是窗口空间，不是钱。

## 卸载

删掉 `cordis.patch.yml` 里那两段和 settings 里的配置段，`dsh plugin remove` 即可。

## 更多

测试、评测方法与详细配置见 `test/` 与 `evidence/` 目录。问题与建议欢迎提 Issue。

MIT License
