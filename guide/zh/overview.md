# Roll — 概述

Roll 是 Supervisor-led 的交付 harness。把目标写下来，让 Roll 拆成 Story，并把每张 Story 路由进 scoped `supervise`、`execute`、`evaluate` 角色。

## 快速开始

```bash
npm install -g @seanyao/roll

cd my-project
roll setup && roll init

roll next           # 接续 design/apply/repair/migrate/loop/status
roll loop go        # AI 在本会话里连续执行 BACKLOG
roll loop status    # 查看运行态和最近 cycle
roll loop watch     # 可选：CLI-first 实时旁观当前 cycle
```

## 工作原理

Roll 以 V4 Supervisor 执行系统运行：

- **Supervisor** —— 项目级 observe/advise 角色。它读取 backlog、merge truth、open PR、scoped role bindings、重复失败、发布就绪和 owner 问题。它协调跨 Story 工作；不实现具体 Story，也不覆盖证据闸。
- **Delta Unit** —— 一张 Story 在需要时先由 `design` 产出 Designer contract，再通过 `execute` 交付，并在配置后由 `evaluate` 评审。
- **角色与绑定** —— `supervise`、`design`、`execute`、`evaluate` 是稳定角色；具体 agent 和可选 model 由 `Scope -> Role -> Binding -> Agent -> Model` 解析。请求的绑定不可用时，Roll 记录并 fail loud，不冒充成另一个 agent。
- **Loop** —— 只要有会话在驱动，就从 BACKLOG 摘取最高优先级故事、在隔离 worktree 里执行，做完接着下一张。CI 通过后才会落到 `main`。会话之间不会有任何推进。
- **Dream** —— `roll dream run-once` 扫描代码库，发现死代码、文档缺口和架构漂移，将 `REFACTOR-NNN` 条目排队交给 loop 领取。
- **Skills** —— 仍然是能力层。角色调用 `$roll-design`、`$roll-build`、`$roll-fix`、`$roll-peer`、`$roll-.qa` 等技能。

你负责提需求、审 PR、执行发布。中间的一切交给 Roll。

## 交付怎么被驱动

只有一种方式:你打开一个 agent 会话,在里面跑 `roll loop go`。那个会话就是 Supervisor,
它会在同一套 backlog、路由剖面、证据、Evaluator 和发布闸之内,一张接一张地领合格的卡,
直到范围做完、`--max-cycles`/`--for` 到点、死循环熔断跳闸,或被暂停。**两次运行之间不会有任何推进,也不会有你没启动过的运行。**

范围可以收得很紧:`roll loop go --epic <name>`、`--cards <id,...>`、`--max-cycles N`、
`--for <duration>`。想先看清理由再定范围,就先问 `roll supervisor status/next/why`。

`roll loop pause` 停自主选卡,`roll loop resume` 放开;熔断器跳闸也会暂停。显式限定卡片的
一次性运行(`roll loop go --cards <id>`)在暂停下仍然执行 —— 那是你当场的决定,不是自主推进。

### 接入样例

**从零开始的新项目**

```bash
mkdir my-product && cd my-product
roll init
roll next
roll design --from-file .roll/brief.md
roll loop go
```

从一句需求、PRD 或几条笔记开始。Roll 说明下一步设计动作，而不是静默创建假工作；Designer 创建 backlog，Supervisor 为每张 Story 选择 `standard`、`verified` 或 `designed` 执行剖面，owner 查看按 Story 收口的 attest 证据。

**已有项目接入**

```bash
cd existing-codebase
roll init
roll next
roll init --apply
roll loop go
```

Roll 无破坏地诊断现有代码，审阅后才创建或更新 Roll metadata，然后基于已有 backlog/docs/context 推理。当前状态通过 CLI-first 可观测入口查看：`roll status`、`roll loop watch`、`roll loop runs`、`roll loop cycle <id>`、告警和 Story 报告。

**按 Scope 路由角色**

```yaml
schema: roll-agents/v1
defaults:
  story:
    roles:
      execute:
        candidates: [kimi, codex]
      evaluate:
        candidates: [pi, reasonix]
```

运行时可用性必须显式记录：不可用 agent 记录为 unavailable；角色解析必须 fail-loud，不能静默替换。

## 功能一览

### 会话驱动执行

- `roll loop go` — AI 从 BACKLOG 领取故事，在隔离 worktree 里一张接一张地执行，只要这个会话还在驱动 `[core]`
- `roll loop status` — 查看运行态、最近 cycle、队列、告警和成本 `[core]`
- `roll loop watch` — 默认只读实时状态；排查事件用 `--events`，审计/底层排障才用 `--raw-events` `[highlight]`
- `roll loop pause / resume` — 手动编码时暂停，完成后让 AI 继续

### 质量门禁

- Peer 评审 — 第二个 AI agent 在高风险构建前挑战方案或 diff `[core]` `[highlight]`
- 自检 — 每次微提交后自动做 post-commit 检查
- 验收检查 — 每次构建后对照故事定义逐条核实 AC
- CI 门禁 — loop 等待 CI 绿；CI 红则停止循环并写入告警 `[core]`
- TCR 纪律 — 测试不过不提交；空 diff 提交自动回滚 `[core]`

### Dream 代码健康巡检

- 代码健康扫描 — `roll dream run-once` 检测死代码、架构漂移、过度工程候选项 `[highlight]`
- 文档覆盖率 — 标记缺失指南、过时文档、未记录的 ENV 变量
- REFACTOR 队列 — 将 REFACTOR-NNN 条目写入 BACKLOG，由 loop 领取

### 故事生命周期

- `$roll-idea` — 一行捕获：即时生成 FIX 或 IDEA 条目 `[core]`
- `roll design` / `$roll-design` — DDD 驱动规划：澄清 → 设计 → 拆分为 INVEST 故事。`roll design` 从命令行在你的 AI agent 里拉起设计技能，并把详细设计渲染成自包含 Design Review Page。`[core]`
- `$roll-build` — Builder 角色执行：TCR 故事执行 → worktree → PR → 证据 `[core]`
- `$roll-fix` — 快速路径 Bug 修复，同样的 CI 门禁，更轻的流程
- Evaluator 角色 —— 执行剖面需要时，做独立评审、可视证据检查、score/attest 契约

### 可观测性

- `roll status` — 判定优先的真相摘要（LOOP · CYCLE · RELEASE · STORY，含 attest 验收覆盖率），其后是约定/AI 客户端同步健康 `[core]`
- `roll loop watch` — 当前 cycle 的 CLI-first 实时 activity 流
- `roll loop cycle <id>` — 单个 cycle 的轨迹与证据指针
- `roll loop runs` — 每轮 TerminalOutcome 历史，含 TCR 次数和耗时
- `roll loop alert` — 查看、确认、清除 loop 告警
- 验收 Review Page —— Story 自己的 `latest/<id>-review.html` 是人类验收入口 `[highlight]`

### 当前可观测性

当前产品是 CLI-first。`roll status`、`roll loop watch`、`roll loop runs`、`roll loop cycle <id>`、`roll status pulse`、告警和按 Story 收口的 attest 报告，是当前活体真相入口。归档重建 是按需静态归档/修复渲染器，适合 CI artifact 和迁移对账；它不是当前真相入口。

三态交付阶梯仍然成立：**claimed -> merged -> attested**。backlog 行写了 Done 只是 `claimed`；PR 合入 `main` 后变 `merged`；Story 证据齐备后变 `attested`。使用 `roll supervisor live` 查看一帧 CLI-first 多角色看板，或用 `roll supervisor live --watch` 让同一看板在终端原地刷新；浏览器/TUI 版 Supervisor Live Console 仍是未来工作。

### 按需技能

- `$roll-debug` — 挂载诊断探针，追踪根因，如果可溯源则自动修复
- `$roll-doc-audit` — 核对文档/网站/help 与实现；索引缺口并起草缺失文档
- `$roll-doctor` — 诊断开发工具链：node、npm、git、AI 工具
- `$roll-notes` — 以叙述形式记录一个开发时刻

### 多 Agent 协作

- Fail-loud 路由 — 请求的 agent/model/rig 不可用 → 记录限制并暂停，或仅按显式 fallback 策略路由 `[highlight]`
- `$roll-peer` — 多轮协商；结构化 adapter 记录一次性 reviewer facts `[core]`
- PR 收件箱 — 外部 PR 先经 AI 评审再合入；过时 PR 自动 rebase `[new]`
- `roll review-pr` — 对任意 PR 按需发起 AI 评审，可指定 agent `[new]`

## 项目结构

Roll 2.0 让项目根目录保持干净，所有 Roll 管理的产物都收进 `.roll/`：

```
my-project/
├── AGENTS.md            # 工程约束（根目录 — Agent 第一读它）
├── README.md            # 产品门面
├── src/  tests/         # 业务代码
└── .roll/               # Roll 接触的一切
    ├── backlog.md       # Story / Fix / Refactor 索引
    ├── features/        # 每个 Story 的 AC + plan 文档
    ├── domain/          # DDD 模型、context map
    ├── briefs/  dream/  # 自主层产出
    └── decisions/       # ADR
```

从 2.0 之前的版本升级？看 [migration-2.0.md](migration-2.0.md) ——
`npx @seanyao/roll@2 migrate` 一次性把旧版 `BACKLOG.md`、`docs/features/`、
`docs/domain/` 迁到新布局。

## 选择接入模式

Roll 支持三种接入模式，按项目起点选择 —— 决策树见
[patterns/](patterns/README.md)：

- **Seed（播种）** —— 空目录 + 产品愿景。从 day 1 就是 Roll 原生形态。
- **Graft（嫁接）** —— 已有代码、零侵入。`$roll-onboard` 从现有项目反推
  生成 `.roll/`。参见 [legacy-onboarding.md](legacy-onboarding.md)。
- **Replant（翻种）** —— 历史包袱重。先反推规格，再按新规格重建。

## 指南目录

| 主题 | 文档 |
|------|------|
| 第一次跑通项目 | [getting-started.md](getting-started.md) |
| 调度、子命令、tmux 可见性 | [loop.md](loop.md) |
| 受治理的工具注册表与策略 | [tools.md](tools.md) |
| 代码健康巡检与 REFACTOR 生成 | [dream.md](dream.md) |
| 跨 Agent 评审协议 | [peer.md](peer.md) |
| 完整技能目录 | [skills.md](skills.md) |
| 接入模式（seed / graft / replant） | [patterns/](patterns/README.md) |
| 给已有项目接入 Roll | [legacy-onboarding.md](legacy-onboarding.md) |
| 从 2.0 之前版本升级 | [migration-2.0.md](migration-2.0.md) |
| 常见场景与故障排查 | [faq.md](faq.md) |
| 环境变量配置 | [configuration.md](configuration.md) |
