/**
 * @responsibility Reads the cross-project registry for the project switcher.
 */
/**
 * US-DOSSIER-027 — read the cross-project registry `~/.roll/projects.json` for
 * the Truth Console top-bar project switcher. READ-ONLY here: US-DOSSIER-028
 * authors/refreshes the file (one row per project, upsert by slug). This module
 * only consumes it, and degrades gracefully to current-project-only whenever the
 * file is absent, empty, or malformed — the snapshot is honest, never erroring.
 *
 * Schema (US-DOSSIER-028 contract): a JSON array of rows
 *   { name, slug, path, releaseTag?, verdict?, lastIndexedAt? }
 * `--json` output of `roll ls` equals this file verbatim, so the registry is the
 * ONE source both the web switcher and the CLI listing read.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isRealProjectPath, reachableProjects as filterReachableProjects } from "@roll/core";
import type { ProjectRegistryEntry } from "./truth-console.js";

/**
 * The home dir the registry lives under. Honors `ROLL_HOME` when set so tests
 * (and any sandboxed run) can redirect the SHARED machine file to a tmp dir and
 * never touch the real `~/.roll/projects.json`. A real single-project user with
 * `ROLL_HOME` unset still resolves to `homedir()` exactly as before. The explicit
 * `home` param seam is kept intact: an explicit argument always wins.
 */
function registryHome(home?: string): string {
  return home ?? process.env["ROLL_HOME"] ?? homedir();
}

/** The machine-level registry path (`~/.roll/projects.json`). */
export function projectsRegistryPath(home?: string): string {
  return join(registryHome(home), ".roll", "projects.json");
}

/**
 * Parse the registry JSON text into well-formed rows. Pure + total: any shape
 * that is not "an array of objects with at least { name, slug, path } strings"
 * yields an empty list rather than throwing, so a malformed machine file can
 * never crash `roll index`. Deterministic: rows are sorted by name (then slug)
 * so the switcher order does not depend on write order across projects.
 */
export function parseProjectsRegistry(text: string): ProjectRegistryEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  // Tolerate either a bare array (the contract) or a `{ projects: [...] }` wrap.
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { projects?: unknown }).projects)
      ? (raw as { projects: unknown[] }).projects
      : [];
  const out: ProjectRegistryEntry[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["slug"] !== "string" || typeof r["path"] !== "string") continue;
    const entry: ProjectRegistryEntry = { name: r["name"], slug: r["slug"], path: r["path"] };
    if (typeof r["releaseTag"] === "string") entry.releaseTag = r["releaseTag"];
    if (typeof r["verdict"] === "string") entry.verdict = r["verdict"];
    if (typeof r["lastIndexedAt"] === "string") entry.lastIndexedAt = r["lastIndexedAt"];
    out.push(entry);
  }
  out.sort((a, b) => (a.name === b.name ? a.slug.localeCompare(b.slug) : a.name.localeCompare(b.name)));
  return out;
}

/**
 * Read + parse `~/.roll/projects.json`. Returns `[]` when the file is missing or
 * unreadable — the single-project degrade is the caller's default (it falls back
 * to the current project alone). `home` (or `ROLL_HOME`) is injectable for tests.
 */
export function collectProjectsRegistry(home?: string): ProjectRegistryEntry[] {
  let text: string;
  try {
    text = readFileSync(projectsRegistryPath(home), "utf8");
  } catch {
    return [];
  }
  return parseProjectsRegistry(text);
}

/**
 * FIX-283 (AC2): the registry rows whose `path` still exists on disk — the ONLY
 * set the web switcher should render. The CLI `roll ls` keeps listing every row
 * with missing/stale flags (that honesty is for the operator); the switcher is a
 * navigation control, so a dead path (a stale tmp fixture that leaked, or a
 * project since deleted) must never render as an un-clickable / 404 entry.
 * FIX-376: also excludes temp paths (resolved path under OS tmpdir or /tmp) and
 * `.roll` basenames (nested meta repos). Pure: `pathExists` is injected
 * (defaults to `existsSync`) so the existence check stays testable. Order is
 * preserved (the input is already name-sorted by `parseProjectsRegistry`).
 */
export function reachableProjects(
  rows: ProjectRegistryEntry[],
  pathExists: (p: string) => boolean = existsSync,
): ProjectRegistryEntry[] {
  return filterReachableProjects(rows, pathExists);
}

/**
 * FIX-283 (AC3) — the ONE self-register guard shared by `roll index` and
 * `roll init` (so adopting roll registers a project immediately, AC4), with the
 * SAME tmp/non-existent skip rule. A `roll index|init` run inside a tmp fixture
 * (the test/CI hot path) must NEVER persist a throwaway row into the REAL
 * `~/.roll/projects.json`. Two seams cooperate:
 *   - the registry path honors `ROLL_HOME` — a sandboxed run (test/CI that sets
 *     `ROLL_HOME=<tmp>`) redirects the WHOLE file to its own dir, so writing a
 *     tmp project row there is intentional and harmless;
 *   - belt-and-suspenders beyond FIX-281: a cwd under the OS temp dir is a
 *     fixture, not a real project, and is skipped REGARDLESS of whether
 *     `ROLL_HOME` is set — so a tmp test cwd can never leak even when a test
 *     forgot to sandbox `ROLL_HOME`. A real single-project user (cwd outside
 *     tmp) still self-registers exactly as before.
 * A cwd that no longer exists is never persisted either way.
 */
export function shouldSelfRegister(cwd: string): boolean {
  let projectReal: string;
  try {
    projectReal = realpathSync(cwd);
  } catch {
    /* cwd vanished mid-run → never write a dead path into any registry */
    return false;
  }
  // FIX-283: skip fixture paths under the OS temp dir unconditionally (no longer
  // gated on ROLL_HOME being unset) — a tmp cwd is never a real project.
  // FIX-376: also check system /tmp (may differ from tmpdir() on macOS).
  if (!isRealProjectPath(projectReal)) return false;
  return true;
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function remoteRepoName(cwd: string): string | null {
  const origin = gitOutput(cwd, ["remote", "get-url", "origin"]);
  const remote =
    origin ??
    gitOutput(cwd, ["remote"])
      ?.split("\n")
      .map((name) => name.trim())
      .find((name) => name !== "");
  const url = origin ?? (remote !== undefined ? gitOutput(cwd, ["remote", "get-url", remote]) : null);
  if (url === null || url === "") return null;
  const clean = url.replace(/\/+$/, "").replace(/\.git$/, "");
  const repo = basename(clean);
  return repo !== "" ? repo : null;
}

/** FIX-307: the human project display name, shared by registry writes and page chrome. */
export function resolveProjectName(cwd: string): string {
  const envName = (process.env["ROLL_BRAND_NAME"] ?? "").trim();
  if (envName !== "") return envName;

  const remoteName = remoteRepoName(cwd);
  if (remoteName !== null) return remoteName;

  const top = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (top !== null && top !== "") return basename(top) || "roll";

  try {
    const real = realpathSync(cwd);
    const base = basename(real);
    if (base !== "") return base;
  } catch {
    const base = basename(cwd);
    if (base !== "") return base;
  }
  return "roll";
}

/** The ONE serialization both `roll index` writes and `roll ls --json` echoes
 *  verbatim — a JSON array of rows, 2-space indented, trailing newline. The
 *  array is the contract (US-DOSSIER-027 reads it as a bare array), so the
 *  switcher and the CLI never disagree on shape. */
export function serializeProjectsRegistry(rows: ProjectRegistryEntry[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/**
 * Pure upsert: replace (or append) the row whose `slug` matches `entry.slug`,
 * keeping every other project's row untouched, and re-sort deterministically by
 * name (then slug) — the SAME order `parseProjectsRegistry` guarantees, so the
 * registry order never depends on which project last ran `roll index`. Other
 * projects' rows are NEVER dropped (the machine file is shared; a concurrent
 * `roll index` in another repo must survive this write).
 */
export function upsertProjectRow(
  existing: ProjectRegistryEntry[],
  entry: ProjectRegistryEntry,
): ProjectRegistryEntry[] {
  const out = existing.filter((r) => r.slug !== entry.slug);
  out.push(entry);
  out.sort((a, b) => (a.name === b.name ? a.slug.localeCompare(b.slug) : a.name.localeCompare(b.name)));
  return out;
}

/**
 * Read-modify-write `~/.roll/projects.json`: UPSERT this project's row by slug
 * and write the whole array back atomically (temp file + rename), so a partial
 * write can never corrupt the shared machine file and a concurrent index in
 * another repo only loses the race, never its row. Re-reads the file just
 * before writing (last-writer-wins per slug) — we never integrate a stale
 * in-memory copy. Best-effort by contract: never throws into `roll index`'s
 * main path; returns the row list it wrote (or `existing` on failure).
 */
export function writeProjectRow(entry: ProjectRegistryEntry, home?: string): ProjectRegistryEntry[] {
  const path = projectsRegistryPath(home);
  const existing = collectProjectsRegistry(home);
  const merged = upsertProjectRow(existing, entry);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeProjectsRegistry(merged), "utf8");
    renameSync(tmp, path);
    return merged;
  } catch {
    return existing;
  }
}
