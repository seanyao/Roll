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
| `ROLL_LOOP_FORCE` | 未设置 | 设为任意非空值时，把这次运行标记为交互式：cycle 打印可读文本，而不是 JSON 流。没有任何命令会替你设置；在 `roll loop go` 前 export，它会被转发进 tmux worker。它不跳过任何检查：没有活跃窗口检查，PAUSE 只有 `roll loop go --cards <id>` 能绕过。 |
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

## 常见覆盖场景

把 roll 状态钉到项目本地目录（适合 CI、测试、隔离实验）：

```bash
export ROLL_HOME="$PWD/.roll-sandbox"
roll setup
roll loop go --max-cycles 1
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
