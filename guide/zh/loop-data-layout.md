# Loop 数据布局（Phase 2.0）

From Phase 2.0 onward, a project's loop runtime data lives inside the project at
`<project>/.roll/loop/`.

从 Phase 2.0 起，项目自己的 loop 运行时数据搬进了**项目目录** `<project>/.roll/loop/`，
不再放在家目录下。只有机器级的绑定文件（launchd runner、attach 脚本）留在
`~/.shared/roll/loop/`。

Move the project, the state moves with it; delete it, the state goes too.

项目挪走，状态跟着走；项目删掉，状态也一起没了。`git status` 和你的 IDE 能在代码
旁边看到 loop 的控制与数据文件。

---

## `<project>/.roll/loop/` 里有什么

What lives in `<project>/.roll/loop/`:

`<project>/.roll/loop/` 里放什么：

| 文件 | 平面 | 内容 |
|------|------|------|
| `state-<slug>.yaml` | 控制 | 当前/最近一次运行：状态、故事 ID、Agent、run_id |
| `ALERT-<slug>.md` | 控制 | 累积的告警（失败、TCR 违规） |
| `PAUSE-<slug>` | 控制 | 暂停标记（由 `roll loop pause` 创建） |
| `mute-<slug>` | 控制 | 项目级 auto-attach 静音标记 |
| `.LOCK-<slug>` | 控制 | 本项目的单实例锁 |
| `heartbeat` | 控制 | 当前 cycle 的存活时间戳 |
| `runs.jsonl` | 数据 | 只追加的运行历史（每次 cycle 一行 JSON） |
| `events.ndjson` | 数据 | 逐 cycle 事件流（phase_start/phase_end…） |
| `cron.log` | 数据 | 旧的聚合 cycle 日志（见下方弃用说明） |

The control plane and the data plane ship independently but both resolve to this
project-local directory.

控制平面（outer runner 在 spawn tmux 之前接触的）和数据平面（inner cycle 脚本写
入的）各自独立演进，但现在都解析到同一个项目本地目录。

---

## Dream 的 cron 日志

`roll-.dream`（代码健康扫描）的 stdout 捕获日志也改为项目本地：

| 服务 | 路径 |
|------|------|
| dream | `<project>/.roll/dream/cron.log` |

以前放在 `~/.shared/roll/dream/cron-<slug>.log`。项目本地后，删项目即
清日志，并发项目也不会互相穿插。

`roll-.dream` (the code-health scan) also writes its stdout capture
project-local:

| Service | Path |
|---------|------|
| dream | `<project>/.roll/dream/cron.log` |

Previously this lived in `~/.shared/roll/dream/cron-<slug>.log`.
Moving it project-local means it is naturally garbage-collected when
the project is deleted, and concurrent projects never interleave.

---

## `~/.shared/roll/loop/` 还剩什么

What is left in `~/.shared/roll/loop/`:

`~/.shared/roll/loop/` 现在只剩：

| 文件 | 为什么留着 |
|------|-----------|
| `run-<slug>.sh` / `run-<slug>-inner.sh` | launchd `WorkingDirectory` / `ProgramArguments` 绑定绝对家目录路径 |
| `attach-<slug>.command` | LaunchServices 双击目标，必须是稳定家目录路径 |
| `worktrees/` | 机器级临时区，非项目本征 |
| `changelog-audit*` | 机器级审计日志 |
| `archived/` | `roll loop gc` 退役 slug 的停车场 |

The global mute switch `~/.shared/roll/mute` also stays in home — it is
machine-wide on purpose.

全局静音开关 `~/.shared/roll/mute`（所有项目、所有自动化活动共享）也留在家目录 ——
它本来就是机器级的。

---

## 跨项目 dashboard

`roll loop runs --all` aggregates per-project files live instead of reading one
machine-wide file.

`roll loop runs --all` 不再读单个机器级的 `runs.jsonl`，而是：

1. Enumerate slugs from launchd plists.
2. Resolve each slug to its project, read its `.roll/loop/runs.jsonl`.
3. Merge with `jq`, sort by timestamp.

1. 从 launchd plist 枚举已安装的 slug。
2. 把每个 slug 解析到它的项目路径，读该项目的 `.roll/loop/runs.jsonl`。
3. 用 `jq` 把所有项目的行归并，按时间排序。

You still get a machine-wide overview, computed live — no central file to drift.

所以你照样能看到机器级总览，只是改为从各项目文件实时聚合 —— 没有会失同步的中心文件。

The cache hook `ROLL_LOOP_RUNS_CACHE_TTL` (default `0`) is reserved for future
use.

可选缓存钩子 `ROLL_LOOP_RUNS_CACHE_TTL`（默认 `0` = 不缓存）为未来预留；目前是实时
聚合。

---

## 家目录遗留文件

The one-time move of control state out of `~/.shared/roll/loop/` into each
project's `.roll/loop/` is over. Roll reads the project-local paths only: no
rewrite on the way in, no fallback to a second location.

把控制状态从 `~/.shared/roll/loop/` 搬进各项目 `.roll/loop/` 的一次性迁移已经结束。
Roll 只读上表里的项目本地路径:cycle 不会在启动时改写路径,也没有第二个位置可回退。

If a project never made the move, copy its files by hand into
`<project>/.roll/loop/`. Leftover `.migrated-*` markers are still reaped by
`roll loop gc`.

如果某个项目从未迁移过，手工把 `state-<slug>.yaml`、`ALERT-<slug>.md`、
`PAUSE-<slug>`、`mute-<slug>`，以及机器级 `runs.jsonl` 里属于它的行，复制进
`<project>/.roll/loop/`。老迁移留下的 `.migrated-*` 标记到期后仍由 `roll loop gc` 回收。

---

## `roll loop gc` — 垃圾回收

`roll loop gc` retires slugs whose project directory no longer exists and sweeps
debris.

`roll loop gc` 退役那些项目目录已不存在的 slug，并清扫迁移/备份残骸。

```bash
roll loop gc                  # 回收孤儿 slug + 残骸（默认保留 30 天）
roll loop gc --dry-run        # 预览将清理什么 —— 不动任何文件
roll loop gc --keep-days 14   # 本次覆盖保留期
```

**What it cleans:**

**它清什么：**

- Orphan slugs → moved to `~/.shared/roll/loop/archived/<slug>-<timestamp>/`,
  launchd plist booted out first.
- `runs.jsonl.tmp.*` write-interrupted leftovers.
- `backup-before-merge-*.tgz` older than 5 days.
- `*.migrated-<ts>` markers older than 7 days.

- 孤儿 slug —— `run-<slug>.sh` / `-inner.sh` / `attach-*.command` 移到
  `~/.shared/roll/loop/archived/<slug>-<时间戳>/`，先 bootout launchd plist。
- `runs.jsonl.tmp.*` 写中断残留。
- 5 天前的 `backup-before-merge-*.tgz`。
- 7 天前的 `*.migrated-<时间戳>` 标记。

**Retention precedence** (highest first): `ROLL_LOOP_GC_RETENTION_DAYS` env >
`loop_gc.retention_days` in `.roll/local.yaml` > default 30 days.

**保留期优先级**（从高到低）：

1. 环境变量 `ROLL_LOOP_GC_RETENTION_DAYS`。
2. `.roll/local.yaml` 里的 `loop_gc.retention_days`。
3. 默认 30 天。

`--dry-run` lists the plan without executing — safe anytime.

`--dry-run` 列出完整计划但不执行 —— 随时可放心运行。

---

## 排查

**Where did my ALERT go?**

**我的 ALERT 跑到哪去了？**

It is now at `<project>/.roll/loop/ALERT-<slug>.md`. Run `roll loop alert` inside
the project.

现在在 `<project>/.roll/loop/ALERT-<slug>.md`。在项目里跑 `roll loop alert`，或直
接打开文件。

**I still have `*.migrated-<timestamp>` files. What are they?**

**我这里还有 `*.migrated-<时间戳>` 文件，那是什么？**

Leftovers from the one-time move to this layout. Nothing writes them any more —
a cycle does not rewrite paths on the way in. `roll loop gc` reaps markers older
than 7 days, so you can also just leave them alone. If you have a project that
never made the move, copy the files to their new paths by hand using the table
above.

这是一次性迁移到当前布局时留下的。现在已经没有任何东西会再写它们 —— 自动迁移随常驻
调度一起退役了，cycle 不再在启动时改写路径。`roll loop gc` 仍会回收 7 天以上的标记，
所以放着不管也可以。如果某个项目从未迁移过，照上面的表把文件手工复制到新路径即可。

See also: [roll loop](loop.md) · [Migration 2.0](migration-2.0.md) · [FAQ](faq.md)

另见：[roll loop](loop.md) · [Migration 2.0](migration-2.0.md) · [FAQ](faq.md)
