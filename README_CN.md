# Roll

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

Roll 是 Supervisor-led CLI，用于按 Story 收口的 AI 交付。打开任意受支持 agent，这个会话就是 Supervisor。

## 安装

```bash
npm install -g @seanyao/roll
```

Node.js >= 22。

## 怎么玩

```bash
roll init
roll next
roll supervisor next
roll loop go
```

- `roll init` 准备项目。
- `roll next` 给出一个最合适的下一步。
- `roll supervisor next` 让当前 agent 会话选择下一张卡。
- `roll loop go` 从当前会话连续驱动 backlog。
- `roll delta` 通过宿主原生 sub-agents 交付单张 Story。

已有代码库先审阅计划，再 `roll init --apply`。`roll loop pause` 暂停自动领卡，`roll loop resume` 恢复。没有定时器，也不会启动你没有启动过的运行。

## 核心机制

- **Human** 负责 backlog、PR 审阅和发布批准。
- **Supervisor** 就是当前 agent 会话。
- **Delta Unit** 通过 `Designer`、`Builder`、`Evaluator` 三个宿主原生 sub-agents 角色交付一张 Story，剖面为 `standard`、`verified`、`designed`。
- **Skills** 提供 `$roll-design`、`$roll-build`、`$roll-fix`、`$roll-peer`。
- **证据** 按 Story 收口：attest、AC map、测试和截图。

## 命令

`roll agent`、`roll backlog`、`roll config`、`roll design`、`roll doctor [skills\|tools\|language\|repair-protection]`、`roll help`、`roll idea`、`roll init`、`roll loop`、`roll next`、`roll north`、`roll release`、`roll setup`、`roll status`、`roll test`、`roll update`。

常用入口：`roll supervisor next`、`roll supervisor live`、`roll supervisor delivery <feature-id|card-id>`、`roll loop go/pause/resume/status/watch/cycles/cycle/alert`、`roll delta prepare/validate/conclude/rigs --refresh`、`roll loop cycle <id> --roles`、`roll loop cycle <id> --collab`、`roll loop cycle --legend`、`roll supervisor live --collab`、Execution Cast。

## 操作要点

- 证据生命周期：`roll attest audit`、`evidence_debt`、`Roll-Evidence`、`claimed`、`rescue/leaked-*`、`.roll/loop/quarantine`。
- 指标：72 小时自主运行、交付率 >=60%、修复税、归因错误、非 idle、backlog 空、`env/harness/card/unknown`、`unknown` 不猜、`pardon-skip-list`、诊断快照。
- 规则：`policy/rules.yaml`、`policy/rules-inventory.yaml`、绝非关键字搜索式完备性、`US-RULE-006` Hold 需要可信 owner 且尚未启用、`doc_drift: soft` 是 advisory。
- 语言：`ROLL_LANG`、`roll config lang`、`roll doctor language`、一次只显示一种语言、Agent 契约、`packages/cli/test/cli-language-surface.test.ts`、`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`、`packages/cli/test/doctor-language.test.ts`。
- Delta：Builder 完成最后一次 green TCR 提交后运行只读预检，不证明模型已执行。

### Delta rig 本机就绪诊断

`roll delta rigs --refresh` 探测每个精确配置的 `{adapter, cliModelId}` 并发布一份完整本机快照。它只读、绝不使用默认模型，也不改变派工、分配或解析。

### Delta Builder 预检

Builder 完成最后一次 green TCR 提交后运行只读预检；预检失败可在同一帧修复，之后再进行正式 validate。

## 文档

- [快速上手](guide/zh/getting-started.md)
- [概述](guide/zh/overview.md)
- [AI agents](guide/zh/ai-agents.md)
- [Loop](guide/zh/loop.md)
- [验收证据](guide/zh/acceptance-evidence.md)
- [交付指标词典](guide/zh/delivery-metrics.md)

## License

[MIT](LICENSE)
