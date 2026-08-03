# roll backlog sync —— 把 GitHub Issues 同步到工作区 backlog

`roll backlog sync` 把 GitHub Issues 拉入一个明确解析出的工作区。它只写规划
产物，不会回写 GitHub。

命令按 `--workspace <ID|路径>`（或 `--ws`）、标准工作区环境、可达 Workspace/Issue
context 或精确 requirement match 解析目标。Active lifecycle 本身绝不能选择与当前
requirement 不匹配的 Workspace。目标歧义、冲突、discovery 不完整、仍处于旧单仓模式，
或路径越出工作区时，都会在任何写入前失败。`--all` 只用于只读聚合，因此 sync 会拒绝它。

## 鉴权

sync 按以下顺序解析 GitHub token：

1. 环境变量或 CI secret 中的 `$GITHUB_TOKEN`。
2. 已执行 `gh auth login` 时使用 `gh auth token`。

两者都不可用时，命令会停止并给出配置指引。

## 快速上手

```bash
# 该工作区首次 sync 必须指定 GitHub 仓库。
roll backlog sync --workspace ws-product --repo seanyao/roll-meta

# 只预览，不写规划产物。
roll backlog sync --workspace ws-product --repo seanyao/roll-meta --dry-run

# 拉取命中任一指定标签的 Issue。
roll backlog sync --workspace ws-product --repo seanyao/roll-meta --label P1,bug

# 后续运行复用该工作区保存的仓库。
roll backlog sync --workspace ws-product
```

当前目录已经能识别工作区时，可以省略 `--workspace`。

## 工作区自有产物

| 产物 | 工作区内路径 |
|---|---|
| 规划索引 | `backlog/index.md` |
| 导入的 Story 契约 | `backlog/backlog-lifecycle/<STORY-ID>/spec.md` |
| sync 配置 | `runtime/backlog-sync.yaml` |

这些路径不能通过旧的 `--backlog`、`--features` 或 `--local-yaml` 参数覆盖。

## 参数

| 参数 | 说明 |
|---|---|
| `--workspace` | 工作区 ID 或绝对路径；省略时使用统一目标解析器。 |
| `--repo` | `owner/repo`；每个工作区首次 sync 必填。 |
| `--dry-run` | 打印计划新增和跳过结果，不写工作区产物。 |
| `--label` | 逗号分隔的标签过滤，可重复；命中任一即可。 |

## 规划身份与状态

第一个识别到的标签决定 Story 类型：

| GitHub 标签 | Story 类型 |
|---|---|
| `bug` | `FIX` |
| `enhancement`、`feature`、`US` | `US` |
| `refactor` | `REFACTOR` |
| 没有识别到的标签 | `US` |

例如 Issue #13 会得到唯一 Story ID `FIX-GH-13`。索引链接、契约目录、契约
标题和命令输出都使用同一个 ID，因此 `roll backlog show FIX-GH-13` 可以直接
打开刚生成的契约。外部标签后续变化时，已有的规划 ID 保持不变。

GitHub 状态不决定 Roll 的规划完成状态。新导入的 open 或 closed Issue 都进入
`📋 Todo`；sync 不覆盖已有规划状态。是否完成仍由 Roll 的交付真相判定。

sync 按 GitHub Issue 编号保持幂等。后续运行会跳过已存在的 Story，并输出
durable 完整 ID：

```text
skipped (already exists): FIX-GH-13
added: 0, skipped: 1, total issues: 1
```

## 每个工作区绑定一个 GitHub source

第一次成功 sync 会在 `runtime/backlog-sync.yaml` 中把该工作区绑定到一个
GitHub `owner/repo` source。后续显式值必须仍指向同一仓库；不同 source 会在
拉取和写入前失败。owner 和仓库名按大小写不敏感比较。

```yaml
backlog_sync:
  repo: seanyao/roll-meta
  direction: issues-to-backlog
  labels: []
  last_sync_at: 2026-07-21T10:00:00Z
```

每个工作区拥有独立的 source 绑定和 sync 时间戳。

## 不支持

一个工作区绑定多个 GitHub Issue source、双向回写、Projects 或 Milestones
映射、PR 关联、非 GitHub provider 和自定义映射规则不属于该命令。
