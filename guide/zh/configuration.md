# Roll — 配置

Roll 在启动时解析三个环境变量。在运行 `roll` 之前覆盖任意一个，
就能改变它查找状态、技能和共享约定的位置。

## 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `ROLL_HOME` | `~/.roll` | 单用户状态根目录。存放 `config.yaml`、已安装的 `skills/`、同步的 `conventions/`。 |
| `ROLL_CONFIG` | `$ROLL_HOME/config.yaml` | 编辑器、loop/dream/brief 调度时间、单工具（`ai_*`）配置。Agent 路由不在这里，而在项目内 `.roll/agents.yaml`（见 [ai-agents.md](ai-agents.md)）。 |
| `ROLL_GLOBAL` | `$ROLL_HOME/conventions/global` | 全局约定文件（`AGENTS.md`、`CLAUDE.md` 等），同步到各 AI 工具目录。 |
| `ROLL_LANG` | 未设置 | 当前进程的用户表面语言覆盖。支持 `en` 与 `zh`；未设置时使用已保存配置或系统语言探测。 |
| `ROLL_HEARTBEAT_TIMEOUT` | `1800`（秒） | loop runner 认定 inner cycle 已成孤儿、需要 heal state 的心跳静默阈值。如果你的 cycle 合理静默时间超过 30 分钟，可调大此值。 |
| `ROLL_LOOP_FORCE` | 未设置 | 设为任意非空值时，`roll loop` 会跳过活跃窗口和 pause 文件检查。`roll loop now` 和 `roll loop test` 内部已自动设置；只有当你希望 cron 定时调度也忽略静默时段时，才需要手动 export。 |
| `ROLL_LOOP_NO_HEAL` | `0` | 设为 `1` 关闭构建完成后的 CI 自愈，恢复 fail-fast。调试或想给自主循环按周期省钱时使用。 |
| `ROLL_LOOP_HEAL_MAX` | `2` | 故事提交落地后，CI 自愈的最大尝试次数。CI 抖动较多时可调大；想更快失败则调小。 |
| `ROLL_PR_MERGE_TIMEOUT` | `600`（秒） | **已弃用（US-AUTO-044）。** 主 loop 不再等合并；符合条件的 PR 由 Delivery Reconciler 按机会推进。 |
| `ROLL_LOOP_NO_POPUP` | 未设置 | 设为任意非空值时，runner 在 macOS 下不再自动弹出 Terminal.app 窗口运行 `tmux attach`。供测试和后台跑批使用——窗口在 tmux session 结束后会留下空 attach 提示，污染桌面。 |
| `ROLL_LOOP_GC_RETENTION_DAYS` | `30` | 覆盖 `roll loop gc` 的保留天数。优先级高于 `.roll/local.yaml` 中的 `loop_gc.retention_days`。 |
| `ROLL_FEED_BUDGET_BYTES` | `16384` | 每个周期交给内层 agent 的上下文 feed 字节预算。设为正整数即可调节容量；非数字或非正数回落默认值。 |
| `ROLL_AGENT_NUDGE` | `1`（开启） | 兼容期的 agent 偏好开关。新模型优先通过 scoped role binding 选择候选；设为 `0`（或 `off`/`false`/`no`）关闭历史偏好。 |
| `ROLL_SKIP_CAPTURE_INSTALL` | 未设置 | 设为 `1` 时，跳过 npm postinstall 和 setup 修复里的 macOS `Roll Capture.app` 尽力安装。 |
| `ROLL_RUN_DIR` | 未设置 | 验收证据 run 目录的标准入口。loop runner 在 agent 启动前设置；`roll attest --run-dir` 与独立 `roll attest` 也会读取它。 |
| `ROLL_EVIDENCE_DIR` | 从 `ROLL_RUN_DIR` 派生 | 已打开证据框中的原始命令/测试产物目录。通常由 runner 或 `roll test` 设置，不需要手写。 |
| `ROLL_SCREENSHOTS_DIR` | 从 `ROLL_RUN_DIR` 派生 | 已打开证据框中的视觉证据目录。通常由 runner 或截图通道设置，不需要手写。 |

`ROLL_CONFIG` 和 `ROLL_GLOBAL` 都派生自 `ROLL_HOME`，所以通常只需覆盖
`ROLL_HOME` 即可一并搬迁。

## 工作区注册表

`roll workspace` 管理 `$ROLL_HOME/workspaces.json` 机器注册表和
`$ROLL_HOME/workspace-events.ndjson` 追加式生命周期事件流。系统不存在全局
current Workspace：每次生命周期变更都必须显式指定一个 ID 或路径，
`list --all` 只读；多个已注册工作区可以同时处于 active。

先在目标根目录之外创建 versioned init config，预览所有路径、注册表和机器缓存决策，
再应用完全相同的配置：

```yaml
schema: roll.workspace-create/v1
id: ws-demo
root: ~/.roll/workspaces/ws-demo
display_name: Demo Workspace
requirements:
  - provider: jira
    ref: SOT-15499
repositories:
  - alias: product
    source: git@example.test:team/product.git
    integration_branch: main
```

```bash
roll workspace create ws-demo --config /absolute/path/workspace-create.yaml --check
roll workspace create ws-demo --config /absolute/path/workspace-create.yaml
```

`--check` 不产生任何写入。Apply 会先写 repair journal，再创建 durable layout；bare
cache 只能创建或复用于 `$ROLL_HOME/repos/`，注册表最后提交，Workspace 内绝不创建常驻
product checkout。相同配置可幂等重跑。

```bash
roll workspace register ws-demo /absolute/path/to/workspace
roll workspace activate ws-demo
roll workspace list --json
roll workspace show ws-demo
roll workspace pause ws-demo
```

查询结果会把注册表/清单一致性与生命周期分开呈现。在工作区调度器表面尚未安装前，
runtime health 会诚实显示为 `unknown`，原因是 `scheduler_not_available`。

### 需求来源采集

采集前必须先在 `workspace.yaml` 声明 Requirement source。命令只读取本地文件；
Jira 与 GitHub 标识只用于来源身份，不会触发 provider 网络调用，也不读取凭据：

```bash
roll workspace requirement add \
  --workspace ws-demo \
  --provider jira \
  --ref SOT-15499 \
  --revision 42 \
  --body-file /absolute/path/SOT-15499.md \
  --context-root /absolute/path/context \
  --context acceptance.md \
  --story US-WS-007
```

命令会在 containment 与 symlink 检查后复制有界的普通上下文文件。每份原始采集都以
不可变形式保存在
`requirements/<provider>/<requirement-id>/revisions/rev-<digest>/`；完全相同的
重复采集零写复用，新 revision 会保留旧字节。`source.yaml` 是原子提交的当前索引；
根级 `requirement.md`、`context/` 与 `attest.md` 都是可重建投影。在采集阶段，
`attest.md` 只把关联 Story 列为 pending，并声明 Issue 自有证据才是权威；它不会读取或
汇总 `issues/` 下的交付证据。若当前投影缺失、陈旧或不安全，采集会直接失败且不会自动
修复；Workspace 诊断与修复属于独立动作。

### Issue 初始化

`roll workspace issue init` 解析一个 Story 的 Contract（Story `spec.md` frontmatter 中的
`repositories:` 块，该 spec 须位于所选工作区自身的 `backlog/**/<story-id>/spec.md` 树内——
绝非调用方 cwd）、工作区的仓库绑定与其关联的 Requirement 来源，然后为该 Story
创建、复用或修复其 Issue——每个声明的仓库目标各对应一份 manifest 与一个 worktree：

```bash
roll workspace issue init US-WS-008 --workspace ws-demo --check --json
roll workspace issue init US-WS-008 --workspace ws-demo --json
```

`--check` 零文件系统写入（含机器级 Roll Home 缓存）地完整解析每个声明目标的仓库缓存与
真实 git worktree 身份，返回每个目标的别名、访问模式、repoId、缓存路径与状态、base SHA、
worktree 路径、工作分支与 create/reuse/repair/conflict 决策。Apply 会先用真实的机器级
Roll Home（`~/.roll/repos`，绝非工作区相对缓存）解析每个目标的仓库缓存，再创建或变更
Issue root：不可变的 `roll.issue/v1` manifest（仅 schema/workspaceId/storyId/requirements/
repositories——不含任何运行时 SHA/路径/分支）、每个目标各一条携带 repoId、别名、访问模式、
base SHA、worktree 路径与工作分支的 append-only `issue:repository_bound` 事件，以及以每个
目标缓存的 base SHA 为根的 `issues/<story-id>/<alias>` worktree。可写目标从仓库绑定的
`workflow.branchPattern` 渲染出唯一分支；只读目标以 detached 方式创建、无本地分支，绝不
被表示为可写的交付腿。同一工作区/Story 身份下 requirements、repositories 或 access 发生
变化会以零变更失败 `manifest_conflict`。若后续目标的 worktree add 真的失败，已应用的干净
新建目标会经由 `git worktree remove` 回滚（既有或脏的 worktree 始终被保留，绝不强制删除），
并写入修复 journal；失败后重跑会恢复并修复同一个 Issue 身份，不会重复创建 worktree、分支
或事件。

## 常见覆盖场景

把 roll 状态钉到项目本地目录（适合 CI、测试、隔离实验）：

```bash
export ROLL_HOME="$PWD/.roll-sandbox"
roll setup
roll loop now
```

不动 `~/.roll`，用另一套约定运行 roll：

```bash
ROLL_GLOBAL=/path/to/team-conventions roll init
```

用一次性配置文件验证通用配置改动时，可以设置 `ROLL_CONFIG`；Agent 语义请通过
`~/.roll/agents.yaml` 与 `.roll/agents.yaml` 管理，并用 `roll agent` 查看解析结果。

## 语言选择

语言有两层控制：

- `ROLL_LANG=en|zh` 只覆盖当前进程，并且优先于已保存配置。
- `roll config lang en|zh` 把偏好写入 Roll 配置；`roll config lang --reset`
  清除偏好，重新使用系统语言探测。

`roll help --lang en|zh <topic>` 可临时切换帮助和指南语言。
`roll doctor language` 会审计活跃文档、约定、skills 与生成表面的语言漂移。
CLI 语言快照维护在 `packages/cli/test/cli-language-surface.test.ts` 和
`packages/cli/test/__snapshots__/cli-language-surface.test.ts.snap`；审计表面由
`packages/cli/test/doctor-language.test.ts` 覆盖。

用户可见表面仍一次只显示一种语言。Agent 契约、代码、git 元数据和稳定 schema key 保持英文；
面向 owner 的对话跟随当前任务里 owner 使用的语言。

## 项目策略

项目内安全策略放在 `.roll/policy.yaml`。验收证据闸默认是 `hard`：带 AC 的
story 要有新鲜且内容充足的 attest 报告，才允许标成 `✅ Done`。

```yaml
loop_safety:
  attest_gate: hard
```

只有显式迁移窗口才应使用 `attest_gate: soft`。soft 模式保留审计记录和告警，
但不阻塞本轮交付。

自动选卡还有一层 advisory 语义排序。它默认开启，也可以显式关闭：

```yaml
pick:
  semantic_ranking: off
```

开启后，Roll 只在 backlog / candidate hash 变化时让默认 agent 排序一次，并把结果
缓存到 `.roll/loop/pick-ranking.json`；最终仍由既有 picker gates 决定能不能选。
如果 agent 超时或返回坏 JSON，Roll 记录 `harness_failure` 并回落到确定性顺序。

## 验证

`roll status` 会打印解析后的路径，便于确认覆盖是否生效；
通过 `$roll-doctor` 技能可以诊断解析后的 `ROLL_HOME` 下的目录结构问题。

## Agent 安装

先安装 agent CLI，再通过 scoped agent 文件声明或绑定：`~/.roll/agents.yaml` 是
Machine Scope，`.roll/agents.yaml` 是 Project Scope。例如：

- Codex CLI：`npm install -g @openai/codex`
- Antigravity CLI：`npm install -g @antigravity/agy`

运行 `roll agent` 查看有效 scope；运行 `roll agent migrate --dry-run` 预览旧 agent
配置迁移。完整模型和支持列表见 [ai-agents.md](ai-agents.md)。

## 相关文档

- [overview.md](overview.md) — 三层模型、BACKLOG 优先级
- [loop.md](loop.md) — `roll loop` 子命令
- [ai-agents.md](ai-agents.md) — 支持的 AI Agent
