# Loop Data Layout (Phase 2.0)

Starting with Phase 2.0, a project's own loop runtime data lives **inside the
project** at `<project>/.roll/loop/`, not under your home directory. Only the
machine-level binding files (launchd runners, attach scripts) stay in
`~/.shared/roll/loop/`.

从 Phase 2.0 起，项目自己的 loop 运行时数据搬进了**项目目录** `<project>/.roll/loop/`，
不再放在家目录下。只有机器级的绑定文件（launchd runner、attach 脚本）留在
`~/.shared/roll/loop/`。

This means: move the project, the state moves with it. Delete the project, the
state goes too. `git status` and your IDE can see the loop's control and data
files alongside your code.

也就是说：项目挪走，状态跟着走；项目删掉，状态也一起没了。`git status` 和你的
IDE 能在代码旁边看到 loop 的控制与数据文件。

---

## What lives in `<project>/.roll/loop/`

What lives in `<project>/.roll/loop/`:

`<project>/.roll/loop/` 里放什么：

| File | Plane | Content |
|------|-------|---------|
| `state-<slug>.yaml` | control | Current/last run: status, story, agent, run_id |
| `ALERT-<slug>.md` | control | Accumulated alerts (failures, TCR violations) |
| `PAUSE-<slug>` | control | Pause marker (created by `roll loop pause`) |
| `mute-<slug>` | control | Per-project auto-attach mute marker |
| `.LOCK-<slug>` | control | Single-runner lock for this project |
| `heartbeat` | control | Liveness timestamp for the running cycle |
| `runs.jsonl` | data | Append-only run history (one JSON line per cycle) |
| `events.ndjson` | data | Per-cycle event stream (phase_start/phase_end, …) |
| `cron.log` | data | Legacy aggregate cycle log (see deprecation note below) |

The control plane (what the outer runner touches before spawning tmux) and the
data plane (what the inner cycle script writes) ship independently, but both now
resolve to the same project-local directory.

控制平面（outer runner 在 spawn tmux 之前接触的）和数据平面（inner cycle 脚本写
入的）各自独立演进，但现在都解析到同一个项目本地目录。

---

## Dream cron logs

`roll-.dream` (the code-health scan) also writes its stdout capture
project-local:

| Service | Path |
|---------|------|
| dream | `<project>/.roll/dream/cron.log` |

Previously this lived in `~/.shared/roll/dream/cron-<slug>.log`.
Moving it project-local means it is naturally garbage-collected when
the project is deleted, and concurrent projects never interleave.

`roll-.dream`（代码健康扫描）的 stdout 捕获日志也改为项目本地：

| 服务 | 路径 |
|------|------|
| dream | `<project>/.roll/dream/cron.log` |

以前放在 `~/.shared/roll/dream/cron-<slug>.log`。项目本地后，删项目即
清日志，并发项目也不会互相穿插。

---

## What is left in `~/.shared/roll/loop/`

What is left in `~/.shared/roll/loop/`:

`~/.shared/roll/loop/` 现在只剩：

| File | Why it stays |
|------|--------------|
| `run-<slug>.sh` / `run-<slug>-inner.sh` | launchd `WorkingDirectory` / `ProgramArguments` bind to absolute home paths |
| `attach-<slug>.command` | LaunchServices double-click target; must be a stable home path |
| `worktrees/` | machine-scoped scratch, not project-intrinsic |
| `changelog-audit*` | machine-level audit log |
| `archived/` | `roll loop gc` parking lot for retired slugs |

`~/.shared/roll/mute` (the global mute switch shared across all projects and all
autonomous activity) also stays in home — it is intentionally machine-wide.

`~/.shared/roll/mute`（所有项目、所有自动化活动共享的全局静音开关）也留在家目录 ——
它本来就是机器级的。

---

## Cross-project dashboard

`roll loop runs --all` no longer reads one machine-wide `runs.jsonl`. Instead it:

`roll loop runs --all` 不再读单个机器级的 `runs.jsonl`，而是：

1. Enumerates installed slugs from launchd plists.
2. Resolves each slug to its project path, reads that project's
   `.roll/loop/runs.jsonl`.
3. Merges every project's rows with `jq` and sorts by timestamp.

1. 从 launchd plist 枚举已安装的 slug。
2. 把每个 slug 解析到它的项目路径，读该项目的 `.roll/loop/runs.jsonl`。
3. 用 `jq` 把所有项目的行归并，按时间排序。

So you still get a machine-wide overview, computed live from per-project files —
no central file to drift out of sync.

所以你照样能看到机器级总览，只是改为从各项目文件实时聚合 —— 没有会失同步的中心文件。

The optional cache hook `ROLL_LOOP_RUNS_CACHE_TTL` (default `0` = no cache) is
reserved for future use; aggregation is live today.

可选的缓存钩子 `ROLL_LOOP_RUNS_CACHE_TTL`（默认 `0` = 不缓存）为未来预留；目前是
实时聚合。

---

## Legacy home-directory files (migration retired)

The one-time move of control state out of `~/.shared/roll/loop/` into each
project's `.roll/loop/` is over. Roll reads the project-local paths in the table
above and nothing else: a cycle does not rewrite paths on the way in, and there is
no fallback to a second location.

把控制状态从 `~/.shared/roll/loop/` 搬进各项目 `.roll/loop/` 的一次性迁移已经结束，
Roll 只读上表里的项目本地路径:cycle 不会在启动时改写路径,也没有第二个位置可回退。
Roll 只读上表里的项目本地路径。

If a project never made the move, copy its files by hand — `state-<slug>.yaml`,
`ALERT-<slug>.md`, `PAUSE-<slug>`, `mute-<slug>`, and its rows from the
machine-wide `runs.jsonl` — into `<project>/.roll/loop/`.

如果某个项目从未迁移过，手工把 `state-<slug>.yaml`、`ALERT-<slug>.md`、
`PAUSE-<slug>`、`mute-<slug>`，以及机器级 `runs.jsonl` 里属于它的行，复制进
`<project>/.roll/loop/`。

Leftover `.migrated-*` and `runs.jsonl.migrated-*` markers from the old migration
are still reaped by `roll loop gc` once they age out (see below), so an upgraded
machine cleans itself up.

老迁移留下的 `.migrated-*` 和 `runs.jsonl.migrated-*` 标记到期后仍由 `roll loop gc`
回收（见下），升级过的机器会自己清干净。

---

## `roll loop gc` — garbage collection

`roll loop gc` retires slugs whose project directory no longer exists, and
sweeps migration/backup debris.

`roll loop gc` 退役那些项目目录已不存在的 slug，并清扫迁移/备份残骸。

```bash
roll loop gc                  # GC orphan slugs + debris (default: keep 30 days)
roll loop gc --dry-run        # Preview what would be removed — touches nothing
roll loop gc --keep-days 14   # Override retention for this run
```

**What it cleans:**

**它清什么：**

- Orphan slugs — `run-<slug>.sh` / `-inner.sh` / `attach-*.command` are moved to
  `~/.shared/roll/loop/archived/<slug>-<timestamp>/`; the launchd plist is
  booted out first.
- `runs.jsonl.tmp.*` write-interrupted leftovers.
- `backup-before-merge-*.tgz` older than 5 days.
- `*.migrated-<ts>` markers older than 7 days.

- 孤儿 slug —— `run-<slug>.sh` / `-inner.sh` / `attach-*.command` 移到
  `~/.shared/roll/loop/archived/<slug>-<时间戳>/`，先 bootout launchd plist。
- `runs.jsonl.tmp.*` 写中断残留。
- 5 天前的 `backup-before-merge-*.tgz`。
- 7 天前的 `*.migrated-<时间戳>` 标记。

**Retention precedence** (highest first):

**保留期优先级**（从高到低）：

1. `ROLL_LOOP_GC_RETENTION_DAYS` environment variable.
2. `loop_gc.retention_days` in `.roll/local.yaml`.
3. Default: 30 days.

1. 环境变量 `ROLL_LOOP_GC_RETENTION_DAYS`。
2. `.roll/local.yaml` 里的 `loop_gc.retention_days`。
3. 默认 30 天。

`--dry-run` lists the full plan without executing — safe to run anytime.

`--dry-run` 列出完整计划但不执行 —— 随时可放心运行。

---

## Troubleshooting

**Where did my ALERT go?**

**我的 ALERT 跑到哪去了？**

It is now at `<project>/.roll/loop/ALERT-<slug>.md`. Run `roll loop alert` from
inside the project, or open the file directly.

现在在 `<project>/.roll/loop/ALERT-<slug>.md`。在项目里跑 `roll loop alert`，或直
接打开文件。

**I still have `*.migrated-<timestamp>` files. What are they?**

**我这里还有 `*.migrated-<时间戳>` 文件，那是什么？**

Leftovers from the one-time move to this layout. Nothing writes them: a cycle does
not rewrite paths on the way in. `roll loop gc` reaps markers older than 7 days, so
you can also just leave them alone. If you have a project that never made the move,
copy the files to their new paths by hand using the table above.

这是一次性迁移到当前布局时留下的。现在已经没有任何东西会再写它们 —— 自动迁移随常驻
调度一起退役了，cycle 不再在启动时改写路径。`roll loop gc` 仍会回收 7 天以上的标记，
所以放着不管也可以。如果某个项目从未迁移过，照上面的表把文件手工复制到新路径即可。

See also: [roll loop](loop.md) · [Migration 2.0](migration-2.0.md) · [FAQ](faq.md)

另见：[roll loop](loop.md) · [Migration 2.0](migration-2.0.md) · [FAQ](faq.md)
