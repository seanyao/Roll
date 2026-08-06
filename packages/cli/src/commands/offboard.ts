/**
 * @responsibility Runs the `offboard` subcommand, porting the v2 offboard flow.
 */
/**
 * `roll offboard` — TS port of bin/roll cmd_offboard (2987-3159) plus the
 * helpers it leans on: _onboard_changeset_path (2591-2593), _loop_in_cycle
 * (10493-10495), and _launchctl_safe (9606-9633).
 *
 * Reverses what `roll init --apply` recorded in .roll/onboard-changeset.yaml:
 * removes files/dirs it created, strips .gitignore entries it added, and
 * unloads + removes any launchd plists it installed. Default is a dry-run
 * preview; --confirm applies. Mirrors the oracle's plan output, cross-project
 * guard, the FIX-125 in-cycle tripwire for plist mutation, and exit codes.
 *
 * The launchctl invocation is dispatched through a `runLaunchctl` indirection
 * (mirrors _launchctl_safe) so difftests can shim a PATH `launchctl` that
 * records argv. Darwin-only host paths ($HOME/Library/LaunchAgents) are kept
 * verbatim — the bash oracle uses them on every platform too, so parity holds.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";

// ─── bash UI helpers (bin/roll:41-56) ────────────────────────────────────────
function pal(): {
  RED: string;
  GREEN: string;
  YELLOW: string;
  CYAN: string;
  BOLD: string;
  NC: string;
} {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { RED: "", GREEN: "", YELLOW: "", CYAN: "", BOLD: "", NC: "" }
    : {
        RED: "\x1b[0;31m",
        GREEN: "\x1b[0;32m",
        YELLOW: "\x1b[0;33m",
        CYAN: "\x1b[0;36m",
        BOLD: "\x1b[1m",
        NC: "\x1b[0m",
      };
}
function info(line: string): void {
  const { CYAN, NC } = pal();
  process.stdout.write(`${CYAN}[roll]${NC} ${line}\n`);
}
function ok(line: string): void {
  const { GREEN, NC } = pal();
  process.stdout.write(`${GREEN}[roll]${NC} ${line}\n`);
}
function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function m(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, msgLang(), key, ...args);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
/** Port of _onboard_changeset_path. */
function changesetPath(projectDir: string): string {
  return join(projectDir, ".roll", "onboard-changeset.yaml");
}

/** Port of _loop_in_cycle. */
function loopInCycle(): boolean {
  return (
    (process.env["ROLL_LOOP_AGENT"] ?? "") !== "" || (process.env["ROLL_CYCLE_LOG_RAW"] ?? "") !== ""
  );
}

/**
 * Port of _launchctl_safe. Read-only ops pass through; otherwise, if the
 * sandboxed _LAUNCHD_DIR diverges from the canonical $HOME/Library/LaunchAgents
 * the call is refused (returns 0 without touching host launchd). A PATH-shimmed
 * launchctl (tests) is the "real binary" path here — there is no bash function
 * stub equivalent in TS, so the function-stub branch collapses into this one.
 */
function runLaunchctl(args: string[]): number {
  const readOnly = new Set(["print", "print-disabled", "list", "version", "dumpstate", "examine"]);
  if (args[0] !== undefined && readOnly.has(args[0])) {
    return spawnSync("launchctl", args, { stdio: "inherit" }).status ?? 1;
  }
  const canonical = join(homedir(), "Library", "LaunchAgents");
  const launchdDir = process.env["_LAUNCHD_DIR"] ?? canonical;
  if (launchdDir !== canonical) return 0;
  return spawnSync("launchctl", args, { stdio: "inherit" }).status ?? 1;
}

/**
 * Minimal parser for the four list sections of a Roll-generated changeset.
 * Mirrors what the oracle's `yaml.safe_load` extracts (the file is always
 * machine-written by _onboard_changeset_begin/_record): a `key:` header
 * followed by `  - "value"` block items, or `key: []` for an empty list.
 * Returns the values for the requested section, in file order.
 */
const SECTIONS = ["files_merged", "files_created", "dirs_created", "gitignore_entries_added", "launchd_plists_installed"] as const;
type Section = (typeof SECTIONS)[number];

function parseChangeset(text: string): { ok: true; data: Record<Section, string[]> } | { ok: false } {
  const data: Record<Section, string[]> = {
    files_merged: [],
    files_created: [],
    dirs_created: [],
    gitignore_entries_added: [],
    launchd_plists_installed: [],
  };
  let current: Section | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // Block list item under the current section.
    const itemMatch = /^\s+-\s+(.*)$/.exec(line);
    if (itemMatch && current) {
      let v = (itemMatch[1] ?? "").trim();
      // Strip one pair of surrounding quotes (yaml scalar).
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      data[current].push(v);
      continue;
    }
    // Top-level key.
    const keyMatch = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (keyMatch) {
      const key = keyMatch[1] ?? "";
      const rest = (keyMatch[2] ?? "").trim();
      if ((SECTIONS as readonly string[]).includes(key)) {
        current = key as Section;
        // Inline empty/flow list `[]` → no items.
      } else {
        current = null; // a non-list key ends any open section
      }
      void rest;
    }
  }
  return { ok: true, data };
}

const ROLL_MERGE_BLOCK_RE = /<!-- roll:onboard:start -->[\s\S]*?<!-- roll:onboard:end -->\n?/g;

function stripRollMergeBlocks(text: string): string {
  return text.replace(ROLL_MERGE_BLOCK_RE, "");
}

function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function resolveChangesetItem(projectDir: string, item: string): string {
  return item.startsWith("/") ? resolve(item) : resolve(projectDir, item);
}

const HELP = `Usage: roll offboard [--confirm]
  Preview (default) or apply (--confirm) the removal of every
  artefact recorded in .roll/onboard-changeset.yaml.
`;

export function offboardCommand(args: string[]): number {
  let confirm = false;
  for (const arg of args) {
    if (arg === "--confirm" || arg === "-y") {
      confirm = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else {
      err(m("offboard.unknown_flag", arg));
      return 1;
    }
  }

  let projectDir: string;
  try {
    // pwd -P resolves symlinks; realpath the cwd to mirror it.
    projectDir = realpathSync(resolve(process.cwd()));
  } catch {
    projectDir = process.cwd();
  }

  const changeset = changesetPath(projectDir);

  if (!existsSync(changeset)) {
    err(m("offboard.no_changeset_en"));
    err(m("offboard.no_changeset_zh"));
    process.stderr.write("\n");
    process.stderr.write(`  ${m("offboard.manual_offboard")}\n`);
    process.stderr.write(`    ${m("offboard.manual_rm_roll")}\n`);
    process.stderr.write(`    ${m("offboard.manual_rm_agents")}\n`);
    process.stderr.write(`    ${m("offboard.manual_edit_gitignore")}\n`);
    return 1;
  }

  const parsed = parseChangeset(readFileSync(changeset, "utf8"));
  if (!parsed.ok) {
    err(m("offboard.failed_to_parse_changeset"));
    return 1;
  }
  const mergedFiles = parsed.data.files_merged;
  const files = parsed.data.files_created;
  const dirs = parsed.data.dirs_created;
  const giEntries = parsed.data.gitignore_entries_added;
  const plists = parsed.data.launchd_plists_installed;

  // Cross-project guard — every recorded file/dir must resolve under project_dir.
  const all = [...mergedFiles, ...files, ...dirs];
  for (const item of all) {
    const resolved = resolveChangesetItem(projectDir, item);
    if (resolved !== projectDir && !resolved.startsWith(`${projectDir}/`)) {
      err(`Refusing to act on '${item}' — it does not resolve under ${projectDir}`);
      err(m("offboard.en", item));
      process.stderr.write("  This usually means the changeset was copied from another project.\n");
      process.stderr.write("  Remove .roll/onboard-changeset.yaml manually, or rerun in the right dir.\n");
      return 1;
    }
  }

  const { BOLD, RED, YELLOW, NC } = pal();

  // Print the plan.
  process.stdout.write("\n");
  process.stdout.write(`  ${BOLD}Offboard plan for ${projectDir}${NC}\n`);
  process.stdout.write("\n");
  if (files.length > 0) {
    process.stdout.write(`  ${RED}Files to remove:${NC}\n`);
    for (const item of files) process.stdout.write(`    rm   ${item}\n`);
    process.stdout.write("\n");
  }
  if (mergedFiles.length > 0) {
    process.stdout.write(`  ${YELLOW}Roll-owned sections to remove:${NC}\n`);
    for (const item of mergedFiles) process.stdout.write(`    strip ${item}\n`);
    process.stdout.write("\n");
  }
  if (dirs.length > 0) {
    process.stdout.write(`  ${RED}Directories to remove:${NC}\n`);
    for (const item of dirs) process.stdout.write(`    rmdir/r ${item}\n`);
    process.stdout.write("\n");
  }
  if (giEntries.length > 0) {
    process.stdout.write(`  ${YELLOW}.gitignore entries to remove:${NC}\n`);
    for (const item of giEntries) process.stdout.write(`    -    ${item}\n`);
    process.stdout.write("\n");
  }
  if (plists.length > 0) {
    process.stdout.write(`  ${YELLOW}launchd plists to unload:${NC}\n`);
    for (const item of plists) process.stdout.write(`    unload ${item}\n`);
    process.stdout.write("\n");
  }
  if (mergedFiles.length === 0 && files.length === 0 && dirs.length === 0 && giEntries.length === 0 && plists.length === 0) {
    info("Changeset is empty — nothing to offboard.");
    info(m("offboard.change_list_is_empty_nothing_to"));
    return 0;
  }

  if (!confirm) {
    process.stdout.write("  This is a dry-run. Re-run with --confirm to apply.\n");
    process.stdout.write(m("offboard.above_is_a_dry_run_preview") + "\n");
    return 0;
  }

  // FIX-125 cycle-context tripwire: refuse plist mutation from inside a cycle.
  if (plists.length > 0 && loopInCycle()) {
    err("Refusing to unload launchd plists from inside a loop cycle (FIX-125).");
    process.stderr.write("  Run 'roll offboard --confirm' from a terminal outside the cycle,\n");
    process.stderr.write("  or pause the loop first: 'roll loop pause'.\n");
    return 1;
  }

  // Apply.
  process.stdout.write(m("offboard.applying_offboard") + "\n");
  for (const item of mergedFiles) {
    const path = resolveChangesetItem(projectDir, item);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    const after = stripRollMergeBlocks(before);
    if (after !== before) {
      writeFileAtomic(path, after);
      process.stdout.write(`    stripped     ${item}\n`);
    }
  }
  for (const item of files) {
    try {
      const path = resolveChangesetItem(projectDir, item);
      rmSync(path, { force: true });
      if (!existsSync(path)) process.stdout.write(`    removed file ${item}\n`);
    } catch {
      /* rm -f swallows errors */
    }
  }
  for (const item of dirs) {
    try {
      rmSync(resolveChangesetItem(projectDir, item), { recursive: true, force: true });
      process.stdout.write(`    removed dir  ${item}\n`);
    } catch {
      /* rm -rf swallows errors */
    }
  }
  for (const item of giEntries) {
    const gi = join(projectDir, ".gitignore");
    if (existsSync(gi)) {
      const lines = readFileSync(gi, "utf8").split("\n");
      // grep -qFx: exact full-line match.
      if (lines.includes(item)) {
        const kept = lines.filter((l) => l !== item);
        writeFileAtomic(gi, kept.join("\n"));
        process.stdout.write(`    .gitignore -   ${item}\n`);
      }
    }
  }
  for (const item of plists) {
    const plistPath = join(homedir(), "Library", "LaunchAgents", item);
    const r = runLaunchctl(["unload", "-w", plistPath]);
    if (r === 0) process.stdout.write(`    unloaded     ${item}\n`);
    rmSync(plistPath, { force: true });
  }
  // Remove the changeset file itself.
  rmSync(changeset, { force: true });
  ok(m("offboard.offboard_complete_offboard"));
  return 0;
}
