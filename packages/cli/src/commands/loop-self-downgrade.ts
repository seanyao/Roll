/**
 * @responsibility Runs the `roll loop self-downgrade` subcommand, downgrading a story's delivery tier.
 */
/**
 * `roll loop self-downgrade <story-id> "<reason>" [sub-a,sub-b,...]`
 *
 * US-AGENT-042 — the v3-native self-downgrade the skill contracts call when a
 * cycle's pre-flight (roll-build/roll-fix) or a reviewer (US-AGENT-041) judges a
 * story too big for one cycle. Rebuilds the v2/bash `_loop_self_downgrade`
 * surface that the TS port left dangling (FIX-364): v3 `roll` is a binary and
 * cannot be `source`d, so the old `bash -c 'source roll; _loop_self_downgrade'`
 * line could never have run.
 *
 * Behaviour:
 *   - Park the parent at 🚫 Hold (a grouping row the picker skips).
 *   - Append the sub-stories as fresh 📋 Todo rows, each inheriting the parent's
 *     ORIGINAL inbound `depends-on` (never the parked parent — that would
 *     deadlock) plus `chain_depth = parent + 1`.
 *   - Close the parent's open PR + delete its branch if one exists (invariant
 *     I3) — best-effort, never fatal.
 *   - Record a `story:split` event for reconciliation.
 *   - CHAIN-DEPTH CAP (US-AGENT-009): a parent whose chain already auto-split
 *     CHAIN_DEPTH_CAP times, or a story that yields < 2 sub-stories, is REFUSED a
 *     split — parked at Hold with an ALERT for human triage (a `story:split`
 *     with `capped: true`), no children appended.
 *
 * Runs from the cycle worktree (cwd) whose `.roll` is symlinked to the real
 * project `.roll`, so the backlog/events writes land on the MAIN backlog the
 * picker reads (FIX-204C). Resolves the project via ROLL_MAIN_PROJECT || cwd.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BacklogStore,
  CHAIN_DEPTH_CAP,
  ConflictError,
  EventBus,
  type ResolvedChild,
  applySelfDowngradeToBacklog,
  buildStorySplitEvent,
  openPrForStory,
  parseChainDepth,
  parseDependsOn,
  planSelfDowngrade,
} from "@roll/core";
import { ghRepoSlug, ghWithRetry, remoteUrl } from "@roll/infra";
import { projectSlug } from "./dashboard.js";

/** Side-effects the command injects (real by default; faked in tests). */
export interface SelfDowngradeDeps {
  /** Epoch-ms clock for event timestamps. */
  now: () => number;
  /**
   * Close a PR and delete its head branch (I3). Returns true on success. Real
   * impl: `gh -R <slug> pr close <n> --delete-branch --comment <reason>` with
   * transient-EOF retry. Best-effort — a failure never fails the downgrade.
   */
  closePr: (opts: { slug?: string; prNumber: number; reason: string }) => Promise<boolean>;
  /** Resolve the GH owner/repo slug for the project (undefined when unknown). */
  repoSlug: (projectPath: string) => Promise<string | undefined>;
}

export function realSelfDowngradeDeps(): SelfDowngradeDeps {
  return {
    now: () => Date.now(),
    repoSlug: async (projectPath) => ghRepoSlug(await remoteUrl(projectPath)),
    closePr: async ({ slug, prNumber, reason }) => {
      const args = [
        ...(slug !== undefined ? ["-R", slug] : []),
        "pr",
        "close",
        String(prNumber),
        "--delete-branch",
        "--comment",
        reason,
      ];
      const r = await ghWithRetry(args);
      return r.code === 0;
    },
  };
}

const FEATURES = (project: string): string => join(project, ".roll", "features");

/** Find the epic dir (under `.roll/features/<epic>/<id>/spec.md`) for a card. */
function findCardEpic(project: string, id: string): string | undefined {
  const base = FEATURES(project);
  if (!existsSync(base)) return undefined;
  for (const epic of readdirSync(base, { withFileTypes: true })) {
    if (!epic.isDirectory()) continue;
    if (existsSync(join(base, epic.name, id, "spec.md"))) return epic.name;
  }
  return undefined;
}

/** Read a card's spec.md `title:` frontmatter; fall back to the id. */
function readCardTitle(project: string, epic: string, id: string): string {
  try {
    const text = readFileSync(join(FEATURES(project), epic, id, "spec.md"), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const m = fm !== null ? /^title:\s*(.+)$/m.exec(fm[1] ?? "") : null;
    const title = (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
    return title !== "" ? title : id;
  } catch {
    return id;
  }
}

/** Read a card's `chain_depth` from its spec.md Agent profile (0 when absent). */
function readSpecChainDepth(project: string, id: string): number {
  const epic = findCardEpic(project, id);
  if (epic === undefined) return 0;
  try {
    return parseChainDepth(readFileSync(join(FEATURES(project), epic, id, "spec.md"), "utf8"));
  } catch {
    return 0;
  }
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function usage(): number {
  process.stderr.write(
    'Usage: roll loop self-downgrade <story-id> "<reason>" [sub-a,sub-b,...]\n' +
      "  Park a too-big story at 🚫 Hold and append its sub-stories as 📋 Todo.\n" +
      "  Omit sub-ids (or pass < 2) to refuse the split and hold for human triage.\n",
  );
  return 2;
}

export async function loopSelfDowngradeCommand(
  argv: string[],
  deps: SelfDowngradeDeps = realSelfDowngradeDeps(),
): Promise<number> {
  const parentId = (argv[0] ?? "").trim();
  const reason = (argv[1] ?? "").trim();
  const subIds = (argv[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parentId === "" || reason === "") return usage();

  const project = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  const backlogPath = join(project, ".roll", "backlog.md");
  const rt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(project, ".roll", "loop");
  const eventsPath = join(rt, "events.ndjson");
  const alertsPath =
    (process.env["ROLL_LOOP_ALERT"] ?? "").trim() ||
    join(rt, `ALERT-${(process.env["ROLL_MAIN_SLUG"] ?? "").trim() || projectSlug(project)}.md`);

  const store = new BacklogStore();
  let snap;
  try {
    snap = store.readBacklog(backlogPath);
  } catch {
    process.stderr.write(`self-downgrade: backlog not found at ${backlogPath}\n`);
    return 1;
  }
  const parent = snap.items.find((it) => it.id === parentId);
  if (parent === undefined) {
    process.stderr.write(`self-downgrade: no backlog row for ${parentId}\n`);
    return 1;
  }

  // chain_depth: prefer the backlog desc tag, fall back to the spec.md profile.
  const descDepth = parseChainDepth(parent.desc);
  const parentChainDepth = descDepth > 0 ? descDepth : readSpecChainDepth(project, parentId);
  const parentDependsOn = parseDependsOn(parent.desc);

  const plan = planSelfDowngrade({ parentId, parentChainDepth, parentDependsOn, subIds });

  const parentEpic = findCardEpic(project, parentId) ?? "autonomous-evolution";
  const children: ResolvedChild[] =
    plan.kind === "split"
      ? plan.children.map((c) => {
          const epic = findCardEpic(project, c.id) ?? parentEpic;
          return { id: c.id, title: readCardTitle(project, epic, c.id), epic, dependsOn: c.dependsOn, chainDepth: c.chainDepth };
        })
      : [];

  // Atomic optimistic backlog write (park parent + append children), retry once
  // if the file changed underfoot (a concurrent cycle's mark).
  try {
    applyBacklog(store, backlogPath, snap.hash, parentId, children);
  } catch (e) {
    if (e instanceof ConflictError) {
      const fresh = store.readBacklog(backlogPath);
      applyBacklog(store, backlogPath, fresh.hash, parentId, children);
    } else {
      throw e;
    }
  }

  const bus = new EventBus();
  // Discover the parent's open PR from the PRE-existing stream (before our split).
  const openPr = openPrForStory(bus.readEvents(eventsPath), parentId);

  const ts = deps.now();
  bus.appendEvent(eventsPath, buildStorySplitEvent(plan, reason, ts));

  if (plan.kind === "cap-hit") {
    const headline =
      plan.capReason === "chain-cap"
        ? `${parentId} hit the self-downgrade chain cap (chain_depth=${plan.chainDepth} ≥ ${CHAIN_DEPTH_CAP}) — held for human triage`
        : `${parentId} could not be split into ≥2 sub-stories (irreducible) — held for human triage`;
    try {
      mkdirSync(dirname(alertsPath), { recursive: true });
      appendFileSync(alertsPath, `[${isoUtc(ts)}] ALERT ${headline}\n`, "utf8");
    } catch {
      /* best-effort: an alert-file blip must not fail the hold */
    }
    bus.appendEvent(eventsPath, { type: "alert:notify", channel: "self-downgrade", message: headline, ts });
  }

  // I3: close the parent's open PR + delete its branch (best-effort, non-fatal).
  let closedPr: number | null = null;
  if (openPr !== null) {
    const slug = await deps.repoSlug(project).catch(() => undefined);
    const closeReason = `self-downgrade: ${parentId} parked → ${reason}`;
    const ok = await deps
      .closePr({ ...(slug !== undefined ? { slug } : {}), prNumber: openPr, reason: closeReason })
      .catch(() => false);
    if (ok) {
      closedPr = openPr;
      bus.appendEvent(eventsPath, { type: "pr:close", prNumber: openPr, reason: closeReason, ts: deps.now() });
    } else {
      process.stderr.write(`self-downgrade: could not close PR #${openPr} for ${parentId} (PR-heal lane will retry)\n`);
    }
  }

  if (plan.kind === "split") {
    process.stdout.write(
      `self-downgrade: ${parentId} → 🚫 Hold; split into ${children.map((c) => c.id).join(", ")} ` +
        `(chain_depth ${plan.chainDepth} → ${plan.chainDepth + 1})` +
        (closedPr !== null ? `; closed PR #${closedPr}` : "") +
        "\n",
    );
  } else {
    process.stdout.write(
      `self-downgrade: ${parentId} → 🚫 Hold; split REFUSED (${plan.capReason}) — ALERT raised for human triage` +
        (closedPr !== null ? `; closed PR #${closedPr}` : "") +
        "\n",
    );
  }
  return 0;
}

function applyBacklog(
  store: BacklogStore,
  path: string,
  expectedHash: string,
  parentId: string,
  children: ResolvedChild[],
): void {
  store.writeBacklog(path, expectedHash, (content) => applySelfDowngradeToBacklog(content, parentId, children));
}
