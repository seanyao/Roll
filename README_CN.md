# Roll

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

Roll 是 Supervisor-led 的 CLI：把 backlog 变成按 Story 收口的 AI 交付流程，在本机可用 agent 之间路由规划、编码、评审、CI 与验收证据，同时把发布和架构决策留在人手里。

## 安装

```bash
npm install -g @seanyao/roll
```

环境要求：Node.js >= 22。

macOS 上 npm 安装会尽量从 `seanyao/roll-capture` 安装 `Roll Capture.app`，用于物理截图。设置 `ROLL_SKIP_CAPTURE_INSTALL=1` 可跳过。

## 快速开始

### 新项目

```bash
mkdir my-product && cd my-product
roll init
roll next
roll loop go
```

`roll init` 会先诊断当前目录；`roll next` 只给出一个最合适的下一步；`roll loop go` 在当前会话中启动一轮交付，从 backlog 逐张领取并完成 Story。

### 已有代码库

```bash
cd existing-codebase
roll init
roll next
roll init --apply    # 审阅接入计划后再写入
roll loop go
```

loop 需要可访问的 Git remote，才能推送分支和创建 PR。`roll loop pause` 会暂停自动领卡，`roll loop resume` 恢复；`roll loop go --cards <id>` 仍可显式执行单张卡。

## 核心机制

Roll 把项目协调与 Story 交付分开：

- **Human**：负责 backlog、审阅 PR、批准发布。
- **Supervisor**：做项目级协调，读取 backlog、CI、PR、证据与失败状态，并给出下一步建议；它不实现 Story，也不覆盖证据闸。
- **Delta Unit**：通过 `Designer`、`Builder`、`Evaluator` 三个稳定角色交付一张 Story，执行剖面为 `standard`、`verified` 或 `designed`。
- **Skills**：角色调用 `$roll-design`、`$roll-build`、`$roll-fix`、`$roll-peer` 等技能，而不是把工作流重写进 TS。
- **证据**：每张 Story 通过自己的 attest 证据、AC map、测试和截图收口。

角色模型是 `Scope -> Role -> Binding -> Agent -> optional Model`。机器级配置在 `~/.roll/agents.yaml`，项目级配置在 `.roll/agents.yaml`。

### 会话驱动

只有运行 `roll loop go` 才会开始领卡。没有定时器，也没有常驻调度器。`roll loop pause` 会暂停自动领卡，`roll loop resume` 恢复。运行可以留在 detached tmux worker 中继续，但不会启动你没有启动过的运行。

### 失败必须响

如果请求的 agent 或 rig 不可用，Roll 会记录不可用原因并暂停或请求 owner 处理，不会静默换用另一个 agent。

## 可观测性

当前真相入口以 CLI 为主：

```text
roll status
roll north
roll loop watch
roll loop runs
roll loop cycle <id>
roll loop alert
roll supervisor live --collab
```

角色与协同可见性通过 `roll loop cycle <id> --roles`、`roll loop cycle <id> --collab`、`roll loop cycle --legend` 和 Execution Cast 查看。

查看 feature 或单张卡的实际交付结论，使用 `roll supervisor delivery <feature-id|card-id> [--json]`。它是一张只读视图：一张卡只有一个最终交付结论，缺失历史保持 `?` 或 `n/a`，不会变成零或成功；它不能路由 agent、重试工作、改变 backlog、合并 PR 或 attest 卡片。统一的 `roll supervisor delivery` 视图是主要入口，`roll delta metrics` 仍是保留的 Delta-only 细节词典。

### 证据生命周期

详见[证据生命周期](guide/zh/acceptance-evidence.md#三段式生命周期)。证据在交付过程中收集，按验收标准核对，并在合并前挂到 Story。合并闸会检查 `attest render`、`ac-map.json`、`claimed` AC、视觉证据和 `evidence_debt`。运行 `roll attest audit [--json]` 查看证据健康；PR body 会携带 `Roll-Evidence` trailer。

Builder 运行期间主 checkout 保持只读。漏进主 checkout 的 dirty 或 ahead 工作会隔离到 `rescue/leaked-*` ref，并在 `.roll/loop/quarantine/` 写 manifest。

失败归因为 `env`、`harness`、`card` 或 `unknown`。同一非 card 根因反复出现会暂停派工，并写入带 playbook 的诊断快照。可用 `roll loop pardon-skip-list` 重建被污染的 skip 账本。

## 安全边界

- Done 表示 PR 已合入 `main` 且证据已接受；发布批准仍由人负责。
- 缺失事实显示为 `?`；可见的 `0` 表示已知为零，不是未知。
- `roll north` 的目标是 72 小时自主运行、交付率 >=60%、修复税 <1x、归因错误 =0；有效自主日需要非 idle 尝试，backlog 空日期不计入自主时长；`unknown` 不猜。
- hard doc-drift 执行**尚未启用**，当前 `doc_drift: soft` 是 advisory。

### Delta rig 本机就绪诊断

请宿主担当 Delta 角色之前，先用 `roll delta rigs` 查看它的本机诊断。不带标志的普通读取
只渲染最近一次完整的本机观测：不会启动模型、写快照，也不会改动工作区、租约、派工、
角色解析或事件。只有当你想对每个精确配置的 `{adapter, cliModelId}` 做有界探测并发布一份
完整的新本机快照时，才使用 `roll delta rigs --refresh`。

例如，已配置的 Codex 候选按其精确的本地模型映射探测（等价于
`codex exec --model <cliModelId> ...`），绝不使用默认模型。找不到可执行文件会显示为
**不可用**并提示安装；没有已验证安全的指定模型非交互选择方式的适配器同样显示为
**不可用**，且不会执行。**未知**包括过期或不兼容的缓存、超时、令牌输出未验证以及
未分类失败；修好界面显示的问题后再刷新。就绪文件保存在本机 `$ROLL_HOME` 下
（`delta-team/rig-adapters.yaml` 与 `delta-team/rig-readiness/…`），只是诊断证据：
它们不是 Delta 生命周期存储，prepare、角色解析、角色准入、租约与交付对账都不会读取。

输出一次调用只使用一种语言：`ROLL_LANG` 是单进程覆盖，然后是持久化的
`roll config lang` 偏好，再是 `LC_ALL`、`LANG` 和英文；中文操作者可用
`ROLL_LANG=zh roll delta rigs --refresh` 获得完整的简体中文本机诊断。**通过**
只表示这个指定模型在记录的观测时间返回了固定的最小令牌。它绝不证明后续长任务、
交付、宿主会话新鲜度或最终角色分配；真正做决定的是 pin、排除规则、标签、
成本上限和角色多样性。

### Delta Builder 预检

Builder 完成最后一次 green TCR 提交后、进行唯一一次正式 Builder validate 前，会运行只读预检。预检失败在同一帧修复，预检通过后再执行正式 `roll delta validate --stage builder --preflight-receipt <path>`。预检不证明模型已执行，也不替代独立 Evaluator 或正式的 fail-closed 校验。

## 规则注册表与文档漂移

`policy/rules.yaml` 是已注册 redline、doc-drift 模式和源码到文档映射的唯一机器可读权威。`policy/rules-inventory.yaml` 是可审计的覆盖面谓词：覆盖面 = 该谓词 + 排除项，绝非关键字搜索式完备性。

当前 `doc_drift: soft` 会输出诊断并以 exit 0 结束；它对手工 GitHub UI 合并只是 advisory。hard 模式**尚未启用**。切换为 hard 由 `US-RULE-006` 跟踪，该卡处于 **Hold**：激活前必须先完成可信 owner 授权与校准设计；peer 会话、交互式 TTY 或 `actor` 字段都不是可信 owner 身份认证。

## 语言

每个用户表面一次只显示一种语言。`ROLL_LANG=en|zh` 固定当前进程，`roll config lang en|zh` 持久保存偏好，`roll doctor language` 审计语言漂移。

Agent 契约、代码注释、git 元数据和 TypeScript 标识符保持英文。用户文档放在 `guide/en/` 与 `guide/zh/`。当前语言控制的快照证据在 `packages/cli/test/cli-language-surface.test.ts`、`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap` 和 `packages/cli/test/doctor-language.test.ts`。

## 命令

| 命令 | 说明 |
|------|------|
| `roll agent [migrate\|list\|cast]` | Agent scope、已安装 agent 与角色分工 |
| `roll backlog [sync\|block\|defer\|lint\|…]` | 查看、管理、lint 和同步待办 |
| `roll config [lang\|prices\|tune\|…]` | 配置语言、价格和建议式调参 |
| `roll design [--from-file <path>] [--agent <name>] [--verbose\|--raw]` | 启动 `$roll-design`，带有限的实时进度和 handoff |
| `roll doctor [skills\|tools\|language\|repair-protection]` | 诊断安装、skills、工具、权限、语言漂移和主 checkout 保护 |
| `roll help [--lang en\|zh] [name]` | 查看内置 Charter 和指南 |
| `roll idea "<一句话描述>"` | 捕获并分类一张 backlog 卡 |
| `roll init` | 诊断当前目录并路由 setup/onboarding |
| `roll loop <go\|watch\|runs\|cycles\|cycle\|alert\|…>` | 运行、观察和维护会话驱动执行 |
| `roll next` | 接续 init/onboard，只给一个最合适的下一步 |
| `roll north [--json] [--no-color]` | 北极星终端面板：自主运行、交付率、修复税、归因错误 |
| `roll release [--dry-run\|--showcase]` | 发版计划与一致性流程 |
| `roll setup [-f\|--force] [--reselect] [--no-capture-install]` | 安装/同步约定并修复就绪度 |
| `roll status [ci\|pulse] [--json]` | 项目健康、CI 状态和交付脉搏 |
| `roll test [--where] [--reset]` | 通过隔离适配器运行测试 |
| `roll update` | 升级全局 Roll 并重新同步约定 |
| `roll --version` / `roll -v` | 显示已安装的 roll 版本 |

## 仓库结构

```text
packages/      TypeScript 引擎（spec · core · infra · cli · web）
lib/           运行时伴生（价格快照、i18n 文案目录）
skills/        Git submodule -> seanyao/roll-skills
conventions/   roll setup 同步的约定
template/      roll init 安装的项目脚手架
```

构建与测试：`pnpm install && pnpm -r test`。

## 文档

- [快速上手](guide/zh/getting-started.md)
- [概述](guide/zh/overview.md)
- [AI agents 与角色路由](guide/zh/ai-agents.md)
- [Loop](guide/zh/loop.md)
- [验收证据](guide/zh/acceptance-evidence.md)
- [交付指标词典](guide/zh/delivery-metrics.md)
- [架构](docs/architecture.md)

完整指南目录：[guide/zh/](guide/zh/)。

## 贡献

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

详见 [SECURITY.md](SECURITY.md)。漏洞请私下汇报。

## License

[MIT](LICENSE)
