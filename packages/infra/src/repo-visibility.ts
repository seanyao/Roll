/**
 * @responsibility Guards repository visibility for image evidence.
 */
/**
 * US-PHYSICAL-008 — repository visibility guard for image evidence.
 *
 * Before any screenshot/image evidence is committed into a git repo, roll checks
 * the remote's visibility. Public or undetermined remotes are treated as public
 * (conservative): image evidence is blocked and surfaced as an ALERT. Private
 * remotes are allowed. An owner can record an explicit waiver in
 * `.roll/local.yaml` to override the block; the waiver itself is the audit trail.
 *
 * In-repo `.roll` projects cache the detected visibility (plus the remote URL
 * fingerprint) so later cycles do not re-query. If the remote URL changes, the
 * cache is invalidated and visibility is re-detected.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { remoteUrl } from "./git.js";
import { ghAvailable, ghRepoSlug } from "./github.js";

/** Visibility outcome for a git remote. */
export type RepoVisibility = "public" | "private" | "unknown";

/** Decision returned by {@link checkImageEvidenceAllowed}. */
export interface VisibilityCheck {
  /** True iff image evidence may be committed to this repo. */
  allowed: boolean;
  /** Human-readable reason for the decision (suitable for ALERTs/logs). */
  reason: string;
  /** The visibility that produced the decision. */
  visibility: RepoVisibility;
  /** True when an explicit owner waiver overrode a public/unknown remote. */
  waived: boolean;
}

/** Injectable seams for tests — never hit the real network. */
export interface VisibilityProbe {
  /** Run a `gh` argv and return captured stdout/stderr + code. */
  ghRun?: (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Run `git <args>` in `cwd` and return captured stdout/stderr + code. */
  gitRun?: (args: readonly string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const LOCAL_CONFIG = ".roll/local.yaml";
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;

function localConfigPath(projectCwd: string): string {
  return join(projectCwd, LOCAL_CONFIG);
}

/** Read the owner waiver: `evidence_public_waiver: true` in `.roll/local.yaml`. */
export function readEvidencePublicWaiver(projectCwd: string): boolean {
  const p = localConfigPath(projectCwd);
  if (!existsSync(p)) return false;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^evidence_public_waiver:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (m !== null) return /^(true|yes|1)$/i.test(m[1]!);
  }
  return false;
}

/** Read cached visibility + remote fingerprint from `.roll/local.yaml`. */
export function readEvidenceVisibilityCache(projectCwd: string): {
  visibility: RepoVisibility | null;
  remoteUrl: string | null;
} {
  const p = localConfigPath(projectCwd);
  if (!existsSync(p)) return { visibility: null, remoteUrl: null };
  let visibility: RepoVisibility | null = null;
  let remoteUrl: string | null = null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const vm = /^evidence_visibility:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (vm !== null) {
      const v = vm[1]!.toLowerCase();
      if (v === "public" || v === "private" || v === "unknown") visibility = v;
    }
    const um = /^evidence_remote:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (um !== null) remoteUrl = um[1]!;
  }
  return { visibility, remoteUrl };
}

/** Write or update the cached visibility + remote fingerprint in `.roll/local.yaml`. */
export function writeEvidenceVisibilityCache(
  projectCwd: string,
  remote: string,
  visibility: RepoVisibility,
): void {
  const p = localConfigPath(projectCwd);
  mkdirSync(dirname(p), { recursive: true });
  const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
  const out: string[] = [];
  let wroteVis = false;
  let wroteUrl = false;
  for (const line of lines) {
    if (/^evidence_visibility:/.test(line)) {
      out.push(`evidence_visibility: ${visibility}`);
      wroteVis = true;
      continue;
    }
    if (/^evidence_remote:/.test(line)) {
      out.push(`evidence_remote: ${remote}`);
      wroteUrl = true;
      continue;
    }
    out.push(line);
  }
  if (!wroteVis) out.push(`evidence_visibility: ${visibility}`);
  if (!wroteUrl) out.push(`evidence_remote: ${remote}`);
  const text = out.join("\n");
  writeFileSync(p, text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Detect the visibility of the git repo at `repoCwd`.
 *
 * Strategy (matches the AC: gh api / ls-remote reachability; undetermined → public):
 *   - GitHub remotes: use `gh api repos/<slug>` when `gh` is available.
 *   - Non-GitHub remotes: use `git ls-remote` as a reachability probe; visibility
 *     remains undetermined.
 *   - Any failure (no remote, gh missing, API error, ls-remote fails) → unknown.
 */
export async function detectRepoVisibility(
  repoCwd: string,
  probe: VisibilityProbe = {},
): Promise<RepoVisibility> {
  const url = await remoteUrl(repoCwd);
  if (url === undefined || url === "") return "unknown";

  const slug = ghRepoSlug(url);
  if (slug !== undefined) {
    const ghOk = probe.ghRun !== undefined ? true : await ghAvailable();
    if (!ghOk) return "unknown";
    const r = await (probe.ghRun ?? defaultGhRun)(["api", `repos/${slug}`, "--jq", ".visibility"]);
    if (r.code === 0) {
      const v = r.stdout.trim().replace(/^"|"$/g, "").toLowerCase();
      if (v === "public") return "public";
      if (v === "private") return "private";
    }
    return "unknown";
  }

  // Non-GitHub remote: ls-remote success means the remote is reachable, but we
  // cannot infer visibility → conservative unknown.
  const r = await (probe.gitRun ?? defaultGitRun)(["ls-remote", url, "HEAD"], repoCwd);
  if (r.code === 0) return "unknown";
  return "unknown";
}

async function defaultGhRun(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { gh } = await import("./github.js");
  return gh(args);
}

async function defaultGitRun(
  args: readonly string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { git } = await import("./git.js");
  return git(args, cwd);
}

/**
 * Decide whether image evidence may be committed to a repo.
 *
 * `projectCwd` is the project root (where `.roll/local.yaml` lives). `repoCwd`
 * is the actual git repo that will receive the images:
 *   - nested roll-meta layout: `repoCwd` is `<projectCwd>/.roll`
 *   - in-repo `.roll` layout: `repoCwd` equals `projectCwd`
 */
export async function checkImageEvidenceAllowed(
  projectCwd: string,
  repoCwd: string,
  probe: VisibilityProbe = {},
): Promise<VisibilityCheck> {
  if (readEvidencePublicWaiver(projectCwd)) {
    return {
      allowed: true,
      reason: "public-visibility waiver active in .roll/local.yaml",
      visibility: "unknown",
      waived: true,
    };
  }

  const url = await remoteUrl(repoCwd);
  const cache = readEvidenceVisibilityCache(projectCwd);
  if (url !== undefined && url !== "" && cache.remoteUrl === url && cache.visibility !== null && cache.visibility !== "unknown") {
    const visibility = cache.visibility;
    return {
      allowed: visibility === "private",
      reason: `cached visibility for this remote: ${visibility}`,
      visibility,
      waived: false,
    };
  }

  const visibility = await detectRepoVisibility(repoCwd, probe);
  if (url !== undefined && url !== "") {
    writeEvidenceVisibilityCache(projectCwd, url, visibility);
  }

  if (visibility === "private") {
    return { allowed: true, reason: "remote is private", visibility, waived: false };
  }
  return {
    allowed: false,
    reason: `remote visibility is ${visibility === "public" ? "public" : "undetermined"}; image evidence blocked`,
    visibility,
    waived: false,
  };
}

/**
 * List image files under the evidence tree that would be staged by `git add -A`.
 * Uses `git status --porcelain` so ignored files are excluded automatically.
 * Returns paths relative to `repoCwd`.
 */
export function imageEvidencePathsInWorkingTree(repoCwd: string): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--no-renames"], {
      cwd: repoCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3).trim();
    if (path === "") continue;
    if (IMAGE_RE.test(path) && /(^|[\/\\])features[\/\\]/.test(path)) {
      paths.push(path);
    }
  }
  return paths;
}
