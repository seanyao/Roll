# Roll — 项目初始化

## 初始化项目

在项目根目录执行：

```bash
roll init
```

`roll init` 会先诊断当前目录状态，再决定是否改动文件：

1. **空目录** —— 全新起点。Roll 直接写入 `AGENTS.md`、空的 `.roll/`
   骨架（`backlog.md`、`features/`、`domain/`），可继续在 `.roll/agents.yaml`
   声明 scoped agent binding。不问问题。这是
   **seed（播种）** 接入模式 —— 见 [patterns/seed-pattern.md](patterns/seed-pattern.md)。
2. **PRD/文档-only** —— Roll 发现需求或产品文档，但没有源码和 manifest。
   这是新项目路径，会指向设计；不会进入已有代码库接入。
3. **已有代码库但未接入 Roll** —— Roll 检测到源码但没有 `.roll/`。它**不会**默默
   生成骨架，而是引导你用 `$roll-onboard`：扫描代码、问一组认知 / 范围 /
   隐私问题、产出 `.roll/init-diagnosis.yaml` 和 `.roll/onboard-plan.yaml`
   供审阅。审阅成对产物后执行
   `roll init --apply`：它会打印审阅检查点，列出每个计划文件操作的动作、目标路径、
   合并/创建模式和用户内容处理方式，并在交互终端等待确认。非交互自动化里，审阅后必须显式执行
   `roll init --apply --auto`。这是 **graft（嫁接）** 模式 —— 见
   [legacy-onboarding.md](legacy-onboarding.md) 与
   [patterns/graft-pattern.md](patterns/graft-pattern.md)。
4. **已初始化** —— `.roll/`、`AGENTS.md`、backlog、features 都存在。Roll
   打印 `Already initialized` 和 `Next: roll status`。
5. **部分接入 Roll** —— 有一部分 Roll 标记但不完整。Roll 打印
   缺失项和仍存在的 pre-v2 旧标记。`roll init --repair` 会先预览修复计划，
   在交互终端等待确认；非交互自动化必须显式执行 `roll init --repair --auto`。
   修复只创建缺失的 Roll-owned 文件或合并 Roll-owned 区块，并写入
   `.roll/onboard-changeset.yaml`，之后 `roll setup offboard` 可以反向移除这些改动。

任一路径之后，都可以用 `roll next` 接着走。它读取相同的 Roll 标记，以及
`.roll/brief.md`、`.roll/onboard-plan.yaml`、`.roll/backlog.md`，只输出一个下一步：
从 brief 进入设计、审阅并 apply onboard plan、修复 partial 标记、执行旧布局迁移、
对下一张 Todo 开 loop，或在没有可执行项时查看 status。

当某条路径在 git worktree 中写入 Roll-owned meta 文件时，`roll init` 会在收尾阶段尽力
把这些文件 add、commit 并 push 到 `origin`。这个 finalize 只覆盖 Roll 管理的路径，例如
`AGENTS.md`、`.claude/CLAUDE.md`、`.roll/**` 和 Roll 自己追加的 `.gitignore` 条目；
产品源码、PRD 和其他用户文件不会被顺手提交。若 commit 或 push 无法完成，init 会打印需要
手动执行的命令。

正在从 2.0 之前的布局升级（`BACKLOG.md` 在根目录或 `docs/features/`）？
先跑 `npx @seanyao/roll@2 migrate` —— 见
[migration-2.0.md](migration-2.0.md)。`roll init` 会拒绝在迁移到一半的
项目上叠加骨架。

## 更新约定和技能

roll 发布新版本后，将新约定同步到项目：

```bash
roll sync
```

`sync` 只覆盖 roll 管理的文件（技能和全局约定），不会动你的 `.roll/backlog.md`、项目源码等文件。

## 典型首次使用流程

```bash
npm install -g @bipo-ape/roll
roll setup                 # 全机器配置 AI 工具（仅需一次）
cd my-project
roll init                  # 诊断并路由该项目
roll next                  # 接续 design/apply/repair/migrate/loop/status
roll loop go               # 在本会话里推进 backlog
```

`roll setup` 会为本机已安装的 AI 工具同步约定。Agent 语义写在
`~/.roll/agents.yaml`（Machine Scope）和 `.roll/agents.yaml`（Project Scope）。
旧的 `primary_agent`、local agent、pairing 或 v3 route-slot 数据可以通过
`roll agent migrate --dry-run` 预览迁移到 scoped 模型。

## 创建的文件

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 约定：领域模型、作用域、编码规范（根目录 — 所有 AI 客户端的入口） |
| `.roll/backlog.md` | 故事跟踪（Epic / Feature / Story / Fix / Refactor） |
| `.roll/features/` | 每个 Feature 的深度文档 |
| `.roll/domain/` | DDD 模型、context map、架构记录 |

## 幂等性

`roll init` 可安全重复执行：完整项目会提示 `roll status`，部分项目会提示
`roll init --repair`，不会再次强行跑脚手架。

## 另见

- [installation.md](installation.md) — 安装和更新 roll
- [conventions.md](conventions.md) — AGENTS.md 结构和约定
- [patterns/](patterns/README.md) — 三种接入模式（seed / graft / replant）
- [legacy-onboarding.md](legacy-onboarding.md) — 将 Roll 嫁接到已有代码库
- [migration-2.0.md](migration-2.0.md) — 从 2.0 之前的布局升级到 `.roll/`
- [loop.md](loop.md) — 开启自主执行

## Git Hooks 自动配置（US-INFRA-008/009）

Roll 的 TCR 提交前检查在 `hooks/pre-commit` 里。
Git 默认忽略这个目录——需要把 `core.hooksPath` 指向它才能生效。
Roll 在三个地方自动完成配置，不会出现"检查门被绕过"的时间窗口：

1. **`roll setup`** — 在当前仓库设置 `core.hooksPath=hooks`。
2. **自主 loop 每轮 cycle preflight** — 每轮启动时确保 worktree 的 hooks 路径正确。
3. **Claude Code SessionStart hook**（`.claude/settings.json`）— 每次新开 Claude Code 会话时自动执行 `git config core.hooksPath hooks`。

**手动覆盖：** 如果你已经把 `core.hooksPath` 设成了别的值，Roll 不会覆盖它。
自动配置只在该值未设或等于 git 默认值 `.git/hooks` 时才触发。

**排查：** 提交时没有运行测试：

```bash
git config core.hooksPath   # 应该显示: hooks
ls hooks/pre-commit          # 应该存在且可执行
roll setup                   # 重新执行配置步骤
```
