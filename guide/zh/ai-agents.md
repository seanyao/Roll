# Roll — AI Agent 支持

Roll 把 AI agent 当作一个按 scope 管理的执行身份池。当前模型是：

```text
Scope -> Role -> Binding -> Agent -> optional Model
```

这个形状在每一层递归复用：Machine 声明本机有哪些 agent，Project 绑定项目和
Story 的角色，Story 或 Skill 可以在需要时进一步收窄绑定。

## Agent 领域文件

- `~/.roll/agents.yaml` 是 Machine Scope，用来声明本机 agent pool，以及
  `supervise` 这类机器级角色。
- `.roll/agents.yaml` 是 Project Scope，用来绑定项目/Story 角色，例如
  `supervise`、`execute`、`evaluate`。

`~/.roll/config.yaml` 仍可作为通用偏好和 legacy migration 输入存在，但它不再是
agent 语义的主配置面。常用命令：

```bash
roll agent                      # 查看 Machine Scope、有效 Project Scope 与已安装 pool
roll agent migrate --dry-run    # 预览 legacy 文件迁移
roll agent migrate              # 写入 roll-agents/v1 文件
roll agent list                 # 查看本机已安装 agent
```

## 角色

Roll 的 Agent 领域有三个核心角色：

- `supervise` — 项目级协调。就是你当前对话的那个 agent 会话：它驱动 loop，
  并可以把其它角色派出去。
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
```

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

## 一个会话，多个角色

你继续留在已有的那个 agent 窗口里工作。这个会话就是 supervisor front door：
它可以查看 `roll agent`、执行 migration，并通过 CLI 驱动 loop。

你不需要为每个角色开一个窗口。cycle 需要 `story.execute` 或 `story.evaluate` 时，
loop 解析绑定并为该角色 spawn 一个 fresh agent session —— 而你所在的会话始终是
那个做协调的。

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

Builder 完成最后一次 green TCR 提交后、进行唯一一次正式 Builder 校验前，运行
`roll delta preflight --delegation <id> --stage builder --json` 做只读自检：它使用与正式校验
相同的结构检查（prepared 上下文、受管工作区身份与分离 HEAD、manifest 与产物校验和、
路径包含、身份/attestation、Builder 证据格式），但不追加任何事件，也不改动
lease/帧/工作区/检查点。失败的预检只是本地诊断，Builder 可在同一委派/帧内修复。它不产生
生命周期成功，也不证明模型执行；它绝不替代正式 fail-closed 校验或独立 Evaluator。把 JSON
输出保存在受管帧之外，随后传给 `roll delta validate --delegation <id> --stage builder
--preflight-receipt <path>`。正式门会把收据与新读取的 heads 和产物字节逐一比对后才推进委派；
收据缺失、格式损坏、过期或不匹配时不写任何生命周期事件，Builder 可以重新预检。

**Builder 交接示例：**`预检失败 → 在同一帧修复 → 预检通过 → 正式 validate`。例如 Builder
证据文件缺失会令预检失败；Builder 在当前帧补齐文件后重跑预检，只有通过后才将收据交给唯一一次
正式 validate。这是本地修复，不是正式 blocked delegation，也不表示自动重试或 fallback。

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

**委派总有 Supervisor。** loop 是宿主会话内的 cycle 连续链——它有主会话、有完整的
sub-agent 能力，与你手动驱动的交付毫无二致。trigger 轴只有一个取值，也不存在准入禁令：
solo、Delta Team、Full Delta Team 三种拓扑对 loop 一律可用。完整流程见 `roll-delta-team` 技能。

## 另见

- [configuration.md](configuration.md) — 配置与策略文件
- [pairing.md](pairing.md) — evaluate role 评审与打分
- [loop.md](loop.md) — 自主模式下的角色解析
