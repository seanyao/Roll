# 系统设计

## 产品定位

roll 是 AI coding agent 的**外层控制系统**（agent harness / reliability layer）。它不进入 agent 内部（不管理 token 窗口、不压缩对话、不干预单次推理），而是在外部建立一个闭环：设定目标 → 调度执行 → 感知结果 → 修正方向。

当前用户入口是 CLI-first：`roll init`、`roll supervisor`、`roll supervisor live`、`roll loop`、`roll status`、`roll loop cycle` 与按 Story 收口的 `roll attest` 验收 Review Page。浏览器/TUI 版 Supervisor Live Console 是下一阶段工作，不作为当前产品面承诺。安装方式：`npm install -g @seanyao/roll`。

## 为什么是分层闭环

一个可靠的控制器，必须是被控系统的一个**连贯模型**（[specs/theory-foundation](specs/theory-foundation.md)）。当同一个能力域被摊在多种异构载体上、靠文本缝合（stdout 解析、现生成脚本、散落的状态文件）时，协调开销本身就在吃掉控制带宽——**散，是不稳定与低效的根因**：那类"引号地狱 / 解析漂移 / 状态不一致"的故障，长的正是载体之间的缝。

所以 roll 是一台**分层的 TypeScript 控制器**：每个能力域一个家，层与层用类型化契约相连，反馈闭环作脊柱。缝消失，长在缝上的那类故障也就失去土壤。

## 设计五原则

1. **每个能力域一个家。** 把摊在四种载体上的同一个域（Orchestration / Observability / Evals / Guardrails / Context Engineering / Tool Use / Sandboxing），收敛成一个连贯的 owner/包。这是 roll 缺的那层"系统设计"。
2. **反馈闭环是脊柱，层是它的器官。** 别把能力域做成并列模块；按"结构核心 + 控制平面"接成一个闭环：核心作动（编排/执行/工具/上下文）→ 控制平面传感/评分/限幅（可观测/Evals/Guardrails）→ 反哺下一轮。
3. **TS 类型 = 层与层之间的契约。** 层与层用类型化接口相连，而不是 stdout 解析 / 现生成脚本——缝消失，长在缝上的那类故障失去土壤。
4. **守住黑盒边界（外层 harness）。** roll 不打开黑盒：token 级压缩、工具 schema 强制、单次 ReAct 委派给内层 agent。不必建模被控对象内部，靠反馈就能控制（[specs/theory-foundation](specs/theory-foundation.md)）。
5. **反馈要有 Goodhart 护栏。** 闭环一旦把度量当目标就会被钻空子。所以 Evals 信号**不自动激活**、只生成"待人确认"候选；人在环上（human-on-the-loop）作监督限幅；retry 设上限并转 replan（anti-windup）；不对噪声反复 replan（deadband）。这是一条显性的设计纪律。

## 系统架构

```
spec         共享类型与事件合同（零依赖）

core         领域逻辑（纯函数，不碰 I/O，通过接口注入外部依赖）
             BacklogStore · StoryPicker · AgentRouter
             PRLifecycle · TCRPipeline · ReconcileEngine
             CostTracker · PolicyEngine · EventBus

infra        I/O 适配层
             Config · Git · GitHub · Tmux · ProcessManager

cli          命令入口（薄壳，解析参数 → 调 core → 格式化输出）

web          站点与静态展示（当前不是活体 Supervisor 控制台）
```

依赖单向向上。下层不感知上层。

**技术选择**：TypeScript（类型安全）、vitest（自带进程沙箱）、commander + chalk（CLI）、simple-git + octokit（Git/GitHub）、handlebars（模板，替代 heredoc）、proper-fs-lock（替代手写锁）、React + shadcn/ui（前端）。

### 能力域归宿（每域一个家）

每个能力域在 6 包里的家：

| 能力域 | 家 |
|---|---|
| **Orchestration** 编排 | `core`（StoryPicker / TCRPipeline / ReconcileEngine / CycleOrchestrator）+ `infra`（worktree / 进程 / tmux 编排） |
| **Sandboxing** 执行隔离 | `infra`（Git worktree / ProcessManager / Tmux） |
| **Tool Use** 工具/多 agent | `core`（AgentRouter / AgentRegistry / CostTracker 的 usage 解析）+ `infra`（spawn / GitHub） |
| **Context Engineering** 上下文 | skill 桥接（独立仓）+ `.roll/` 文档纪律（是契约） |
| **Observability** 可观测 | `spec`（事件 schema）+ `core`（EventBus 写端 + 选择器）+ `cli`（CLI-first 观察面） |
| **Evals** 验证/评分 | `core`（Evals 六维 + 测试质量门） |
| **Guardrails** 治理 | `core`（PolicyEngine + Budget guardrails） |

> skills 不进 TS：仍是 markdown + shell，经桥接 spawn（它们是"灵魂/契约"，归 `roll-skills` 独立仓）。roll 收敛的是**控制器代码**，不是 skill 内容。

## 领域模型

系统分为 8 个 Bounded Context。每个上下文内部一致，上下文之间通过共享 artifact 和事件流协作——没有中央调度器。

### BC1 · Backlog

管理项目意图。一个故事一棵层级树：Epic → Feature → Story。

**核心概念**：
- 故事有唯一 ID，处于四种状态之一：待办 / 进行中 / 完成 / 暂缓
- 故事之间有依赖边（`depends-on`）
- 状态翻转必须使用精确整行匹配（杜绝子串误伤）

**写规则**：多写并发使用乐观锁——读出全文哈希，修改后写前校验哈希未变，冲突即重试。写操作原子完成。

### BC2 · Loop 编排

这是系统的引擎。一个 Loop 是 agent 会话里的一段连续交付：会话跑 `roll loop go`，逐个 Cycle 推进，直到范围做完、`--max-cycles`/`--for` 到点、死循环熔断跳闸,或被暂停。两次运行之间不会有任何推进,也不会有你没启动过的运行。

**Cycle 生命周期**：选故事（先查租约 `deliveryLease`）→ 路由 agent → 创建隔离工作区 → agent 执行（TCR 循环）→ attest 硬闸 → 送交 PR → AWAITING_MERGE 挂起并释放 loop → pick 下一张卡。交付推进由 Delivery Reconciler 在任意 `roll` 调用时机会性对账完成——不依赖独立 daemon。

**关键约束**：
- 一 Cycle 只做一个 Story。AWAITING_MERGE 后释放 loop，拿下一个；交付由 Delivery Reconciler 对账推进，不 block loop。
- 进程可能被 SIGKILL。下次唤醒时，通过锁龄、心跳、PID 判断孤儿态，安全接管或重做。
- 心跳每 60 秒写入一次。超时无心跳 → 判定死亡并落终态。
- 退出时无条件写入终态。这是硬约束——trap 兜底。
- 连续失败达阈值 → 暂停并告警，等用户决策。不自动换 agent。不无限重试。

**Loop 类型**：
| 类型 | 职责 |
|------|------|
| main | 消费待办，执行完整的 pick→TCR→PR→AWAITING_MERGE→对账 周期（含 Delivery Reconciler 机会性对账） |
| ci | 监控 CI 状态 |
| alert | 消费 ALERT 文件，推送到用户 |

### BC3 · Agent Scope / Role

管理可用的 AI agent 及其角色绑定。领域模型是递归的：

```text
Scope -> Role -> Binding -> Agent -> optional Model
```

**Scope**：`machine` / `project` / `story` / `skill` 等层级使用同一套形状。
Machine Scope 写在 `~/.roll/agents.yaml`，声明本机 Agent Pool、能力和机器级
`supervise`；Project Scope 写在 `.roll/agents.yaml`，绑定项目/Story 默认角色并可
`inherits: machine`。

**Role**：Canonical user-facing role model is **Supervisor / Designer / Builder / Evaluator**。

- Supervisor = control plane：接收 owner 意图、选卡、选执行剖面、观察 cycle、暂停或升级，但不替交付角色写实现或验收结论。
- Designer = design plane：把 idea/problem 收敛成设计、Story spec、evaluation contract，以及执行时的 `role-artifacts/designer/design-contract.md`。
- Builder = implementation plane：只按 Story spec 与 Designer contract 产出代码、文档和证据。
- Evaluator = verification plane：用 fresh session 对 Builder 交付、验收证据、score 和 gates 作独立判断。

角色值保留类型化 scope 形状：`supervise` / `design` / `execute` / `evaluate`。Story 交付通过 `story.design`、`story.execute`、`story.evaluate` 组合成执行剖面；角色之间只用 fresh sessions 和 artifact handoff 协作，不共享原始会话。

**Binding**：角色可以固定到一个 agent，也可以从候选池选择。选择策略是显式、可审计的
（例如 `first-available`、`least-recent`、`seeded-random`、`health-aware`），结果记录 source、trace、
candidates 和 skipped runtime health。

**公平候选池**：静态配置列出公平候选，不因历史 auth/VPN/account/network 事故永久排除
支持的 agent。Designer、Builder、Peer Reviewer 和 Evaluator 从同一个已安装 agent pool 里
选择；selector 可以按 capability、health、parser stability、recent failures、cost 和 story
risk 排序，也可以按 owner 明确策略偏好多样性，但默认不因 agent brand、是否也能监督、或是否
与其他角色同品牌而硬排除。`least-recent` 读 `runs.jsonl` 的近期使用记录公平轮换，避免反复落到
同一个 agent。`health-aware` 保留 pool 可见性，并按近期 auth block、timeout、parser failure、
no-TCR/gave-up、成功交付、成本档位和角色能力标签排序。运行时探活只影响当前 resolution：不可用
候选被记录为 skipped，静态池不被悄悄改写。`roll supervisor route --role <role> --story <id>
[--json]` 暴露 route trace：候选池、ranked score/reasons、warnings、skipped 候选及原因、策略、
近期使用输入、最终 agent 和 source 配置路径。

**Rig lifecycle**：quota、auth、network 和 agent stall 是运行级状态，不回写
`agents.yaml`。loop 把不可用 rig 写入 runtime lifecycle 文件并发出 `rig:suspended` /
`rig:recovered` 事件；挂起 rig 按恢复窗口轻量探活，恢复后自动回到候选池。若当前池全挂起，
cycle 写 `loop:pending`，只做恢复探测，不启动 Builder、不把卡记失败、不触发全局熔断。

**反规则**：不因历史表现自动改写角色绑定。不做失败后的静默跨 agent 重试。指标可以*建议*
策略变更，但绝不绕过 human-on-the-loop。

### BC4 · 交付（Delivery Reconciler）

每次交付是一个 Pull Request。一个 Story 至多同时有一个 open PR。

**最后一公里 = 一个 reconcile 闭环，无独立守护进程。**

#### 交付生命周期

```
building ──attest earned──► publishable ──push+PR──► awaiting_merge ──┐
   │                                                                  │
   └─attest MISSING──► blocked_no_evidence (fail-loud，不推分支)        │
                                                                       ▼
   awaiting_merge ──L1/L2 强信号命中──► delivered / delivered_external
   awaiting_merge ──CI 绿未合──► 自驱合并 (gh pr merge --squash) ──► 下轮判 delivered
   awaiting_merge ──CI 红──► ci_failed ──► fix-forward cycle
   awaiting_merge ──CI 长红(≥24h)──► degraded(ci_stuck)，带 reason+dwell
   awaiting_merge ──draft / 合并冲突 / 缺权限──► degraded(draft|merge_conflict|no_permission)
   awaiting_merge ──PR 被关(未合)──► terminal(pr_closed_unmerged)
   awaiting_merge ──mergeable UNKNOWN / gh 错──► wait（瞬时态，不判）
   awaiting_merge ──同卡他 cycle 已 delivered──► superseded（带原因）
   awaiting_merge ──证据不足──► 留 awaiting_merge（绝不误判）
```

**交付状态**：

| 状态 | 含义 |
|------|------|
| `building` | TCR 进行中 |
| `blocked_no_evidence` | 过了测试但缺 attest/ac-map → fail-loud，未推分支 |
| `awaiting_merge` | 分支+PR 已开；挂起，loop 释放并继续下一张卡 |
| `ci_failed` | PR CI 红 → 需 fix-forward |
| `delivered` | 合进 main：runner 自驱合并 |
| `delivered_external` | 合进 main：外部（supervisor / 人手动合 / 其他 cycle）——patch-id / PR-state 反查确认，一等公民 |
| `superseded` | 同卡另一 cycle 已 delivered |
| `abandoned` | lease 释放 / 卡撤销 |

#### 分层真相判定（强→弱，任一强信号即 delivered）

| 层 | 信号 | 可靠性 | 何时可用 |
|---|---|---|---|
| L1 | **PR 状态**：`gh pr view` → `MERGED`；gh 沉默时离线同源——main 上的 `(#N)` merge commit（无 PR 号的旧 cycle 回退到 subject 含 story-id） | 最强（权威） | gh 可用且 PR 可解析时；离线也可从 main 的 git log 读 |
| L2 | **patch-id 等价**：`git patch-id(diff origin/main...branch)` ∈ main 候选 merge commit 的 patch-id 集 | 强（squash/rebase 安全） | 离线也行；不依赖 gh |
| L3 | **backlog Done + attest 报告存在** | 弱（仅佐证，单独不足） | 兜底交叉验证 |

**判定规则**：`delivered` 需 ≥1 个强信号（L1 或 L2）。L3 单独不足以判 delivered（agent 可能预写 Done）。L1 与 L2 冲突时以 L1 为准并告警。全不命中 → 留 `awaiting_merge`，**绝不误判**。

**边界态判据（US-DELIV-010）**：卡死/终态 PR 不再笼统挂起——`reconcileDelivery` 派生确定性判定：PR 被关（未合）→ `terminal(pr_closed_unmerged)`；draft / 合并冲突 / CI 长红（滞留 ≥ `CI_STUCK_DWELL_MS`=24h，锚定 `delivery:published`）/ gh 缺权限（auth）→ `degraded`，均带 **reason + dwell**（`roll loop reconcile --json` 可读，供呈现与人工分流）；mergeable UNKNOWN、gh 瞬时错误（offline/provider_error/not_found）→ `wait`；分支删除 / force-push 改了 patch-id → L2 自然失效，靠 L1 或 wait；squash 改写标题不影响 patch-id（按 diff 内容计算）。铁律不变：**degraded/terminal 绝不等于 delivered**，draft/冲突/UNKNOWN 也绝不触发自驱合并。

**单一真相引擎（US-DELIV-008）**：`roll loop reconcile` 命令与 `roll loop cycles` 读路径共用同一个纯函数 `reconcileDelivery` + 同一份事实采集（`packages/cli/src/lib/delivery-facts.ts`）。旧 subject-match 探针已退役为 L1 的离线输入信号，不再是并行的第二判据——读路径与命令对同一 cycle 的 delivered 判定永不分歧。

#### Delivery Reconciler

纯判定 + 薄 IO，在任意 `roll` 调用 / cycle 边界 / `roll loop reconcile` 时机会性运行：

- **触发点**：(a) 每次 `roll loop` cycle 边界；(b) 任意 `roll` 命令的前置机会性 reconcile；(c) 显式 `roll loop reconcile [--json]`；(d) CI 里可选一步
- **自驱合并**：CI 绿且未合 → `gh pr merge --squash`，不依赖仓库 auto-merge 开关
- **外部合并反查**：supervisor / 人手动合并被 patch-id / PR-state 自动回填为 `delivered_external`——手动合并是一等支持路径，不是泄漏
- **幂等 & 崩溃可续**：reconcile 反复跑永远安全，向真相收敛
- **无常驻进程**：合并逻辑住在 Delivery Reconciler 里，由驱动交付的那个会话调用

#### 交付判定

合并入 main 才算交付。PR 已开、CI 已绿、agent 声称完成都不算——事后对账，只认 main 上真实的 merge commit。main 是唯一交付真相；reconcile 只把真相投影回 cycle 行。

### BC5 · 演化

追踪一个 Story 的完整生长过程。每一次 TCR 微提交、每一次回退都可追溯。支持对比不同 agent 对同一 Story 的实现，支持回退到任意历史节点。

### BC6 · 策略

解析并执行 `.roll/policy.yaml` 中的人类意图。

**策略类型**：
- 自动合并：满足条件自动 merge PR
- 审查标记：特定文件或层级标记需人审查
- 安全限幅：连续失败 N 次 → 暂停并告警
- 角色绑定：覆盖 scoped role 到 agent/model 的解析
- 网络首检：任何需要网络的命令（`loop go/run`、agent 拉起、showcase、release 开 PR、update）把连通性（含代理）作为第一道检查。不通时跑配置的恢复钩子 `loop_safety.proxy_enable_cmd` 再复检：通了继续，仍不通就立刻停手并给出可操作的中英文原因——绝不带病前进、绝不空转、绝不静默降级。该钩子是用户自填的命令（roll 不内置任何代理工具）；未配置即停手并告知。
  - 探测目标默认是 `github.com:443`（海外路径）。若你的工作流只用国内可直连的服务（如 DeepSeek/Bailian），把探测指向你确实需要的主机：`loop_safety.probe_url: <host:port 或 URL>`（FIX-1025）；这样 VPN 掉线也不会因一个工作流根本不需要的固定海外主机而误停。
  - 完全跳过预检：`loop_safety.skip_network_check: true`（FIX-1025）——当你确认所配置的服务可直连、不希望被任何固定主机探测拦住时使用。
  - English: the precheck defaults to `github.com:443`. For a domestic-only workflow, point it at a host you actually need via `loop_safety.probe_url`, or opt out entirely with `loop_safety.skip_network_check: true` — so a dropped VPN never halts loop/release when every configured provider is directly reachable.
- Warm session 复用：`loop_safety.session_reuse: true` 只表达复用意图；必须同时设置 `loop_safety.resume_scope: same-story` 才会在同一 story 重试时复用 codex session。缺省、非法值或未设置 `resume_scope` 都按 `off` 处理，跨卡复用保持禁用。
- Builder 硬轮换：`loop_safety.builder_no_consecutive_repeat`（默认开）保证任意连续两个 cycle 的 builder agent 不相同——上一个 cycle 的 builder 被从本次 execute 池中硬排除。池缩到只剩上一个 builder 时**失败即声（ALERT + pending）**，绝不静默重复、绝不空转；轮换真正发生时记 `builder:rotation` 事件可审计。设 `builder_no_consecutive_repeat: false` 关闭；仅约束 builder（Evaluator 独立性靠 fresh session，不靠排除品牌）。
  - English: `loop_safety.builder_no_consecutive_repeat` (default on) forbids two consecutive cycles from sharing a Builder — the previous cycle's builder is hard-excluded from the execute pool. If that empties the pool it fails loud (ALERT + pending), never repeating silently; a real rotation records a `builder:rotation` audit event. Set `false` to disable. Builder-only (Evaluator independence comes from fresh sessions, not brand exclusion).

策略是规则源——它不直接执行动作，而是被其他上下文读取并遵循。

### BC7 · 可观测

不可变事件流是唯一的真相源。所有状态都从事件重建，无独立缓存。

#### 三流权威边界（Keystone 契约）

实时可观测收死在三条流的明确边界上——不新建第四条流：

| 流 | 权威级别 | 语义 |
|---|---------|------|
| `events.ndjson` | **唯一持久真相** | 全量结构化 `RollEvent`（原子追加）；所有状态从这里重建。runner 写的事实（`cycle:phase/first_edit/tcr/stdout/end`、`pr:*`、`gate`、`attest`）跨 agent 通用、不可变。 |
| `ActivitySignal` | **投影模型** | 从 `RollEvent` 流派生（`cycleActivitySignalsFromEvents`），是按 tier/seg/summary 归一化的 UI 模型。所有下游渲染（watch 窗口、cycle ledger、未来 Supervisor Live Console）**只消费 `ActivitySignal`**——不做 per-agent 解析。`cycle-<id>.signals.jsonl` 持久化全量信号。 |
| `live.log` | **debug 附件** | Agent stdout 直通记录——不参与判定、不打分、不作为证据。可被截断、可缺失。仅供调试。 |

**单读选择器不变量**：`collectDossierState(cwd) → TruthSnapshot` 是读侧唯一数据归口。页面的 ~18 个面板（agent、On Deck、projects、casting、charter、skills 等）全部走这个快照——页面渲染路径不得绕过它直读文件或单独 collect。来自 US-OBS-016（读侧收口）和 FIX-376/377（幽灵项目/On Deck 计数）的教训：只要存在"第二条读取路径"，漂移就是时间问题。`truth-adapter.ts`（在 `@roll/core`）是选择器的唯一入口。

**持久化文件**：
| 文件 | 内容 |
|------|------|
| `events.ndjson` | 全量事件（每行一个 JSON，原子追加） |
| `runs.jsonl` | 运行摘要（按 story+cycle_id 去重） |
| `heartbeat` | 活性心跳（idle 也写） |
| `cycle-<id>.signals.jsonl` | 每个 cycle 的标准 ActivitySignal 全量持久化 |

**事件类型**：`cycle:start/phase/tcr/end/terminal`、`warm-session:capture/resume-selected/resume-skipped`、`pr:open/merge`、`route:resolve`、`loop:heartbeat/fire/paused`、`policy:safety_pause`、`alert`、`peer:gate`、`attest:gate`、`ci:*`。

#### CLI-first 实时控制台（`roll loop cycle watch`）

主线是 CLI：`roll loop cycle watch [<id>] [--once] [--since <lines>] [--json]` 提供一个进行中 cycle 的**标准 ActivitySignal 流**。不传 id 时自动跟随当前 running cycle。

窗口显示：
- **顶部概要**：cycle id、story id、agent、outcome
- **信号行**（`●` 彩色圆点 + tier/seg/summary）：lifecycle（开始/结束/超时回收）、TCR（每次 test/commit/revert）、gate（peer/attest 闸通过/失败）、stdout（agent 输出摘要）、工具调用（tool_use → tool_result）
- **证据指针**：cycle 结束或 `--once` 时输出 PR/diff/story 链接

信号来自 `events.ndjson` → `cycleActivitySignalsFromEvents()` 或已持久化的 `signals.jsonl`；消费 `tail -F` 跟随，不依赖 daemon。

对非当前 running cycle，`--once` 回放一帧后退出；`--json` 输出机器可读视图。

详见 [实时控制台指南](live-console.md)。

#### 静态导出 vs CLI-first 实时观察

- **实时 CLI**（`roll loop cycle watch`）：直接跟随 `events.ndjson` 或 `signals.jsonl`，不经过外部进程——CLI 窗口在任何时候都是可用的一线视图。
- **状态摘要**（`roll status` / `roll status pulse` / `roll loop runs` / `roll loop cycle <id>`）：从同一选择器读取 backlog、merge truth、cycle history、release readiness 和 story-scoped attest 覆盖率。
- **静态导出**（归档重建）：按需把选择器结果渲染为 HTML archive，以 `file://` 打开。它是一次性快照，适合归档、CI artifact、历史修复和迁移对账；不是当前用户面的活体真相入口。

这些入口共享 `collectDossierState` / `cycleActivitySignalsFromEvents`，但当前产品承诺以 CLI-first 为准。

#### Supervisor Live Board

`roll supervisor live` 是当前已交付的 CLI-first 多角色 board：读取事件流生成 Supervisor pane 与 Designer / Builder / Evaluator role panes。默认模式输出一帧快照；`roll supervisor live --watch` 在交互式终端中原地重绘同一 view model，不追加重复帧，也不写任何 loop/backlog/release/evidence 状态。未来浏览器/TUI 面应复用同一 view model，并遵守以下边界：

- **依赖方向**：浏览器可观测只读消费 `spec` 事件 schema 与 `core` 读侧选择器；loop 不依赖浏览器进程。
- **只读隔离**：观察面不得写入 loop 状态，不得影响 Story delivery 的 TCR、CI、merge 或 attest 闸。
- **角色视图**：未来 board 展示 Supervisor、Designer、Builder、Evaluator、`supervise` / `design` / `execute` / `evaluate` 角色、scope/role/binding 解析、agent/model、runtime skipped candidates 和 story-scoped evidence；它不替代 evaluate 裁定或 owner 决策。
- **fail-loud**：浏览器面只能显示不可用 agent/model 和 skipped runtime facts，不能把替代执行包装成原请求 agent。

#### 远程就绪缝（design-constraint-only，未建）

以下为**设计约束**，写入架构是为了防止未来的"先建后设计"——当前**一条代码都没写**：

- **传输**：默认 `localhost-bind + no-auth` → 未来可切 `network-bind + bearer-token + relay`
- **通道分离**：READ 可观测通道 ⟂ 未来 WRITE/控制通道（独立端口 + 认证，不同安全域）
- **relay 未解**：异步路径借 GitHub 交会点绕过了 NAT（roll-meta repo 作异步 rendezvous）；实时路径没有等价物——"bind 0.0.0.0 + token"只是暴露端口，不解决可达性。relay 是未来真问题，不是这个 sprint 的。
- **不杜撰 API**：未写服务发现、健康检查、连接恢复、reconnect backoff 等协议——留到真实建立时。

#### 异步远程（现有，互补）

实时控制台（CLI watch / future browser live）和 git-snapshot 异步远程（roll-meta + GitHub 作交会点）是**同一选择器、不同发射器**的关系：

- **异步路径**：`roll-meta` 私有 git 仓通过 `commitRollMetadataRepo` 提交 `.roll` 状态快照。远端 agent 读取 roll-meta + GitHub API 感知项目状态——不依赖实时连接。
- **实时路径**：当前产品只交付 `roll loop cycle watch`；未来浏览器实时面必须复用同一标准流，不能重新引入旧 daemon/frame surface。
- **共存**：二者彼此独立、并行不悖。实时路径不做异步远程做的事（跨 NAT 状态同步）；异步路径不做实时路径的事（秒级活信号）。详见 `.roll/features/loop-observability/live-console-design.md` §2.3。

#### 证据按构造（US-OBS-031）

证据从 activity 流 + diff **自动起草**，不再是 builder 手动步骤：

- ac-map（AC→证据映射）从 cycle 活动流（改了哪些文件、跑了哪些命令、通过了哪些闸）和 git diff 自动生成骨架
- 验收 Review Page 由 `roll attest` 从 ac-map + 截图 + 测试输出自动渲染；legacy report alias 仅作迁移兼容
- 截图由 loop runner 的 headless Playwright 自动捕获（声明了 `deliverable_url` 的卡）

这是一个方向声明——US-OBS-031 的实际落地范围以它自己的 spec 为准。架构锚点是：**证据的素材源（activity stream + diff）已经在 BC7 中提供；证据生成路径不从外部另起。**

### BC8 · 成本

归集每个 Cycle 的实际消耗并设闸。

**记录内容**：`(agent, model, 输入 token, 输出 token, 预估成本, 回退次数, 含回退的有效成本)`。

**成本可见,不设自动闸**:上面这些数按 cycle 记账并在 `roll loop status` / 轮次账本里可读,但 Roll 不会因为成本自动降级或暂停 —— 全局兜底是死循环熔断器(连续无进展即停),范围与轮数上限由 owner 每次用 `--max-cycles` / `--for` 显式给。

### BC8.5 · 驱动方式与运行态

Roll 只有一种驱动方式：**agent 会话**。owner 打开会话、跑 `roll loop go`,那个会话就是
Supervisor;它可以把活派给 Delta Team。没有第二种触发方式,也没有任何东西会自行唤醒。

- **范围**由命令给定:`roll loop go`(全部 Todo)、`--epic <name>`、`--cards <id,...>`、
  `--max-cycles N`、`--for <duration>`。同一套 backlog、truth、route profile、execution
  profile、attest evidence、Evaluator 和 release gates 对所有范围一视同仁。
- **运行态**只有两个:`ACTIVE` 与 `PAUSED`。`roll loop pause` 停自主推进,`roll loop resume`
  放开;熔断器也会自动写 PAUSE。显式限定卡片的一次性运行(`roll loop go --cards <id>`)
  在 PAUSED 下仍然执行 —— 那是 owner 当场的决定,不是自主推进。
- **持久化来源**只用已有的 loop/supervisor 状态:PAUSE marker、events/runs/backlog。
  不得新增 `mode.yaml` 之类的第二真相。

**能力边界(如实):** 不开 agent 会话,backlog 不会动。Roll 不装任何定时器,也不在后台
留任何常驻进程。

### BC9 · Supervisor 与执行剖面（v4）

v4 把"一张 Story 怎么交付"和"项目级怎么协调"分成两层。

**执行剖面 / Execution Profile**：一张 Story 的交付按风险/ROI 选最便宜够用的角色流水线，用户不必先想"团队形状"：

- `standard` = Builder（低风险、范围局部、AC 清晰、证据风险低）
- `verified` = Builder -> Evaluator（用户可见 / 需视觉证据 / 历史证据薄弱——靠独立判断而非自评）
- `designed` = Designer -> Builder -> Evaluator（需求模糊 / 跨模块 / 触及 truth·release·路由·状态语义——风险是"做错事"而不仅是"证不出来"）

剖面在 Cycle 开始时选一次并记入 `execution:profile` 事件。角色之间只通过 artifact（`role-artifacts/designer/design-contract.md` / `execute-evidence` / `eval-report.md` + `artifact-manifest.json`）交接，不共享原始会话；每个角色都是 fresh session。`evaluate` 不是单一 `pass/fail`——blocking review、score、attest 是三个分开的契约。evaluate→execute 的修复回合受硬熔断约束（最大轮数、重复 finding 签名、预算、超时），触界即升级。

**攻防结对（Adversarial pairing，`verified` / `designed` 剖面内的 Builder 步）**：在这两个剖面里，Builder 步不再是单个 agent 同时写测试和实现，而是由**循环引擎真正编排**（US-LOOP-100..106，全在 `@roll/core` + CLI runner）：先 spawn 一个 test_author 写红测试 → 再 spawn 一个**异构**的 implementer 只写实现变绿（不得改测试）→ 绿后进入攻防回合（attacker 补破坏性测试 → implementer 修），直到攻不动。终止由纯函数 `adversarialNextStep` 三重独立判定（按优先级 总超时 → 回合上限 → 连续无洞,任一命中即停）保证**无人值守绝不挂死**；任何攻防异常（无异构伙伴 / agent 不可用 / 单回合挂死）经 `adversarialDegradeDecision` **降级回标准单 builder** 完成本卡并记 `adversarial:degraded` 事件——不静默、不死锁。默认参数：`max_rounds=4`、`dry_rounds_to_stop=2`、`total_timeout_sec=2700`。每卡结果（回合数 / 抓洞数 / 终止原因 / 是否降级）折进 runs 行，`roll loop adversarial` 输出攻防 vs 标准 cohort 的只读影子跑聚合，供 owner 用数据决定是否扩大剖面覆盖（设计 §9）。攻防路径**默认休眠**，仅当项目把 `execution_policy.mode` opt-in 到 verified/designed 才启用；`standard` 剖面零变化。

**Supervisor**：项目级协调者，负责不属于某一张具体 Story 的工作——跨 Story/Epic 上下文、backlog 排序、风险分级、执行剖面建议、路由/Rig 建议、预算、并行、卡住的 cycle、重复失败、文件冲突、合并队列、发布就绪、truth coverage / 显式 release blockers、系统级用户交互（"接下来做什么？""为什么卡住？"）与 owner 升级。

Supervisor **绝不**：实现具体 Story、写 Story 的评估报告、覆盖 Evaluator 裁定、绕过 attest 闸、直接标记 Story 为 Done、用指标静默改写路由/策略。v4.0 的 Supervisor 是 observe/advise（`roll supervisor`）：先用确定性 selector 把事实结构化，再（必要时）让 agent 措辞建议；历史 Done 缺少结构化 DeliveryRecord 只作为 truth coverage/backfill 提醒，发布是否阻塞以显式 release blockers / release consistency 为准；持久化策略变更一律需 owner 确认。安全并行调度（`max_parallel_cycles`、文件冲突串行化、合并队列/预算暂停）的决策逻辑已就位，活体并行交付留待 v4.1。

Backlog-clearing 模式下，Supervisor 的默认 scope 是所有 live 且非 Hold 的 `FIX-*`、`US-*`、`REFACTOR-*` 行；不是只扫缺陷修复。`IDEA-*` 只有被 owner 提升为 Story/Fix/Refactor 后才进入执行池。Supervisor 先对账 backlog、依赖、open PR、CI、Evaluator/Scorer、manual-merge gate、近期 cycle 终态、preserved worktree 和 `.roll` meta，再选择下一张卡。每张卡独立 cast Builder；执行剖面需要时独立 cast Designer、Evaluator/Scorer。`gave_up`、zero TCR、缺少 PR/CI/evaluator 证据、解析失败、auth/permission block、`[roll:manual-merge]` PR 或 `.roll` meta drift 都是停止继续调度并要求 owner/根因动作的信号。产品 repo 的 PR/CI/main truth 与 `.roll` meta truth 分开对账和提交。

#### Supervisor Backlog-Clearing Runbook

这是 Supervisor 的项目级操作契约，目标是清空当前 scope 内所有非 Hold 卡，而不是完成某一种卡型。

1. **Scope gate**：每轮开始先重读 live backlog，只纳入 `📋 Todo` / 可执行状态的 `FIX-*`、`US-*`、`REFACTOR-*`；排除 `🚫 Hold`、`✅ Done`、`IDEA-*`、已有 open PR 或 active cycle 的卡。
2. **Truth preflight**：启动下一张卡前必须确认上一轮没有未处理的 PR、红 CI、manual-merge gate、缺失 delivery record、缺失 evaluator/score、`.roll` meta dirty 或 preserved worktree。任一存在就先处理事实差异，不继续派新卡。
3. **One card, one cast**：每张卡 fresh 选择 Builder；`verified` 剖面必须 fresh 选择 Evaluator/Scorer，`designed` 剖面还必须 fresh 选择 Designer。Designer、Builder、Peer Reviewer、Evaluator 可以来自同一 agent pool，但不能共享同一会话；角色链必须写入可读摘要和结构化事件。
4. **Observe while running**：Supervisor 观察 cycle 心跳、TCR 数、builder stdout、peer/score 事件、PR/CI、attest gate 和 role summary；它只监督与分流，不在 Builder 会话里补实现，也不替 Evaluator 改 verdict。
5. **Failure triage before retry**：同一卡失败后先分类根因，再决定下一步。`gave_up`、zero TCR、auth/permission block、解析失败、缺报告、PR/CI 缺席、CI 红、路径/元数据误路由属于 supervisor-blocking，不允许盲目重跑；需要先建卡/修基础设施/换 agent/补权限/人工合并。实现缺口则保留 worktree 证据，换 fresh Builder 或 owner 指定 Builder 继续。
6. **Merge and metadata closeout**：一张卡只有在 PR merged to `main`、CI green、attest/report/role evidence 存在、backlog/spec 状态一致、`.roll` meta 已单独提交并推送后，才算可从 scope 移除。
7. **Continue condition**：只有当上一步 closeout 干净、没有 structural blocker、预算/并行/文件冲突闸允许时，Supervisor 才选择下一张卡。否则进入 guided pause，并给 owner 一个具体下一步命令或待确认动作。

这套 runbook 是 `roll supervisor next/why/live` 的产品标准：CLI 输出应能解释当前卡、当前 cast、为什么继续、为什么停止，以及下一步需要谁做什么。

#### 分支/worktree canary 与安全恢复 / Branch-worktree canary & safe recovery (FIX-1273)

The branch/worktree leak canary (US-LOOP-096) counts every ephemeral branch + every dir under `.roll/loop/worktrees` and PAUSEs the loop over threshold (`ROLL_BRANCH_CANARY_MAX`, default 8). It counts inactive worktrees deliberately preserved for unpublished commits or dirty recovery too — so historical pressure can pause the loop even when nothing is genuinely leaking.

- 触发即枚举 / Auditable trip：canary 触发时,PAUSE marker、ALERT 与 `branch_canary_tripped` 事件枚举出被计数的**每一条** ephemeral branch 与 loop worktree,并附上各 worktree 的审计处置 (disposition),而不是一个裸数字。
- 唯一权威是审计 / Audit is the sole authority：`roll worktree cleanup` 从 `roll worktree audit` 派生动作,**只**移除审计判定为 inactive + merged + clean 的 `disposable_candidate`。它绝不因为 worktree "旧" 或 "被计数" 就删除,也绝不把 canary 计数翻译成批量删除。
- 先演练后执行 / Dry-run first：`roll worktree cleanup --dry-run`(默认)打印被计数的 refs/dirs、审计处置、以及把总数拉回阈值以下所需的**最小**候选集;它绝不改动 git 状态。
- 应用即复核 / Apply revalidates：`roll worktree cleanup --apply` 在**每一次**移除前立刻重跑审计,要求 path + head + inactive + no-tracked-dirt + merged-ancestry + `disposable_candidate` 全部一致,才通过 git 移除该 worktree 并 prune 注册、发出 `worktree_cleanup_applied` 事件。changed head / 新脏 / 缺失 path / 并发激活一律 fail-closed(发 `worktree_cleanup_refused`),绝不改删其它 preserved worktree 作替补。
- 恢复要显式 / Explicit resume：成功清理后,unpublished / dirty / active / external worktree 依旧保留在 canary 账上;操作者确认压力已清除后,显式执行 `roll loop resume` 让 loop 重新派卡。

Preserved（unpublished / dirty / active / external）worktree 永远不会被 cleanup 移除;它们仍计入 canary,是 Truth preflight 里 “preserved worktree” 这一停摆信号的一部分。

#### Retired terms and breaking boundary

`Prime Agent` is a retired active term. `Planner` is a retired active term. `planned` is a retired execution profile, and `planner-contract.md` is a retired active artifact. Historical archives may preserve those words as immutable evidence, but active runtime docs, help, UI, tests, and skills use Supervisor / Designer / Builder / Evaluator.

This taxonomy cleanup is breaking by design. No alias, fallback, or dual-write path is introduced for removed inputs such as `execution_profiles.planned`, `roles.planner`, `execution_policy.mode: planned`, `default_profile: planned`, or active `planner-contract.md` consumption. Manual migration is expected.

> 命名：只用 **Supervisor / Designer / Builder / Evaluator / Agent Scope / Role / Binding / Agent / Model**。核心角色是 `supervise` / `design` / `execute` / `evaluate`。内部命令 `roll supervisor` 与 `Supervisor*` 代码标识符保留，因为它们已经匹配 canonical control-plane role。

#### Delta Team 与 Full Delta Team 交付协议 / Delta Team & Full Delta Team delivery protocol

Roll 有两种有名字的交付拓扑，二者不同，且都不同于健康修复用的 **delivery team**
（`AgentHealthIssue.routing: "delivery_team"` 的 FIX 路由目标——该 health-routing
字面量绝不写作 `delta_team`，拓扑名 `delta-team` / `full-delta-team` 专属拓扑，二者不
混用）。

- **Delta Team**（普通、host-guided）= *当前宿主主会话* 作为**隐式 Supervisor**，加上由
  该宿主 native 能力创建的 **host-native 子会话**担任 Designer → Builder → Evaluator
  角色。宿主（Pi、Cursor…）自行请求并 attest 这些子会话；Roll 从不 spawn、resume 或
  配置任何会话（包括主会话）。Roll 只通过 `roll delta` 管理协议：证据帧、schema 校验、
  事件（`delta:*`）、投影与 fail-closed 闸。
- **Full Delta Team** = *独立编排* 的多 agent / 多宿主拓扑。共用同一协议、artifact 布局、
  事件与角色契约，但通过 Roll 通用 agent 适配器启动各自独立的角色会话。独立 agent/宿主
  永不称作普通 Delta Team。

诚实边界 / Honest boundaries（协议明说，绝不夸大）：

- **终止绑定 = Option C（仅 handoff）。** 结构有效的 Evaluator 报告最多到
  `delta:terminal(handoff_ready)`——不是 Done、不是 merge、不是 attest 裁定、不是
  DeliveryRecord。之后由 owner **手动**走既有 delivery/PR/attest；Roll 不自动绑定，
  也不做 delivery/Done 声明。唯一 Done 终止仍是 Story 路径（`roll attest` 接受证据 +
  合入 `main` 的 PR 对账 + GitHub merge 证据）。
- **宿主 attestation 仅结构校验（structural validation only）。** 只验证宿主提供的
  `hostId` / `roleInstanceId` / `sessionId` / `modelId` 非空、在需要处唯一、且在
  resolution/事件/manifest 间对应。绝不证明会话新起、声明角色/模型被遵守，或模型真的
  执行过。
- **本地 preset = 宿主本地配置。** `~/.roll/delta-team/presets.yaml` 是 machine-local，
  绝不进项目配置、`.roll/agents.yaml`、`.roll/policy.yaml` 或 `@roll/core`。
- **Host-guided 成本不可观测（`? (host_unobservable)`）。** 绝不估算、定价或写零；
  host-guided 委派不写 `runs.jsonl` usage 行、不派生每角色/总成本。

委派总有 Supervisor / Every delegation has a Supervisor：loop 是宿主会话内的 cycle
连续链，与任何交付一样拥有主会话与完整 sub-agent 能力。trigger 轴只有一个取值，
不存在准入禁令——solo / Delta Team / Full Delta Team 三种拓扑对 loop 一律可用。Host-guided
委派不创建 Cycle、`runs.jsonl` 行或 `cycle:terminal`，也不更新 `latest`。本节不引入
daemon 或新状态存储；`events.ndjson` 里的 `delta:*` 事件是 Delegation 聚合的唯一生命周期
真相。完整 host-guided 流程见 `roll-delta-team` 技能与 [ai-agents](../guide/en/ai-agents.md)。

### 上下文协作

```
人（写故事 / 定策略）
    │                          ┌──────────────┐
    ▼                          │ BC6 策略      │
┌──────────┐   Backlog         │ 规则          │
│ BC1      │◄──────────────────│               │
│ 意图管理  │                    └──┬───┬───────┘
└────┬─────┘                      │   │
     │ Todo                       ▼   ▼
     ▼                      ┌──────────────────┐
┌──────────┐  Route 请求     │ BC2 编排          │
│ BC3 路由  │◄───────────────│ pick→TCR→PR→对账 │──cycle:*/heartbeat──┐
└──────────┘──route:resolve─►│                  │                     │
                             └──┬───┬───────────┘                     │
                                │   │ git/PR                          ▼
                          cost  │   ▼                    ┌──────────────────┐
                                ▼  ┌──────────────────┐  │ BC4 交付          │
                           ┌──────────┐               │  │ PR → CI → merge  │
                           │ BC8 成本  │               │  └──────┬───────────┘
                           │ 记录 + 闸 │               │         │ merged
                           └──────────┘               │         ▼
                                                      │     main (真相)
                                                      │         │
  全部事件 append ────────────────────────────────────────────► ┌──────────────────┐
                                                                │ BC7 可观测        │
  ALERT ← loop 写 ← alert loop 推 → 人                           │ 事件流 (唯一源)   │
                                                                │ → BC5 + UI       │
                                                                └──────────────────┘
```

**协作模式**：策略被下游遵从（Conformist）、Backlog 和 git/PR 是共享真相（Shared Kernel）、路由结果写事件（Customer/Supplier）、对账层过滤假交付（Anti-Corruption）、事件追加（Published Language）。loops coordinate via shared artifacts——多 loop 独立、event-driven，互不直接调用。

## 行为合同

以下 12 条不变量定义了系统的可靠性边界。每条必须可测试（与 [specs/harness-principles](specs/harness-principles.md) 的 C1–C12 一一对应，那里有每条的 FIX 证据）。

| # | 不变量 |
|---|--------|
| I1 | 在跑 Cycle 每 ≤60s 写心跳。超 watchdog 阈值必回收并落终态。进程活性 ⟂ 业务健康。 |
| I2 | 任意时刻进程被 SIGKILL，下次重入检测孤儿态并安全接管。不依赖优雅退出。 |
| I3 | 同一 Story 至多一个 open PR。开 PR 前先查去重。 |
| I4 | Backlog 是愿望，main 是真相。每 Cycle 末对账——标了完成但未合并的自动退回。退出码 0 ≠ 已交付，CI 绿 ≠ 已交付。 |
| I5 | 一个坏 Story 不冻结其他工作。连败 N 次 → 永久暂缓。不靠手动干预无限重试。 |
| I6 | 连续失败 → 暂停 + 告警 + 通知，人决策。不自动跨 agent fallback。 |
| I7 | 路径即身份。所有运行态数据放在 `<project>/.roll/loop/`。不同项目并行互不污染，无共享可变状态。 |
| I8 | 状态从不可变事件流重建，无独立缓存。追加原子（tmp→rename）。退出无条件写终态。 |
| I9 | 多写并发用乐观锁。标记 Story 精确匹配，不用子串。 |
| I10 | 按可预测规则路由（任务层级/类型）。spawn 前秒级探活。同输入路由恒定。 |
| I11 | 每 Cycle 记录 `(agent, model, token, cost, 回退次数, 有效成本)`。逼近预算上限 → 降级或暂停并通知。有效成本含回退。 |
| I12 | 一 Cycle 一个 Story，全新上下文，TCR 每步 green-or-revert。0 个 TCR 提交 → 判定失败并告警。 |

## 事实来源(US-TRUTH 系列)

读侧三件套(dashboard / archive / status)不再各自解析 backlog/events/runs:

- **权威矩阵** `packages/spec/src/types/truth.ts`(`TRUTH_ANCHORS`):每个持久事实字段声明唯一权威源、唯一写者、派生视图、冲突仲裁与 unknown 判据。跨仓仲裁:`github_pr_merge > product_main > roll_meta`。
- **终态事件** `cycle:terminal`(schema v1,`TERMINAL_SCHEMA_EPOCH_SEC` 起强制):每字段要么有完整值,要么带枚举化缺失原因——静默 0/"—" 在结构上不可能。
- **选择器** `packages/core/src/truth/selectors.ts`:`deriveStoryTruth / deriveCycleTruth / deriveEvidenceTruth`,纯函数、闭合 reason code;输出 truth/warn/fail/unknown/grandfathered。
- **唯一读侧适配器** `packages/cli/src/lib/truth-adapter.ts`:dashboard 的周期分类、静态归档的 delivered 判定全部经它走选择器;**新增消费者必须走这里,再写一个本地解析就是本 epic 关掉的回归**。unknown 一律渲染为 `?`,绝不静默显示成功。
- **三聚合投影**:Story 判断 backlog 声明与 `main`/验收证据是否一致;Cycle 只认 TerminalOutcome 终态事实;Release 汇总发版闸 verdict 与有效 waiver。README / guide / site 只描述这些目标态语义。
- **claim vs truth**:backlog 的 `✅ Done` 是声明,不是事实源;`main` 合并、证据报告、终态事件、发版闸事件才是事实锚点。所有 UI 投影必须把声明和真相分开呈现。
- **静态归档首页**:归档重建 按需渲染 Story / Cycle / Release tiles 和真相条;未知事实显示 `?`,已知为零才显示 `0`。premature Done 会被标成 drift/fail,不会被当作已交付。它是 archive/repair renderer,不是当前活体真相入口。
- **影子审计**:只读漂移扫描作为 `roll release` 闸的内部模块运行,报告落 `.roll/reports/consistency/`。
- **发版闸**:`roll release` 是唯一发版命令,事务内置一致性闸;任一维 fail 拦截发版,没有豁免路径——修掉漂移才能发。历史 release:waiver 事件仅作存档,不再有写入者。一致性闸跑在**开 PR / 合并之前**(发布分支上 bump+changelog 已提交、未合并),漂移在落 `main` 前就被拦,绝不留"已合并但没打 tag"的半成品。`main` 受 PR 保护,发版给自己也开 PR,再用 GitHub 原生 auto-merge(`gh pr merge --auto --squash`)自驱合并:不依赖 `com.roll.pr.<slug>` 看护 lane,进程中断也由 GitHub 完成合并;等待期逐轮打印进度,CI 不调度时推空提交 nudge;仓库未开 "Allow auto-merge" 则诚实报错而非静默挂死。
- **变更点护栏** `packages/spec/src/types/truth-registry.ts`(`TRUTH_FIELD_REGISTRY`):落盘且被第二处读取的字段必须登记(绑锚点、记写者、derived-cache 必声明 rebuild);未登记字段 CI 红并指路登记——历史 v2 字段 grandfather 列单。局部变量不登记。

### 结构化交付真相 (`DeliveryRecord` / `deliveries.jsonl`)

Backlog 状态格（`✅ Done` / `🔨 In Progress` 等）是**给人看的派生显示**——机器**绝不** parse 它当真相。机器管理的交付生命周期真相是结构化 `DeliveryRecord` 投影，存储在 `.roll/loop/deliveries.jsonl`（可重建 JSONL 缓存）。

**`DeliveryRecord`**（`packages/spec/src/types/delivery.ts`）：
- `storyId` / `cycleId` — 唯一定位一次交付
- `lifecycleState` — 机器派生的生命周期状态（见下一节）
- `prNumber` / `prUrl` / `mergedAt` / `mergeCommit` — PR 事实（`FactOr<T>`，缺失带枚举化原因，非静默零）
- `recordedAt` — 记录写入时间（epoch ms）

**事实来源**：
- `runs.jsonl` — cycle 意图、发布尝试、PR 字段、终态 outcome。
- first-parent `main`/`origin/main` git merge log — `done` 的权威信号；story-id 可出现在 merge subject 或 body。
- `deliveries.jsonl` — 从 runs + git 重建出的缓存，不是独立真相源；删掉后 `ensureDeliveriesFresh()` 会重建。
- `backlog.md` — 人可读声明与派生显示，不能作为机器交付真相。

**写入/重建规则**：Cycle 发 PR 时把 PR 字段写入 run 事实；交付投影由 `ensureDeliveriesFresh()` 幂等重建并覆盖 `deliveries.jsonl`，同一 story 的记录按投影规则 last-wins/merge-wins。PR 合并后的 `done` 以主干 merge 为准，而不是以 agent 自述或 backlog 翻牌为准。

**读取规则**：所有消费者（picker / reconcile / archive / watch）**一律**走 `queryStoryDelivery()`，不读 markdown 状态——见 [唯一查询入口](#唯一查询入口-querystorydelivery)。

### 生命周期与裁定正交

两个维度各自独立——绝不混：

| 维度 | 语义 | 值空间 | 来源 |
|------|------|--------|------|
| **LifecycleState**（生命周期） | 卡**在哪**（管道位置） | `todo` / `building` / `in_flight` / `ci_red` / `blocked` / `on_hold` / `done` / `failed` / `abandoned` | 机器从 `TerminalOutcome` + PR 状态**派生**（`lifecycleFromFacts()`），不手设 |
| **TruthState**（裁定） | claim 是否**对**（校验结果） | `truth` / `warn` / `fail` / `unknown` / `grandfathered` | 选择器 `deriveStoryTruth`/`deriveCycleTruth` 从权威锚点仲裁 |

一张卡可以同时处于 `in_flight`（生命周期：PR 已开）和 `warn`（裁定：backlog 行仍标记 `📋 Todo`，声明滞后）——两个字段独立承载，不互斥、不塌缩。`ci_red` 是 `in_flight` 的 PR 级子状态（CI 挂了但卡仍在飞——修→重推→还 `in_flight`）。

### 唯一查询入口 (`queryStoryDelivery`)

**`queryStoryDelivery(storyId, deliveries) → StoryDeliveryTruth`**（`packages/core/src/truth/query.ts`）是交付真相的**唯一确定性查询函数**。纯函数、零 I/O、零 markdown parse——给定 story ID 和所有 `DeliveryRecord`，返回一个序列化 verdict。

**消费者契约（硬约束）**：
- **picker**（选卡）：跳过 `lifecycleState ∈ {in_flight, ci_red, done, blocked, on_hold}` 的卡
- **reconcile**（对账）：比对 `StoryDeliveryTruth.delivered` 与 backlog 声明
- **archive**（静态归档）：`lifecycleState` + `deliveringCycles` 渲染交付阶段
- **watch / dashboard**（监控）：`TruthState` + 派生 backlog 状态格

**新增消费者必须走 `queryStoryDelivery`**——再写一个本地 markdown 解析、backlog 正则匹配、或 `runs.jsonl` 裸读，就是本 epic 关掉的回归。

**`deriveBacklogStatus(truth) → string`**：从 `StoryDeliveryTruth` 派生 backlog 显示字符串（如 `🔨 In Progress · PR#878`、`✅ Done · merged abc1234`）。backlog 状态格从此是**纯派生视图**——人可读但机器不认。`roll truth query <storyId>` CLI 命令直接调用 `queryStoryDelivery`，输出结构化 verdict。

### 存储裁定：不上 SQLite 当源

真实发生的 3-agent 会审（codex + kimi + pi，2026-06-20）一致否决 SQLite 作权威真相源。理由：

1. **毁 git-native** — SQLite 二进制不可 diff、不可 PR 评审、不可 `git revert` 单行回滚（I8）。
2. **毁 worktree 隔离** — Cycle worktree 各自操作同一个 SQLite 文件 → 需要 WAL 模式 + 文件锁 + 额外并发协议（I7）。
3. **毁可重建性** — 从事件流重建 SQLite 须维护 schema 迁移链；JSONL 按行追加，重建 = `cat events → filter → append`（I8）。
4. **过度工程** — "原子记全 卡↔PR↔🔨" justify 的是**事务性写入边界**（单 writer 一条复合 record 一次原子 append），不必是 DB。单行 JSON 远小于 `PIPE_BUF`（POSIX 保证原子性），一个 `O_APPEND write()` 就够了。

**当前方案**：`deliveries.jsonl` — append-only JSONL，复用已有原子写。SQLite **仅可作未来可重建的派生查询缓存**（每日从事件流重建），永不做真相源。

### 消费者契约总结

```
consumer         input                     output / 行为
────────         ─────                     ─────────────
picker           queryStoryDelivery()      skip if in_flight/ci_red/done/blocked/on_hold
reconcile        queryStoryDelivery()      delivered? vs backlog claim → drift verdict
archive          StoryDeliveryTruth        lifecycle + deliveringCycles → phase UI
watch/dashboard  StoryDeliveryTruth        TruthState + derived backlog status → display
release gate     queryStoryDelivery()      all stories delivered? → gate pass/fail
shadow audit     queryStoryDelivery()      claim vs truth drift → .roll/reports/consistency/
```

`roll release consistency` 的 `truth-live` 维度是该契约的 CI/发版闸：它先运行 `ensureDeliveriesFresh()`，再用 `queryStoryDelivery()` 断言发布增量里的故事确实由结构化投影证明为 `done`，并校验 Done 行上的 PR ref 与投影一致。
