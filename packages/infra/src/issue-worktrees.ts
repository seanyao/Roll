import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  renderBranchPattern,
  resolveIssueInitPlan,
  resolveRequirementSourcesForStory,
  type IssueInitOutcome,
  type IssueInitTargetPlan,
  type IssueStoryContract,
  type IssueTargetProbeState,
} from "@roll/core";
import {
  ISSUE_MANIFEST_V1,
  parseIssueManifest,
  type IssueManifest,
  type IssueRepositoryTarget,
  type RepositoryBinding,
  type RequirementSourceManifest,
} from "@roll/spec";
import {
  ensureRepositoryCache,
  inspectRepositoryCache,
  resolveRepositoryCacheIdentity,
  withRepositoryCacheLock,
  type RepositoryCacheProbeState,
} from "./repository-cache.js";
import {
  branchExists,
  checkWorktreeCompatibility,
  inspectGovernedBranchState,
  issueWorktreeAdd,
  issueWorktreeIdentity,
  issueWorktreeRemove,
  protectReadOnlyWorktree,
  type ExpectedWorktreeFacts,
} from "./issue-worktree-git.js";
import { git, isImmutableGitObjectId } from "./git.js";
import {
  withWorkspaceAuthorityLock,
  WorkspaceAuthorityLockError,
} from "./workspace-authority-lock.js";

const ISSUE_INIT_JOURNAL_V1 = "roll.issue-init-journal/v1" as const;

export type IssueInitializationErrorCode =
  | "rejected"
  | "manifest_conflict"
  | "apply_failed"
  | "symlink_escape";

export class IssueInitializationError extends Error {
  constructor(readonly code: IssueInitializationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IssueInitializationError";
  }
}

/** Every ancestor segment from `root` down to (and including) `target`,
 *  shallowest first — used to walk a path's containing directories without
 *  ever following a symlink partway through. */
function ancestorSegments(root: string, target: string): string[] {
  const rel = relative(root, target);
  if (rel === "") return [root];
  const parts = rel.split(sep);
  const segments = [root];
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    segments.push(cursor);
  }
  return segments;
}

/** Resolve `path`'s real path using the deepest EXISTING ancestor (walking
 *  up until one is found — the root itself, e.g. a tmpdir, always exists),
 *  then re-appending whatever suffix does not exist yet on disk. This keeps
 *  the "not created yet" case (the common one — `issueRoot` is usually
 *  absent until apply creates it) resolved on the SAME basis as an already-
 *  existing path, so comparing two `realpathOrPending` results never
 *  produces a false mismatch purely from one side being real-resolved (e.g.
 *  macOS `/tmp` → `/private/tmp`) and the other not. */
function realpathOrPending(path: string): string {
  let existing = path;
  const pending: string[] = [];
  while (!existsSync(existing)) {
    const parent = resolve(existing, "..");
    if (parent === existing) break; // filesystem root; stop rather than loop forever.
    pending.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  const real = realpathSync(existing);
  return pending.length === 0 ? real : join(real, ...pending);
}

/** Refuse an Issue root that escapes its Workspace — either because
 *  `issueRoot` (or `workspace/issues`, or any other ancestor between
 *  `workspaceRoot` and `issueRoot`) is ITSELF a symlink, or because its
 *  resolved real path lands outside the Workspace's own real path. Every
 *  ancestor is checked with `lstatSync` (never following a symlink to probe
 *  what it is), so a symlinked `issues/` directory is caught even though its
 *  target might coincidentally still resolve somewhere that LOOKS contained.
 *  A missing ancestor (ENOENT) is fine — creation happens later, after this
 *  check passes; only an EXISTING symlink anywhere in the chain is refused. */
function assertContainedIssueRoot(workspaceRoot: string, issueRoot: string): void {
  const root = resolve(workspaceRoot);
  const target = resolve(issueRoot);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new IssueInitializationError("symlink_escape", "Issue root is not contained within its Workspace");
  }
  for (const segment of ancestorSegments(root, target)) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(segment);
    } catch {
      continue; // ENOENT: not created yet, nothing to escape through.
    }
    if (stat.isSymbolicLink()) {
      throw new IssueInitializationError("symlink_escape", `Issue root path contains a symlink at ${segment}`);
    }
  }
  // Backstop: even if every segment individually looked like a plain
  // directory, the REAL path (after resolving any deeper symlink a bind
  // mount or a component we don't control might introduce) must still land
  // inside the Workspace's real path.
  const realRoot = realpathOrPending(root);
  const realTarget = realpathOrPending(target);
  const realRel = relative(realRoot, realTarget);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || resolve(realRel) === realRel) {
    throw new IssueInitializationError("symlink_escape", "Issue root's real path escapes its Workspace's real path");
  }
}

function manifestPath(issueRoot: string): string {
  return join(issueRoot, "manifest.json");
}

function eventsPath(issueRoot: string): string {
  return join(issueRoot, "events.jsonl");
}

function journalPath(issueRoot: string): string {
  return join(issueRoot, "issue-init.pending.json");
}

/** Every alias already recorded by a prior `issue:repository_bound` event —
 *  an idempotent retry must never emit a second event for the same alias. */
function recordedRepositoryBoundAliases(issueRoot: string): ReadonlySet<string> {
  return new Set(readRepositoryBoundFacts(issueRoot).keys());
}

/** One target's Issue-LOCAL pinned facts — the ONLY source of truth for an
 *  existing target's immutable base once ANY journal or event exists for it.
 *  The shared machine cache's current `refs/remotes/origin/<branch>` is
 *  NEVER consulted for these once pinned: another Workspace sharing that
 *  cache can advance it at any time, and this Issue's target must stay
 *  pinned at whatever base it actually started from. Carries the FULL
 *  identity (workspaceId/storyId/repoId), not just the runtime values,
 *  so a caller can cross-check a pinned fact against the identity it is
 *  CURRENTLY resolving for — a fact recorded under a different
 *  Workspace/Story/repository binding is never silently reused. */
export interface PinnedTargetFacts {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repoId: string;
  readonly baseSha: string;
  readonly access: "read" | "write";
  readonly path: string;
  readonly workBranch: string | null;
}

/** Thrown when an Issue's own persisted facts (journal or events) are
 *  malformed or mutually conflicting for one alias — fails loud rather than
 *  silently ignoring the record or falling back to the shared cache. */
export class PinnedFactsConflictError extends Error {}

function parseRepositoryBoundEvent(raw: unknown, issueRoot: string): { readonly alias: string; readonly fact: PinnedTargetFacts } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const event = raw as Record<string, unknown>;
  if (event["type"] !== "issue:repository_bound") return undefined;
  const alias = event["alias"];
  const workspaceId = event["workspaceId"];
  const storyId = event["storyId"];
  const repoId = event["repoId"];
  const baseSha = event["baseSha"];
  const access = event["access"];
  const worktreePath = event["worktreePath"];
  const workBranch = event["workBranch"];
  if (typeof alias !== "string" || alias === "") {
    throw new PinnedFactsConflictError(`issue:repository_bound event in ${issueRoot} is missing a valid alias`);
  }
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} is missing a valid workspaceId`);
  }
  if (typeof storyId !== "string" || storyId === "") {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} is missing a valid storyId`);
  }
  if (typeof repoId !== "string" || repoId === "") {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} is missing a valid repoId`);
  }
  if (typeof baseSha !== "string" || !isImmutableGitObjectId(baseSha)) {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} has an invalid baseSha (must be a full lowercase hex object id)`);
  }
  if (access !== "read" && access !== "write") {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} has an invalid access value`);
  }
  if (typeof worktreePath !== "string" || worktreePath === "") {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} is missing a valid worktreePath`);
  }
  if (workBranch !== null && typeof workBranch !== "string") {
    throw new PinnedFactsConflictError(`issue:repository_bound event for "${alias}" in ${issueRoot} has an invalid workBranch`);
  }
  return { alias, fact: { workspaceId, storyId, repoId, baseSha, access, path: worktreePath, workBranch: workBranch ?? null } };
}

/** Read every `issue:repository_bound` fact ever durably recorded for this
 *  Issue, keyed by alias. FAILS LOUD (throws {@link PinnedFactsConflictError})
 *  on ANY malformed line — including the trailing one — or when the SAME
 *  alias has two events disagreeing on baseSha/access/path/workBranch. Every
 *  write to this file is now an atomic temp-file + rename (see
 *  {@link appendRepositoryBoundEventsAtomically}), never a partial `flag: "a"` append,
 *  so there is no longer a plausible "benign truncated trailing line"
 *  failure mode to tolerate: any parse failure anywhere in the file is a
 *  genuine corruption, and silently dropping it could un-bind an alias that
 *  had already durably completed, letting a retry recreate/rebind it and
 *  lose the fact that it was ever pinned. */
export function readRepositoryBoundFacts(
  issueRoot: string,
  dependencies: { readonly readText?: (path: string) => string } = {},
): ReadonlyMap<string, PinnedTargetFacts> {
  const path = eventsPath(issueRoot);
  if (dependencies.readText === undefined && !existsSync(path)) return new Map();
  const text = dependencies.readText?.(path) ?? readFileSync(path, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const facts = new Map<string, PinnedTargetFacts>();
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new PinnedFactsConflictError(`events.jsonl in ${issueRoot} has a corrupted line: ${(error as Error).message}`);
    }
    const parsed = parseRepositoryBoundEvent(raw, issueRoot);
    if (parsed === undefined) continue;
    const existing = facts.get(parsed.alias);
    if (existing !== undefined && !pinnedFactsEqual(existing, parsed.fact)) {
      throw new PinnedFactsConflictError(`issue:repository_bound events for "${parsed.alias}" in ${issueRoot} disagree with each other`);
    }
    facts.set(parsed.alias, parsed.fact);
  }
  return facts;
}

/** Append new `issue:repository_bound` event lines to this Issue's
 *  events.jsonl as ONE atomic operation — never a `flag: "a"` append (which
 *  can leave a torn write on a crash mid-syscall). Reads and STRICTLY
 *  validates the entire existing stream first (via {@link readRepositoryBoundFacts}
 *  — any malformed existing line, trailing or not, fails loud here too,
 *  before this function adds anything new), then writes existing-bytes +
 *  new-lines to a temp file and renames it over the real path in one
 *  filesystem operation. A reader can therefore only ever observe the
 *  file in its previous complete state or its next complete state, never a
 *  partially-written one. */
function appendRepositoryBoundEventsAtomically(issueRoot: string, newLines: string): void {
  if (newLines === "") return;
  readRepositoryBoundFacts(issueRoot); // Validates the existing stream is well-formed before extending it.
  const path = eventsPath(issueRoot);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWrite(path, existing + newLines);
}

/** Append one already-validated Issue event using the same strict, atomic stream
 * extension as repository binding. Callers own the event schema and identity;
 * malformed existing streams still fail loud before any write. */
export function appendIssueEventAtomically(issueRoot: string, event: Readonly<Record<string, unknown>>): void {
  appendRepositoryBoundEventsAtomically(issueRoot, `${JSON.stringify(event)}\n`);
}

/** One target's pinned facts as recorded in the CURRENT interrupted journal
 *  — the Issue-local source of truth while a prior apply is mid-flight
 *  (`applying`/`repair_required`), before any event has been durably
 *  written for it. Validates the journal's OWN top-level shape (schema,
 *  status, workspaceId/storyId identity, and a well-formed targets array
 *  with no duplicate alias) before trusting any per-target entry — an old
 *  or hand-edited journal missing these must fail loud rather than let a
 *  caller guess facts from the shared cache instead. */
function readJournalPinnedFacts(issueRoot: string): ReadonlyMap<string, PinnedTargetFacts> {
  const path = journalPath(issueRoot);
  if (!existsSync(path)) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} is not a valid journal record`);
  }
  const journal = raw as Record<string, unknown>;
  if (journal["schema"] !== ISSUE_INIT_JOURNAL_V1) {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} has an unrecognized or missing schema`);
  }
  if (journal["status"] !== "applying" && journal["status"] !== "repair_required") {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} has an invalid status`);
  }
  const journalWorkspaceId = journal["workspaceId"];
  const journalStoryId = journal["storyId"];
  if (typeof journalWorkspaceId !== "string" || journalWorkspaceId === "") {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} is missing a valid workspaceId`);
  }
  if (typeof journalStoryId !== "string" || journalStoryId === "") {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} is missing a valid storyId`);
  }
  const targets = journal["targets"];
  if (!Array.isArray(targets)) {
    throw new PinnedFactsConflictError(`Issue init journal at ${path} is missing a valid targets array`);
  }
  const facts = new Map<string, PinnedTargetFacts>();
  const seenAliases = new Set<string>();
  for (const entry of targets) {
    if (typeof entry !== "object" || entry === null) {
      throw new PinnedFactsConflictError(`Issue init journal at ${path} has a malformed target entry`);
    }
    const record = entry as Record<string, unknown>;
    const alias = record["alias"];
    const repoId = record["repoId"];
    const baseSha = record["baseSha"];
    const access = record["access"];
    const path2 = record["path"];
    const workBranch = record["workBranch"];
    if (typeof alias !== "string" || alias === "") {
      throw new PinnedFactsConflictError(`Issue init journal at ${path} has a target entry with an invalid alias`);
    }
    if (seenAliases.has(alias)) {
      throw new PinnedFactsConflictError(`Issue init journal at ${path} declares alias "${alias}" more than once`);
    }
    seenAliases.add(alias);
    if (typeof repoId !== "string" || repoId === "") {
      throw new PinnedFactsConflictError(`Issue init journal entry for "${alias}" in ${issueRoot} is missing a valid repoId`);
    }
    if (typeof path2 !== "string" || path2 === "") {
      throw new PinnedFactsConflictError(`Issue init journal entry for "${alias}" in ${issueRoot} is missing a valid path`);
    }
    if (access !== "read" && access !== "write") {
      throw new PinnedFactsConflictError(`Issue init journal entry for "${alias}" in ${issueRoot} has an invalid access value`);
    }
    if (workBranch !== null && workBranch !== undefined && typeof workBranch !== "string") {
      throw new PinnedFactsConflictError(`Issue init journal entry for "${alias}" in ${issueRoot} has an invalid workBranch`);
    }
    // A journal is only ever WRITTEN once every declared target's cache and
    // base SHA are fully resolved (see applyIssueInit) — there is no valid
    // "not pinned yet" state for a persisted journal entry to represent.
    // Missing/null/empty/non-string baseSha here means the journal itself
    // is corrupted or predates the pinning contract; it is never silently
    // treated as "nothing pinned yet".
    if (typeof baseSha !== "string" || !isImmutableGitObjectId(baseSha)) {
      throw new PinnedFactsConflictError(`Issue init journal entry for "${alias}" in ${issueRoot} has an invalid baseSha (must be a full lowercase hex object id)`);
    }
    facts.set(alias, {
      workspaceId: journalWorkspaceId,
      storyId: journalStoryId,
      repoId,
      baseSha,
      access,
      path: path2,
      workBranch: (workBranch ?? null) as string | null,
    });
  }
  return facts;
}

export type IssueInitJournalInspection = "absent" | "valid" | "unsupported_schema";

/** Read-only doctor seam over the same strict journal parser used by apply.
 * It exposes no pinned SHA/path/owner facts and only confirms whether the
 * interrupted transaction belongs to the expected Workspace/Story. */
export function inspectIssueInitJournal(
  issueRoot: string,
  expected: { readonly workspaceId: string; readonly storyId: string },
): IssueInitJournalInspection {
  if (!existsSync(journalPath(issueRoot))) return "absent";
  try {
    const facts = readJournalPinnedFacts(issueRoot);
    for (const fact of facts.values()) {
      if (fact.workspaceId !== expected.workspaceId || fact.storyId !== expected.storyId) {
        return "unsupported_schema";
      }
    }
    return "valid";
  } catch {
    return "unsupported_schema";
  }
}

function pinnedFactsEqual(a: PinnedTargetFacts, b: PinnedTargetFacts): boolean {
  return a.workspaceId === b.workspaceId
    && a.storyId === b.storyId
    && a.repoId === b.repoId
    && a.baseSha === b.baseSha
    && a.access === b.access
    && a.path === b.path
    && a.workBranch === b.workBranch;
}

/** Resolve ONE target's pinned base fact set — NOT a "journal wins, else
 *  events" short-circuit. Both sources are parsed and strictly validated
 *  independently; when BOTH have a fact for this alias, they are
 *  cross-checked and any disagreement is a fail-loud
 *  {@link PinnedFactsConflictError} (a lingering journal must never
 *  silently override — or be silently overridden by — the completed
 *  event record). A completed `issue:repository_bound` event is the
 *  source of truth for a target that has ever finished successfully: once
 *  it exists, it is what this function returns, regardless of what a
 *  STALE journal (left behind by some earlier, already-superseded attempt)
 *  happens to also say, AS LONG AS the two agree. A journal-only fact
 *  (no event yet) is returned for a target whose FIRST attempt is still
 *  in flight. `undefined` means genuinely nothing has EVER been pinned
 *  for this alias (a brand-new target) — the caller must resolve a fresh
 *  base from the shared cache and pin it for the first time.
 *
 *  Cross-validates whatever IS found against `expectedIdentity` — the
 *  workspaceId/storyId/repoId this call is CURRENTLY resolving for. A
 *  pinned fact recorded under a different identity (e.g. the Story
 *  Contract's binding for this alias now points at a different repository
 *  than what was originally pinned) is a real conflict, never silently
 *  accepted just because the alias string matches. */
function readPinnedTargetFacts(
  issueRoot: string,
  alias: string,
  expectedIdentity: { readonly workspaceId: string; readonly storyId: string; readonly repoId: string },
): PinnedTargetFacts | undefined {
  const fromJournal = readJournalPinnedFacts(issueRoot).get(alias);
  const fromEvents = readRepositoryBoundFacts(issueRoot).get(alias);
  if (fromJournal !== undefined && fromEvents !== undefined) {
    if (!pinnedFactsEqual(fromJournal, fromEvents)) {
      throw new PinnedFactsConflictError(
        `Issue init journal and completed issue:repository_bound event for "${alias}" in ${issueRoot} disagree — refusing to guess which is authoritative`,
      );
    }
  }
  const resolved = fromEvents ?? fromJournal; // Completed events are the source of truth once a target has ever finished.
  if (resolved === undefined) return undefined;
  if (
    resolved.workspaceId !== expectedIdentity.workspaceId
    || resolved.storyId !== expectedIdentity.storyId
    || resolved.repoId !== expectedIdentity.repoId
  ) {
    throw new PinnedFactsConflictError(
      `Pinned facts for "${alias}" in ${issueRoot} were recorded under a different workspace/story/repository identity than the one currently resolving`,
    );
  }
  return resolved;
}

function integrationRefspecFor(binding: RepositoryBinding): string {
  return `+refs/heads/${binding.integrationBranch}:refs/remotes/origin/${binding.integrationBranch}`;
}

/** Read-only base SHA resolution against an already-cached remote-tracking ref
 *  — never fetches, so callers report the LAST cached base without any write.
 *  ONLY valid for a genuinely brand-new target (no pinned fact exists yet):
 *  once any journal/event has pinned a base for this alias, that pinned
 *  value is the only truth (see {@link readPinnedTargetFacts}) — this
 *  function must never be consulted for an already-pinned target, since the
 *  shared cache's current ref can have advanced independently. */
async function readCachedBaseSha(cachePath: string, integrationBranch: string): Promise<string | null> {
  const result = await git(["rev-parse", `refs/remotes/origin/${integrationBranch}`], cachePath);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Verify a pinned base SHA's commit OBJECT actually exists in this
 *  repository cache — a pinned fact naming a SHA the cache has since lost
 *  (e.g. an aggressive `gc` on a very old pin, or a cache that was
 *  recreated) must never be reported as compatible just because the two
 *  strings match; git itself must confirm the object is really there. */
async function pinnedBaseShaExistsInCache(cachePath: string, baseSha: string): Promise<boolean> {
  const result = await git(["cat-file", "-e", `${baseSha}^{commit}`], cachePath);
  return result.code === 0;
}

/** Resolve the EXPECTED facts for one declared target: its pinned base
 *  (Issue-local facts if any exist; otherwise a fresh preview/resolve of the
 *  shared cache's CURRENT integration ref, for a genuinely brand-new
 *  target only) plus its declared access and governed branch. `baseSha` is
 *  `null` whenever the pinned base's commit object cannot be confirmed
 *  present in the cache — never silently falls back to re-deriving from the
 *  shared ref once a fact is pinned. `isPinned` is true whenever ANY
 *  journal/event fact already exists for this alias — an absent worktree
 *  path for an already-pinned target is a REPAIR, never a fresh "created",
 *  even if the pinned object itself later turns out to be missing (that is
 *  its own separate conflict, not "never existed"). */
async function resolveExpectedTargetFacts(
  issueRoot: string,
  cachePath: string,
  workspaceId: string,
  storyId: string,
  alias: string,
  repoId: string,
  access: "read" | "write",
  workBranch: string | null,
  integrationBranch: string,
): Promise<{ readonly facts: ExpectedWorktreeFacts; readonly isPinned: boolean }> {
  const pinned = readPinnedTargetFacts(issueRoot, alias, { workspaceId, storyId, repoId });
  if (pinned !== undefined) {
    const objectPresent = await pinnedBaseShaExistsInCache(cachePath, pinned.baseSha);
    return { facts: { access, workBranch, baseSha: objectPresent ? pinned.baseSha : null }, isPinned: true };
  }
  const preview = await readCachedBaseSha(cachePath, integrationBranch);
  return { facts: { access, workBranch, baseSha: preview }, isPinned: false };
}

/** Every immutable field the manifest carries for one repository target —
 *  compared in full so a changed requirement/repository/access set under the
 *  same Workspace/Story identity is a manifest_conflict, not silently reused. */
function manifestsMatch(issueRoot: string, onDisk: unknown, expected: IssueManifest): boolean {
  const parsed = parseIssueManifest(onDisk, { workspaceId: expected.workspaceId, storyId: expected.storyId });
  if (!parsed.ok) return false;
  try {
    const repositories = parsed.value.repositories.map((actual, index) => {
      const target = expected.repositories[index];
      if (
        actual.access !== "write" || actual.workBranch !== undefined ||
        target?.access !== "write" || target.workBranch === undefined
      ) return actual;
      const pinned = readPinnedTargetFacts(issueRoot, actual.alias, {
        workspaceId: expected.workspaceId,
        storyId: expected.storyId,
        repoId: actual.repoId,
      });
      if (pinned?.workBranch !== target.workBranch) return actual;
      return { ...actual, workBranch: target.workBranch };
    });
    const actualIntegration = parsed.value.integrationAcceptance;
    const expectedIntegration = expected.integrationAcceptance;
    const writable = parsed.value.repositories.filter((target) => target.access === "write");
    const integrationAcceptance = actualIntegration !== undefined && actualIntegration.cwd === undefined &&
        expectedIntegration?.cwd !== undefined && writable.length === 1 && writable[0]?.alias === expectedIntegration.cwd
      ? { ...actualIntegration, cwd: expectedIntegration.cwd }
      : actualIntegration;
    const normalized: IssueManifest = {
      ...parsed.value,
      repositories,
      ...(integrationAcceptance === undefined ? {} : { integrationAcceptance }),
    };
    // A Requirement campaign target is frozen only when the Issue is created.
    // Adding a target to the same Requirement revision later must not
    // retroactively rewrite or invalidate an existing legacy Issue that did
    // not capture one. Once an Issue carries a target, however, it remains an
    // immutable part of the comparison.
    let comparableExpected: Omit<IssueManifest, "deliveryTarget"> | IssueManifest = expected;
    if (normalized.deliveryTarget === undefined) {
      const { deliveryTarget, ...legacyExpected } = expected;
      void deliveryTarget;
      comparableExpected = legacyExpected;
    }
    return isDeepStrictEqual(normalized, comparableExpected);
  } catch {
    return false;
  }
}

export interface IssueCheckTargetReport {
  readonly alias: string;
  readonly access: "read" | "write";
  readonly repoId: string;
  readonly cachePath: string;
  readonly cacheState: RepositoryCacheProbeState;
  readonly baseSha: string | null;
  readonly worktreePath: string;
  readonly workBranch: string | null;
  readonly decision: IssueInitOutcome | "conflict";
}

export interface IssueCheckReport {
  readonly manifest: { readonly state: IssueTargetProbeState };
  readonly targets: Readonly<Record<string, IssueCheckTargetReport>>;
}

export interface InspectIssueInitInput {
  readonly workspaceId: string;
  readonly rollHome: string;
  /** The Workspace root `issueRoot` must resolve inside of — required so a
   *  symlinked Issue root (or a symlinked ancestor, e.g. `workspace/issues`
   *  itself) escaping the Workspace is caught before any read/report. */
  readonly workspaceRoot: string;
  readonly issueRoot: string;
  readonly contract: IssueStoryContract;
  readonly bindings: readonly RepositoryBinding[];
  /** REQUIRED — `--check` cross-validates the on-disk manifest against the
   *  FULL immutable contract (workspaceId/storyId/requirements/repositories)
   *  via {@link manifestsMatch}, never just identity: a Story Contract or
   *  Requirement-link drift under the same workspaceId/storyId must be
   *  reported as a real manifest conflict, the same parity apply already
   *  enforces. There is no identity-only fallback — every caller must
   *  resolve its Requirement sources before calling check. */
  readonly requirementManifests: readonly RequirementSourceManifest[];
}

/** Build the SAME immutable manifest shape apply would produce for this
 *  contract/bindings/requirements — bound targets only, in declared order —
 *  so `--check` can compare the on-disk manifest against the full contract,
 *  not just its identity. An alias with no matching binding is excluded here
 *  exactly as apply's own plan builder excludes it (never invented into a
 *  fake repository entry) — that target's real conflict is reported
 *  separately, per-target, in {@link inspectIssueInit}'s target loop; this
 *  expected manifest is ONLY ever used for the manifest-identity probe, never
 *  returned or treated as an apply-safe plan. */
function expectedManifestForContract(
  workspaceId: string,
  contract: IssueStoryContract,
  bindingsByAlias: ReadonlyMap<string, RepositoryBinding>,
  requirementManifests: readonly RequirementSourceManifest[],
): IssueManifest {
  const repositories: IssueRepositoryTarget[] = [];
  for (const declared of contract.repositories) {
    const binding = bindingsByAlias.get(declared.alias);
    if (binding === undefined) continue;
    repositories.push(
      declared.access === "read"
        ? { repoId: binding.repoId, alias: declared.alias, access: "read", requiredDelivery: false, ...(declared.dependsOnRepo === undefined ? {} : { dependsOnRepo: declared.dependsOnRepo }) }
        : {
          repoId: binding.repoId,
          alias: declared.alias,
          access: "write",
          requiredDelivery: declared.requiredDelivery,
          noChangePolicy: declared.requiredDelivery ? "changes_required" : "no_change_allowed",
          workBranch: renderBranchPattern(binding.workflow.branchPattern, {
            workspaceId,
            storyId: contract.storyId,
            repoAlias: declared.alias,
          }),
          ...(declared.dependsOnRepo === undefined ? {} : { dependsOnRepo: declared.dependsOnRepo }),
        },
    );
  }
  const linkedRequirements = resolveRequirementSourcesForStory(requirementManifests, contract.storyId);
  const requirements = linkedRequirements
    .map((manifest) => ({ provider: manifest.provider, ref: manifest.ref }));
  const deliveryTargets = new Map(linkedRequirements.flatMap((manifest) =>
    manifest.deliveryTarget === undefined ? [] : [[JSON.stringify(manifest.deliveryTarget), manifest.deliveryTarget] as const]
  ));
  const deliveryTarget = deliveryTargets.size === 1 ? [...deliveryTargets.values()][0] : undefined;
  return {
    schema: ISSUE_MANIFEST_V1,
    workspaceId,
    storyId: contract.storyId,
    requirements,
    repositories,
    ...(contract.integrationAcceptance === undefined ? {} : { integrationAcceptance: contract.integrationAcceptance }),
    ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
  };
}

function probeManifestState(issueRoot: string, expected: IssueManifest): IssueTargetProbeState {
  const interrupted = existsSync(journalPath(issueRoot));
  const path = manifestPath(issueRoot);
  if (!existsSync(path)) return interrupted ? "repairable" : "absent";
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "conflict";
  }
  return manifestsMatch(issueRoot, value, expected) ? "compatible" : "conflict";
}

/** Combine a target's cache state and its real git worktree identity into ONE
 *  probe state the core plan resolver already understands. */
function combineTargetState(cacheState: RepositoryCacheProbeState, worktreeState: IssueTargetProbeState): IssueTargetProbeState {
  if (cacheState === "conflict" || worktreeState === "conflict") return "conflict";
  if (worktreeState === "absent") return cacheState === "compatible" ? "absent" : cacheState;
  return worktreeState;
}

async function resolveAbsentWriteTargetState(
  cachePath: string,
  workBranch: string,
  baseSha: string | null,
  isPinned: boolean,
): Promise<IssueTargetProbeState> {
  if (baseSha === null) {
    return await branchExists(cachePath, workBranch) ? "conflict" : isPinned ? "repairable" : "absent";
  }
  const branchState = await inspectGovernedBranchState(cachePath, workBranch, baseSha);
  if (branchState === "absent") return isPinned ? "repairable" : "absent";
  if (!isPinned) return "conflict";
  return branchState === "conflict" ? "conflict" : "repairable";
}

/** Resolve a target's real worktree state against what THIS Issue target
 *  EXPECTS (its pinned base — never the shared cache's current ref — plus
 *  its declared access and governed branch). A present worktree that fails
 *  {@link checkWorktreeCompatibility} (wrong branch, wrong HEAD not an
 *  ancestor for a write target, wrong HEAD for a read target, or an
 *  unavailable pinned base) is reported as a genuine conflict, never
 *  silently treated as reusable.
 *
 *  `isPinned` distinguishes a genuinely brand-new target (no journal/event
 *  has EVER pinned a base for this alias — an absent worktree there really
 *  is "created" from scratch) from an EXISTING pinned target whose worktree
 *  path just happens to be missing right now (e.g. deleted by hand, or the
 *  Issue was interrupted after pinning but before creating it) — that is a
 *  REPAIR, and must be reported "repairable", never "absent"/"created",
 *  even though this Issue is completely healthy otherwise. */
async function probeWorktreeState(
  path: string,
  cachePath: string,
  expected: ExpectedWorktreeFacts,
  isPinned: boolean,
  inspectGovernedBranch: boolean,
): Promise<IssueTargetProbeState> {
  const identity = await issueWorktreeIdentity(path, cachePath);
  if (identity.state === "absent") {
    if (expected.workBranch === null || !inspectGovernedBranch) return isPinned ? "repairable" : "absent";
    return resolveAbsentWriteTargetState(cachePath, expected.workBranch, expected.baseSha, isPinned);
  }
  if (identity.state === "conflict") return "conflict";
  const compatible = await checkWorktreeCompatibility(identity, cachePath, expected);
  return compatible ? "compatible" : "conflict";
}

/** Fully resolve every declared repository target — cache and real worktree
 *  identity — with ZERO filesystem writes (including the machine Roll Home
 *  cache): `inspectRepositoryCache` never creates roots/locks/journals, and
 *  worktree identity is read-only `git` introspection. */
export async function inspectIssueInit(input: InspectIssueInitInput): Promise<IssueCheckReport> {
  try {
    assertContainedIssueRoot(input.workspaceRoot, input.issueRoot);
  } catch {
    // --check is a zero-write preflight: a contained-root violation is
    // reported as a manifest conflict rather than thrown, so the operator
    // sees a truthful "conflict" decision instead of a crash.
    return { manifest: { state: "conflict" }, targets: {} };
  }
  const bindingsByAlias = new Map(input.bindings.map((binding) => [binding.alias, binding]));
  const expectedManifest = expectedManifestForContract(input.workspaceId, input.contract, bindingsByAlias, input.requirementManifests);
  const manifestState = probeManifestState(input.issueRoot, expectedManifest);
  const targets: Record<string, IssueCheckTargetReport> = {};
  for (const declared of input.contract.repositories) {
    const binding = bindingsByAlias.get(declared.alias);
    if (binding === undefined) {
      // Apply (resolveIssueInitPlan) rejects an alias with no matching
      // Workspace binding as unknown_field — check must report the same
      // real conflict for this target, never silently drop it from the
      // report as if it were fine to continue past.
      targets[declared.alias] = {
        alias: declared.alias,
        access: declared.access,
        repoId: "",
        cachePath: "",
        cacheState: "conflict",
        baseSha: null,
        worktreePath: join(input.issueRoot, declared.alias),
        workBranch: null,
        decision: "conflict",
      };
      continue;
    }
    const identity = resolveRepositoryCacheIdentity({ rollHome: input.rollHome, binding });
    const cacheState = await inspectRepositoryCache({ rollHome: input.rollHome, binding });
    const workBranch = declared.access === "write"
      ? renderBranchPattern(binding.workflow.branchPattern, { workspaceId: input.workspaceId, storyId: input.contract.storyId, repoAlias: declared.alias })
      : null;
    let expected: ExpectedWorktreeFacts;
    let isPinned: boolean;
    try {
      if (cacheState === "compatible") {
        const resolved = await resolveExpectedTargetFacts(input.issueRoot, identity.cachePath, input.workspaceId, input.contract.storyId, declared.alias, binding.repoId, declared.access, workBranch, binding.integrationBranch);
        expected = resolved.facts;
        isPinned = resolved.isPinned;
      } else {
        expected = { access: declared.access, workBranch, baseSha: null };
        isPinned = readPinnedTargetFacts(input.issueRoot, declared.alias, { workspaceId: input.workspaceId, storyId: input.contract.storyId, repoId: binding.repoId }) !== undefined;
      }
    } catch {
      // A malformed/conflicting Issue-local pinned fact is a real conflict —
      // --check must surface it truthfully, never crash or guess.
      targets[declared.alias] = {
        alias: declared.alias,
        access: declared.access,
        repoId: binding.repoId,
        cachePath: identity.cachePath,
        cacheState,
        baseSha: null,
        worktreePath: join(input.issueRoot, declared.alias),
        workBranch,
        decision: "conflict",
      };
      continue;
    }
    const worktreePath = join(input.issueRoot, declared.alias);
    const worktreeState = await probeWorktreeState(worktreePath, identity.cachePath, expected, isPinned, true);
    const combined = combineTargetState(cacheState, worktreeState);
    const decision: IssueInitOutcome | "conflict" = combined === "absent" ? "created" : combined === "compatible" ? "reused" : combined === "repairable" ? "repaired" : "conflict";
    targets[declared.alias] = {
      alias: declared.alias,
      access: declared.access,
      repoId: binding.repoId,
      cachePath: identity.cachePath,
      cacheState,
      baseSha: expected.baseSha,
      worktreePath,
      workBranch,
      decision,
    };
  }
  return { manifest: { state: manifestState }, targets };
}

export interface ApplyIssueInitDeps {
  /** Test-only causal trace for the Workspace authority lock and nested
   * repository-cache locks acquired by this operation. */
  readonly onLockAcquired?: (lock: "authority" | "repository", alias?: string) => void;
  /** Test-only hook fired synchronously right after each target's real git
   *  worktree is created — lets a test inject a genuine filesystem mutation
   *  (e.g. making an earlier target dirty) between one target's creation and
   *  a LATER target's failure, without faking any git operation itself. */
  readonly afterTargetCreated?: (alias: string, path: string) => void;
  /** Test-only hook fired for a newly-created READ target's real worktree,
   *  AFTER the journal has recorded it as created but BEFORE
   *  {@link protectReadOnlyWorktree} runs — lets a test induce a genuine
   *  filesystem-level protection failure (e.g. chmod a nested directory
   *  unreadable) to prove the journal-before-protect ordering: a real target
   *  the OS then refuses to protect must still roll back via a real `git
   *  worktree remove`, never linger ungoverned. */
  readonly beforeProtect?: (alias: string, path: string) => void;
  /** Test-only hook fired for EVERY declared target, immediately before the
   *  re-probe that decides create-vs-reuse for it (see applyIssueInit) — the
   *  ONLY seam a test needs to inject a genuine TOCTOU: an ordinary directory
   *  or an unrelated real git worktree materializing at this exact path in
   *  the gap between the earlier preflight probe and this mutation-time
   *  decision. Fires whether the preflight decided this target absent,
   *  reused, or repaired. */
  readonly beforeMutateTarget?: (alias: string, path: string) => void;
  /** Test-only observation fired INSIDE the owning repoId machine lock,
   * immediately before `git worktree add` mutates the shared bare cache. */
  readonly beforeAddMutation?: (alias: string, path: string) => void;
  /** Test-only observation fired INSIDE the owning repoId machine lock,
   * immediately before rollback removes a newly-created worktree and its
   * governed branch from the shared bare cache. */
  readonly beforeRollbackMutation?: (alias: string, path: string) => void;
}

export interface ApplyIssueInitInput {
  readonly workspaceId: string;
  readonly rollHome: string;
  /** The Workspace root `issueRoot` must resolve inside of — see
   *  {@link InspectIssueInitInput.workspaceRoot}. */
  readonly workspaceRoot: string;
  readonly issueRoot: string;
  readonly contract: IssueStoryContract;
  readonly bindings: readonly RepositoryBinding[];
  readonly requirementManifests: readonly RequirementSourceManifest[];
}

export interface ApplyIssueInitResult {
  readonly outcome: IssueInitOutcome;
  readonly manifest: IssueManifest;
}

interface ResolvedTargetCache {
  readonly alias: string;
  readonly repoId: string;
  readonly cachePath: string;
  /** The rollHome + binding this target resolved against — carried so every
   *  worktree add/remove mutation (create loop and rollback alike) can be
   *  serialized behind the SAME per-`repoId` machine lock as the cache. */
  readonly rollHome: string;
  readonly binding: RepositoryBinding;
  readonly baseSha: string;
  /** True whenever ANY journal/event fact already exists for this alias
   *  (see {@link resolveExpectedTargetFacts}'s own `isPinned`) — the ONLY
   *  targets ever allowed to recover an orphan governed branch (see
   *  {@link issueWorktreeAdd}'s `allowOrphanRecovery`). A brand-new,
   *  never-pinned target must never silently adopt a pre-existing branch of
   *  the same name. */
  readonly isPinned: boolean;
  readonly expected: ExpectedWorktreeFacts;
}

interface JournalTarget {
  readonly alias: string;
  readonly repoId: string;
  readonly path: string;
  readonly created: boolean;
  readonly workBranch: string | null;
  readonly access: "read" | "write";
  /** The pinned immutable base for this target — REQUIRED, never null/absent.
   *  Every target's repository cache and base SHA (`cacheByAlias`) is fully
   *  resolved BEFORE the journal is ever constructed or written (see
   *  applyIssueInit), so there is no valid "not yet resolved" state for the
   *  journal to represent: a journal is only ever written once every target
   *  in it is genuinely pinned. Persisted BEFORE any worktree mutation so an
   *  interrupted retry reads the SAME base back rather than re-deriving one
   *  from the shared cache's (possibly since-advanced) current ref. */
  readonly baseSha: string;
  /** Whether THIS run created `workBranch` as a brand-new ref, versus
   *  reusing (recovering) an already-existing orphan branch. `false` for a
   *  read target (no branch at all) and for any target not yet created this
   *  run. Rollback ({@link rollbackCreatedTargets}) deletes the branch ONLY
   *  when this is `true` — a recovered orphan branch (and whatever later
   *  real Story commits it already carries) must survive a later target's
   *  failure untouched. */
  readonly branchCreatedThisRun: boolean;
}

interface IssueInitJournal {
  readonly schema: typeof ISSUE_INIT_JOURNAL_V1;
  readonly transactionId: string;
  readonly workspaceId: string;
  readonly storyId: string;
  readonly status: "applying" | "repair_required";
  readonly targets: readonly JournalTarget[];
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeJournal(issueRoot: string, journal: IssueInitJournal): void {
  atomicWrite(journalPath(issueRoot), `${JSON.stringify(journal, null, 2)}\n`);
}

/** Roll back newly-created targets via real `git worktree remove` — refuses
 *  (and preserves) a target that has gone dirty since creation, or one that
 *  was never newly-created (pre-existing). Never a blind `rm -rf`. */
async function rollbackCreatedTargets(
  targets: readonly JournalTarget[],
  cacheByAlias: ReadonlyMap<string, ResolvedTargetCache>,
  deps: Pick<ApplyIssueInitDeps, "beforeRollbackMutation" | "onLockAcquired">,
): Promise<void> {
  for (const target of [...targets].reverse()) {
    if (!target.created) continue;
    if (!existsSync(target.path)) continue;
    const cache = cacheByAlias.get(target.alias);
    if (cache === undefined) continue;
    const identity = await issueWorktreeIdentity(target.path, cache.cachePath);
    if (identity.state !== "compatible" || identity.dirty) continue; // preserve: conflict or dirty
    // The worktree remove and the governed-branch delete both mutate the same
    // shared cache admin — take the owning repoId lock once so a concurrent
    // Workspace's add cannot interleave with either half of this rollback.
    try {
      await withRepositoryCacheLock({
        rollHome: cache.rollHome,
        binding: cache.binding,
        onLockAcquired: () => deps.onLockAcquired?.("repository", target.alias),
      }, async () => {
        deps.beforeRollbackMutation?.(target.alias, target.path);
        await issueWorktreeRemove(cache.cachePath, target.path, { readOnly: target.access === "read" });
        // The worktree is gone; also delete the governed branch, but ONLY when
        // THIS run actually created it — so a repair retry can `worktree add
        // -b` the same branch name again without "a branch named ... already
        // exists". A branch this run merely RECOVERED (orphan reuse) is left
        // completely alone: it may already carry later real Story commits made
        // before whatever earlier interruption orphaned it, and this run never
        // owned its lifecycle.
        if (target.workBranch !== null && target.branchCreatedThisRun) {
          await git(["branch", "-D", target.workBranch], cache.cachePath);
        }
      });
    } catch {
      // A target that refuses removal (e.g. went dirty between the identity
      // check and now) is preserved — never forced. issueWorktreeRemove
      // already re-protected it if it was a read target, so the preserved
      // checkout stays non-writable rather than silently ending up exposed.
      continue;
    }
  }
}

/** Create, reuse or repair one Issue root: an immutable manifest and one real
 *  git worktree per declared repository target, from the actual machine Roll
 *  Home repository cache (~/.roll/repos via the existing repository-cache
 *  contract) — never a Workspace-relative cache. ALL targets/cache/base SHA
 *  are resolved before the Issue root is created or mutated. */
async function applyIssueInitUnlocked(input: ApplyIssueInitInput, deps: ApplyIssueInitDeps = {}): Promise<ApplyIssueInitResult> {
  // Containment MUST be checked before any read/write below — a symlinked
  // Issue root (or a symlinked ancestor like `workspace/issues` itself)
  // escaping the Workspace would otherwise let every subsequent manifest,
  // journal, event and worktree mutation land outside the Workspace entirely.
  assertContainedIssueRoot(input.workspaceRoot, input.issueRoot);
  const bindingsByAlias = new Map(input.bindings.map((binding) => [binding.alias, binding]));
  const manifestOnDiskPath = manifestPath(input.issueRoot);
  const manifestExists = existsSync(manifestOnDiskPath);
  let manifestOnDisk: unknown = null;
  if (manifestExists) {
    try {
      manifestOnDisk = JSON.parse(readFileSync(manifestOnDiskPath, "utf8"));
    } catch {
      throw new IssueInitializationError("manifest_conflict", "Issue manifest on disk is not valid JSON");
    }
  }
  const manifestRecord = manifestOnDisk as Record<string, unknown> | null;
  const manifestIdentityMatches = manifestRecord !== null
    && manifestRecord["workspaceId"] === input.workspaceId
    && manifestRecord["storyId"] === input.contract.storyId;
  if (manifestExists && !manifestIdentityMatches) {
    throw new IssueInitializationError("manifest_conflict", "Issue manifest on disk conflicts with the resolved Workspace/Story identity");
  }

  // Resolve EVERY target's cache and real worktree identity BEFORE any mutation.
  const worktreeStates: Record<string, IssueTargetProbeState> = {};
  const cacheByAlias = new Map<string, ResolvedTargetCache>();
  for (const declared of input.contract.repositories) {
    const binding = bindingsByAlias.get(declared.alias);
    if (binding === undefined) continue; // core plan resolver reports this as unknown_field
    const identity = resolveRepositoryCacheIdentity({ rollHome: input.rollHome, binding });
    const cacheState = await inspectRepositoryCache({ rollHome: input.rollHome, binding });
    const workBranch = declared.access === "write"
      ? renderBranchPattern(binding.workflow.branchPattern, { workspaceId: input.workspaceId, storyId: input.contract.storyId, repoAlias: declared.alias })
      : null;
    let expected: ExpectedWorktreeFacts;
    let isPinned: boolean;
    try {
      if (cacheState === "compatible") {
        const resolved = await resolveExpectedTargetFacts(input.issueRoot, identity.cachePath, input.workspaceId, input.contract.storyId, declared.alias, binding.repoId, declared.access, workBranch, binding.integrationBranch);
        expected = resolved.facts;
        isPinned = resolved.isPinned;
      } else {
        expected = { access: declared.access, workBranch, baseSha: null };
        isPinned = readPinnedTargetFacts(input.issueRoot, declared.alias, { workspaceId: input.workspaceId, storyId: input.contract.storyId, repoId: binding.repoId }) !== undefined;
      }
    } catch (error) {
      throw new IssueInitializationError("rejected", `Issue-local pinned facts for ${declared.alias} are malformed or conflicting: ${(error as Error).message}`, { cause: error });
    }
    const worktreePath = join(input.issueRoot, declared.alias);
    const worktreeState = await probeWorktreeState(worktreePath, identity.cachePath, expected, isPinned, true);
    worktreeStates[declared.alias] = combineTargetState(cacheState, worktreeState);
  }

  const planResult = resolveIssueInitPlan({
    workspaceId: input.workspaceId,
    contract: input.contract,
    bindings: input.bindings,
    requirementManifests: input.requirementManifests,
  }, {
    manifest: { state: manifestExists ? "compatible" : (existsSync(journalPath(input.issueRoot)) ? "repairable" : "absent") },
    worktrees: worktreeStates,
  });
  if (!planResult.ok) {
    throw new IssueInitializationError("rejected", `Issue init plan was rejected: ${planResult.errors[0]?.message ?? "invalid plan"}`);
  }
  const plan = planResult.value;

  if (manifestExists && !manifestsMatch(input.issueRoot, manifestOnDisk, plan.manifest)) {
    throw new IssueInitializationError("manifest_conflict", "Issue manifest on disk conflicts with the resolved Story Contract's immutable intent");
  }

  // Resolve (fetch/create/reuse) EVERY target's repository cache BEFORE
  // creating or mutating the Issue root — a failure here leaves no trace.
  // The fetch itself is real and necessary (a write target's merge-base
  // ancestor check, or a repair recreate, needs the cache's object store
  // current) — but the resulting freshly-fetched integration HEAD is used
  // as THIS target's base ONLY when nothing has ever been pinned for it
  // yet. An already-pinned target keeps its Issue-local pinned base
  // regardless of how far the shared cache's ref has since advanced.
  for (const declared of input.contract.repositories) {
    const binding = bindingsByAlias.get(declared.alias);
    if (binding === undefined) continue;
    try {
      const cache = await ensureRepositoryCache({
        binding,
        rollHome: input.rollHome,
        integrationRefspec: integrationRefspecFor(binding),
        onLockAcquired: () => deps.onLockAcquired?.("repository", declared.alias),
      });
      const pinned = readPinnedTargetFacts(input.issueRoot, declared.alias, { workspaceId: input.workspaceId, storyId: input.contract.storyId, repoId: binding.repoId });
      if (pinned !== undefined) {
        const objectPresent = await pinnedBaseShaExistsInCache(cache.cachePath, pinned.baseSha);
        if (!objectPresent) {
          throw new IssueInitializationError("apply_failed", `Pinned base ${pinned.baseSha} for ${declared.alias} is no longer present in its repository cache`);
        }
      }
      const workBranch = declared.access === "write"
        ? renderBranchPattern(binding.workflow.branchPattern, { workspaceId: input.workspaceId, storyId: input.contract.storyId, repoAlias: declared.alias })
        : null;
      const baseSha = pinned?.baseSha ?? cache.baseSha;
      cacheByAlias.set(declared.alias, {
        alias: declared.alias,
        repoId: binding.repoId,
        cachePath: cache.cachePath,
        rollHome: input.rollHome,
        binding,
        baseSha,
        isPinned: pinned !== undefined,
        expected: { access: declared.access, workBranch, baseSha },
      });
    } catch (error) {
      if (error instanceof IssueInitializationError) throw error;
      throw new IssueInitializationError("apply_failed", `Failed to resolve the repository cache for ${declared.alias}: ${(error as Error).message}`, { cause: error });
    }
  }

  mkdirSync(input.issueRoot, { recursive: true });
  // Every target's baseSha is ALREADY resolved (cacheByAlias, above) at this
  // point — persisting it into the journal HERE, before any worktree
  // mutation, is what lets an interrupted retry read the SAME pinned base
  // back (readJournalPinnedFacts) instead of re-deriving one from the
  // shared cache's ref, which may have advanced by then. A REQUIRED lookup
  // (never an optional-chain-with-null-fallback): the cache-resolution loop
  // above either populated `cacheByAlias` for every declared target or
  // already threw — so a missing entry here would mean the journal is
  // about to be written with an unpinned target, which must never happen.
  const targets: JournalTarget[] = plan.targets.map((target) => {
    const cache = cacheByAlias.get(target.alias);
    if (cache === undefined) {
      throw new IssueInitializationError("apply_failed", `Refusing to write the Issue init journal: ${target.alias} has no resolved repository cache/base SHA to pin`);
    }
    return {
      alias: target.alias,
      repoId: target.repoId,
      path: join(input.issueRoot, target.alias),
      created: false,
      workBranch: target.workBranch,
      access: target.access,
      baseSha: cache.baseSha,
      branchCreatedThisRun: false,
    };
  });
  let journal: IssueInitJournal = {
    schema: ISSUE_INIT_JOURNAL_V1,
    transactionId: randomUUID(),
    workspaceId: input.workspaceId,
    storyId: input.contract.storyId,
    status: "applying",
    targets,
  };
  writeJournal(input.issueRoot, journal);
  try {
    for (const [index, target] of plan.targets.entries()) {
      const isReadTarget = target.access === "read";
      const targetPath = targets[index]!.path;
      const cache = cacheByAlias.get(target.alias);
      if (cache === undefined) throw new IssueInitializationError("apply_failed", `Missing resolved repository cache for ${target.alias}`);

      // TOCTOU re-probe: the preflight decision (`target.action`) was made
      // against a snapshot that may now be stale — a directory or an
      // unrelated real worktree can appear at `targetPath` in the window
      // between that snapshot and this exact moment. Re-probe the REAL,
      // CURRENT state immediately before deciding create-vs-reuse; never
      // trust the earlier snapshot alone for the mutation decision itself.
      deps.beforeMutateTarget?.(target.alias, targetPath);
      const freshIdentity = await issueWorktreeIdentity(targetPath, cache.cachePath);

      if (target.action === "reused") {
        // Preflight expected this target ALREADY present and compatible. It
        // may only continue if the REAL, current facts still match — cache,
        // branch, HEAD/base and access compatibility — never on the
        // strength of the earlier snapshot alone.
        const stillCompatible = await checkWorktreeCompatibility(freshIdentity, cache.cachePath, cache.expected);
        if (!stillCompatible) {
          throw new IssueInitializationError(
            "apply_failed",
            `${target.alias} was expected reused/compatible but its real worktree no longer matches at mutation time (TOCTOU) — refusing to protect or bind it`,
          );
        }
        if (isReadTarget) protectReadOnlyWorktree(targetPath);
        continue;
      }

      if (freshIdentity.state !== "absent") {
        // Preflight expected "created" (nothing here) or a repair where the
        // path was absent — but something now occupies `targetPath`: an
        // ordinary directory, an unrelated real git worktree, or a wrong
        // worktree entirely. This is a genuine TOCTOU: fail loud, leave the
        // foreign path completely untouched, never protect it and never
        // emit issue:repository_bound for it.
        throw new IssueInitializationError(
          "apply_failed",
          `${target.alias} was expected absent but a real path now exists at ${targetPath} (TOCTOU) — refusing to create a worktree over it`,
        );
      }

      // Serialize the shared-cache mutation (`git worktree prune` + `add -b`)
      // behind the owning repoId machine lock. Two Workspaces preparing the
      // same repoId concurrently otherwise interleave these non-atomic admin
      // rewrites and can cross-bind a worktree path to the wrong governed
      // branch (US-WS-011 concurrent-isolation gate).
      const added = await withRepositoryCacheLock(
        {
          rollHome: cache.rollHome,
          binding: cache.binding,
          onLockAcquired: () => deps.onLockAcquired?.("repository", target.alias),
        },
        () => {
          deps.beforeAddMutation?.(target.alias, targetPath);
          return issueWorktreeAdd(cache.cachePath, targetPath, cache.baseSha, target.workBranch, {
            // Orphan governed-branch recovery is only ever permitted for a
            // target that already carries a valid Issue-local pin — a
            // brand-new, never-pinned target must never silently adopt a
            // pre-existing branch of the same name.
            allowOrphanRecovery: cache.isPinned,
          });
        },
      );
      // Journal the creation BEFORE protecting: if protection throws, rollback
      // must still know this worktree was created THIS run so it gets cleaned
      // up rather than left behind ungoverned.
      targets[index] = { ...targets[index]!, created: true, branchCreatedThisRun: added.branchCreatedThisRun };
      journal = { ...journal, targets: [...targets] };
      writeJournal(input.issueRoot, journal);
      if (isReadTarget) {
        deps.beforeProtect?.(target.alias, targets[index]!.path);
        protectReadOnlyWorktree(targets[index]!.path);
      }
      deps.afterTargetCreated?.(target.alias, targets[index]!.path);
    }
    if (!manifestExists) {
      atomicWrite(manifestOnDiskPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);
    }
    const boundAliases = recordedRepositoryBoundAliases(input.issueRoot);
    const eventLines = plan.targets
      .filter((target) => !boundAliases.has(target.alias))
      .map((target: IssueInitTargetPlan) => `${JSON.stringify({
        type: "issue:repository_bound",
        workspaceId: input.workspaceId,
        storyId: input.contract.storyId,
        alias: target.alias,
        repoId: target.repoId,
        access: target.access,
        baseSha: cacheByAlias.get(target.alias)?.baseSha,
        worktreePath: targets.find((entry) => entry.alias === target.alias)?.path,
        workBranch: target.workBranch,
        ts: Date.now(),
      })}\n`).join("");
    // Events are committed as ONE atomic write (existing validated stream +
    // new lines, temp file + rename) BEFORE the journal is removed — so a
    // crash between the two still leaves the journal as the honest "still
    // applying" signal, and a re-run's boundAliases re-check above already
    // dedupes against whatever did get durably committed.
    appendRepositoryBoundEventsAtomically(input.issueRoot, eventLines);
    rmSync(journalPath(input.issueRoot), { force: true });
    return { outcome: plan.outcome, manifest: plan.manifest };
  } catch (error) {
    await rollbackCreatedTargets(targets, cacheByAlias, deps);
    journal = { ...journal, status: "repair_required", targets: [...targets] };
    writeJournal(input.issueRoot, journal);
    if (error instanceof IssueInitializationError) throw error;
    throw new IssueInitializationError("apply_failed", `Issue init failed: ${(error as Error).message}`, { cause: error });
  }
}

export async function applyIssueInit(input: ApplyIssueInitInput, deps: ApplyIssueInitDeps = {}): Promise<ApplyIssueInitResult> {
  try {
    return await withWorkspaceAuthorityLock({
      rollHome: input.rollHome,
      workspaceId: input.workspaceId,
      operation: "issue-init",
      onAcquired: () => deps.onLockAcquired?.("authority"),
    }, () => applyIssueInitUnlocked(input, deps));
  } catch (error) {
    if (error instanceof WorkspaceAuthorityLockError) {
      throw new IssueInitializationError("apply_failed", "Workspace authority is locked by another metadata writer", { cause: error });
    }
    throw error;
  }
}
