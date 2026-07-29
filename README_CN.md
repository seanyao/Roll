```
 ██████╗  ██████╗ ██╗     ██╗     
 ██╔══██╗██╔═══██╗██║     ██║     
 ██████╔╝██║   ██║██║     ██║     
 ██╔══██╗██║   ██║██║     ██║     
 ██║  ██║╚██████╔╝███████╗███████╗
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝
```

**[English README](README.md)**

[![官网](https://img.shields.io/badge/官网-seanyao.github.io%2Froll-blue)](https://seanyao.github.io/roll/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

Roll 是 Supervisor-led 的 CLI harness：把 AI agent 解析为按 Story 收口的规划、构建、评估、git、CI 与验收证据流程。支持 Claude、Codex、Kimi、Pi、Antigravity、Reasonix 等本机可用 agent。

## 安装

```bash
curl -fsSL https://seanyao.github.io/roll/install | bash
```

```bash
npm install -g @seanyao/roll
```

环境要求：Node.js ≥ 22。Roll 是自包含的 TypeScript CLI —— 除 node 外无其它运行时引擎。
macOS 上通过 npm 安装时，会顺手从 `seanyao/roll-capture` 最新 GitHub Release
安装 `Roll Capture.app` 到 `~/Applications`，用于物理截图。CI、headless、非 macOS、
离线下载失败或 `ROLL_SKIP_CAPTURE_INSTALL=1` 都会静默跳过且不让安装失败；`roll setup`
和 `roll doctor tools` 会继续报告同一套就绪度与修复路径。

## 使用

```bash
cd your-project
roll init           # 在当前项目落地 Roll（交互式确认）
roll next           # 接续 design、apply、repair、migrate、loop 或 status
roll loop on        # 可选：让 AI 自动跑 backlog
```

`roll init` 会先诊断当前目录：完整 Roll 项目提示 `roll status`；部分接入
提示 `roll init --repair`；pre-2.0 布局提示迁移且不写文件。已有代码库会进入
`$roll-onboard`；PRD/文档-only 工作区按新项目处理，生成 `.roll/brief.md` 并指向
`roll design --from-file <detected-doc>`。空目录会在交互终端询问你要做什么；脚本或 CI 中，
普通 `roll init` 只读，`roll init --auto` 写入占位 brief 后指向 `roll design`。
已有代码库的 graft 流程里，`roll init --apply` 会先校验产物、打印每个计划文件操作的
审阅检查点，并在写入前等待 owner 确认；自动化必须在审阅后显式使用
`roll init --apply --auto`。
任一路径之后，`roll next` 都是继续按钮：它读取同一份 brief、onboard plan、
backlog 和 Roll 标记，只打印一个最合适的下一步命令，而不是让用户自己猜。
当 `roll init` 在 git worktree 中写入 Roll-owned meta 文件时，它会尽力把这些文件
add、commit 并 push 到 `origin`，然后打印提交/推送结果。你自己创建的产品文件不会被
纳入这次收尾提交。
第一次跑建议从[快速上手](guide/zh/getting-started.md)开始。

## 语言表面

Roll 的用户表面一次只显示一种语言。`ROLL_LANG=en|zh` 固定当前进程语言，
`roll config lang en|zh` 持久保存偏好，`roll config lang --reset` 回到系统语言探测。
临时查看帮助可用 `roll help --lang en|zh`；`roll doctor language` 用来审计文档、约定、
skills 与生成页面的语言漂移。

Agent 契约、代码注释、git 元数据和 TypeScript 标识符属于 harness 契约层，保持英文。
与 owner 的对话跟随 owner 使用的语言。用户文档放在 `guide/en/` 与 `guide/zh/`
两套 locale 文件中；贡献者应更新对应 locale 文件或 i18n catalog，不要把翻译对写进同一个
渲染表面。当前语言控制的快照证据在
`packages/cli/test/cli-language-surface.test.ts`、
`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap` 和
`packages/cli/test/doctor-language.test.ts`。

## V4 Agent 执行模型

Roll V4 使用同一个递归领域模型：

```text
Scope -> Role -> Binding -> Agent -> optional Model
```

Machine Scope 声明本机 agent pool 和 `supervise` 等机器级角色；Project Scope 绑定
项目和 Story 默认角色；Story/Skill 可以在需要时进一步收窄。主配置面是：

- `~/.roll/agents.yaml`：Machine Scope。
- `.roll/agents.yaml`：Project Scope。

Roll V4 把项目协调和单 Story 交付拆开：

- **Supervisor** 负责项目级协调：backlog 顺序、跨 Story 上下文、重复失败、发布就绪、预算与 owner 升级。它只观察和建议，不实现具体 Story，也不覆盖证据闸。
- **Delta Unit** 用 scoped roles 交付一张 Story：`design` 在需要时生成 Designer contract，`execute` 执行 Builder 交付，`evaluate` 评审证据。
- **`supervise` / `design` / `execute` / `evaluate` 角色**是稳定契约；具体 `agent` 和 `model` 由 scoped binding 解析。
- **Skills 仍然存在**，是角色调用的能力层。角色调用 `$roll-design`、`$roll-build`、`$roll-fix`、`$roll-peer`、`$roll-.qa` 等技能，而不是把技能重写进 TS。
- **运行时不可用必须响**。静态配置公平列出候选；auth、VPN、账号、网络等运行时问题只影响本次 resolution，并记录原因，不永久污染候选池。
- **attest 与证据按 Story 收口**。验收入口是这张 Story 自己的验收 Review Page（`latest/<id>-review.html`）、AC map 和截图/测试产物；`latest/<id>-report.html` 在一个发版周期内保留为旧别名。

### 运行模式

Roll 有两个产品模式，它们共用同一套 backlog、truth、路由剖面、执行剖面、证据、Evaluator 和发布闸：

- **guided** —— owner 通过 `roll supervisor status/next/why` 驱动，并用
  `roll loop go --cards <id>` 等命令显式启动工作。guided 模式不会静默开启长时间
  Story 执行。scheduler off 时，`roll loop go` 执行一次手动 goal；loop paused 时，
  先 `roll loop resume`，定时工作才会继续。
- **autonomous** —— `roll loop on` 安装 scheduler；符合条件的 Story 会在 pause、
  budget、route、evidence、Evaluator、release gates 内被调度。`roll loop pause` /
  `roll loop off` 回到 guided；`roll loop resume` / `roll loop on` 显式切回
  autonomous。

项目可以声明 Story 默认角色绑定：

```yaml
schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [kimi, codex, pi]
        require: [execute]
        strategy: first-available
      evaluate:
        kind: select
        from: [claude, codex, kimi, pi, agy, reasonix]
        require: [evaluate]
        strategy: health-aware
```

旧的 `primary_agent`、`.roll/pairing.yaml`、`.roll/local.yaml agent` 和
easy/default/hard/fallback route slots 仍作为兼容输入可迁移，但不再是主要 agent
管理模型。使用 `roll agent` 查看 scope/role/pool，使用
`roll agent migrate --dry-run` 预览迁移。

Workspace-first 模式下，稳定的 `workspaceId` 是身份；一台机器可以保持多个 active
Workspace，每个变更命令必须显式或确定性解析到一个目标。Workspace 保存 Requirement、
backlog 与 Story/Issue 交付记录，代码只出现在 `issues/<storyId>/<repoAlias>/` worktree；
`~/.roll/repos/<repoId>.git` 是多个 Workspace 可复用、可重建且不进入交付真相链的机器
bare cache。完整的创建、目标解析、多仓 Story、exact-SHA 验收和历史迁移流程见
[Workspace 指南](guide/zh/workspaces.md)。

## 接入样例

**从零开始的新项目**

```bash
mkdir my-product && cd my-product
roll init
# 在交互终端描述需求、指向 PRD，或让 Roll 从已有笔记写 .roll/brief.md。
roll next
roll design --from-file .roll/brief.md
roll loop on
```

Roll 会说明下一步设计动作，而不是静默创建假工作。Designer 把需求拆成 Stories，Supervisor 为每张 Story 选择 `standard`、`verified` 或 `designed`，角色通过 fresh session 执行，owner 查看按 Story 收口的 attest 证据。

**已有项目接入**

```bash
cd existing-codebase
roll init
roll next
roll init --apply        # 审阅生成的 onboard plan 后再执行
roll loop on
```

Roll 先无破坏地诊断仓库；只有审阅后才写入或更新 Roll metadata。随后 Supervisor 基于已有 backlog、docs、context、open PR 与 scoped role bindings 推理。当前状态通过 CLI-first 可观测入口查看：`roll status`、`roll loop watch`、`roll loop runs`、`roll loop cycle <id>`、`roll loop alert` 和 Story 报告。

## 新项目快速启动

新项目需要先配置 remote，loop 才能推送分支并创建 PR：

```bash
cd your-project
roll init
# 1. 为项目创建 GitHub 仓库并添加为 origin
# 2. 推送当前分支，让 loop 有地方落地工作成果
git push -u origin main
# 3. 启动自主循环
roll loop on
```

如果仓库不存在或不可达，loop 会快速失败并发出 ALERT，避免在无法推送的目
标上浪费 agent token。需要暂停时运行 `roll loop pause` 会持久化暂停标记；
准备好后用 `roll loop resume` 恢复。

例外：显式配置 `publish_mode: local` 的 campaign 只落到本地 integration branch；
在全部本地验收通过且 owner 打开远端发布闸之前，不会 push 或创建 PR。

## 命令

| 命令 | 说明 |
|------|------|
| `roll agent [--workspace <ID\|路径>\|migrate\|list\|readiness\|cast]` | 查看机器 Agent Scope/就绪度，或只读解析一个 Workspace 的角色分工 |
| `roll backlog [show\|sync\|block\|defer\|lint\|…] [--workspace <ID\|路径>]` | 查看和管理一个明确 Workspace 的待办；`--all` 仅限只读 |
| `roll config [lang\|prices\|tune\|…]` | 配置语言、价格和建议式调参 |
| `roll delivery <list\|show\|reconcile> [--workspace <ID\|路径>]` | 查看 Issue 各仓 PR/CI/merge 事实与 exact-SHA 集成验收；`list --all` 仅限只读 |
| `roll design [--from-file <path>] [--agent <name>] [--workspace <ID\|路径>]` | 在一个明确 Workspace authority 上交互式启动 `$roll-design` |
| `roll doctor [skills\|tools\|language]` | 诊断安装、skills、工具、权限与语言漂移 |
| `roll help [--lang en\|zh] [name]` | 查看内置 Charter / guide；`roll --help` 显示 CLI usage |
| `roll idea "<一句话描述>" --workspace <ID\|路径>` | 在一个明确 Workspace backlog 中捕获并分类卡片 |
| `roll init` | 诊断当前目录并路由 setup/onboard |
| `roll loop <on\|go\|pause\|resume> --workspace <ID\|路径>` / `roll loop status --all` | 运行或变更一个 Workspace scheduler；聚合状态仅限只读 |
| `roll next` | 接续 init/onboard，只给一个最合适的下一步 |
| `roll north [--json] [--no-color]` | 北极星终端面板：自主运行时长、交付率、修复税和归因错误 |
| `roll release [--dry-run\|--showcase]` | 发版计划/流程与 golden-path showcase 支撑 |
| `roll setup [-f\|--force] [--reselect] [--no-capture-install]` / `roll setup skills\|offboard` | 安装/同步约定，修复 Roll Capture.app 就绪度，或移除 Roll 管理的项目产物 |
| `roll status [ci\|pulse] [--json]` | 项目健康、CI 状态和交付脉搏 |
| `roll test [--where] [--reset]` | 通过隔离适配器运行测试 |
| `roll workspace <init\|issue\|requirement\|doctor\|migrate\|list\|show\|register\|activate\|pause\|archive>` | 初始化/定位 Workspace、诊断并有界修复漂移、检查/应用/续跑/回滚历史迁移，并管理生命周期 |
| `roll update` | 升级全局 Roll 并重新同步约定 |
| `roll --version` / `roll -v` | 显示已安装的 roll 版本 |

保留的支撑能力都挂在所属命令下：`roll config prices`、`roll config tune`、
`roll agent cast`、`roll doctor tools`、`roll status ci`、`roll status pulse`、
`roll loop cycles`、`roll loop cycle`、`roll release showcase`、`roll setup offboard`。
这些能力的历史顶层别名现在返回标准 unknown-command 响应。

## 当前可观测性

Roll 当前是 CLI-first 可观测。持久事实只走一条读路径：anchors -> selectors
-> adapter -> projections。`roll status`、`roll loop watch`、`roll loop runs`、
`roll loop cycle <id>`、`roll status pulse` 和按 Story 收口的 attest 报告，是当前用户面的
真相入口。归档重建 只是按需的归档/修复渲染器，用来生成静态 HTML 页面；
它不是当前活体交付真相入口。
角色与协同可见性也在同一表面上：`roll loop cycle <id> --roles`、
`roll loop cycle <id> --collab`、`roll loop cycle --legend`、`roll supervisor live --collab`，以及 Execution Cast
报告区块，会展示 selected/returned/accepted 角色结果。

- `roll status` 顶部有一行北极星摘要。它把 `roll north` 的四项指标压成一行：
  自主运行时长、交付率、修复税、归因错误；每项后面的点表示当前状态。
- `roll north` 展开 14 天面板。目标是自主运行时长 ≥72 小时、交付率 ≥60%、
  修复税 <1x、归因错误 =0。防应试口径直接属于指标定义：有效自主日需要至少
  6 次非 idle 尝试；backlog 空的日期只停表不计时；修复税只用 US 卡作为分母；
  `unknown` 不猜。`null` 表示暂无可用数据，面板会给出原因。
- backlog 行是声明；`main` 上的 merge 证据和记录化验收证据才是真相。过早写
  `✅ Done` 会显示成漂移。
- 失败归因为 `env`、`harness`、`card` 或 `unknown`。同一非 card 根因反复出现时，
  系统会按根因暂停派工，并写入带 playbook 的诊断快照。看到派工暂停时，先读快照，
  修复其中点名的环境或 Roll 组件，再 resume。如果旧的 env/harness 失败污染了卡片
  skip 账本，用 `roll loop pardon-skip-list [--dry-run] [--include-unknown]`
  从 runs/events 重新计算并平反。
- Builder 周期中主 checkout 会被物理设为只读。若 dirty 或 ahead 改动漏进主
  checkout，会被隔离到 `rescue/leaked-*` ref，并在 `.roll/loop/quarantine/`
  写 manifest。manifest 记录文件列表和还原命令，用它来认领或恢复隔离内容。
- cycle 历史使用 TerminalOutcome 词汇，不再教旧的自由文本摘要。
- 缺失事实显示 `?`。可见的 `0` 表示已知为零，不表示未知。

合并证据闸会严格执行：`attest render` 失败、`ac-map.json` 悬空路径、`claimed`
AC 状态、无豁免可视卡缺截图，都会拒合。PR body 里的 `Roll-Evidence` trailer
指向这张 Story 的证据入口。用 `roll attest audit [--json]` 查悬空证据引用与
`evidence_debt` 行。详见[验收证据](guide/zh/acceptance-evidence.md)和
[Loop 失败处理](guide/zh/loop.md#失败归因与暂停)。

`roll supervisor live` 是已交付的 CLI-first 多角色看板。它默认打印一帧快照，适合脚本和快速查看；`roll supervisor live --watch` 会让同一个看板保持打开，并从同一条事件驱动 view model 原地刷新。浏览器/TUI 版 Supervisor Live Console 仍是未来工作，必须复用这个 view model。

## 仓库结构

开发态是 pnpm monorepo，发布态是单一 npm 包。

```
packages/      TypeScript 引擎（pnpm workspaces）：spec · core · infra · cli · web
lib/           运行时伴生（价格快照、i18n 文案目录）
skills/        Git submodule → seanyao/roll-skills（agent 技能契约）
conventions/   roll setup 同步到各 AI 客户端的约定
template/      roll init 安装的项目脚手架
```

构建与测试：`pnpm install && pnpm -r test`。

发布为单一 npm 包 `@seanyao/roll`：`dist/`（CLI 经 esbuild 打平为单个自包含 ESM）+ `lib/` + `skills/` + `conventions/` + `template/`。

## 文档

| | |
|---|---|
| **从这里开始** | [快速上手](guide/zh/getting-started.md) · [Workspace-first 交付](guide/zh/workspaces.md) · [概述与架构](guide/zh/overview.md) · [工程方法论](guide/zh/methodology.md) |
| **日常使用** | [Loop（自主执行器）](guide/zh/loop.md) · [Context Engineering](guide/zh/context.md) · [APE Context 迁移](guide/zh/context-ape-migration.md) · [Workspace Doctor](guide/zh/workspace-doctor.md) · [工具与策略](guide/zh/tools.md) · [浏览器操作（受管通道 + 交互通道）](guide/zh/browser-operations.md) · [配置](guide/zh/configuration.md) · [价格与成本](guide/zh/pricing.md) · [FAQ](guide/zh/faq.md) |
| **质量机制** | [验收证据（`roll attest`）](guide/zh/acceptance-evidence.md) · [证据生命周期](guide/zh/acceptance-evidence.md#三段式生命周期) · [一致性与发版闸](guide/zh/consistency.md) · [跨 Agent 配对](guide/zh/pairing.md) · [Peer 评审](guide/zh/peer.md) · [测试隔离](guide/zh/test-isolation.md) |
| **底层设计** | [架构：分层·领域·不变量](docs/architecture.md) · [验证体系](docs/verification.md) · [理念宣言](docs/manifesto.md) |

完整指南目录：[guide/zh/README.md](guide/zh/README.md) —— agent 路由、peer 评审、feedback、backlog 同步、接入模式等。

## 贡献

详见 [CONTRIBUTING.md](CONTRIBUTING.md)，里面有开发流程、测试方法和 PR 约定。

## 安全

详见 [SECURITY.md](SECURITY.md)。漏洞请私下汇报，不要在公开 Issue 里贴。

## License

[MIT](LICENSE)
