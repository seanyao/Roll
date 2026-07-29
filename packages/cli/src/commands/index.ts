/** Ported-command registry — one line per migrated subcommand. */
import { resolveLang } from "@roll/spec";
import { registerPorted, usage } from "../bridge.js";
import { renderState } from "../render.js";
import { renderLoopHelp } from "../lib/loop-help.js";
import { agentCommand } from "./agent.js";
import { agentListCommand } from "./agent-list.js";
import { alertCommand } from "./alert.js";
import { attestCommand } from "./attest.js";
import { backlogCommand } from "./backlog.js";
import {
  backlogClaimCommand,
  backlogLintCommand,
  backlogSetStatusCommand,
  backlogUnstickCommand,
} from "./backlog-mgmt.js";
import { backlogSyncCommand } from "./backlog-sync.js";
import {
  loopAgentRoutesCommand,
  loopEnforceTcrCommand,
  loopHotfixHeadContextCommand,
  loopNotifyCommand,
  loopPrecheckCiCommand,
  loopUnknownSubcommand,
} from "./loop-cycle-gates.js";
// US-DOSSIER-037: `roll cast` (routing view) + `roll doc --lang` (Charter/guide viewer).
import { castCommand } from "./cast.js";
import { DOC_USAGE, docCommand } from "./doc.js";
import { ciCommand, ciWaitCommand } from "./ci.js";
import { configCommand } from "./config.js";
import { cycleCommand } from "./cycle.js";
import { cyclesCommand } from "./cycles.js";
import { SUPERVISOR_USAGE, supervisorCommand } from "./supervisor.js";
import { dashboardCommand, loopEvalCommand, loopStoryCommand } from "./dashboard.js";
import { loopRunsCommand } from "./loop-runs.js";
import { loopSignalsCommand } from "./loop-signals.js";
import { loopAdversarialCommand } from "./loop-adversarial.js";
import { loopLogCommand } from "./loop-log.js";
import { loopGoalCommand } from "./loop-goal.js";
import { loopGoCommand } from "./loop-go.js";
import { loopRecoverCommand } from "./loop-recover.js";
import { loopPardonSkipListCommand } from "./loop-pardon-skip-list.js";
import { loopEventsCommand } from "./loop-events.js";
import { doctorCommand, languageAuditCommand, doctorPardonCommand } from "./doctor.js";
import { browserCommand } from "./browser.js";
import { dreamCommand } from "./dream.js";
import { ideaCommand } from "./idea.js";
import { indexCommand } from "./index-gen.js";
import { storyNewCommand } from "./story-new.js";
import { storyValidateCommand } from "./story-validate.js";
import { initCommand } from "./init.js";
import { NEXT_USAGE, nextCommand } from "./next.js";
import { northCommand } from "./north.js";
import { designCommand } from "./design.js";
// REFACTOR-049: `roll lang` retired → use `roll config lang <zh|en|--reset>`.
// The lang module's write/clear/read surfaces are consumed by config.ts.
import { loopFmtCommand } from "./loop-fmt.js";
import { loopWatchCommand } from "./loop-watch.js";
import {
  loopGcCommand,
  loopMuteCommand,
  loopResetCommand,
  loopTestCommand,
  loopUnmuteCommand,
} from "./loop-maint.js";
import { loopReconcileCommand } from "./loop-reconcile.js";
import { loopReconcilePendingCommand } from "./loop-reconcile-pending.js";
import { loopReviewResizeCommand } from "./loop-review-resize.js";
import { loopExhaustionSplitCommand } from "./loop-exhaustion-split.js";
import { loopRunOnceCommand } from "./loop-run-once.js";
import { loopSelfDowngradeCommand } from "./loop-self-downgrade.js";
import {
} from "./loop-sched.js";
import { offboardCommand } from "./offboard.js";
import { pricesCommand } from "./prices.js";
import { pulseCommand } from "./pulse.js";
import { releaseCommand } from "./release.js";
import { setupCommand } from "./setup.js";
import { showcaseCommand } from "./showcase.js";
import { skillsCommand } from "./skills.js";
import { statusCommand } from "./status.js";
import { testCommand } from "./test.js";
import { toolCommand } from "./tool.js";
import { captureCommand } from "./capture.js";
import { TRUTH_USAGE, truthCommand } from "./truth.js";
import { tuneCommand } from "./tune.js";
import { updateCommand } from "./update.js";
import { versionCommand } from "./version.js";
import { worktreeAuditCommand } from "./worktree-audit.js";
import { worktreeCleanupCommand } from "./worktree-cleanup.js";
import { deltaCommand } from "./delta.js";

let registered = false;

const HELP_USAGE = DOC_USAGE.replaceAll("roll doc", "roll help");

const CI_USAGE =
  "Usage: roll status ci [--wait] [--timeout=N]\n" +
  "  Show GitHub Actions status for the current HEAD; --wait gates until checks finish.\n";

function currentHelpLang() {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

const DOCTOR_TOOLS_USAGE =
  "Usage: roll doctor tools\n" +
  "  Show registered tools, input contracts, effective policy state, and requirement readiness.\n";

function doctorUsage(): string {
  return currentHelpLang() === "zh"
    ? "用法：roll doctor [skills|language|pardon|repair-protection|--tools]\n  环境与安装体检；--tools 只看工具、真实截图与权限预检就绪度；repair-protection 修复残留主 checkout 写保护；pardon 诊断/重置跳过名单。\n"
    : "Usage: roll doctor [skills|language|pardon|repair-protection|--tools]\n  Environment + install diagnosis; --tools shows focused tool, physical screenshot, and permission preflight readiness; repair-protection clears stale main-checkout write protection; pardon diagnoses/resets the skip-list.\n";
}

function unknownTopLevel(command: string): number {
  process.stderr.write(`roll: unknown command '${command}'\n\n${usage()}`);
  return 1;
}

function removedTopLevel(command: string) {
  return (): number => unknownTopLevel(command);
}

function isHelp(arg: string | undefined): boolean {
  return arg === "help" || arg === "--help" || arg === "-h";
}

export function registerAll(): void {
  if (registered) return;
  registered = true;
  registerPorted("help", (args) => {
    if (isHelp(args[0])) {
      process.stdout.write(`${HELP_USAGE}\n`);
      return 0;
    }
    return docCommand(args);
  }, { help: HELP_USAGE });
  registerPorted("status", (args) => {
    if (args[0] === "ci") {
      const rest = args.slice(1);
      if (isHelp(rest[0])) {
        process.stdout.write(CI_USAGE);
        return 0;
      }
      if (rest.includes("--wait")) return ciWaitCommand(rest);
      return ciCommand(rest) ?? 1;
    }
    if (args[0] === "pulse") return pulseCommand(args.slice(1));
    return statusCommand(args);
  }, { help: "Usage: roll status [ci|pulse]\n  Project health snapshot, CI status, or delivery pulse.\n项目健康、CI 状态或交付脉搏速览。" });
  // REFACTOR-049: `roll lang` retired → use `roll config lang <zh|en|--reset>`.
  // REFACTOR-052: machine-only surfaces stay callable but leave the main usage.
  // Collected top-level verbs print a one-line redirect instead of behaving as
  // long-lived aliases; the live surfaces are nested below loop/release/setup/doctor.
  // US-DOSSIER-032 / US-DOSSIER-036: `roll skills` is a first-class audit+sync
  // surface (the build spec is authoritative; it overrides command-surface-round2
  // which demotes skills to T2). `audit` runs the repo-side strict audit — the
  // ONE yardstick the machine-global Skills page + scripts/audit-skills.mjs read;
  // `sync` installs the catalog; a bare/`help` call prints the usage that names
  // both. The legacy `generate`/`check` still route through the doctor skills /
  // setup skills nests (registered below), so those redirects never break (AC2).
  registerPorted("skills", removedTopLevel("skills"), { hidden: true });
  registerPorted("alert", removedTopLevel("alert"), { hidden: true });
  // `doctor`: all four health sections ported TS (agent/pr/skills/launchd).
  registerPorted("doctor", (args) => {
    if (args[0] === "skills") {
      const rest = args.slice(1);
      if (isHelp(rest[0])) return skillsCommand(["help"]);
      return skillsCommand(["check", ...rest]);
    }
    if (args[0] === "tools") {
      const rest = args.slice(1);
      if (isHelp(rest[0])) {
        process.stdout.write(DOCTOR_TOOLS_USAGE);
        return 0;
      }
      return toolCommand(["status", ...rest]);
    }
    if (args[0] === "language") {
      return languageAuditCommand(args.slice(1));
    }
    if (args[0] === "pardon") {
      return doctorPardonCommand(args.slice(1));
    }
    return doctorCommand(args);
  }, { help: doctorUsage });
  // US-BROW-003: `browser` — DevTools dependency preflight + browser doctor.
  // setup --dry-run never writes; doctor reports managed/interactive/capture readiness.
  // US-BROW-010: `browser update` — check and approve DevTools transport updates.
  registerPorted("browser", (args) => browserCommand(args), {
    help:
      "Usage: roll browser <setup|doctor|run|interactive|update>\n  setup --dry-run previews machine config + preflight; setup --confirm writes ~/.roll/browser-operations.yaml; doctor [--json] reports lane readiness and doctor --probe runs a real chrome-devtools-mcp session end-to-end; run --story <id> --url <target> [--action …] runs one policy-gated managed operation through the real pinned MCP lane with a temporary Chrome profile (diagnostic-only output; --fixture is a test-only fake-target seam, never a fallback); interactive requires an attached TTY and one owner approval before connecting to an already-open loopback Chrome endpoint for one typed low-risk action; update [--check|--apply --confirm] manages transport version.\n浏览器操作依赖预检与体检；setup --dry-run 只预览不写入，doctor 报告 managed/interactive/capture 就绪度、doctor --probe 起真实 chrome-devtools-mcp 会话做端到端活体验证，run --story --url 经策略闸走真实固定版本 MCP 通道对目标跑一次受管操作（临时 Chrome 档案，输出仅诊断；--fixture 是仅测试的假目标接缝，不是回落），interactive 必须附着 TTY 并逐次由 owner 批准，才可连接已开启的本机 Chrome 调试端点执行一个低风险 typed 动作；update 管理传输版本。",
  });
  // US-EVID-032: `capture` — capture-policy migration (best_effort, capability
  // gated + reversible), evidence-only repair (never reopens the build), and
  // readiness status (v2 gateway + renderer + effective policy).
  registerPorted("capture", (args) => captureCommand(args), {
    help:
      "Usage: roll capture <status|migrate|repair|local-window>\n" +
      "  status  [--project <path>] [--json]                 gateway/renderer readiness + effective capture policy\n" +
      "  migrate [--project <path>] [--revert] [--dry-run] [--json]  enable best_effort when capabilities are ready; reversible\n" +
      "  repair  <story-id> [--project <path>] [--health <path>] [--json]  evidence-only repair; never reopens the build\n" +
      "  local-window --story <ID> --url <loopback-url> [--prepare <json>] [--run <id>] [--project <path>] [--json]  isolated local synthetic page only\n",
  });
  // `attest`: the acceptance-evidence report (US-ATTEST-006) — v3-native, no
  // bash counterpart (additive; the evidence chain is new product surface).
  registerPorted("attest", attestCommand, { hidden: true });
  // `cycles`: the cycle ledger as a first-class command (US-CLI-012) — same
  // aggregation + verdict vocabulary as the web ledger; failures never swallowed.
  registerPorted("cycles", removedTopLevel("cycles"));
  // `cycle`: one cycle's trace tape (US-CLI-013) — the `roll cycles` tail hint target.
  registerPorted("cycle", removedTopLevel("cycle"));
  // US-V4-008: `supervisor` — the project-level Supervisor (observe/advise).
  // Cross-Story coordination, never Story implementation.
  registerPorted("supervisor", supervisorCommand, { help: SUPERVISOR_USAGE });
  // FIX-343 (AC1): the agent-facing self-grade command is REMOVED. The working
  // agent never grades its own delivery; the cycle's Review Score is produced
  // solely by a fresh-session peer Reviewer (runScorePairing). The only writer of
  // a score note is that Reviewer path, which always sets `scoring: 'pair'`.
  // `index`: regenerate the backlog-derived ID→epic map (US-META-001). v3-native.
  registerPorted("index", (args) => (args[0] === "--rebuild" ? indexCommand(args) : unknownTopLevel("index")), { hidden: true });
  // `ls`: the cross-project registry listing (US-DOSSIER-028) — name·tag·verdict·path
  // from ~/.roll/projects.json; --json echoes the file verbatim. ONE registry, two
  // faces (this + the web switcher); missing/stale rows flagged, never dropped.
  registerPorted("ls", removedTopLevel("ls"));
  // `story new`: internal/advanced explicit card-folder minting (US-META-009).
  // REFACTOR-050: `roll idea` is now the one user-facing card-capture entry;
  // `story new` is retained for agents/skills that need explicit ID+epic control.
  registerPorted("story", (args) => {
    if (args[0] === "new") return storyNewCommand(args.slice(1));
    // FIX-339 (AC7): `story validate <ID>` — must-declare + visual-evidence-AC
    // self-check, the command-side of the AC6 hard闸 (roll-design prefills it).
    if (args[0] === "validate") return storyValidateCommand(args.slice(1));
    process.stdout.write(
      "Usage: roll story new <ID> --title <text> [--epic <epic>] [--note <text>]\n" +
        "       roll story validate <ID>\n",
    );
    return args[0] === undefined || args[0] === "--help" || args[0] === "-h" ? 0 : 1;
  });
  // `gc`: age out old surplus attest runs across the archive layout (US-META-001).
  registerPorted("gc", removedTopLevel("gc"), { hidden: true });
  // REFACTOR-048: `archive migrate` (old verification/<ID> tree port) retired —
  // that one-time migration completed (US-META-002a..c); cleanup lives in `gc`,
  // dossier reconciliation in `roll index --rebuild`.
  // `dream`: full surface TS (US-PORT-020). `run-once` is the v3-native scan
  // heart; every other arg mirrors v2's generic unknown-command surface without
  // shelling to bin/roll.
  registerPorted("dream", dreamCommand, { hidden: true, help: "Usage: roll dream run-once\n  Nightly self-scan (patterns, docs freshness, test quality) — run one pass now.\n夜间自检跑一遍。" });
  // `agent`: full surface TS (view/list/use/set/unknown). The write face owns
  // .roll/agents.yaml plus legacy .roll/local.yaml sync; no bash fallback.
  registerPorted("agent", (args) => {
    if (args[0] === "cast") return castCommand(args.slice(1));
    return agentCommand(args);
  }, { help: "Usage: roll agent [migrate [--dry-run]|list|cast]\n  View Agent Scope roles, migrate legacy config, list installed agents, or print role casting.\n查看 Agent Scope 角色、迁移旧配置、列出 installed agent，或打印角色分工。" });
  registerPorted("agents", agentListCommand, { hidden: true }); // US-AGENT-048: bash-oracle `roll agents` alias for `roll agent list`
  // `pair`: v3-native Cross-Agent Pairing (US-PAIR-001). `pair init` scaffolds
  // legacy pairing compatibility commands. No bash fallback
  // (v2 had no pairing).
  registerPorted("pair", removedTopLevel("pair"));
  // `peer`: v3-native one-shot heterogeneous peer review adapter (FIX-255).
  // This is a product-level command, distinct from cycle `pair` gates, and does
  // not fall back to the retired bash peer surface.
  registerPorted("peer", removedTopLevel("peer"));
  // `backlog`: FULLY TS as of US-PORT-019. Display + block/defer/unblock/promote
  // + lint + unstick + sync (GitHub issues→backlog) all run native; no bash
  // fallback remains.
  registerPorted("backlog", (args) => {
    const sub = args[0];
    if (sub === "block" || sub === "defer" || sub === "unblock" || sub === "promote") {
      return backlogSetStatusCommand(sub, args.slice(1));
    }
    if (sub === "claim") return backlogClaimCommand(args.slice(1));
    if (sub === "lint") return backlogLintCommand(args.slice(1));
    if (sub === "unstick") return backlogUnstickCommand(args.slice(1));
    if (sub === "sync") return backlogSyncCommand(args.slice(1));
    return backlogCommand(args);
  }, { help: "Usage: roll backlog\n  Render the backlog board.\n渲染任务板。" });
  // FIX-356a: `roll brief` retired — US-PORT-002 was an immature owner digest.
  // The absent-command convention (standard unknown-command error from the bridge)
  // is the chosen retired-surface behaviour.
  // US-DOSSIER-037: `roll cast` — the same role Casting table
  // the static archive renders (US-DOSSIER-030 Casting grid). ONE computation, two
  // surfaces: it calls the shared `collectCasting()` view-model (no re-read of the
  // router); `--json` emits that view-model verbatim. Manual, read-only.
  registerPorted("cast", removedTopLevel("cast"));
  // US-DOSSIER-037: `roll doc [--lang en|zh] [name]` — view Charter/guide markdown
  // in the terminal via the SAME `collectCharter()` collector the web Charter
  // browser uses (US-DOSSIER-033), rendered as readable text. `--lang` selects the
  // guide tree, falling back to the configured language via the SAME resolver
  // `roll lang` uses; an unknown --lang exits non-zero bilingually. Read-only viewer.
  registerPorted("doc", removedTopLevel("doc"));
  // `idea`: v3-native deterministic backlog capture (US-PORT-003). Classifies
  // bug→FIX / idea→IDEA, auto-numbers (max suffix + 1), lint-gates the
  // description with the same rules as the bash _backlog_lint oracle, and
  // appends through BacklogStore's optimistic atomic write (与 backlog 存取同源).
  // A lint violation reports and refuses — no bad card is ever written.
  // No bash fallback: v2 had no `roll idea` command (capture was skill-only).
  registerPorted("idea", ideaCommand);
  // `release`: v3-native read-only release guidance (US-PORT-004). Computes the
  // next calver version from package.json + today, surfaces changelog readiness,
  // and prints the PR/tag flow + the CI consistency-gate note. It NEVER bumps,
  // commits, tags, or publishes — a release is always a human decision (loop
  // hard rule). No bash fallback: v2 had no `roll release` subcommand (the flow
  // lived in the private ops wrapper, which stays for the actual publish).
  // US-REL-007: ONE release command. The transaction (bump → changelog fold →
  // package gate → PR → merge → consistency gate → tag push) lives in the
  // command itself; the old ship/waiver/changelog/consistency sub-routes exit
  // through the normal unknown-route error. npm publish stays the owner's
  // separate, 2FA-authenticated step.
  registerPorted("release", (args) => {
    if (args[0] === "showcase") return showcaseCommand(args.slice(1));
    return releaseCommand(args);
  });
  // US-SHOW-001: `roll showcase` — the golden-path standard E2E. Resets the
  // target card in a throwaway sandbox, casts an explicit strict-diversity real-agent trio
  // (builder=kimi / reviewer=claude / scorer=pi), delivers it via `roll loop
  // go`, captures fresh CLI+web screenshots, assembles the full evidence chain,
  // and emits a pass/fail verdict. The real-agent step is the only
  // non-deterministic one (delegated to `loop go`); the orchestration heart
  // (reset / casting validation / chain assembly / verdict) is the pure
  // ../lib/showcase.ts, unit-tested in the normal suite. Never touches the main
  // repo or the real ~/.roll. Release-runnable (recommended, non-hard-blocking).
  registerPorted("showcase", removedTopLevel("showcase"));
  // `prices`: full surface TS (show/help/unknown + refresh network write).
  // `refresh` uses the native vendor registry/parser/snapshot writer; no bash
  // fallback remains (US-PORT-017). REFACTOR-051 owner review kept this as the
  // human-operated cost-accounting source.
  registerPorted("pulse", removedTopLevel("pulse"));
  registerPorted("prices", removedTopLevel("prices"));
  // `config`: FULLY TS now (US-PORT-006 — 整个 config 命令收口). Read surface
  // (help/--list/key read) + write surface + the three compact facades
  // (loop-window/loop-schedule/dream-time) all run native; no bash fallback.
  // DELIBERATE divergence: a config write no longer implicitly remounts launchd
  // (apply a new schedule with `roll loop on`); CLI output stays byte-identical
  // to v2, and the v2 `_config_resolve` `set -u` crash on a missing global file
  // is fixed. See config.ts header.
  registerPorted("config", (args) => {
    if (args[0] === "prices") return pricesCommand(args.slice(1));
    if (args[0] === "tune") return tuneCommand(args.slice(1));
    return configCommand(args);
  });
  // `changelog`: fully TS, deterministic-canonical (US-PORT-005). The v2 default
  // `generate` shelled the configured agent to AI-restyle the draft (and the
  // dispatch fell back to bash to do it); that path is RETIRED. The deterministic
  // draft is now the only output, produced natively in TS — no bash fallback,
  // no agent, no warn noise. `--no-ai` is kept as an accepted no-op.
  // `consistency`: check/--json/--project-dir + help + unknown all TS (full
  // surface ported; the python orchestrator is reimplemented byte-for-byte).
  // REFACTOR-051: `roll feedback` retired. Use `roll idea` for backlog capture
  // or `gh issue create` for GitHub issues.
  // `init`: full surface TS (fresh/re-init scaffold, existing-codebase onboard
  // launcher, --apply plan consumption, unknown flags, and no-template guard).
  // No sub-paths on bash.
  registerPorted("init", initCommand, { help: "Usage: roll init [--auto|--repair|--apply] [--yes|--then design]\n  Diagnose this project and route to scaffold, PRD design, existing-codebase onboard, repair, migration, or roll status.\n  --auto: apply deterministic fresh-project scaffolding in non-interactive runs.\n  --repair: repair partial Roll markers only.\n  --apply: validate and apply a reviewed existing-codebase onboard plan.\n  --yes / --then design: after scaffolding a PRD project, continue straight into `roll design` (skips the confirm prompt).\n诊断项目并路由到骨架、PRD 设计、已有代码库接入、修复、迁移或 roll status。\n  --apply：校验并应用已审阅的已有代码库接入计划。\n  --yes / --then design：脚手架搭好后直接续跑 `roll design`（跳过确认）。" });
  registerPorted("next", nextCommand, { help: NEXT_USAGE });
  registerPorted("north", northCommand, {
    help: () =>
      currentHelpLang() === "zh"
        ? "用法：roll north [--json] [--no-color]\n  渲染北极星终端面板，或输出原始 roll.north.v1 指标 JSON。\n  四项指标：自主运行时长、交付率、修复税、归因错误；显示当前值、目标、14 天趋势条、趋势箭头和状态。\n  null 表示暂无数据，面板会给出原因。\n"
        : "Usage: roll north [--json] [--no-color]\n  Render the north-star terminal panel, or emit the raw roll.north.v1 metrics JSON.\n  Metrics: autonomy, delivery rate, fix tax, and attribution errors; each shows current value, target, 14-day sparkline, trend arrow, and status.\n  null means no data yet; the panel prints the reason.\n",
  });
  // `design`: explicit thin entry point for the $roll-design skill
  // (US-ONBOARD-NUDGE-004). Loads the skill and launches the selected agent;
  // all design logic lives in the skill, not here.
  registerPorted("design", designCommand, { help: "Usage: roll design [--from-file <path> | \"<requirement>\"] [--agent <name>] [--verbose|--raw]\n  Launch $roll-design interactively with bounded live progress, card-created events, quiet heartbeats, and final handoff; when new Todo cards are created, offer `roll loop go --review auto` after showing agent-pool health.\n交互式启动 $roll-design；默认实时显示有界进展、建卡事件、静默心跳和最终交付；产出新 Todo 卡时会显示 agent 池健康概况，并提议启动 `roll loop go --review auto`。" });
  // REFACTOR-048: `migrate-features` (card-skeleton backfill for pre-card-era
  // stories, US-META-007) retired — that one-time backfill completed; new cards
  // are minted via `roll story new`.
  // REFACTOR-051: `roll migrate` retired from v3. Pre-2.0 projects should pin
  // the old toolchain (`npx @seanyao/roll@2 migrate`) for the one-time upgrade.
  // `offboard`: full surface TS (changeset parse, cross-project guard, plan
  // print, FIX-125 in-cycle plist tripwire, --confirm apply). No bash fallback.
  registerPorted("offboard", removedTopLevel("offboard"));
  // `setup`: full surface TS (fresh / --force / already-synced re-run,
  // unknown-argument, and no-conventions-source guard). No sub-paths on bash.
  registerPorted("setup", (args) => {
    if (args[0] === "skills") {
      const rest = args.slice(1);
      if (isHelp(rest[0])) return skillsCommand(["help"]);
      return skillsCommand(["generate", ...rest]);
    }
    if (args[0] === "offboard") return offboardCommand(args.slice(1));
    return setupCommand(args);
  }, { help: "Usage: roll setup [-f|--force] [--reselect] [--no-capture-install]\n       roll setup skills [args...]\n       roll setup offboard [args...]\n  Install or re-sync Roll conventions/templates for this machine; use -f to force refresh; --no-capture-install skips Roll Capture.app repair.\n本机安装或重新同步 Roll 模板与约定；-f 强制刷新；--no-capture-install 跳过 Roll Capture.app 修复。" });
  // `ci`: the READ surface is TS (no-flag / `--timeout=N` status report:
  // gh-absent warn, not-a-git-repo err, gh-run-list failure, no-runs note, and
  // the per-run "<name>: <status>/<conclusion>" listing). The `--wait` CI gate
  // (_ci_wait's polling loop) returns null → falls back to the frozen bash.
  registerPorted("ci", (args) => {
    if (args.includes("--wait")) return ciWaitCommand(args); // US-PORT-015: TS CI gate
    return unknownTopLevel("ci");
  });
  // `test`: full surface TS (arg parse, --where routing, --reset lock+dispatch,
  // the default exec path through the isolation adapter). type=none runs the
  // suite on the host via a forwarded `npm test`; any other configured type
  // (incl. a stale `tart` — lane removed by REFACTOR-046) errors non-zero WITHOUT a
  // silent host fallback (US-ISO-003). No sub-paths on bash.
  registerPorted("test", testCommand);
  registerPorted("tool", removedTopLevel("tool"));
  // `truth`: deterministic delivery-truth query (US-TRUTH-016). Pure read-only
  // — reads deliveries.jsonl, runs queryStoryDelivery, prints the verdict.
  // Zero markdown parse. `--json` emits the StoryDeliveryTruth verbatim.
  registerPorted("truth", truthCommand, { help: TRUTH_USAGE, hidden: true });
  // `tune`: v3-native US-EVID-015 second-order control loop, READ-ONLY. Aggregates
  // four trend signals (review-score notes / runs.jsonl pass rate / events.ndjson
  // misjudgments / runs result_eval.dims rubric relevance) into the pure
  // buildSelfTuningPlan, which emits suggest-only proposals with evidence +
  // rollback. NEVER writes policy/agents/rubric config; `tune reset` prints the
  // default rollback values without touching disk. No bash fallback (v2 had none).
  registerPorted("tune", removedTopLevel("tune"));
  // `update`: full surface TS (npm + curl upgrade paths, cache invalidation, the
  // post-update `roll setup` chain, changelog). The real install is driven via
  // spawned npm/curl/tar; the curl atomic dir-swap is the one whitelisted gap.
  // No sub-paths on bash.
  registerPorted("update", updateCommand, { help: "Usage: roll update\n  Upgrade the global roll to the latest release (network + global writes).\n升级全局 roll——有副作用,--help 永不触发。" });
  // `version` / `--version` / `-v`: TS-native (FIX-202). Reads the install
  // tree's package.json (single source of truth), so it no longer reports the
  // fossil bin/roll VERSION= literal. No bash fallback for these.
  registerPorted("version", removedTopLevel("version"), { hidden: true });
  registerPorted("--version", versionCommand);
  registerPorted("-v", versionCommand);
  // US-LOOP-093: `worktree audit` — read-only worktree lifecycle audit
  // FIX-1273: `worktree cleanup` — safe, audit-derived recovery for canary pressure
  registerPorted("delta", deltaCommand, { hidden: true });
  registerPorted("worktree", (args): number | Promise<number> => {
    if (args[0] === "audit") return worktreeAuditCommand(args.slice(1));
    if (args[0] === "cleanup") return worktreeCleanupCommand(args.slice(1));
    process.stderr.write("roll worktree: unknown subcommand. Try 'roll worktree audit' or 'roll worktree cleanup'.\n");
    return 1;
  }, { help: "Usage: roll worktree <audit|cleanup> [options]\n  audit    Read-only audit of all git worktrees: ownership, dirt, merge evidence, disposition.\n  cleanup  Safe, audit-derived recovery for branch/worktree canary pressure (--dry-run first, then --apply, then roll loop resume).\n只读审计所有 git worktree,并对 canary 压力提供仅基于审计的安全清理(先 --dry-run,再 --apply,最后 roll loop resume)。" });
  // `loop` is FULLY TS as of US-PORT-021 prep — no subcommand falls back to bash.
  // `on` generates the v3 self-contained runner (DELIBERATE divergence from the
  // v2 tmux outer/inner pair, whitelisted in AGENTS.md). Bare `roll loop`
  // defaults to status (mirrors the v2 `${1:-status}`).
  registerPorted("loop", (args) => {
    // US-EVID-032: `loop status --capture` exposes v2 gateway + renderer
    // readiness and the effective capture policy (AC4). Additive flag — the
    // default `loop status` dashboard output is unchanged.
    if ((args[0] === undefined || args[0] === "status") && args.includes("--capture")) {
      return captureCommand(["status", ...args.slice(1).filter((a) => a !== "--capture")]);
    }
    if (args[0] === undefined || args[0] === "status") return dashboardCommand(args.slice(1));
    // `loop eval` / `loop story`: read-face commands (US-PORT-007) — thin TS
    // readers over the same cycle pipeline `loop status` owns. No bash fallback.
    if (args[0] === "eval") return loopEvalCommand(args.slice(1));
    if (args[0] === "story") return loopStoryCommand(args.slice(1));
    if (args[0] === "runs") return loopRunsCommand(args.slice(1));
    if (args[0] === "cycles") return cyclesCommand(args.slice(1));
    if (args[0] === "cycle") return cycleCommand(args.slice(1));
    if (args[0] === "goal") return loopGoalCommand(args.slice(1));
    if (args[0] === "go") return loopGoCommand(args.slice(1));
    // `loop recover [<story-id>] [--apply]`: the supervised recovery path out of
    // a no-progress STOP (FIX-1049). Without --apply it prints the auditable
    // stall facts (blocked card, streak, last/next Builder, handoff to inspect);
    // with --apply it clears the stall for ONE retry by a DIFFERENT Builder, or
    // denies + explains when no alternate Builder exists. Never bypasses the
    // breaker silently — records a `goal:recovery` event either way.
    if (args[0] === "recover") return loopRecoverCommand(args.slice(1));
    if (args[0] === "pardon-skip-list") return loopPardonSkipListCommand(args.slice(1));
    if (args[0] === "signals") return loopSignalsCommand(args.slice(1));
    // `loop adversarial [--json]`: US-LOOP-104 read-only shadow-run aggregate —
    // adversarial vs standard cohort metrics folded from runs.jsonl.
    if (args[0] === "adversarial") return loopAdversarialCommand(args.slice(1));
    // `loop log` / `loop events`: residual pure-read viewers (US-PORT-022) over
    // .roll/cycle-logs and the shared events ndjson. No bash fallback.
    if (args[0] === "log") return loopLogCommand(args.slice(1));
    if (args[0] === "events") return loopEventsCommand(args.slice(1));
    if (args[0] === "alert") return alertCommand(args.slice(1));
    // `loop monitor` / `loop attach`: retired aliases are gone from dispatch;
    // the tested stub helpers stay only as historical format fixtures.
    if (args[0] === "monitor") return loopUnknownSubcommand(args[0]);
    if (args[0] === "attach") return loopUnknownSubcommand(args[0]);
    if (args[0] === "run-once") return loopRunOnceCommand(args.slice(1));
    // `loop self-downgrade <story> <reason> [subs]`: park a too-big story at
    // 🚫 Hold + append its sub-stories (US-AGENT-042). The roll-build/roll-fix
    // pre-flight and the reviewer-trigger (US-AGENT-041) invoke this.
    if (args[0] === "self-downgrade") return loopSelfDowngradeCommand(args.slice(1));
    // `loop review-resize <story>`: reviewer-triggered re-split (US-AGENT-041) —
    // if the latest peer score flagged the scope too large, design sub-stories
    // from the gaps, gate on heterogeneous consensus, then self-downgrade.
    if (args[0] === "review-resize") return loopReviewResizeCommand(args.slice(1));
    // `loop exhaustion-split <story> [reason]`: agent-exhaustion auto-split
    // (FIX-931) — after FIX-930's rotation exhausts every rig on a card,
    // $roll-design mints sub-stories, then self-downgrade parks the parent.
    if (args[0] === "exhaustion-split") return loopExhaustionSplitCommand(args.slice(1));
    // `loop fmt`: the observation-window formatter (US-PORT-012) — stdin
    // stream-json → three-tier transcript. v3-native; the watch pipe feeds it.
    if (args[0] === "fmt") return loopFmtCommand(args.slice(1));
    // `loop watch`: the one-command, READ-ONLY, concise live view (US-LOOP-074) —
    // auto-locates THIS project's .roll/loop/live.log and streams it through the
    // US-LOOP-077 renderer. Never writes/signals the loop; not network-gated
    // (local file tail only — see networkNeeds). `--attach` = tmux attach -r.
    if (args[0] === "watch") return loopWatchCommand(args.slice(1));
    // `loop reconcile`: US-DELIV-002 layered reconcile-from-main — probes
    // awaiting cycles against main (PR state + patch-id), emits delivery:reconciled.
    if (args[0] === "reconcile") return loopReconcileCommand(args.slice(1));
    // `loop reconcile-pending`: FIX-1052 bounded PR polling reconciler — polls
    // pending-merge PRs, fetches origin/main on merge, and updates delivery truth.
    if (args[0] === "reconcile-pending") return loopReconcilePendingCommand(args.slice(1));
    // US-LOOP-113: `on` / `off` / `fallback` / `pause` / `resume` / `now` are gone.
    // They existed to install, remove, or poke a resident scheduler; delivery now
    // runs in the agent session that drives it (`roll loop go`). No stub is left —
    // they fall through to the unknown-subcommand path like any other typo.
    // `loop reset` / `loop mute` / `loop unmute`: residual write/maintenance
    // subcommands (US-PORT-022) — clear per-project state + heal counters, and
    // the auto-attach popup toggle pair. No bash fallback.
    if (args[0] === "reset") return loopResetCommand(args.slice(1));
    if (args[0] === "mute") return loopMuteCommand(args.slice(1));
    if (args[0] === "unmute") return loopUnmuteCommand(args.slice(1));
    // `loop gc` (≠ top-level `roll gc`): garbage-collect orphan slugs + tmp
    // debris + expired backups (US-PORT-022 / US-LOOP-021). FIX-125 gated.
    if (args[0] === "gc") return loopGcCommand(args.slice(1));
    // `loop test` (≠ top-level `roll test`): manual smoke gate — generates the
    // v3 test runner and runs it once with ROLL_LOOP_FORCE=1 (US-PORT-022).
    if (args[0] === "test") return loopTestCommand(args.slice(1));
    // `loop branches`: retired and no longer dispatched.
    if (args[0] === "branches") return loopUnknownSubcommand(args[0]);
    // Cycle-gate subcommands the loop AGENT invokes per the roll-loop skill
    // (US-PORT-021 prerequisite — the last loop fallbacks, now native TS).
    if (args[0] === "notify") return loopNotifyCommand(args.slice(1));
    if (args[0] === "enforce-tcr") return loopEnforceTcrCommand(args.slice(1));
    if (args[0] === "precheck-ci") return loopPrecheckCiCommand(args.slice(1));
    if (args[0] === "hotfix-head-context") return loopHotfixHeadContextCommand(args.slice(1));
    if (args[0] === "agent-routes") return loopAgentRoutesCommand(args.slice(1));
    if (args[0] === "test-quality-check") return loopUnknownSubcommand(args[0]);
    // Anything else is an unknown loop subcommand — print the v2 usage, exit 1
    // (no bash fallback remains; bin/roll is being retired in US-PORT-021).
    return loopUnknownSubcommand(args[0]);
  }, {
    // US-DOSSIER-035: a help PROVIDER (not a static string) so `roll loop --help`
    // renders the grouped (control/observe/alerts/maintain) bands locale-resolved
    // — single-language per resolved locale — while still routing through the
    // bridge's central read-only help contract (FIX-239).
    help: () => {
      const lang = resolveLang({
        rollLang: process.env["ROLL_LANG"],
        lcAll: process.env["LC_ALL"],
        lang: process.env["LANG"],
      });
      if (!process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "") renderState.useColor = false;
      return renderLoopHelp(lang);
    },
  });
}
