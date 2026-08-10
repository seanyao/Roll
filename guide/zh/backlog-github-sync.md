# roll backlog sync —— 把 GitHub Issues 同步进 backlog

`roll backlog sync` 从 GitHub 仓库拉取 issues,写进本地
`.roll/backlog.md`。v1 是单向的(issues → backlog),不回写 GitHub。

`roll backlog sync` pulls GitHub issues into your local backlog
(one-direction in v1).

## 鉴权

sync 按以下顺序解析 GitHub token:

1. `$GITHUB_TOKEN` —— 在环境变量或 CI secret 里设置。
2. `gh auth token` —— 跑过 `gh auth login` 后回退到 GitHub CLI。

两者都没有时命令会停下来,并提示怎么设置。

```bash
export GITHUB_TOKEN=ghp_xxx
# 或者用 GitHub CLI:
gh auth login
```

## 快速上手

```bash
# 首次 sync 必须显式指定仓库:
roll backlog sync --repo seanyao/roll-meta

# 只预览,不写文件:
roll backlog sync --repo seanyao/roll-meta --dry-run

# 只拉带指定标签的 issue(命中任一即可,OR 语义):
roll backlog sync --repo seanyao/roll-meta --label P1,bug

# 首次成功后会记住仓库,之后可以省略 --repo:
roll backlog sync
```

## 参数

| 参数         | 说明 |
|--------------|------|
| `--repo`     | `owner/repo`。首次 sync 必填,之后从配置读取。 |
| `--dry-run`  | 计算并打印差异,但不改动 `.roll/backlog.md`。 |
| `--label`    | 逗号分隔的标签过滤,可重复;命中任一即匹配(OR)。 |

## label → type 映射

issue 的标签决定 backlog 类型前缀。第一个命中的标签生效;都不命中
时默认 `US`。

| GitHub 标签                  | Backlog 类型 |
|-----------------------------|--------------|
| `bug`                       | `FIX`        |
| `enhancement` / `feature` / `US` | `US`    |
| `refactor`                  | `REFACTOR`   |
| (无匹配标签)                | `US`         |

issue 状态映射到状态列:`open` → `📋 Todo`,`closed` → `✅ Done`。
issue 标题作为行描述。

## ID 与幂等

每个 issue 得到稳定的 backlog id `GH-<编号>`(例如 issue #13 →
`GH-13`),再与类型前缀组合(`US-GH-13`、`FIX-GH-13`)。

sync 是幂等的:二次运行会跳过 backlog 里已存在 id 的 issue —— 不覆盖
已有行的状态或描述,并打印 `skipped (already exists): GH-13`。每次运行
结尾给出汇总:

```
added: 2, skipped: 5, total issues: 7
```

`--dry-run` 用 `+`(将新增)和 `=`(将跳过)标记打印同样的差异,且
永不改动文件。

## 配置:`.roll/local.yaml`

一次真正成功的 sync 之后,解析出的仓库、标签和时间戳会被持久化,后续
运行可省略 `--repo`:

```yaml
backlog_sync:
  repo: seanyao/roll-meta
  direction: issues-to-backlog
  labels: []
  last_sync_at: 2026-05-28T10:00:00Z
```

| 字段            | 含义 |
|-----------------|------|
| `repo`          | 无 flag 时的默认 `owner/repo`。 |
| `direction`     | v1 始终是 `issues-to-backlog`。 |
| `labels`        | 默认标签过滤;显式 `--label` 会覆盖它。 |
| `last_sync_at`  | 上一次成功 sync 的时间戳。 |

显式 flag 始终覆盖配置。若 `.roll/local.yaml` 没有 `backlog_sync:` 块,
首次 sync 必须传 `--repo`。

## v1 不做

双向回写、Projects/Milestones 映射、PR 关联、非 GitHub 平台、自定义
映射规则,均不在 v1 范围内。
