# Roll — AI Agent 支持

Roll 把 AI agent 当作一个按 scope 管理的执行身份池。当前模型是：

```text
Scope -> Role -> Binding -> Agent -> optional Model
```

这个形状在每一层递归复用：Machine 声明能力；Project 继续承载 legacy 仓库绑定；
已注册 Workspace 则固定通过 `machine -> workspace -> story -> skill` casting，Story
或 Skill 可以继续收窄绑定。

## Agent 领域文件

- `~/.roll/agents.yaml` 是 Machine Scope，用来声明本机 agent pool，以及
  `supervise` 这类机器级角色。
- `.roll/agents.yaml` 是 Project Scope，用来绑定项目/Story 角色，例如
  `supervise`、`execute`、`evaluate`。
- `<workspace>/agents.yaml` 是 Workspace Scope，只允许 `roles` 与
  `defaults.story` / `defaults.skill`。它不能声明 agent、model、disabled state 或
  capacity；Workspace runtime 也不会 fallback 到仓库内 Project Scope。

`~/.roll/config.yaml` 仍可作为通用偏好和 legacy migration 输入存在，但它不再是
agent 语义的主配置面。常用命令：

```bash
roll agent                      # 查看 Machine Scope、有效 Project Scope 与已安装 pool
roll agent migrate --dry-run    # 预览 legacy 文件迁移
roll agent migrate              # 写入 roll-agents/v1 文件
roll agent list                 # 查看本机已安装 agent
roll agent readiness [agent]    # 查看机器 readiness
roll agent --workspace <id>     # 只读查看 Workspace 有效 casting 与来源链
```

`roll agent list` 与 `roll agent readiness` 始终是 machine view，不随 cwd 或当前
Workspace 改变。auth/network/quota 等运行时信号只影响本次 trace，不会回写配置。

## 角色

Roll 的 Agent 领域有三个核心角色：

- `supervise` — 项目级协调。guided mode 下可以是你当前对话的 agent；autonomous
  mode 下由 Roll 解析角色并驱动 loop。
- `execute` — 通过选中的 skill 工作流构建或修复 Story。
- `evaluate` — 用 fresh session 评审、打分或检查交付。

**一个跑完的 cycle 里，谁演了哪个角色？** cycle 跑完后，解析出的角色不是要你
从日志里重建的谜题。跑 `roll loop cycle <id> --roles` 就能看清谁是 Builder、谁是
Evaluator，咨询了哪些 peer，以及 gate 采纳了哪一个 score。同一份阵容也写进
`summary.md` / `summary.json`，并内嵌到故事的 Execution Cast 报告块。完整的面见
[Cycle 角色可观测](./loop.md#cycle-角色可观测)。

Project 通常给 Story 设置默认角色绑定：

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

Machine Scope 可以声明 supervisor 和本机 agent pool：

```yaml
schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [supervise, execute, evaluate]
  kimi:
    capabilities: [execute, evaluate]
roles:
  supervise:
    use: codex
capacity:
  global: auto
  default_per_agent: 1
  agents:
    codex: 2
  heartbeat_seconds: 30
  stale_after_seconds: 120
```

## 机器进程容量

`capacity` 是 closed Machine Scope policy；Project 与 Workspace 文件不能声明或扩大
它。`global: auto` 等于所有启用 agent 的 slot 总和。若整个 block 缺失，每个启用的
machine agent 默认一个 slot，global limit 就是这些 slot 的总和。

每个 Builder、test-author、implementer 和 attacker 进程都必须在 spawn 前取得一个
exact-owned lease。per-agent limit 跨 model 与 account/context key 聚合。没有可用 slot
时，cycle 记录中性的 `waiting_capacity`，把 Story 恢复为 Todo，等后续 eligible tick
再试；它不会触发 fallback、Story failure 或 no-progress 计数。当前 acquired/waiting
agent、model 与 retry 状态可用以下命令查看：

```bash
roll loop status --all
```

lease event 只保留 routing identity 与时间信息；auth、quota、network 和 credential
状态不会写入 capacity policy 或 status。

## 公平候选池

静态配置只列出公平候选，不应该因为某次历史 auth、VPN、账号或网络问题永久排除
某个支持的 agent。运行时健康在角色解析或 spawn 时检查：

- 当前不可用的候选只在本次 resolution 中被跳过；
- 跳过原因作为运行时事实记录；
- 静态 pool 保持公平，除非你显式收窄它。

未知或未注册的 agent 名会在配置解析时 fail loud。

`health-aware` 是开放角色 casting 的选择策略。除非 owner policy 显式收窄 pool，
Designer、Builder、Evaluator、Peer Reviewer 都从同一个已安装候选池里可见地选择，
再按近期健康信号、角色能力标签、成功交付、近期使用和成本档位排序。降级候选仍会显示
并带 warning，但不会因为 least-recent 早于健康候选被选中。便宜但较弱的 agent 可以继续
适合聚焦任务，同时在 broad 或高风险 Builder 工作中排到更低。

需要看清本次 casting 时，用 route trace：

```bash
roll supervisor route --role builder --story US-123
roll supervisor route --role evaluator --story US-123 --json
```

trace 会列出每个候选、eligibility、score reasons、warnings、skipped runtime facts、
最终选中 agent、策略和来源 binding。

## Guided Mode 与 Autonomous Mode

Guided mode 下，你可以继续留在当前 agent 窗口里工作。这个会话就是 supervisor
front door：它可以查看 `roll agent`、执行 migration，并通过 CLI 让 Roll 继续。

Autonomous mode 下，你不需要手动打开多个 agent 窗口。loop 会解析 `supervise`、
`story.execute`、`story.evaluate`，再按绑定为各角色 spawn fresh agent session。

## 支持的 Agent

| Agent | CLI 命令 | 备注 |
|-------|----------|------|
| Claude Code | `claude` | Anthropic coding agent。 |
| Kimi CLI | `kimi-code`（旧版：`kimi-cli` / `kimi`） | Moonshot coding agent。 |
| Codex CLI | `codex` | OpenAI coding agent；`openai` 别名解析到 `codex`。 |
| Antigravity | `agy` | Google Antigravity agent；旧 `gemini` 别名解析到 `agy`。 |
| Pi | `pi` | `deepseek` 别名解析到 `pi`。 |
| Reasonix | `reasonix` | DeepSeek 原生 coding agent；需要 `DEEPSEEK_API_KEY`。 |
| Cursor | `cursor-agent` | Cursor headless agent；首日 usage 记录为 `?`，直到其 stdout 提供可解析的 token/cost 输出。 |

Agent 差异只放在一份 profile 里，不散落到下游 runner/gate：

1. 在 `packages/core/src/agent/specs.ts` 增加公开 registry 项。
2. 在 `packages/cli/src/runner/agent-spawn.ts` 增加或更新 runner profile。
3. executor、attest、pairing、scoring 保持 agent-agnostic。
4. 为 profile 与 registry 项补单测。

## Agent 工具链健康（US-V4-022）

Supervisor 把 agent 工具链健康当作协调工作的一部分，而不是留给 owner 的谜团。
它会扫描警告、auth/network 状态、被污染的技能根目录、陈旧的 setup 同步以及
worktree 权限失败，并把它们归类为以下四类之一：

- **auth_block** — "403"、"please run /login"、"Unauthorized" → `pause_for_owner`
- **network_block** — `ECONNREFUSED`、`ETIMEDOUT`、DNS 失败 → `continue`
  （瞬态；loop 会重试或呼吸）
- **setup_skill_root_pollution** — Reasonix 辅助目录警告、skill 缺少 description
  → `create_fix` → 作为 FIX 路由给 delivery team
- **worktree_permission_failure** — worktree 路径上的 `EACCES` / "permission denied"
  → `pause_for_owner`

当信号是 setup/skill-root 污染时，Supervisor **不会**把它标成 auth-blocked，
而是把修复路由到 backlog/delivery team 作为 FIX，而不是让 owner 临时救火。
Supervisor 负责协调和诊断这些问题，但它不会变成 Builder 或 Evaluator，
也不会自动删除全局文件。

```bash
roll supervisor health             # 人类可读的健康面板
roll supervisor health --json      # 机器可读的分类结果
roll supervisor next               # 下一张卡 + agent health 摘要
```

## 旧 Agent 配置迁移

旧项目可能还会有 `.roll/local.yaml agent`、`.roll/pairing.yaml`，或者
`.roll/agents.yaml` 里的 v3 route slots。它们不再是运行时输入。先用
`roll agent migrate --dry-run` 预览一次性迁移，再用 `roll agent migrate`
写入 scoped binding。loop 遇到 v3 route slots 会明确失败，不会悄悄启用第二套配置模型。

## Delta Team 与 Full Delta Team

Roll 区分两种有名字的交付拓扑，二者不可混为一谈，也不要与上面健康修复用的
**delivery team**（FIX 路由目标）混淆。

- **Delta Team**（普通的、host-guided）= *当前宿主主会话* 作为**隐式 Supervisor**，
  加上由该宿主 native 能力创建的 **host-native 子会话**担任 Designer、Builder、
  Evaluator 角色。宿主（Pi、Cursor…）用自己的能力请求并 attest 这些子会话；Roll
  从不 spawn、resume 或配置任何会话，包括你自己的会话。Roll 只通过 `roll delta`
  管理协议本身——证据帧、schema 校验、事件、投影与 fail-closed 闸。
- **Full Delta Team** = *独立编排* 的多 agent / 多宿主拓扑。它共用同一套协议，但通过
  Roll 的通用 agent 适配器启动各自独立的角色会话。独立的 agent/宿主永远不叫普通
  Delta Team。

角色之间只通过命名、带校验和的 artifact 与事件流交接，绝不传递原始会话。Builder 是
唯一的 worktree 写者；Designer、Evaluator、Peer 除自己的 artifact 目录外均只读。Peer
只是 Evaluator 的可选咨询输入，绝不替代 Evaluator。

**诚实边界——这些是协议明说的限制，绝不可夸大：**

- **终止绑定是 Option C，仅 handoff。** 结构上有效的 Evaluator 报告最多只能到
  `delta:terminal(handoff_ready)`。它**不是** Done、不是 merge、不是 attest 裁定、
  也不是 DeliveryRecord。`handoff_ready` 之后由 owner **手动**走既有的
  delivery/PR/attest 流程；Roll 不自动绑定任何东西，也不做 delivery/Done 声明。唯一的
  Done 终止仍是 Story 路径（经 `roll attest` 接受证据；交付由合入 `main` 的 PR 对账）。
- **宿主 attestation 只是结构校验。** `roll delta validate` 只检查宿主提供的 token
  （`hostId`、`roleInstanceId`、`sessionId`、`modelId`）非空、在需要处唯一，且在
  resolution/事件/manifest 间互相对应。它**绝不**证明会话是新起的、声明的角色/模型被
  遵守，或任何模型真的执行过。
- **本地 preset 是宿主本地配置。** 组合偏好放在 `~/.roll/delta-team/presets.yaml`
  （machine-local），绝不进项目配置、`.roll/agents.yaml`、`.roll/policy.yaml` 或
  `@roll/core`。
- **Host-guided 成本不可观测。** 状态渲染 `? (host_unobservable)`；Roll 绝不为
  host-guided 子会话工作估算、定价或写零。

**Loop 准入。** loop 没有隐式的宿主主会话，因此 `loop-autonomous + delta-team` 请求会
被确定性地阻塞为 `host_supervisor_required`——绝不静默转成 solo 或 Full Delta。
`loop-autonomous + full-delta-team` 是显式 opt-in。默认的自主 solo 交付保持不变。完整的
host-guided 流程见 `roll-delta-team` 技能。

## 另见

- [configuration.md](configuration.md) — 配置与策略文件
- [pairing.md](pairing.md) — evaluate role 评审与打分
- [loop.md](loop.md) — 自主模式下的角色解析
