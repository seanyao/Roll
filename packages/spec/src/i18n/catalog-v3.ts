/**
 * v3-native message catalog. The frozen v2 catalog (catalog.generated.json) is
 * mechanically derived from the bash oracle and must not be hand-edited; strings
 * for behaviour that is new in v3 live here instead (see catalog.ts header).
 *
 * Both en and zh are always present so the single-language contract (output
 * follows ROLL_LANG, never mixes) holds.
 */
import type { Catalog } from "./index.js";

export const v3Catalog: Catalog = {
  // `delta.banner.*` — persisted Delta Team assembly summary (US-DELTA-009).
  "delta.banner.title": {
    en: "▁▁▁ Delta Team assembling ▁▁▁",
    zh: "▁▁▁ Delta Team 正在组队 ▁▁▁",
  },
  "delta.banner.story": {
    en: "story",
    zh: "卡片",
  },
  "delta.banner.diversity": {
    en: "diversity",
    zh: "异构",
  },
  "delta.banner.diversity_distinct": {
    en: "%s ≠ %s  ✓",
    zh: "%s ≠ %s  ✓",
  },
  "delta.banner.diversity_undeclared": {
    en: "undeclared heterogeneity",
    zh: "未声明异构",
  },
  "delta.banner.frame": {
    en: "frame",
    zh: "帧",
  },
  "delta.banner.lease_held": {
    en: "lease held",
    zh: "租约已持有",
  },
  "delta.phase.validate.title": {
    en: "▁▁▁ Delta Team validating ▁▁▁",
    zh: "▁▁▁ Delta Team 正在验证 ▁▁▁",
  },
  "delta.phase.conclude.title": {
    en: "▁▁▁ Delta Team concluded ▁▁▁",
    zh: "▁▁▁ Delta Team 已收尾 ▁▁▁",
  },
  "delta.phase.delegation": {
    en: "delegation",
    zh: "委派",
  },
  "delta.phase.stage": {
    en: "stage",
    zh: "阶段",
  },
  "delta.phase.verdict": {
    en: "verdict",
    zh: "结论",
  },
  "delta.phase.allowed": {
    en: "allowed",
    zh: "通过",
  },
  "delta.phase.blocked": {
    en: "blocked",
    zh: "阻断",
  },
  "delta.phase.reason": {
    en: "reason",
    zh: "原因",
  },
  "delta.phase.outcome": {
    en: "outcome",
    zh: "结果",
  },
  "delta.phase.disposition": {
    en: "owner disposition",
    zh: "owner 决定",
  },
  "delta.phase.disposition_unselected": {
    en: "not owner-approved",
    zh: "尚未获 owner 批准",
  },

  // `north.*` — terminal north-star panel (US-OBS-047). The calculation stays
  // in @roll/core; these strings only label the shared roll.north.v1 report.
  "north.title": {
    en: "North Star",
    zh: "北极星",
  },
  "north.status_title": {
    en: "North",
    zh: "北极星",
  },
  "north.metric.autonomy": {
    en: "autonomy",
    zh: "自主运行",
  },
  "north.metric.deliveryRate": {
    en: "delivery rate",
    zh: "交付率",
  },
  "north.metric.fixTax": {
    en: "fix tax",
    zh: "修复税",
  },
  "north.metric.attributionErrors": {
    en: "attribution errors",
    zh: "归因错误",
  },
  "north.metric_short.autonomy": {
    en: "auto",
    zh: "自主",
  },
  "north.metric_short.deliveryRate": {
    en: "delivery",
    zh: "交付",
  },
  "north.metric_short.fixTax": {
    en: "fix",
    zh: "修复",
  },
  "north.metric_short.attributionErrors": {
    en: "attr",
    zh: "归因",
  },
  "north.no_data": {
    en: "no data",
    zh: "暂无数据",
  },
  "north.reason.no_history": {
    en: "no history",
    zh: "暂无历史",
  },
  "north.reason.no_product_deliveries": {
    en: "no product deliveries",
    zh: "暂无产品交付",
  },
  "north.reason.unknown": {
    en: "unknown reason",
    zh: "原因未知",
  },
  "north.trend.up": {
    en: "↑",
    zh: "↑",
  },
  "north.trend.down": {
    en: "↓",
    zh: "↓",
  },
  "north.trend.flat": {
    en: "→",
    zh: "→",
  },
  "north.status.met": {
    en: "met",
    zh: "达标",
  },
  "north.status.near": {
    en: "near",
    zh: "接近",
  },
  "north.status.miss": {
    en: "miss",
    zh: "未达标",
  },

  // `supervisor.journal.*` — structured supervisor narrative stream (US-OBS-048).
  "supervisor.journal.title": {
    en: "Supervisor journal",
    zh: "督导日志",
  },
  "supervisor.journal.empty": {
    en: "no journal entries",
    zh: "暂无日志条目",
  },
  "supervisor.journal.summary": {
    en: "journal: %d entries",
    zh: "督导日志：%d 条",
  },
  "supervisor.journal.latest": {
    en: "latest: %s by %s · %s",
    zh: "最新：%s · 操作者 %s · %s",
  },
  "supervisor.journal.header": {
    en: "Time · Actor · Action · Story · Note",
    zh: "时间 · 操作者 · 动作 · 卡片 · 备注",
  },
  "supervisor.journal.recorded": {
    en: "Recorded supervisor journal entry %s",
    zh: "已记录督导日志条目 %s",
  },
  "supervisor.journal.invalid_action": {
    en: "Invalid action '%s'. Use: decide, verify, rescue, escalate, note",
    zh: "无效动作 '%s'。可用：decide、verify、rescue、escalate、note",
  },
  "supervisor.journal.missing_action": {
    en: "--action is required",
    zh: "需要提供 --action",
  },
  "supervisor.journal.usage": {
    en: "Usage: roll supervisor journal [list|record] [--limit N] [--story ID] [--action ACTION] [--note TEXT] [--evidence PATH] [--json]\n  list    view recent journal entries (default)\n  record  append a structured supervisor decision/verification/rescue note\n",
    zh: "用法：roll supervisor journal [list|record] [--limit N] [--story ID] [--action ACTION] [--note TEXT] [--evidence PATH] [--json]\n  list    查看近期督导日志条目（默认）\n  record  追加一条结构化督导决策/验证/救场记录\n",
  },

  // `agent.*` — v3-native agent roster compatibility messages (US-AGENT-045).
  "agent.use_removed_agent": {
    en: "'%s' is no longer supported. Use one of: claude, kimi, codex, pi, agy, reasonix, cursor",
    zh: "'%s' 已不再支持。请使用：claude, kimi, codex, pi, agy, reasonix, cursor",
  },

  // `agent.*` — v4 default-agent vs project route-profile separation (US-V4-002).
  "agent.default_usage": {
    en: "`roll agent default` is retired. Use `roll agent migrate --dry-run`, then author `supervise` in ~/.roll/agents.yaml.",
    zh: "`roll agent default` 已退役。先用 `roll agent migrate --dry-run`，再在 ~/.roll/agents.yaml 中维护 `supervise`。",
  },
  "agent.default_current": {
    en: "Machine default agent: %s",
    zh: "机器默认 agent：%s",
  },
  "agent.default_none": {
    en: "No machine default agent set yet (falls back to the first installed agent)",
    zh: "尚未设置机器默认 agent（回退到首个已安装的 agent）",
  },
  "agent.default_unknown_agent": {
    en: "Unknown agent '%s'. Use one of: claude, kimi, codex, pi, agy, reasonix, cursor",
    zh: "未知 agent '%s'。可用：claude, kimi, codex, pi, agy, reasonix, cursor",
  },
  "agent.default_saved": {
    en: "Machine default agent set to %s",
    zh: "机器默认 agent 已设为 %s",
  },
  "agent.default_routes_followed": {
    en: "Project routes that followed the old default were updated to %s",
    zh: "原先跟随旧默认的项目路由已更新为 %s",
  },
  "agent.default_routes_preserved": {
    en: "Customized project routes in .roll/agents.yaml were preserved",
    zh: "已保留 .roll/agents.yaml 中自定义的项目路由",
  },
  "agent.use_retired": {
    en: "This legacy agent command is retired. Use `roll agent migrate --dry-run`, then author roles in ~/.roll/agents.yaml or .roll/agents.yaml.",
    zh: "这个 legacy agent 命令已退役。先用 `roll agent migrate --dry-run`，再在 ~/.roll/agents.yaml 或 .roll/agents.yaml 中维护角色绑定。",
  },
  "agent.view_default_label": {
    en: "Default agent (~/.roll/config.yaml)",
    zh: "默认 agent（~/.roll/config.yaml）",
  },
  "agent.view_routes_label": {
    en: "Project routes (.roll/agents.yaml)",
    zh: "项目路由（.roll/agents.yaml）",
  },

  // `ideav3.*` — the live `roll idea` capture command (US-PORT-003). Both en and
  // zh are always present so the single-language contract (output follows
  // ROLL_LANG, never mixes) holds.
  "ideav3.recorded": {
    en: "Recorded as %s",
    zh: "已记录为 %s",
  },
  "ideav3.type": {
    en: "Type",
    zh: "类型",
  },
  "ideav3.section": {
    en: "Section",
    zh: "分区",
  },
  "ideav3.text": {
    en: "Text",
    zh: "描述",
  },
  "ideav3.kind_bug": {
    en: "bug",
    zh: "缺陷",
  },
  "ideav3.kind_idea": {
    en: "idea",
    zh: "想法",
  },
  "ideav3.usage": {
    en: "Usage: roll idea <description>",
    zh: "用法：roll idea <描述>",
  },
  "ideav3.empty": {
    en: "Provide a short description to capture",
    zh: "请提供一句简短描述以记录",
  },
  "ideav3.lint_failed": {
    en: "Description fails backlog lint (%s) — not recorded",
    zh: "描述未过待办校验（%s）— 未记录",
  },
  "ideav3.lint_hint": {
    en: "Shorten to one plain sentence: ≤120 chars, no code, paths, filenames, or function names",
    zh: "精简为一句人话：≤120 字，不含代码、路径、文件名或函数名",
  },
  "ideav3.conflict": {
    en: "Backlog changed on disk — re-run to capture",
    zh: "待办文件已变更 — 请重试以记录",
  },

  // `releasev3.*` — the read-only release-guidance command (US-PORT-004). `roll
  // release` computes the next calver version, surfaces changelog readiness, and
  // prints the PR/tag flow; it NEVER pushes a tag or publishes (release is always
  // a human decision). Both en and zh present so the single-language contract
  // (output follows ROLL_LANG, never mixes) holds.
  "releasev3.usage": {
    en: "Usage: roll release [--dry-run|--yes|--showcase|--json] | roll release verify <version> [--no-latest]\n  The ONE release flow: bump → changelog fold → package gate → commit-push → consistency gate → PR → auto-merge → tag push.\n  Drives the merge itself via GitHub auto-merge (needs \"Allow auto-merge\" on the repo); prints progress while it waits and nudges CI if it stalls.\n  The consistency gate runs BEFORE the PR — a drifting release aborts before anything merges. Stops at the tag push; the tag push creates a DRAFT GitHub Release. npm publish stays yours (2FA).\n  release verify <version>  Phase 2 (FIX-1480): after you `npm publish`, confirm npm has the version (npm is the truth source) and promote the draft GitHub Release to latest; fails loud and leaves the draft untouched if npm lacks it. --no-latest skips the dist-tags.latest check.\n  --showcase  After a successful release, run the golden-path showcase (real models; recommended, non-blocking — never fails the release).",
    zh: "用法：roll release [--dry-run|--yes|--showcase|--json] | roll release verify <版本> [--no-latest]\n  唯一发版流：版本号 → 折叠 changelog → 包闸 → 提交推送 → 一致性闸 → PR → 自动合并 → 推 tag。\n  自驱合并（GitHub auto-merge，需仓库开启 “Allow auto-merge”）；等待期间打印进度，CI 卡住时自动推一下。\n  一致性闸在开 PR 之前先跑——漂移的发版会在任何东西合并前中止。止步于推 tag；推 tag 只会创建**草稿** GitHub Release。npm publish 仍由你执行（2FA）。\n  release verify <版本>  第二阶段（FIX-1480）：你 `npm publish` 之后,核对 npm 上确有该版本（npm 是真相源）并把草稿 GitHub Release 提升为正式；npm 上没有则响亮报错、草稿原样保留。--no-latest 跳过 dist-tags.latest 检查。\n  --showcase  发版成功后跑一次黄金路径 showcase（真模型；建议、非硬卡——绝不让发版失败）。",
  },
  "releasev3.title": {
    en: "Release plan",
    zh: "发版计划",
  },
  "releasev3.current": {
    en: "Current version",
    zh: "当前版本",
  },
  "releasev3.next": {
    en: "Suggested next",
    zh: "建议下一版",
  },
  "releasev3.tag": {
    en: "Tag",
    zh: "标签",
  },
  "releasev3.changelog": {
    en: "Changelog",
    zh: "更新日志",
  },
  "releasev3.changelog_ready": {
    en: "Unreleased section has content",
    zh: "未发布区有内容",
  },
  "releasev3.changelog_empty": {
    en: "nothing under Unreleased — add entries to CHANGELOG.md before releasing",
    zh: "未发布区为空 — 发版前先把条目写进 CHANGELOG.md",
  },
  "releasev3.flow_title": {
    en: "Release flow (run these yourself — a release is always a human decision):",
    zh: "发版流程（请亲手执行 — 发版始终由人拍板）：",
  },
  "releasev3.step_bump": {
    en: "Bump package.json version to %s",
    zh: "把 package.json 版本号改为 %s",
  },
  "releasev3.step_commit": {
    en: "Commit the bump and open a PR to main",
    zh: "提交版本号变更并向 main 开 PR",
  },
  "releasev3.step_merge": {
    en: "After CI is green and the PR is merged, pull main",
    zh: "CI 通过且 PR 合并后，拉取 main",
  },
  "releasev3.step_tag": {
    en: "Tag %s and push the tag — this triggers the release workflow",
    zh: "打标签 %s 并推送 — 触发发版流水线",
  },
  "releasev3.gate_note": {
    en: "The consistency gate runs on tag push and aborts the release on any gap.",
    zh: "一致性闸在推送标签时运行，任一维度对不上即中止发版。",
  },
  "releasev3.gate_preview": {
    en: "Preview locally with: roll release --dry-run",
    zh: "本地预检：roll release --dry-run",
  },
  "releasev3.no_pkg": {
    en: "package.json version not found — run from the repo root",
    zh: "未找到 package.json 版本号 — 请在仓库根目录运行",
  },

  // `loopv3.*` — the retirement notices for the v2 tmux-popup commands
  // `loop monitor` / `loop attach` (US-PORT-007). The v3 self-contained runner
  // already streams every cycle into the tmux session roll-loop-<slug>, so the
  // old auto-refresh popup (monitor) has no object, and attaching is just a
  // plain `tmux attach`. Both en and zh present (single-language contract).
  "loopv3.monitor_retired": {
    en: "roll loop monitor is retired. Use `roll loop status` for a snapshot, or watch the live cycle: tmux attach -t roll-loop-%s",
    zh: "roll loop monitor 已退役。用 `roll loop status` 看快照，或观察实时周期：tmux attach -t roll-loop-%s",
  },
  "loopv3.attach_retired": {
    en: "roll loop attach is retired. Attach to the live cycle directly: tmux attach -t roll-loop-%s",
    zh: "roll loop attach 已退役。直接观察实时周期：tmux attach -t roll-loop-%s",
  },
  // `loop branches` (US-PORT-022): pure user-introspection (listed loop-branch
  // merge status); no internal caller, so it retires rather than port. The one
  // line that reproduced it is offered for anyone who still wants the view.
  "loopv3.branches_retired": {
    en: "roll loop branches is retired. List loop branches directly: git ls-remote --heads origin 'loop/*'",
    zh: "roll loop branches 已退役。直接列出 loop 分支：git ls-remote --heads origin 'loop/*'",
  },

  // FIX-232: doctor proxy-environment check
  "doctor.proxy_env_warning": {
    en: "Stale proxy environment variables",
    zh: "残留的代理环境变量",
  },
  "doctor.proxy_env_hint": {
    en: "Proxy variables are set but unreachable — a closed proxy app may have poisoned launchd. Clean up:",
    zh: "代理变量已设置但目标不可达 — 已关闭的代理软件可能毒化了 launchd。请清理：",
  },

  // FIX-232 AC2: loop egress pre-check messages
  "loop.egress_blocked": {
    en: "egress blocked (proxy?): network pre-check failed — cycle %s refused to start",
    zh: "出网阻断（疑似代理？）：网络预检失败 — 周期 %s 拒绝启动",
  },

  // FIX-298: shared network guard (first-checkpoint connectivity + active recovery).
  // Lines are emitted one per locale (the single-language contract) — EN and ZH
  // are kept on separate lines by the caller, never inline on one line.
  "net.recovering": {
    en: "network unreachable — running the configured proxy-enable command, then re-checking…",
    zh: "网络不可达 — 正在执行已配置的代理启用命令，然后重新检测……",
  },
  "net.recovered": {
    en: "network restored after the proxy-enable command — continuing.",
    zh: "执行代理启用命令后网络已恢复 — 继续。",
  },
  // FIX-1025: announced when the precheck is opted out via
  // `loop_safety.skip_network_check: true` (configured providers reachable directly).
  "net.skipped": {
    en: "network precheck skipped (loop_safety.skip_network_check) — assuming configured providers are reachable.",
    zh: "已跳过网络预检（loop_safety.skip_network_check）——假定所配置的服务可直接访问。",
  },
  // %s is the command name (e.g. `roll loop go`). Halt message: clear, actionable.
  // FIX-1025: the probe defaults to a foreign host; if your domestic providers are
  // reachable directly, point the probe at one (`probe_url`) or opt out
  // (`skip_network_check`) instead of forcing a proxy the work does not need.
  "net.blocked_no_hook": {
    en: "%s needs the network, but the connectivity probe failed. If your configured providers ARE reachable, point the probe at one with `loop_safety.probe_url: <host:port>` or opt out with `loop_safety.skip_network_check: true` in .roll/policy.yaml. Otherwise add `loop_safety.proxy_enable_cmd: <your proxy-on command>` (e.g. your VPN/proxy toggle), check your connection, then retry.",
    zh: "%s 需要网络，但连通性探测失败。若所配置的服务其实可达，请用 `loop_safety.probe_url: <host:port>` 把探测指向其中一个，或在 .roll/policy.yaml 中设置 `loop_safety.skip_network_check: true` 跳过预检。否则请加入 `loop_safety.proxy_enable_cmd: <你的开代理命令>`（例如你的 VPN/代理开关），检查网络后重试。",
  },
  "net.blocked_after_hook": {
    en: "%s needs the network, but the probe STILL failed after running the configured proxy-enable command. Check that the command actually turns on connectivity, or point `loop_safety.probe_url` at a host you do need, then retry.",
    zh: "%s 需要网络，但执行已配置的代理启用命令后探测仍失败。请确认该命令确实能打开网络，或将 `loop_safety.probe_url` 指向你确实需要的主机后重试。",
  },

  // FIX-394 — chromium headless browser messages
  "fix394.chromium_unavailable": {
    en: "headless Chromium unavailable",
    zh: "无头 Chromium 不可用",
  },
  "fix394.chromium_offline_hint": {
    en: "offline or network error — chromium download may have failed",
    zh: "离线或网络错误 — Chromium 下载可能失败",
  },
  "fix394.web_evidence_skipped": {
    en: "web evidence skipped",
    zh: "网页证据已跳过",
  },
  "fix394.chromium_fix_hint": {
    en: "run `roll init` or `npx playwright install chromium` after connecting to the network to enable web screenshots",
    zh: "联网后运行 `roll init` 或 `npx playwright install chromium` 以启用网页截图",
  },
  "fix394.browser_tool_degraded": {
    en: "browser tool unavailable — headless Chromium not installed",
    zh: "浏览器工具不可用 — 无头 Chromium 未安装",
  },

  // `onboard.*` — design handoff nudge (US-ONBOARD-NUDGE-001).
  // %s is $roll-design (baseline); `roll design` command phrasing to be
  // added by US-ONBOARD-NUDGE-005 after US-ONBOARD-NUDGE-004 ships.
  "onboard.design_nudge": {
    en: "Run %s — Found requirement docs but an empty backlog. Turn them into a domain model + INVEST backlog, then roll loop.",
    zh: "运行 %s — 检测到需求文档但待办为空。将其转化为领域模型 + INVEST 待办列表，然后 roll loop。",
  },

  // `design.*` — explicit `roll design` entry point (US-ONBOARD-NUDGE-004 / FIX-1055).
  // Thin wrapper that launches the existing $roll-design skill interactively.
  "design.usage": {
    en: "Usage: roll design [--from-file <path> | \"<requirement>\"] [--agent <name>] [--verbose|--raw]\n  Launch the $roll-design skill in an interactive agent conversation.\n  Default output streams bounded live progress, card-created events, quiet heartbeats, and the final handoff while preserving the raw transcript.\n  When a successful design creates new Todo cards, roll prints agent-pool health and asks whether to start `roll loop go --review auto`.\n  `--from-file` binds a PRD/brief file as the design input.\n  `\"<requirement>\"` binds a free-text design target; it cannot be combined with `--from-file`.\n  `--agent` and `ROLL_DESIGN_AGENT` override only this design session; scoped roles live in ~/.roll/agents.yaml and .roll/agents.yaml.\n  `--verbose` streams lower-priority normalized activity; `--raw` streams the raw child output live.\n  Unlike `roll init`, this command runs an LLM — run it only when you want to design.",
    zh: "用法：roll design [--from-file <path> | \"<requirement>\"] [--agent <name>] [--verbose|--raw]\n  在交互式 agent 对话中启动 $roll-design skill。\n  默认输出会实时显示有界进展、建卡事件、静默心跳和最终交付，同时保留完整原始记录。\n  当成功设计产出新的 Todo 卡时，roll 会打印 agent 池健康概况，并询问是否启动 `roll loop go --review auto`。\n  `--from-file` 会把 PRD/brief 文件绑定为设计输入。\n  `\"<requirement>\"` 会绑定自由文本设计目标；不能与 `--from-file` 混用。\n  `--agent` 与 `ROLL_DESIGN_AGENT` 只覆盖本次 design session；scoped roles 位于 ~/.roll/agents.yaml 和 .roll/agents.yaml。\n  `--verbose` 实时显示较低优先级的规范化活动；`--raw` 实时输出子进程原始流。\n  与 `roll init` 不同，本命令会运行 LLM——只在需要设计时执行。",
  },
  "design.not_roll_project": {
    en: "This directory is not a Roll project (no .roll/). Run `roll init` first.",
    zh: "当前目录不是 Roll 项目（缺少 .roll/）。请先运行 `roll init`。",
  },
  "design.skill_missing": {
    en: "Skill file missing: skills/roll-design/SKILL.md. Run `roll setup` or initialise the skills submodule.",
    zh: "skill 文件缺失：skills/roll-design/SKILL.md。请运行 `roll setup` 或初始化 skills submodule。",
  },
  "design.no_agent": {
    en: "No AI agent detected. Install one (e.g., claude, kimi, pi) and try again.",
    zh: "未检测到 AI agent。请安装一个（如 claude、kimi、pi）后重试。",
  },
  "design.unknown_agent": {
    en: "Agent '%s' is unknown or not installed.",
    zh: "agent '%s' 未知或未安装。",
  },
  "design.from_file_missing": {
    en: "`--from-file` requires a path.",
    zh: "`--from-file` 需要一个文件路径。",
  },
  "design.from_file_not_found": {
    en: "Design source file not found: %s",
    zh: "未找到设计输入文件：%s",
  },
  "design.bare_backlog_help": {
    en: "No design target given. This project already has a backlog with work items.\n  Provide a target to scope the design session:\n    roll design --from-file <path>    — design from a PRD/brief/requirement file\n    roll design \"<requirement>\"       — one-shot design from a free-text requirement\n    roll supervisor next              — pick the next item from the backlog\n    roll loop go --cards <id>         — dispatch a backlog card directly\n  Run `roll design --help` for full usage.",
    zh: "未指定设计目标。该项目已有待办事项。\n  请指定目标以限定设计范围：\n    roll design --from-file <path>    — 从 PRD/brief/需求文件开始设计\n    roll design \"<requirement>\"       — 从自由文本需求开始一次性设计\n    roll supervisor next              — 从待办中选择下一项\n    roll loop go --cards <id>         — 直接分派待办卡\n  执行 `roll design --help` 查看完整用法。",
  },

  // FIX-1055: bounded progress view + final artifact handoff.
  "design.run_started": { en: "Design run started", zh: "设计运行开始" },
  "design.target": { en: "target: %s", zh: "目标：%s" },
  "design.target_from_file": { en: "target: from-file %s", zh: "目标：from-file %s" },
  "design.target_none": { en: "target: none", zh: "目标：无" },
  "design.target_none_label": { en: "none", zh: "无" },
  "design.mode_design_only": { en: "mode: design-only", zh: "模式：design-only" },
  "design.mode_from_file": { en: "mode: from-file · %s", zh: "模式：from-file · %s" },
  "design.mode_design_only_idea": {
    en: "mode: design-only · IDEA cards require owner sign-off before story split",
    zh: "模式：design-only · IDEA 卡片在拆分为实现卡前需要负责人签批",
  },
  "design.agent": { en: "agent: %s", zh: "agent：%s" },
  "design.raw_transcript": { en: "raw transcript: %s", zh: "原始记录：%s" },
  "design.handoff": { en: "Design Review Page handoff", zh: "Design Review Page 交付" },
  "design.status_label": { en: "status: %s", zh: "状态：%s" },
  "design.design_label": { en: "design: %s", zh: "设计产物：%s" },
  "design.review_page_label": { en: "Design Review Page: %s", zh: "Design Review Page：%s" },
  "design.html_label": { en: "Design Review Page: %s", zh: "Design Review Page：%s" },
  "design.cards_label": { en: "cards: %d", zh: "卡片数：%d" },
  "design.why_label": { en: "why: %s", zh: "原因：%s" },
  "design.next_label": { en: "next: %s", zh: "下一步：%s" },
  "design.transcript_label": { en: "transcript: %s", zh: "记录：%s" },
  "design.empty_transcript": { en: "transcript is empty", zh: "记录为空" },
  "design.status.awaiting_signoff": { en: "awaiting owner sign-off", zh: "等待负责人签批" },
  "design.status.cards_created": { en: "%d card(s) created", zh: "已创建 %d 张卡片" },
  "design.status.no_cards": { en: "no cards created", zh: "未创建卡片" },
  "design.status.agent_failed": { en: "agent exited with code %s", zh: "agent 退出码 %s" },
  "design.why.idea_signoff": {
    en: "IDEA cards require owner sign-off before story split",
    zh: "IDEA 卡片在拆分前需要负责人签批",
  },
  "design.next.cards_created": {
    en: "review the created cards and run `roll loop go --cards <id>` to dispatch them",
    zh: "审阅已创建的卡片并运行 `roll loop go --cards <id>` 进行分派",
  },
  "design.next.review_and_split": {
    en: "open the Design Review Page, then ask `roll design` to split %s into implementation cards",
    zh: "打开 Design Review Page 审阅，然后让 `roll design` 把 %s 拆成实现卡",
  },
  "design.next.no_cards": {
    en: "scope is design-only; no implementation cards were created for %s",
    zh: "本次为纯设计；未为 %s 创建实现卡",
  },
  "design.loop.agent_pool": {
    en: "Agent pool: %d active, %d suspended",
    zh: "Agent 池：%d 个可用，%d 个已挂起",
  },
  "design.loop.suspended_agent": {
    en: "suspended: %s (%s)",
    zh: "已挂起：%s（%s）",
  },
  "design.loop.prompt": {
    en: "Start loop now? [y/N]",
    zh: "现在启动 loop 吗？[y/N]",
  },
  "design.loop.manual_next": {
    en: "Next: roll loop go --review auto",
    zh: "下一步：roll loop go --review auto",
  },

  // `setup.*` — legacy setup agent selection (compatibility only).
  "setup.primary_prompt": {
    en: "Multiple AI agents detected. Pick the initial supervise role:",
    zh: "检测到多个 AI agent，请选择初始 supervise 角色：",
  },
  "setup.primary_auto_set": {
    en: "Only %s is installed — recorded as the initial supervise agent.",
    zh: "仅安装了 %s — 已记录为初始 supervise agent。",
  },
  "setup.primary_no_agents": {
    en: "No AI agents installed. Install one (e.g., claude, kimi, pi), then run `roll agent migrate --dry-run` or author ~/.roll/agents.yaml.",
    zh: "未安装 AI agent。请先安装一个（如 claude、kimi、pi），再运行 `roll agent migrate --dry-run` 或维护 ~/.roll/agents.yaml。",
  },
  "setup.primary_reselect": {
    en: "--reselect: pick a new initial supervise agent.",
    zh: "--reselect：重新选择初始 supervise agent。",
  },
  "setup.primary_set": {
    en: "Initial supervise agent recorded as %s.",
    zh: "初始 supervise agent 已记录为 %s。",
  },

  // FIX-1021: `roll init` summary / confirmation
  "init.detected_project_type": {
    en: "Detected project type: %s",
    zh: "检测到项目类型：%s",
  },
  "init.will_scaffold": {
    en: "Roll will scaffold AGENTS.md, .roll/backlog.md, .roll/features/, scoped agent-ready .roll/, and .claude/CLAUDE.md.",
    zh: "Roll 将在此目录生成 AGENTS.md、.roll/backlog.md、.roll/features/、可承载 scoped agent 配置的 .roll/ 与 .claude/CLAUDE.md。",
  },
  "init.proceed_prompt": {
    en: "Proceed?",
    zh: "继续？",
  },
  "init.cancelled": {
    en: "Init cancelled. Run `roll init` again when ready.",
    zh: "初始化已取消。准备就绪后重新运行 `roll init`。",
  },
  "init.auto_non_interactive": {
    en: "Non-interactive mode — proceeding automatically. Use `roll init --auto` to suppress this notice.",
    zh: "非交互模式 — 自动继续。可使用 `roll init --auto` 跳过此提示。",
  },
  "init.onboard_plan_facts_hash_unreadable": {
    en: "could not read factsHash from .roll/onboard-plan.yaml",
    zh: "无法读取 .roll/onboard-plan.yaml 中的 factsHash",
  },
  "init.onboard_plan_facts_hash_stale": {
    en: "plan factsHash is stale: expected %s, got %s",
    zh: "plan factsHash 已过期：当前应为 %s，plan 中为 %s",
  },
  "init.onboard_regenerate_before_apply": {
    en: "Regenerate the plan by running $roll-onboard again before applying.",
    zh: "应用前请重新运行 $roll-onboard 生成 plan。",
  },
  "init.onboard_plan_validated_review": {
    en: "Onboard plan validated. Review .roll/init-diagnosis.yaml and .roll/onboard-plan.yaml before applying.",
    zh: "接入方案已通过校验。应用前请审阅 .roll/init-diagnosis.yaml 和 .roll/onboard-plan.yaml。",
  },
  "init.onboard_apply_review_title": {
    en: "Onboard apply review checkpoint",
    zh: "应用接入方案审阅检查点",
  },
  "init.onboard_apply_review_action": {
    en: "action",
    zh: "动作",
  },
  "init.onboard_apply_review_target": {
    en: "target",
    zh: "路径",
  },
  "init.onboard_apply_review_mode": {
    en: "mode",
    zh: "模式",
  },
  "init.onboard_apply_review_owner_content": {
    en: "owner content",
    zh: "用户内容",
  },
  "init.onboard_apply_review_action_append": {
    en: "append",
    zh: "追加",
  },
  "init.onboard_apply_review_action_create": {
    en: "create",
    zh: "创建",
  },
  "init.onboard_apply_review_action_keep": {
    en: "keep",
    zh: "保留",
  },
  "init.onboard_apply_review_action_merge": {
    en: "merge",
    zh: "合并",
  },
  "init.onboard_apply_review_action_replace": {
    en: "replace",
    zh: "替换",
  },
  "init.onboard_apply_review_mode_append_line": {
    en: "append-line",
    zh: "追加行",
  },
  "init.onboard_apply_review_mode_create_if_missing": {
    en: "create-if-missing",
    zh: "缺失时创建",
  },
  "init.onboard_apply_review_mode_ensure_directory": {
    en: "ensure-directory",
    zh: "确保目录",
  },
  "init.onboard_apply_review_mode_replace": {
    en: "replace",
    zh: "替换",
  },
  "init.onboard_apply_review_mode_section_merge": {
    en: "section-merge",
    zh: "章节合并",
  },
  "init.onboard_apply_review_owner_not_present": {
    en: "not present",
    zh: "不存在",
  },
  "init.onboard_apply_review_owner_preserved": {
    en: "preserved",
    zh: "保留",
  },
  "init.onboard_apply_review_owner_replaced": {
    en: "replaced",
    zh: "会替换",
  },
  "init.onboard_apply_review_owner_roll_owned": {
    en: "roll-owned",
    zh: "Roll 管理",
  },
  "init.onboard_apply_review_sync_note": {
    en: "After confirmation, Roll also syncs conventions to the configured AI tools and registers this project.",
    zh: "确认后，Roll 还会把约定同步到已配置的 AI 工具，并登记这个项目。",
  },
  "init.onboard_apply_auto_required": {
    en: "Non-interactive apply requires explicit review acknowledgement:",
    zh: "非交互应用需要显式确认已审阅：",
  },
  "init.onboard_apply_confirm_prompt": {
    en: "Proceed with these changes?",
    zh: "确认执行这些变更？",
  },
  "init.onboard_apply_failed": {
    en: "Onboard apply failed before completion.",
    zh: "onboard 应用未完成即失败。",
  },
  "init.onboard_apply_recovery": {
    en: "Recovery metadata: .roll/onboard-changeset.yaml if present. Inspect it, then run roll offboard --confirm to reverse Roll-owned artifacts.",
    zh: "恢复元数据：如存在请检查 .roll/onboard-changeset.yaml，然后运行 roll offboard --confirm 回滚 Roll 管理的产物。",
  },
  "init.no_files_changed": {
    en: "No files changed.",
    zh: "未修改任何文件。",
  },

  // FIX-1020: new-project workflow — repo-first next steps
  "init.next_create_repo": {
    en: "Create a GitHub repo and push the initial commit",
    zh: "创建 GitHub 仓库并推送初始提交",
  },
  "init.next_push_commands": {
    en: "gh repo create <name> --public --source=. --push (or `git remote add origin ... && git push -u origin main`)",
    zh: "gh repo create <name> --public --source=. --push（或 `git remote add origin ... && git push -u origin main`）",
  },
  "init.next_loop_on": {
    en: "Drive the backlog with roll loop go",
    zh: "用 roll loop go 推进 backlog",
  },
  "init.next_repo_required": {
    en: "`roll loop` needs a pushable GitHub remote — create the repo first.",
    zh: "`roll loop` 需要一个可推送的 GitHub remote — 请先创建仓库。",
  },

  // FIX-1019 / FIX-1020: loop repo pushability precheck + pause gate
  "loop.paused_marker_present": {
    en: "loop is paused (PAUSE marker present) — skipping this tick. Run `roll loop resume` when ready.",
    zh: "loop 已暂停（存在 PAUSE 标记）— 跳过本次触发。准备就绪后运行 `roll loop resume`。",
  },
  "loop.repo_unreachable": {
    en: "GitHub repo unreachable — `git ls-remote origin` failed. Create the remote repo and push before running the loop.",
    zh: "GitHub 仓库不可达 — `git ls-remote origin` 失败。请先创建远程仓库并推送，再运行 loop。",
  },
  "loop.no_remote": {
    en: "No git remote configured — `roll loop` needs a pushable GitHub remote. Add one with `git remote add origin ...`",
    zh: "未配置 git remote — `roll loop` 需要一个可推送的 GitHub remote。请用 `git remote add origin ...` 添加。",
  },
  "loop.not_a_git_repo": {
    en: "Not a git repository — `roll loop` needs a git repo with a pushable GitHub remote.",
    zh: "不是 git 仓库 — `roll loop` 需要一个带有可推送 GitHub remote 的 git 仓库。",
  },
  "loop.sched.mount_failed": {
    en: "loop on: %d launchd job(s) failed to mount after retry — scheduling is not active",
    zh: "loop on: 重试后仍有 %d 个 launchd 任务挂载失败 — 排程未生效",
  },
  "loop.sched.domain": {
    en: "domain",
    zh: "域",
  },
  "loop.sched.label": {
    en: "label",
    zh: "标签",
  },
  "loop.sched.cause": {
    en: "cause",
    zh: "原因",
  },
  "loop.sched.retry_exhausted": {
    en: "job was not armed after bootout and bootstrap were retried",
    zh: "bootout 与 bootstrap 重试后任务仍未激活",
  },
  "loop.sched.inspect": {
    en: "Inspect and retry these exact commands:",
    zh: "请执行以下命令排查并重试:",
  },
  "loop.sched.retry": {
    en: "After correcting the reported path or launchd state, run `roll loop on` again.",
    zh: "修正上述路径或 launchd 状态后,再次运行 `roll loop on`。",
  },
  // US-LOOP-108: launchd failure ends unarmed and names the owner-confirmed
  // process fallback WITHOUT starting it automatically.
  "loop.sched.unarmed": {
    en: "scheduler: unarmed — no autonomous work will run",
    zh: "排程:未激活 — 不会运行任何自主任务",
  },
  "loop.sched.fallback_hint": {
    en: "Or, if launchd cannot be repaired, start an owner-confirmed process fallback (NOT a launchd replacement across reboot/login):",
    zh: "或者,若 launchd 无法修复,启动一个 owner 明示确认的进程 fallback(重启/登出后不等价于 launchd):",
  },

  // FIX-1042: agent skill-root pollution (auxiliary dirs mounted as skills)
  "doctor.skill_root_pollution": {
    en: "Polluted agent skill roots (auxiliary directories mounted as skills)",
    zh: "受污染的 agent skill 根目录（辅助目录被当作 skill 挂载）",
  },
  "doctor.skill_root_pollution_hint": {
    en: "These are Roll docs/reports, not skills — re-run `roll setup` to remove them so agents stop warning about missing descriptions.",
    zh: "这些是 Roll 文档/报告，不是 skill —— 重新运行 `roll setup` 即可移除，agent 将不再报告缺少 description 的警告。",
  },

  // US-PHYSICAL-003: Roll Capture.app setup/doctor readiness guidance
  "setup.roll_capture_not_ready": {
    en: "Roll Capture.app is not ready; physical screenshots will honestly skip at capture time.",
    zh: "Roll Capture.app 尚未就绪，物理截图会在捕获时降级为明确跳过。",
  },
  "setup.roll_capture_install": {
    en: "Install Roll Capture.app: place it in ~/Applications or /Applications, then open it once.",
    zh: "安装 Roll Capture.app：将它放到 ~/Applications 或 /Applications，然后打开一次。",
  },
  "setup.roll_capture_permission": {
    en: "Host permission proxy: doctor checks the current terminal host only; Roll Capture.app manages its own Screen Recording permission on first capture.",
    zh: "宿主权限代理：doctor 只检查当前终端宿主；Roll Capture.app 首次捕获时会自行管理屏幕录制权限。",
  },
  "setup.roll_capture_inbox": {
    en: "inbox: %s",
    zh: "inbox：%s",
  },

  // US-LANG-002: language policy mechanical audit
  "doctor.language_audit_title": {
    en: "Language policy audit",
    zh: "语言政策审计",
  },
  "doctor.language_audit_ok": {
    en: "No mixed-language output rules found",
    zh: "未发现混排输出规则",
  },
  "doctor.language_audit_findings_count": {
    en: "policy finding(s)",
    zh: "条政策发现",
  },

  // REFACTOR-072: binary staleness surfaced in doctor (loop run-once side effect preserved)
  "doctor.binary_staleness_title": {
    en: "Loop binary version",
    zh: "Loop 程序版本",
  },
  "doctor.binary_staleness_unknown": {
    en: "No recent version check — run `roll loop run-once` to populate.",
    zh: "暂无近期版本检查记录 — 运行一次 `roll loop run-once` 后将显示。",
  },
  "doctor.binary_staleness_ok": {
    en: "running v%s, up to date (latest %s)",
    zh: "当前 v%s，已是最新 %s",
  },
  "doctor.binary_staleness_stale": {
    en: "running v%s, latest %s — run `roll update`",
    zh: "当前 v%s，最新 %s — 建议运行 `roll update`",
  },

  // FIX-1453 — `roll capture` i18n (was hardcoded English, dual-line mixed).

  "capture.usage": {
    en: "Usage: roll capture <status|migrate|repair|local-window>\n  status  [--project <path>] [--json]                 gateway/renderer readiness + effective capture policy\n  migrate [--project <path>] [--revert] [--dry-run] [--json]  enable best_effort when capabilities are ready; reversible\n  repair  <story-id> [--project <path>] [--health <path>] [--json]  evidence-only repair; never reopens the build\n  local-window --story <ID> --url <loopback-url> [--prepare <json>] [--run <id>] [--project <path>] [--json]  isolated local synthetic page only\n",
    zh: "用法：roll capture <status|migrate|repair|local-window>\n  status  [--project <path>] [--json]                 网关/渲染器就绪度 + 有效截图策略\n  migrate [--project <path>] [--revert] [--dry-run] [--json]  能力就绪时启用 best_effort（可回退）\n  repair  <story-id> [--project <path>] [--health <path>] [--json]  仅证据修复；绝不重新打开构建\n  local-window --story <ID> --url <loopback-url> [--prepare <json>] [--run <id>] [--project <path>] [--json]  仅捕获隔离的本地合成页面\n",
  },
  "capture.unknown_subcommand": {
    en: "[roll] unknown 'roll capture' subcommand: %s",
    zh: "[roll] 未知 'roll capture' 子命令：%s",
  },

  // local-window
  "capture.refresh.wrote": {
    en: "capture refresh: wrote host capabilities to %s",
    zh: "capture refresh：已将主机能力写入 %s",
  },
  "capture.local_window.usage": {
    en: "Usage: roll capture local-window --story <ID> --url <loopback-url> [--run <id>] [--project <path>] [--json]",
    zh: "用法：roll capture local-window --story <ID> --url <loopback-url> [--run <id>] [--project <path>] [--json]",
  },
  "capture.local_window.unsafe_id": {
    en: "local-window requires safe story and run identifiers (letters, digits, dot, underscore, hyphen only).",
    zh: "local-window 需要安全的 story 与 run 标识符（仅字母、数字、点、下划线、连字符）。",
  },
  "capture.local_window.loopback_only": {
    en: "local-window only permits loopback HTTP(S) pages; no owner Chrome or remote URL was opened.",
    zh: "local-window 仅允许 loopback HTTP(S) 页面；不会打开用户的 Chrome 或远程 URL。",
  },
  "capture.local_window.result": {
    en: "local-window capture: %s",
    zh: "local-window 截图：%s",
  },
  "capture.local_window.no_extension": {
    en: "  browser extension: not used",
    zh: "  浏览器扩展：未使用",
  },
  "capture.local_window.privacy": {
    en: "  privacy: loopback-only synthetic target in a temporary profile",
    zh: "  隐私：仅在临时 profile 中捕获 loopback 合成页面",
  },
  "capture.local_window.selector": {
    en: "  selector: %s · %s",
    zh: "  选择器：%s · %s",
  },
  "capture.local_window.screenshot": {
    en: "  screenshot: %s",
    zh: "  截图：%s",
  },
  "capture.local_window.receipt": {
    en: "  receipt: %s",
    zh: "  回执：%s",
  },
  "capture.local_window.reason": {
    en: "  reason: %s",
    zh: "  原因：%s",
  },
  "capture.local_window.prepare_must_be_list": {
    en: "prepare must be a JSON action list",
    zh: "prepare 必须是 JSON action 列表",
  },
  "capture.local_window.prepare_max_actions": {
    en: "prepare allows at most 16 actions",
    zh: "prepare 最多允许 16 个 action",
  },
  "capture.local_window.prepare_action_object": {
    en: "prepare action must be an object",
    zh: "prepare action 必须是对象",
  },
  "capture.local_window.prepare_wait_ms": {
    en: "prepare wait requires only kind and an integer ms from 0 to 5000",
    zh: "prepare wait 只需 kind 和 0-5000 之间的整数 ms",
  },
  "capture.local_window.prepare_waits_max": {
    en: "prepare waits may total at most 15000ms",
    zh: "prepare wait 总计不能超过 15000ms",
  },
  "capture.local_window.prepare_selector_required": {
    en: "prepare %s requires only kind and a non-empty selector",
    zh: "prepare %s 只需 kind 和非空选择器",
  },
  "capture.local_window.prepare_fill_required": {
    en: "prepare fill requires only kind, a non-empty selector, and a value of at most 1000 characters",
    zh: "prepare fill 只需 kind、非空选择器和不超过 1000 字符的 value",
  },
  "capture.local_window.prepare_only_permits": {
    en: "prepare only permits click, fill, wait, and scroll actions",
    zh: "prepare 只允许 click、fill、wait、scroll 四种 action",
  },

  // migrate
  "capture.migrate.revert": {
    en: "capture migrate --revert: %s",
    zh: "capture migrate --revert：%s",
  },
  "capture.migrate.result": {
    en: "capture migrate: %s (%s)",
    zh: "capture migrate：%s（%s）",
  },
  "capture.migrate.detail": {
    en: "  %s",
    zh: "  %s",
  },
  "capture.dry_run_not_written": {
    en: " (dry-run; not written)",
    zh: "（dry-run；未写入）",
  },
  "capture.written": {
    en: " (written)",
    zh: "（已写入）",
  },
  "capture.no_change": {
    en: " (no change)",
    zh: "（无变更）",
  },

  // repair
  "capture.repair.usage": {
    en: "Usage: roll capture repair <story-id> [--project <path>] [--health <path>] [--json]",
    zh: "用法：roll capture repair <story-id> [--project <path>] [--health <path>] [--json]",
  },
  "capture.repair.no_record": {
    en: "no evidence-health record at %s; nothing to repair",
    zh: "%s 没有 evidence-health 记录；无需修复",
  },
  "capture.repair.failed_delivery": {
    en: "delivery failed: normal failure handling, not an evidence repair; build not reopened",
    zh: "交付失败：走正常失败处理，不属证据修复；构建不会重新打开",
  },
  "capture.repair.not_degraded": {
    en: "visual state is \"%s\", not degraded-infrastructure; not evidence-only repairable; build not reopened",
    zh: "visual 状态为 \"%s\"，不是 degraded-infrastructure；不可做仅证据修复；构建不会重新打开",
  },
  "capture.repair.result": {
    en: "capture repair: %s",
    zh: "capture repair：%s",
  },
  "capture.repair.reopened": {
    en: "  reopenedBuild=%s buildUntouched=%s",
    zh: "  reopenedBuild=%s buildUntouched=%s",
  },
  "capture.repair.visual": {
    en: "  visual: %s -> %s",
    zh: "  visual：%s -> %s",
  },

  // capture-policy readiness (shared by `roll capture status` + `roll doctor`)
  "capture.readiness.title": {
    en: "Capture policy readiness",
    zh: "截图策略就绪度",
  },
  "capture.readiness.gateway_ready": {
    en: "  %s v2 capture gateway — ready",
    zh: "  %s v2 capture gateway — 就绪",
  },
  "capture.readiness.gateway_unavailable": {
    en: "  %s v2 capture gateway — unavailable",
    zh: "  %s v2 capture gateway — 不可用",
  },
  "capture.readiness.renderer_ready": {
    en: "  %s browser renderer — ready",
    zh: "  %s browser renderer — 就绪",
  },
  "capture.readiness.renderer_unavailable": {
    en: "  %s browser renderer — unavailable",
    zh: "  %s browser renderer — 不可用",
  },
  "capture.readiness.policy": {
    en: "  · effective capture policy — %s",
    zh: "  · 有效截图策略 — %s",
  },
  "capture.readiness.migration": {
    en: "  · next migration — %s (%s)",
    zh: "  · 下次迁移 — %s（%s）",
  },

  // US-DELTA-003 — protocol-only `roll delta` CLI
  "delta.help.usage": {
    en: "Usage: roll delta <prepare|validate|conclude|status|help>\n\n  Delta Team (host-guided) = the current host main session (implicit Supervisor)\n  plus host-native Designer/Builder/Evaluator sub-agent sessions, driven through\n  roll delta. Roll never spawns, resumes, or configures any session, including\n  yours.\n\n  Managed-runtime boundary:\n    - prepare for solo or delta-team atomically holds the Story delivery reservation,\n      creates one managed WorkspaceSet beneath .roll/loop/worktrees, and returns its\n      detached checkout and publish-ref identity. Start the Builder only there.\n    - host-guided full-delta-team is refused before side effects; Full Delta attaches\n      to an existing Cycle WorkspaceSet and never creates a nested Delta workspace.\n    - handoff_ready preserves the reservation and workspace. It is NOT Done, a merge,\n      an attest verdict, or a DeliveryRecord. Cleanup needs confirmed merge plus\n      accepted attest and a fresh all-member inspection.\n    - Legacy/external paths remain visible as unknown or unmanaged; Roll never adopts\n      or deletes them automatically.\n\n  Honest protocol boundary:\n    - Host attestation is structural validation only (non-empty/unique tokens that\n      correspond across resolution/event/manifest); never proof of a fresh session\n      or that a model executed.\n    - Presets live in ~/.roll/delta-team/presets.yaml (host-local config only).\n    - Host-guided cost renders ? (host_unobservable) — never estimated or zeroed.\n\n  Host-guided delegation lifecycle commands (protocol-only; no agent spawning).\n\n  roll delta prepare <story-id> --trigger host-guided --topology solo|delta-team|full-delta-team --profile standard|verified|designed --preset <id> --resolution <path> [--continuation-run <name>] [--json]\n    Atomically reserve delivery, allocate the managed workspace, and create the immutable frame.\n    --continuation-run only takes over a task that was explicitly redelegated to <name>\n    (owner_redelegate --continuation-run <name>): it verifies the recorded redelegation,\n    creates a fresh standard delta run, and swaps the occupancy atomically — it never\n    touches any other task.\n\n  roll delta validate --delegation <id> --stage designer|builder|evaluator|peer [--json]\n    Validate a role-stage submission through the protocol-validator boundary.\n\n  roll delta conclude --delegation <id> --delivery-disposition owner_continue|owner_hold|owner_redelegate [--continuation-run <name>] [--json]\n    Record owner-approved terminal binding (Option C: handoff_ready/handoff_only).\n    owner_redelegate transfers the reservation to the named successor; the successor\n    takes over with roll delta prepare --continuation-run <name>.\n\n  roll delta status [--story <id>|--delegation <id>] [--json]\n    Read-only delegation status projection from event truth.\n\n  roll delta help\n    Print this help.\n",
    zh: "用法：roll delta <prepare|validate|conclude|status|help>\n\n  Delta Team（host-guided）= 当前宿主主会话（隐式 Supervisor）加上由宿主 native\n  能力创建的 Designer/Builder/Evaluator 子会话，通过 roll delta 驱动。Roll 从不\n  spawn、resume 或配置任何会话（包括你自己的）。\n\n  受管运行时边界：\n    - solo 或 delta-team 的 prepare 会原子持有 Story 交付预留，在\n      .roll/loop/worktrees 下创建一个受管 WorkspaceSet，并返回 detached checkout\n      和 publish-ref 身份。Builder 只能在该工作区开始。\n    - host-guided full-delta-team 会在副作用前被拒绝；Full Delta 只附着到既有 Cycle\n      WorkspaceSet，绝不创建嵌套 Delta 工作区。\n    - handoff_ready 会保留预留和工作区；它不是 Done、merge、attest 裁定或\n      DeliveryRecord。清理必须有已确认合并、已接受 attest 和新鲜的全成员检查。\n    - 旧路径/外部路径只会作为 unknown 或 unmanaged 可见；Roll 从不自动认领或删除。\n\n  如实的协议边界：\n    - 宿主 attestation 仅结构校验（token 非空/唯一且在 resolution/事件/manifest 间\n      对应）；绝不证明会话新起或模型执行过。\n    - preset 放在 ~/.roll/delta-team/presets.yaml（仅宿主本地配置）。\n    - host-guided 成本渲染 ? (host_unobservable)——绝不估算或写零。\n\n  宿主导引的委派生命周期命令（仅协议层；不启任何 agent）。\n\n  roll delta prepare <story-id> --trigger host-guided --topology solo|delta-team|full-delta-team --profile standard|verified|designed --preset <id> --resolution <path> [--continuation-run <name>] [--json]\n    原子预留交付、分配受管工作区，并创建不可变帧。\n    --continuation-run 只接手明确转交给 <name> 的任务（owner_redelegate --continuation-run\n    <name>）：它会核对已落盘的转交记录，创建全新的标准 delta 运行，并原子替换占用——\n    绝不触碰其他任务。\n\n  roll delta validate --delegation <id> --stage designer|builder|evaluator|peer [--json]\n    经过协议校验边界验证角色阶段提交。\n\n  roll delta conclude --delegation <id> --delivery-disposition owner_continue|owner_hold|owner_redelegate [--continuation-run <name>] [--json]\n    记录 owner 批准的终止绑定（Option C：handoff_ready/handoff_only）。\n    owner_redelegate 会把占用转交给指定继任名字；继任者用 roll delta prepare\n    --continuation-run <name> 接手。\n\n  roll delta status [--story <id>|--delegation <id>] [--json]\n    从事件真相只读投影委派状态。\n\n  roll delta help\n    打印此帮助。\n",
  },
  "delta.error.unknown_subcommand": {
    en: "roll delta: unknown subcommand '%s'. Try: prepare, validate, preflight, conclude, status, help",
    zh: "roll delta：未知子命令 '%s'。可用：prepare、validate、preflight、conclude、status、help",
  },
  "delta.error.missing_story": {
    en: "roll delta: <story-id> is required",
    zh: "roll delta：需要提供 <story-id>",
  },
  "delta.error.duplicate_flag": {
    en: "roll delta: duplicate flag '%s'",
    zh: "roll delta：重复标志 '%s'",
  },
  "delta.error.unexpected_positional": {
    en: "roll delta: unexpected positional argument '%s'",
    zh: "roll delta：非预期的位置参数 '%s'",
  },
  "delta.error.unknown_flag": {
    en: "roll delta: unknown flag '%s'",
    zh: "roll delta：未知标志 '%s'",
  },
  "delta.error.missing_required": {
    en: "roll delta: missing required flag '%s'",
    zh: "roll delta：缺少必需标志 '%s'",
  },
  "delta.error.missing_value": {
    en: "roll delta: missing value for '%s'",
    zh: "roll delta：'%s' 缺少值",
  },
  "delta.error.invalid_value": {
    en: "roll delta: invalid value '%s' for '%s'. Expected: %s",
    zh: "roll delta：值 '%s' 对 '%s' 无效。应为：%s",
  },
  "delta.error.cycle_rejected": {
    en: "roll delta: --cycle is not supported for host-guided prepare (no cycle allocation)",
    zh: "roll delta：host-guided prepare 不支持 --cycle（无 cycle 分配）",
  },
  "delta.error.full_delta_requires_cycle_workspace": {
    en: "roll delta prepare: host-guided full-delta-team requires an existing Cycle WorkspaceSet",
    zh: "roll delta prepare：host-guided full-delta-team 需要既有的 Cycle WorkspaceSet",
  },
  "delta.error.status_selector": {
    en: "roll delta status: provide --story <id> or --delegation <id>",
    zh: "roll delta status：请提供 --story <id> 或 --delegation <id>",
  },
  "delta.error.continuation_not_available": {
    en: "roll delta prepare: no reservation on story %s was explicitly redelegated to '%s'; --continuation-run only takes over a task that names this exact successor",
    zh: "roll delta prepare：故事 %s 上没有明确转交给 '%s' 的占用；--continuation-run 只能接手明确写着这个继任名字的任务",
  },
  "delta.error.continuation_not_verifiable": {
    en: "roll delta prepare: the reservation on story %s naming '%s' cannot be matched to a recorded redelegation; the pickup identity cannot be verified, refusing",
    zh: "roll delta prepare：故事 %s 上名为 '%s' 的占用找不到对应的转交记录；接手身份无法核实，已拒绝",
  },
  "delta.error.continuation_adoption_failed": {
    en: "roll delta prepare: the reservation redelegated to '%s' on story %s changed while taking over; nothing was claimed and no events were written",
    zh: "roll delta prepare：接手故事 %s 上转交给 '%s' 的占用时占用发生变化；未占用、未写事件",
  },
  "delta.error.continuation_adopted": {
    en: "Delegation %s was redelegated to '%s' and run %s has taken over the story; this old task is already superseded and cannot be concluded again",
    zh: "委派 %s 已转交给 '%s'，故事已由新运行 %s 接手；旧任务已被取代，不能再次收尾",
  },
  "delta.prepare.continuation_picked_up": {
    en: "Picked up the task redelegated to '%s' (from run %s)",
    zh: "已接手转交给 '%s' 的任务（来自运行 %s）",
  },
  "delta.preflight.unsupported_stage": {
    en: "roll delta preflight supports only the managed builder stage (got '%s')",
    zh: "roll delta preflight 仅支持受管理的建造者阶段（收到 '%s'）",
  },
  "delta.preflight.managed_required": {
    en: "roll delta preflight requires managed workspace facts (legacy or missing preparation)",
    zh: "roll delta preflight 需要受管理的工作区事实（旧版或缺失的准备数据）",
  },
  "delta.preflight.passed": {
    en: "Builder preflight passed: %s is structurally complete",
    zh: "建造者预检通过：%s 在结构上完整",
  },
  "delta.preflight.failed": {
    en: "Builder preflight failed: %s",
    zh: "建造者预检失败：%s",
  },
  "delta.help.preflight": {
    en: "\n  roll delta preflight --delegation <id> --stage builder [--json]\n    Read-only Builder self-check: the same structural checks as formal\n    validation, with no events and no lease/frame/workspace/checkpoint writes.\n    Formal roll delta validate remains the only lifecycle gate.\n\n",
    zh: "\n  roll delta preflight --delegation <id> --stage builder [--json]\n    只读建造者自检：与正式校验相同的结构检查，不写任何事件，也不改动\n    lease/帧/工作区/检查点。正式 roll delta validate 仍是唯一生命周期门。\n\n",
  },
  "delta.help.metrics": {
    en: "\n  roll delta metrics [--from <epoch-ms|ISO>] [--to <epoch-ms|ISO>] [--json]\n    Read immutable event and delivery truth. It never selects a rig, changes priority, or merges.\n\n",
    zh: "\n  roll delta metrics [--from <epoch-ms|ISO>] [--to <epoch-ms|ISO>] [--json]\n    只读不可变事件和交付真相；绝不选择模型组合、改变优先级或合并。\n\n",
  },
  "delta.help.builder_receipt": {
    en: "\n  Managed Builder handoff:\n    Save `roll delta preflight --delegation <id> --stage builder --json` stdout outside the managed frame.\n    Then run validate with `--preflight-receipt <path>`; a missing, stale, or malformed receipt writes no lifecycle event.\n",
    zh: "\n  受管 Builder 交接：\n    把 `roll delta preflight --delegation <id> --stage builder --json` 的 stdout 保存在受管帧外。\n    随后用 `--preflight-receipt <path>` 运行 validate；收据缺失、过期或格式损坏时不写生命周期事件。\n",
  },
  "delta.status.orphan_header": {
    en: "Uncommitted frames:",
    zh: "未提交帧：",
  },
  "delta.status.orphan_status": {
    en: "unknown: uncommitted_delegation_frame",
    zh: "unknown: 未提交委派帧",
  },
  "delta.status.orphan_recovery": {
    en: "release the host-delegation lease then re-prepare or remove the orphan frame",
    zh: "释放 host-delegation 租约后重新 prepare，或清理孤立帧",
  },
  "delta.status.no_delegation": {
    en: "No delegation found.",
    zh: "未找到委派。",
  },
  "delta.prepare.prepared": { en: "Delegation prepared", zh: "委派已准备" },
  "delta.field.run_id": { en: "run ID", zh: "运行 ID" },
  "delta.field.frame": { en: "frame", zh: "帧" },
  "delta.field.workspace": { en: "workspace", zh: "工作区" },
  "delta.field.member": { en: "member", zh: "成员" },
  "delta.field.detached_head": { en: "detached HEAD", zh: "分离 HEAD" },
  "delta.field.publish_ref": { en: "publish ref", zh: "发布引用" },
  "delta.field.delegation": { en: "Delegation", zh: "委派" },
  "delta.field.story": { en: "Story", zh: "故事" },
  "delta.field.status": { en: "Status", zh: "状态" },
  "delta.field.mode": { en: "Mode", zh: "模式" },
  "delta.field.trigger": { en: "Trigger", zh: "触发方式" },
  "delta.field.topology": { en: "Topology", zh: "拓扑" },
  "delta.field.profile": { en: "Profile", zh: "质量配置" },
  "delta.field.cost": { en: "Cost", zh: "成本" },
  "delta.field.roles": { en: "Roles", zh: "角色" },
  "delta.field.block": { en: "Block", zh: "阻塞" },
  "delta.field.terminal": { en: "Terminal", zh: "终态" },
  // `doc_drift.*` — US-RULE-004a soft doc-drift gate diagnostic. Soft mode
  // NEVER blocks: the annotation makes the hit observable while exit stays 0.
  "doc_drift.soft_hit.summary": {
    en: "doc-drift soft hit %s: %d surface(s) changed without their declared docs (gate=soft, exit unchanged)",
    zh: "doc-drift soft hit %s:%d 个文档面的源码已改动但声明文档未同步(gate=soft,退出码不变)",
  },
  "doc_drift.soft_hit.surface": {
    en: "surface %s: %s",
    zh: "文档面 %s:%s",
  },
};
