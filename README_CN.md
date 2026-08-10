```
 ██████╗  ██████╗ ██╗     ██╗     
 ██╔══██╗██╔═══██╗██║     ██║     
 ██████╔╝██║   ██║██║     ██║     
 ██╔══██╗██║   ██║██║     ██║     
 ██║  ██║╚██████╔╝███████╗███████╗
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝
```

**[English README](README.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@seanyao/roll.svg)](https://www.npmjs.com/package/@seanyao/roll)
[![CI](https://github.com/seanyao/roll/actions/workflows/ci.yml/badge.svg)](https://github.com/seanyao/roll/actions/workflows/ci.yml)

**Roll 让你电脑上已经装好的 AI 编程工具，按一个正规团队的方式干活 —— 并且把
"干完了"的证据留下来给你查。**

你手上的 AI 本来就会写代码，前提是你坐在那儿一句一句盯着它。Roll 是它外面那一层：
把你的需求拆成小任务，一次派一个任务给 AI，逼它自己跑测试，帮你开 PR，最后留下
一份你能打开看的验收证据。

## Roll 到底替你做什么

你给一句需求。之后每个任务，Roll 会：

1. **拆活** —— 一个需求变成一串编好号的小任务，写进 `.roll/backlog.md`，每个任务
   自带验收标准。
2. **挑一个任务派给 AI** —— Claude、Codex、Kimi、Pi、Antigravity、Reasonix、
   Cursor，你装了哪个、登录了哪个就用哪个。
3. **把 AI 关在自己的沙箱里干** —— 活是在单独的 git worktree 里做的，不是在你正
   待着的那个目录里。
4. **让它自己证明干好了** —— 测试必须过，然后换另一个 AI 来评审并打分。
5. **开 PR** —— CI 必须绿。只有 PR 合进 `main`，任务才算 Done。Roll 不给自己判卷。
6. **归档证据** —— 每个任务有自己的验收页，带测试输出和截图；"能用了"是一个你能
   点开来看的东西。

然后接着下一个任务。

**先说清一件最要紧的事：Roll 不会自己开工。** 没有定时器、没有后台常驻服务、没有
计划任务。活之所以在动，是因为你打开终端跑了 `roll loop go`。你不跑，它就不动。

## 开始之前，你需要四样东西

- **Node.js 22 或更高。** 除了 node，Roll 不需要别的运行时。
- **一个 git 仓库**，并配好能推的 GitHub `origin`，它才有地方推分支、开 PR。
- **至少一个装好并登录了的 AI 命令行工具** —— Claude Code、Codex、Kimi、Pi、
  Antigravity、Reasonix 或 Cursor。Roll 是指挥它们的，不是替代它们，自己不带模型。
- **对花钱有个预期。** token 是记在你自己的账号上，不是 Roll 的。真干活就真烧钱，
  `roll status` 会告诉你到目前花了多少。

## 安装

```bash
npm install -g @seanyao/roll
```

macOS 上安装时还会顺手把 `Roll Capture.app` 装到 `~/Applications` —— 验收证据里
那些真截图靠它。装不上也不影响（CI、无界面环境、非 macOS、没网，或你设了
`ROLL_SKIP_CAPTURE_INSTALL=1`），安装照样成功，Roll 只会告诉你截图功能还没就绪，
`roll doctor tools` 会给出修的办法。细节见[安装](guide/zh/installation.md)。

## 五分钟跑通第一个任务

```bash
# 1. 这台机器上做一次：把各个 AI 工具要读的约定装好。
roll setup

# 2. 进你的项目。这一步只是先"看"一眼你的目录并告诉你它打算干什么，
#    不会背着你去改一个已有的代码库。
cd your-project
roll init

# 3. 不知道下一步该干啥？让它只告诉你一条命令。
roll next

# 4. 用一句话写下一个小任务。
roll idea "加一个 /health 接口，返回 200"

# 5. 只做这一个任务就停，方便你看清整个过程。
roll loop go --max-cycles 1

# 6. 看进展。
roll loop status

# 7. 打开这个任务的验收证据。
roll attest US-XXX-001
```

第一个任务一定要小 —— 一个看得见的行为，一条明显的验证路径。一个小任务真跑完，
比一个大任务卡住能学到的多得多。

如果你手上是 PRD 或一堆笔记，不是一个具体任务，那就把文档交给它去拆：
`roll design --from-file docs/PRD.md`。完整流程见[快速上手](guide/zh/getting-started.md)。

## 跑起来你会看到什么

`roll status` 是最该先学会看的一屏。这是它在一个真实项目上的样子：

```
  WARN    主干对账待处理（快照已过期）   exit 1
  北极星  自主 0h ● · 交付 暂无数据 ● · 修复 暂无数据 ● · 归因 暂无数据 ●

  LOOP      会话驱动 · 无进行中的 go 会话
  CYCLE     31 / 3天   12 失败 · ¥213.60
  RELEASE   v4.704.2 已就绪   unknown · f:0 w:44 ?:78 · 483 已合 · 606 待交付
  STORY     8% 验收覆盖      失败 0 · 未知 573

  漂移 0 · 已交付 483 (含历史 445) · 未知 573 · 待办 30
```

怎么读：

- **北极星** —— 一行四个健康指标：自己跑了多久、任务落地的频率、有多少精力花在
  返工上、失败归因准不准。`roll north` 会展开成 14 天面板，带目标值（72 小时自主
  时长、交付率 ≥60%、修复税、归因错误）和每项背后的防应试口径。
- **LOOP** —— 现在有没有正在跑的一轮。
- **CYCLE** —— 最近三天试了多少次、失败几次、花了多少钱。
- **STORY** —— 已完成的活里，有多少留下了验收证据。
- **漂移** —— 标了 Done 但 `main` 上找不到对应证据的任务。待办清单和现实不一致时，
  Roll 会直接指出来，而不是照着清单信。
- `?` 表示它不知道；`0` 表示它知道答案就是零。

任务正在构建时，`roll loop watch` 能看实时过程。这两个都是只读的，Ctrl-C 只关掉
视图，不影响正在跑的活。

## 新手最先问的几个问题

**它会不会把我代码搞坏？** 每个任务都在自己的 git worktree 里做，而且 AI 干活期间
你的主 checkout 会被设成物理只读。任何东西进 `main` 都得走 PR 且 CI 绿。万一真有
改动漏进你的 checkout，Roll 会把它挪到 `rescue/leaked-*` 分支上，并在
`.roll/loop/quarantine` 写一份说明告诉你怎么取回 —— 它不会把活直接扔掉。

**我把终端关了会怎样？** 它还在跑 —— 那是一个 detach 出去的 tmux worker，你只是
不再看着它而已。想让它停下来：

```bash
roll loop pause     # 不再摘新任务
roll loop resume    # 放开，继续干
```

同一类失败反复出现时 Roll 也会自己 pause，而不是在一个坏掉的环境上继续烧 token；
回到运行态的正规出口就是 `roll loop resume`。

**我怎么知道它没糊弄我？** 因为待办清单上那个 `✅ Done` 只被当成一句*声明*，不算
事实。事实是 `main` 上的合并记录和归档的证据。证据缺失或指向不存在的文件会直接拒
合；`roll attest audit` 会把缺的列出来。真正在本机证明不了的事情（比如一次真实发布、
一次真实的 OAuth 回调），报告上写的是 `UNVERIFIED`，不会给你一个绿。

**出问题了但我不知道是什么问题。** 按这个顺序问：

```bash
roll doctor      # 安装、AI 工具、外部工具健康吗？
roll next        # 这个项目下一步该干什么？
roll help        # 内置文档
```

**要花多少钱？** `roll status` 显示已花的；`roll config prices` 是模型价格表。
详见[价格与成本](guide/zh/pricing.md)。

## 你真正会天天用的命令

| | |
|---|---|
| `roll init` → `roll next` | 接入项目，然后永远靠它问下一步 |
| `roll idea "..."` | 加一个任务 |
| `roll loop go` | 开始干（`--max-cycles 1` 只干一个，`--epic <name>` 只干一块） |
| `roll loop status` / `roll loop watch` | 快照 / 实时 |
| `roll status` | 一屏看项目健康 |
| `roll loop pause` / `roll loop resume` | 停 / 继续 |

## 全部命令

| 命令 | 说明 |
|------|------|
| `roll agent [migrate\|list\|cast]` | 本机装了哪些 AI、谁承担哪个角色 |
| `roll backlog [sync\|block\|defer\|lint\|…]` | 查看、管理、lint 和同步任务清单 |
| `roll config [lang\|prices\|tune\|…]` | 语言、模型价格、建议式调参 |
| `roll design [--from-file <path>] [--agent <name>]` | 用 `$roll-design` 技能把需求聊成任务 |
| `roll doctor [skills\|tools\|language\|repair-protection]` | 诊断安装、技能、工具、权限、语言漂移与写保护 |
| `roll help [--lang en\|zh] [name]` | 内置文档；`roll --help` 显示命令用法 |
| `roll idea "<一句话描述>"` | 记录并分类一个任务 |
| `roll init` | 诊断当前目录并决定怎么接入 |
| `roll loop <go\|pause\|resume\|watch\|status\|runs\|cycles\|cycle\|…>` | 运行、观察和维护交付循环 |
| `roll next` | 不管你在什么状态，只给一条最合适的下一步 |
| `roll north [--json] [--no-color]` | 14 天面板：自主时长、交付率、修复税、归因错误 |
| `roll release [--dry-run\|--showcase]` | 发版计划与 golden-path 演示 |
| `roll setup [-f\|--force] [--reselect] [--no-capture-install]` / `roll setup skills\|offboard` | 安装/同步约定、修截图就绪度，或移除 Roll 的文件 |
| `roll status [ci\|pulse] [--json]` | 项目健康、CI 状态、交付脉搏 |
| `roll test [--where] [--reset]` | 通过隔离适配器跑测试 |
| `roll update` | 升级全局安装并重新同步约定 |
| `roll --version` / `roll -v` | 显示已安装版本 |

支撑能力都挂在所属命令下：`roll config prices`、`roll agent cast`、
`roll doctor tools`、`roll status ci`、`roll status pulse`、`roll loop cycles`、
`roll loop cycle`、`roll release showcase`、`roll setup offboard`。

---

## 想深入的话

下面这些是等你把基本流程跑顺了、想知道这台机器怎么造的时候再看的。

### 谁负责什么

Roll 把"协调一个项目"和"交付一个任务"分开：

- **Supervisor** 管项目级的事：任务顺序、跨任务上下文、反复失败、发布就绪、预算，
  以及什么时候该来问你。它只观察和建议，从不亲自实现任务，也不能覆盖证据闸。
- **Delta Unit** 用四个稳定角色交付一个任务 —— `design`（需要时产出 Designer
  契约）、`execute`（真正写）、`evaluate`（评审打分）、`supervise`（任务之上的协调）。
- **哪个 AI 来当哪个角色**，按 `Scope -> Role -> Binding -> Agent -> Model` 解析，
  声明在 `~/.roll/agents.yaml`（本机）和 `.roll/agents.yaml`（本项目）：

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
          from: [claude, codex, kimi, pi, agy, reasonix, cursor]
          require: [evaluate]
          strategy: health-aware
  ```

- **某个 AI 调不动时**（auth、网络、VPN、账号状态），Roll 会把这件事记下来并说出
  口，而不是悄悄换一个 AI 然后报成功。`roll supervisor route --role builder
  --story <id>` 会列出每个候选、各自为什么被排到那个位置或被跳过、最后选了谁。
- **技能仍然是能力层。** 角色去调用 `$roll-design`、`$roll-build`、`$roll-fix`、
  `$roll-peer`，而不是把这些重写进 TypeScript。

日常形态叫 **Delta Team**：你当前这个会话就是 Supervisor，通过 `roll delta` 去请求
Designer、Builder、Evaluator 的子会话。Roll 自己从不启动、恢复或配置任何会话，
包括你的。一份有效的 Evaluator 报告只走到 `delta:terminal(handoff_ready)` 就停 ——
之后的交付/PR 步骤由你自己跑，而 Done 依然只来自合进 `main`。这种模式下的成本记作
`? (host_unobservable)`，不估、不折算、也不写成零。

操作步骤见 [AI agent](guide/zh/ai-agents.md)。

### Delta rig 本机就绪诊断

`roll delta rigs --refresh` 探测每个精确配置的 `{adapter, cliModelId}` 并发布一份
完整本机快照。它只读、**绝不使用默认模型**，也不改变派工、分配或解析。

探测通过只说明这个 rig 刚刚在这台机器上应答了，不代表更多。

### Delta Builder 预检

Builder 完成最后一次 green TCR 提交后会跑一次只读预检：预检失败可以在同一帧里修好，
之后再走正式 validate。预检只检查这一帧的完整性，并不能证明某个模型真的执行过、
会话是新的，或者一个长任务能跑完。

### 看清一轮里发生了什么

可观测性是 CLI-first 的。持久事实只走一条读路径：anchors -> selectors -> adapter
-> projections。

```bash
roll loop cycle <id> --roles      # 选了谁、谁回了、谁被采纳
roll loop cycle <id> --collab     # 角色之间的交接
roll loop cycle --legend          # 符号是什么意思
roll supervisor live              # 多角色看板，打一帧
roll supervisor live --collab     # 同一个看板 + 协同细节
roll supervisor live --watch      # 保持打开，原地刷新
```

同一批事实也出现在任务报告的 Execution Cast 区块里。失败会被归因为 `env`、
`harness`、`card` 或 `unknown` —— 同一个非 `card` 根因反复出现时会暂停派工，并写
一份带 playbook 的诊断快照，而 `unknown` 不猜。一个有效的自主日需要至少 6 次非
idle 尝试；backlog 空的日子只停表，不算在头上。如果旧的环境类失败污染了跳过名单，
`roll loop pardon-skip-list [--dry-run]` 会从记录里重算一遍。

### 证据与闸

一个任务是通过它自己的验收 Review Page（`latest/<id>-review.html`）、AC map、
截图和测试产物被验收的。

合并闸很严：`attest render` 失败、`ac-map.json` 里指向不存在的路径、AC 状态还停在
`claimed`、可视任务既没截图也没豁免，都可能拒合。PR body 里的 `Roll-Evidence`
trailer 让评审者一步跳到证据；`roll attest audit [--json]` 查悬空引用和
`evidence_debt` 行。

详见[验收证据](guide/zh/acceptance-evidence.md)和
[证据生命周期](guide/zh/acceptance-evidence.md#三段式生命周期)。

### 规则层

Roll 自己的工程规则放在一个带版本的注册表 `policy/rules.yaml` 里，并投影进架构与
验证文档。覆盖率由 `policy/rules-inventory.yaml` 这份审计清单来判定，**并不是
关键字搜索式完备性** —— 关键字搜的结果证明不了完备。

不是每条规则都拦人：`doc_drift: soft` 是 advisory（只报不拦）。更严的
`US-RULE-006` 模式是一张 Hold 卡 —— 它要求可信 owner，目前尚未启用。

### 语言

Roll 的每个用户界面一次只显示一种语言。`ROLL_LANG=en|zh` 固定当前进程，
`roll config lang en|zh` 保存偏好，`roll config lang --reset` 回到系统语言探测，
`roll help --lang en|zh` 用来临时看一眼另一种语言。`roll doctor language` 审计文档、
约定、技能和生成页面的语言漂移。

Agent 契约、代码注释、git 元数据和 TypeScript 标识符保持英文 —— 那是 harness 的
契约层。跟你的对话跟随你的语言。用户文档分别放在 `guide/en/` 和 `guide/zh/`；改的
时候更新对应语言的文件或 i18n 文案目录，不要把两种语言塞进同一个渲染出来的界面。
这些语言控制的覆盖证据在
`packages/cli/test/cli-language-surface.test.ts`、
`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap` 和
`packages/cli/test/doctor-language.test.ts`。

### 仓库结构

开发态是 pnpm monorepo，发布出去是一个 npm 包。

```
packages/      TypeScript 引擎（pnpm workspaces）：spec · core · infra · cli · web
lib/           运行时伴生（价格快照、i18n 文案目录）
skills/        Git submodule → agent 技能契约
conventions/   roll setup 同步进各 AI 客户端的约定
template/      roll init 安装的项目脚手架
policy/        规则注册表与它的审计清单
```

构建与测试：`pnpm install && pnpm -r test`。

## 文档

| | |
|---|---|
| **从这里开始** | [快速上手](guide/zh/getting-started.md) · [概述](guide/zh/overview.md) · [工程方法论](guide/zh/methodology.md) |
| **日常使用** | [Loop](guide/zh/loop.md) · [AI agent](guide/zh/ai-agents.md) · [配置](guide/zh/configuration.md) · [价格与成本](guide/zh/pricing.md) · [FAQ](guide/zh/faq.md) |
| **质量机制** | [验收证据](guide/zh/acceptance-evidence.md) · [证据生命周期](guide/zh/acceptance-evidence.md#三段式生命周期) · [一致性与发版闸](guide/zh/consistency.md) · [测试](guide/zh/testing.md) · [测试隔离](guide/zh/test-isolation.md) |
| **底层设计** | [架构](docs/architecture.md) · [验证体系](docs/verification.md) |

完整目录：[guide/zh/](guide/zh/)。

## 贡献

详见 [CONTRIBUTING.md](CONTRIBUTING.md)，里面有开发流程、测试方法和 PR 约定。

## 安全

详见 [SECURITY.md](SECURITY.md)。漏洞请私下汇报，不要发在公开 Issue 里。

## License

[MIT](LICENSE)
