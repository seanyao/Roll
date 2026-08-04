/**
 * Frozen-expectation test: TS `roll consistency`.
 *
 * `consistencyCommand` was proven byte-equal to the bash oracle `bin/roll
 * consistency` (which shelled lib/consistency_check.py) under diff-test, both
 * reading a fabricated --project-dir fixture per dimension (code/docs/i18n/tests/
 * site). Per US-PORT-009c the oracle is retired: the `bin/roll consistency` spawn
 * is dropped and each case freezes the TS `{status, stdout, stderr}` as an inline
 * snapshot (zero engine spawn). Fixtures are fixed file trees → every dimension
 * verdict is deterministic; the random --project-dir path is scrubbed to `<PROJ>`
 * so the frozen value stays portable (macOS `/var/folders` vs Linux CI `/tmp`).
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSISTENCY_DIMENSIONS } from "@roll/core";
import { runConsistencyCheck as consistencyCommand } from "../src/lib/release-consistency.js";
import { seedUpdateCheckCache } from "./helpers.js";

const dirs: string[] = [];
let home = "";
let cwd = ""; // an empty dir the commands run *in* (project-dir is explicit)

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "roll-cn-home-"));
  cwd = mkdtempSync(join(tmpdir(), "roll-cn-cwd-"));
  dirs.push(home, cwd);
  mkdirSync(join(home, ".roll"), { recursive: true });
  seedUpdateCheckCache(join(home, ".roll"));
});

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function mk(): string {
  const p = mkdtempSync(join(tmpdir(), "roll-cn-proj-"));
  dirs.push(p);
  return p;
}
function w(base: string, rel: string, content: string): void {
  const full = join(base, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// ── Fixture builders (one per scenario) ──────────────────────────────────────
function healthy(): string {
  const p = mk();
  w(p, ".roll/backlog.md", "# Backlog\n\n### Feature: widget\n\n| [US-W-001] | thing | ✅ Done |\n");
  w(p, ".roll/features.md", "# Features\n\n- widget — does widget things\n");
  w(p, "guide/en/intro.md", "intro\n");
  w(p, "guide/zh/intro.md", "介绍\n");
  w(p, "lib/i18n/x.sh", "_i18n_set en a.b hi\n_i18n_set zh a.b 你好\n");
  w(p, "tests/cmd_widget.bats", "@test widget {\n  true\n}\n");
  w(p, "site/roll-data.js", 'const FEATURE_GROUPS = [{ name: "widget" }];\n');
  return p;
}

function codeViolation(): string {
  const p = mk();
  // Done feature 'orphan' not present in features.md → code gap.
  w(p, ".roll/backlog.md", "# Backlog\n\n### Feature: orphan\n\n| [US-O-001] | x | ✅ Done |\n");
  w(p, ".roll/features.md", "# Features\n\n- something-else\n");
  return p;
}

function i18nViolation(): string {
  const p = mk();
  // guide/en/extra.md has no zh; i18n key only-en and only-zh.
  w(p, "guide/en/intro.md", "intro\n");
  w(p, "guide/en/extra.md", "extra\n");
  w(p, "guide/zh/intro.md", "介绍\n");
  w(p, "lib/i18n/x.sh", "_i18n_set en only.en hi\n_i18n_set zh only.zh 你\n_i18n_set en both.k a\n_i18n_set zh both.k b\n");
  return p;
}

function testsViolation(): string {
  const p = mk();
  // Done feature 'authentication' with no matching test; a stale test file.
  w(p, ".roll/backlog.md", "# Backlog\n\n### Feature: authentication\n\n| [US-A-001] | x | ✅ Done |\n");
  w(p, "tests/stalefeature.bats", "@test x {\n  true\n}\n");
  return p;
}

function siteViolation(): string {
  const p = mk();
  w(p, "site/roll-data.js", 'const NAV = [{ path: "guide/en/ghost.md" }];\n');
  return p;
}

function docsCommandSurfaceViolation(): string {
  const p = mk();
  w(p, "README.md", "Use `roll feedback` to file quick notes.\n");
  return p;
}

function siteCommandSurfaceViolation(): string {
  const p = mk();
  w(p, "site/roll-data.js", 'const FEATURE_GROUPS = [{ name: "roll alert" }];\n');
  return p;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function envBase(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    ROLL_HOME: join(home, ".roll"),
    NO_COLOR: "1",
    ...extra,
  };
}

const ENV_KEYS = ["PATH", "HOME", "ROLL_HOME", "NO_COLOR", "ROLL_LANG", "LC_ALL", "LANG"];

function tsCn(args: string[], extra: Record<string, string>): Run {
  const save: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) save[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(envBase(extra))) process.env[k] = v;
  const saveCwd = process.cwd();
  process.chdir(cwd);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (outChunks.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (errChunks.push(String(c)), true);
  let status: number;
  try {
    status = consistencyCommand(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const k of ENV_KEYS) {
      const v = save[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { status, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

/** Run the TS command and scrub the random --project-dir path → portable. */
function cn(args: string[], proj: string, extra: Record<string, string> = {}): Run {
  const t = tsCn(args, extra);
  const scrub = (s: string): string => (proj ? s.split(proj).join("<PROJ>") : s);
  return { status: t.status, stdout: scrub(t.stdout), stderr: scrub(t.stderr) };
}

// Unrolled (inline snapshots are keyed by call site — a loop can't hold distinct
// per-case frozen values).
describe("frozen: roll consistency", () => {
  it("check (human) — healthy (all pass)", () => {
    const p = healthy();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ✅ code-backlog: pass
      ✅ cards: pass
      ✅ docs: pass
         ℹ retired-command scan + release-delta changelog coverage active
      ✅ tests: pass
      ✅ bilingual: pass
      ✅ site: pass
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: pass
      ",
      }
    `);
  });
  it("check --json — healthy (all pass)", () => {
    const p = healthy();
    expect(cn(["check", "--json", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "{
        "overall": "pass",
        "dimensions": {
          "code-backlog": {
            "status": "pass",
            "gaps": []
          },
          "cards": {
            "status": "pass",
            "gaps": []
          },
          "docs": {
            "status": "pass",
            "gaps": [],
            "note": "retired-command scan + release-delta changelog coverage active"
          },
          "tests": {
            "status": "pass",
            "gaps": []
          },
          "bilingual": {
            "status": "pass",
            "gaps": []
          },
          "site": {
            "status": "pass",
            "gaps": [],
            "note": "checked top-level commands and guide links; story-to-site coverage is not configured"
          },
          "truth-live": {
            "status": "pass",
            "gaps": []
          }
        }
      }
      ",
      }
    `);
  });

  it("check (human) — code dimension gap", () => {
    const p = codeViolation();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ❌ code-backlog: fail
         • Feature 'orphan' has Done stories but is missing from features.md catalog
      ✅ cards: pass
      ✅ docs: pass
         ℹ retired-command scan + release-delta changelog coverage active
      ✅ tests: pass
      ✅ bilingual: pass
      ✅ site: pass
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: fail
      ",
      }
    `);
  });
  it("check --json — code dimension gap", () => {
    const p = codeViolation();
    expect(cn(["check", "--json", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "{
        "overall": "fail",
        "dimensions": {
          "code-backlog": {
            "status": "fail",
            "gaps": [
              "Feature 'orphan' has Done stories but is missing from features.md catalog"
            ]
          },
          "cards": {
            "status": "pass",
            "gaps": []
          },
          "docs": {
            "status": "pass",
            "gaps": [],
            "note": "retired-command scan + release-delta changelog coverage active"
          },
          "tests": {
            "status": "pass",
            "gaps": []
          },
          "bilingual": {
            "status": "pass",
            "gaps": []
          },
          "site": {
            "status": "pass",
            "gaps": [],
            "note": "checked top-level commands and guide links; story-to-site coverage is not configured"
          },
          "truth-live": {
            "status": "pass",
            "gaps": []
          }
        }
      }
      ",
      }
    `);
  });

  it("check (human) — i18n dimension gaps (guide parity + key parity)", () => {
    const p = i18nViolation();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ✅ code-backlog: pass
      ✅ cards: pass
      ✅ docs: pass
         ℹ retired-command scan + release-delta changelog coverage active
      ✅ tests: pass
      ❌ bilingual: fail
         • guide/en/extra.md has no corresponding guide/zh/extra.md
         • i18n key 'only.en' has EN but is missing ZH translation
         • i18n key 'only.zh' has ZH but is missing EN translation
      ✅ site: pass
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: fail
      ",
      }
    `);
  });
  it("check --json — i18n dimension gaps (guide parity + key parity)", () => {
    const p = i18nViolation();
    expect(cn(["check", "--json", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "{
        "overall": "fail",
        "dimensions": {
          "code-backlog": {
            "status": "pass",
            "gaps": []
          },
          "cards": {
            "status": "pass",
            "gaps": []
          },
          "docs": {
            "status": "pass",
            "gaps": [],
            "note": "retired-command scan + release-delta changelog coverage active"
          },
          "tests": {
            "status": "pass",
            "gaps": []
          },
          "bilingual": {
            "status": "fail",
            "gaps": [
              "guide/en/extra.md has no corresponding guide/zh/extra.md",
              "i18n key 'only.en' has EN but is missing ZH translation",
              "i18n key 'only.zh' has ZH but is missing EN translation"
            ]
          },
          "site": {
            "status": "pass",
            "gaps": [],
            "note": "checked top-level commands and guide links; story-to-site coverage is not configured"
          },
          "truth-live": {
            "status": "pass",
            "gaps": []
          }
        }
      }
      ",
      }
    `);
  });

  it("check (human) — tests dimension gaps (coverage + stale)", () => {
    const p = testsViolation();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ✅ code-backlog: pass
      ✅ cards: pass
      ✅ docs: pass
         ℹ retired-command scan + release-delta changelog coverage active
      ❌ tests: fail
         • Feature 'authentication' has Done stories but no test file appears to cover it (heuristic: no test file name matches keywords ['authentication'])
         • Test file 'stalefeature.bats' appears to reference feature 'stalefeature' which does not exist in backlog — may be stale
      ✅ bilingual: pass
      ✅ site: pass
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: fail
      ",
      }
    `);
  });
  it("check --json — tests dimension gaps (coverage + stale)", () => {
    const p = testsViolation();
    expect(cn(["check", "--json", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "{
        "overall": "fail",
        "dimensions": {
          "code-backlog": {
            "status": "pass",
            "gaps": []
          },
          "cards": {
            "status": "pass",
            "gaps": []
          },
          "docs": {
            "status": "pass",
            "gaps": [],
            "note": "retired-command scan + release-delta changelog coverage active"
          },
          "tests": {
            "status": "fail",
            "gaps": [
              "Feature 'authentication' has Done stories but no test file appears to cover it (heuristic: no test file name matches keywords ['authentication'])",
              "Test file 'stalefeature.bats' appears to reference feature 'stalefeature' which does not exist in backlog — may be stale"
            ]
          },
          "bilingual": {
            "status": "pass",
            "gaps": []
          },
          "site": {
            "status": "pass",
            "gaps": [],
            "note": "checked top-level commands and guide links; story-to-site coverage is not configured"
          },
          "truth-live": {
            "status": "pass",
            "gaps": []
          }
        }
      }
      ",
      }
    `);
  });

  it("check (human) — site dimension gap", () => {
    const p = siteViolation();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ✅ code-backlog: pass
      ✅ cards: pass
      ✅ docs: pass
         ℹ retired-command scan + release-delta changelog coverage active
      ✅ tests: pass
      ✅ bilingual: pass
      ❌ site: fail
         • site/roll-data.js links a guide that does not exist: guide/en/ghost.md
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: fail
      ",
      }
    `);
  });
  it("check --json — site dimension gap", () => {
    const p = siteViolation();
    expect(cn(["check", "--json", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "{
        "overall": "fail",
        "dimensions": {
          "code-backlog": {
            "status": "pass",
            "gaps": []
          },
          "cards": {
            "status": "pass",
            "gaps": []
          },
          "docs": {
            "status": "pass",
            "gaps": [],
            "note": "retired-command scan + release-delta changelog coverage active"
          },
          "tests": {
            "status": "pass",
            "gaps": []
          },
          "bilingual": {
            "status": "pass",
            "gaps": []
          },
          "site": {
            "status": "fail",
            "gaps": [
              "site/roll-data.js links a guide that does not exist: guide/en/ghost.md"
            ],
            "note": "checked top-level commands and guide links; story-to-site coverage is not configured"
          },
          "truth-live": {
            "status": "pass",
            "gaps": []
          }
        }
      }
      ",
      }
    `);
  });

  it("check (human) — docs hidden/retired command surface gap", () => {
    const p = docsCommandSurfaceViolation();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ✅ code-backlog: pass
      ✅ cards: pass
      ❌ docs: fail
         • README.md:1 references hidden/retired top-level 'roll feedback' (use 'roll idea')
      ✅ tests: pass
      ✅ bilingual: pass
      ✅ site: pass
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: fail
      ",
      }
    `);
  });

  it("check --json — site hidden/retired command surface gap", () => {
    const p = siteCommandSurfaceViolation();
    expect(cn(["check", "--json", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "",
        "stdout": "{
        "overall": "fail",
        "dimensions": {
          "code-backlog": {
            "status": "pass",
            "gaps": []
          },
          "cards": {
            "status": "pass",
            "gaps": []
          },
          "docs": {
            "status": "pass",
            "gaps": [],
            "note": "retired-command scan + release-delta changelog coverage active"
          },
          "tests": {
            "status": "pass",
            "gaps": []
          },
          "bilingual": {
            "status": "pass",
            "gaps": []
          },
          "site": {
            "status": "fail",
            "gaps": [
              "site/roll-data.js:1 references hidden/retired top-level 'roll alert' (use 'roll loop alert')"
            ],
            "note": "checked top-level commands and guide links; story-to-site coverage is not configured"
          },
          "truth-live": {
            "status": "pass",
            "gaps": []
          }
        }
      }
      ",
      }
    `);
  });

  it("check on an empty project-dir → all pass", () => {
    const p = mk();
    expect(cn(["check", "--project-dir", p], p)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Consistency Report
      ==================================================
      ✅ code-backlog: pass
      ✅ cards: pass
      ✅ docs: pass
         ℹ retired-command scan + release-delta changelog coverage active
      ✅ tests: pass
      ✅ bilingual: pass
      ✅ site: pass
         ℹ checked top-level commands and guide links; story-to-site coverage is not configured
      ✅ truth-live: pass
      --------------------------------------------------
      Overall: pass
      ",
      }
    `);
  });

  it("help output (long)", () => {
    expect(cn(["--help"], "")).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "Usage: roll release --gate-check <subcommand>

        check [--json] [--project-dir DIR]    逐维度跑一致性检查
          Run checks across seven dimensions (code-backlog, cards, docs, tests,
          bilingual, site, truth-live) and produce a verdict-first table. Any failing
          dimension aborts the release.
          跑七维一致性、判定优先输出；任一维失败即中止发版。
          Site checks cover surviving top-level command mentions and guide links only;
          story-to-site coverage is not configured.
          site 检查只覆盖仍存活的顶层命令引用和指南链接；不核对每张故事是否上站。

        roll release --gate-check check                # verdict-first seven-dimension table
        roll release --gate-check check --json         # machine-readable JSON (same computation)
        roll release --gate-check audit [--json]       # US-TRUTH-002 shadow drift audit (read-only, exit 0)
      ",
      }
    `);
  });

  it("unknown subcommand → exit 1 (en)", () => {
    expect(cn(["bogus"], "", { ROLL_LANG: "en" })).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "[roll] Unknown consistency subcommand: bogus
      [roll] Try: roll release --gate-check check
      ",
        "stdout": "",
      }
    `);
  });
  it("unknown subcommand → exit 1 (zh)", () => {
    expect(cn(["bogus"], "", { ROLL_LANG: "zh" })).toMatchInlineSnapshot(`
      {
        "status": 1,
        "stderr": "[roll] 未知的一致性子命令: bogus
      [roll] Try: roll release --gate-check check
      ",
        "stdout": "",
      }
    `);
  });
});

// ── US-DOSSIER-022: same-vocabulary contract (AC2 / AC3) ─────────────────────
// Both faces read @roll/core's CONSISTENCY_DIMENSIONS. The web panel proves it
// in truth-console.test.ts (data-dim="<key>" for all gate dimensions); here we prove the
// `roll release` gate report emits the SAME keys in the SAME order, so a
// reader who sees `bilingual` in the browser sees `bilingual` (never `i18n`) in
// the terminal — Delivery Dossier ruling #3, 各面同口径.

/** Pull the dimension keys, in order, out of the human report's `<icon> key: status` lines. */
function reportDimKeys(stdout: string): string[] {
  const keys: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(?:✅|❌)\s+(\S+):\s+(?:pass|fail)$/.exec(line);
    if (m?.[1] !== undefined) keys.push(m[1]);
  }
  return keys;
}

/** Parse `{overall, dimensions}` JSON from the --json report. */
function reportJson(proj: string): { overall: string; dimensions: Record<string, { status: string }> } {
  return JSON.parse(cn(["check", "--json", "--project-dir", proj], proj).stdout);
}

describe("US-DOSSIER-022: web + CLI read one dimension vocabulary", () => {
  it("AC2: the gate report's dimension keys equal CONSISTENCY_DIMENSIONS, in order", () => {
    const p = healthy();
    const cliKeys = reportDimKeys(cn(["check", "--project-dir", p], p).stdout);
    // The exact constant the web panel (release-panel.ts) iterates.
    expect(cliKeys).toEqual([...CONSISTENCY_DIMENSIONS]);
    // …and the JSON report keys match the same sequence verbatim.
    expect(Object.keys(reportJson(p).dimensions)).toEqual([...CONSISTENCY_DIMENSIONS]);
  });

  it("AC2: the retired vocabulary ('code', 'i18n') no longer appears as a dimension key", () => {
    const p = healthy();
    const keys = Object.keys(reportJson(p).dimensions);
    expect(keys).not.toContain("code");
    expect(keys).not.toContain("i18n");
    expect(keys).toContain("code-backlog");
    expect(keys).toContain("bilingual");
  });

  it("AC3: each dimension is accounted for exactly once — none lost, none duplicated", () => {
    const p = healthy();
    const keys = Object.keys(reportJson(p).dimensions);
    expect(new Set(keys).size).toBe(CONSISTENCY_DIMENSIONS.length);
    expect(keys.length).toBe(CONSISTENCY_DIMENSIONS.length);
  });
});

// ── US-DOSSIER-036: `roll release consistency check` verdict-first table ──────
// The public command renders the verdict-first seven-dimension table (renderMode
// "table") from the SAME runAll computation the gate runs. AC3 (gate dims, one
// vocabulary, f/w/?), AC4 (any f>0 fails → exit non-zero, verdict first), AC7
// (--json field-by-field parity with the human table).

function tableRun(args: string[], proj: string, extra: Record<string, string> = {}): Run {
  const save: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) save[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(envBase(extra))) process.env[k] = v;
  const saveCwd = process.cwd();
  process.chdir(cwd);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (outChunks.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (errChunks.push(String(c)), true);
  let status: number;
  try {
    status = consistencyCommand(args, "roll release consistency", { renderMode: "table" }) as number;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const k of ENV_KEYS) {
      const v = save[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const scrub = (s: string): string => (proj ? s.split(proj).join("<PROJ>") : s);
  return { status, stdout: scrub(outChunks.join("")), stderr: scrub(errChunks.join("")) };
}

describe("US-DOSSIER-036: roll release consistency check — verdict-first table", () => {
  it("AC3/AC4: healthy → PASS first, seven ①…⑦ dims, f:0 everywhere, exit 0", () => {
    const r = tableRun(["check", "--project-dir", healthy()], "", { ROLL_LANG: "en" });
    expect(r.status).toBe(0);
    const first = r.stdout.split("\n")[0] ?? "";
    expect(first).toContain("PASS");
    expect(first).toContain("exit 0");
    for (const glyph of ["① code ↔ backlog", "② cards / evidence", "③ docs", "④ tests", "⑤ bilingual", "⑥ site", "⑦ truth live"]) {
      expect(r.stdout).toContain(glyph);
    }
    expect(r.stdout).toContain("checked top-level commands and guide links; story-to-site coverage is not configured");
    expect(r.stdout).toContain("any f>0 aborts the release");
  });

  it("AC4: a failing dimension makes the verdict FAIL and exits non-zero", () => {
    const r = tableRun(["check", "--project-dir", codeViolation()], "", { ROLL_LANG: "en" });
    expect(r.status).toBe(1);
    const first = r.stdout.split("\n")[0] ?? "";
    expect(first).toContain("FAIL");
    expect(first).toContain("1 fail");
    expect(first).toContain("exit 1");
    // the failing dim's row carries f:1.
    expect(r.stdout).toMatch(/① code ↔ backlog[\s\S]*?f:1/);
  });

  it("AC7: --json carries the same overall verdict + per-dim f/w/? as the human table", () => {
    const p = codeViolation();
    const human = tableRun(["check", "--project-dir", p], "", { ROLL_LANG: "en" });
    const j = JSON.parse(tableRun(["check", "--json", "--project-dir", p], "").stdout) as {
      overall: string;
      dimensions: Record<string, { status: string; fail: number; warn: number; unknown: number }>;
    };
    expect(j.overall).toBe("fail");
    expect(human.stdout.split("\n")[0]).toContain("FAIL");
    // The dims, in the shared CONSISTENCY_DIMENSIONS order.
    expect(Object.keys(j.dimensions)).toEqual([...CONSISTENCY_DIMENSIONS]);
    // The failing dim's count equals the f:N the human row printed.
    expect(j.dimensions["code-backlog"]?.fail).toBe(1);
    expect(j.dimensions["cards"]?.fail).toBe(0);
  });

  it("AC8: bilingual dimension labels render on SEPARATE lines (zh)", () => {
    const r = tableRun(["check", "--project-dir", healthy()], "", { ROLL_LANG: "zh" });
    expect(r.status).toBe(0);
    // The verdict word is localized; the zh dim names ride their own lines.
    expect(r.stdout).toContain("通过");
    expect(r.stdout).toContain("代码↔待办");
    expect(r.stdout).toContain("站点");
  });
});
