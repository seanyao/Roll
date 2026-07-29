/**
 * US-ATTEST-006 — `roll attest` composition pins: feature-file resolution,
 * run-dir lifecycle + latest symlink, evidence.json, the ac-map intent hook
 * (absent ⇒ honest all-Claimed), and the never-block failure policy.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RollCaptureProvider, type EvidenceRun, type ShotRun } from "@roll/infra";
import { createHash } from "node:crypto";
import {
  ROLL_CAPTURE_HOST_APP_NAME,
  ROLL_CAPTURE_HOST_BUNDLE_ID,
  ROLL_CAPTURE_PROTOCOL_V1,
  ROLL_CAPTURE_PROTOCOL_V2,
  type CaptureIntentV2,
  type CaptureReceiptV2,
  type RollCaptureRequestV1,
  type RollCaptureResponseV1,
} from "@roll/spec";
import { bi, type CaptureLanePort } from "@roll/core";
import {
  assessDocGapFromFiles,
  attestCommand,
  buildCardContext,
  detectAfterOnly,
  detectBeforeAfter,
  findFeatureFile,
  readBacklogRow,
  resolveStoryAcItems,
} from "../src/commands/attest.js";
import { collectBrowserTimeline } from "../src/lib/browser-timeline-collect.js";
import { collectBrowserTruth } from "../src/lib/browser-truth-collect.js";
import { renderStoryPage } from "../src/lib/story-page.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function project(): string {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-")));
  dirs.push(proj);
  mkdirSync(join(proj, ".roll", "features", "demo"), { recursive: true });
  writeFileSync(
    join(proj, ".roll", "features", "demo", "FIX-300.md"),
    ["# FIX-300 — demo", "", "**AC:**", "- [ ] 第一条验收", "- [ ] 第二条验收", ""].join("\n"),
  );
  return proj;
}

const quietRun: EvidenceRun = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

function inDir<T>(proj: string, fn: () => Promise<T>): Promise<T> {
  const save = process.cwd();
  process.chdir(proj);
  return fn().finally(() => process.chdir(save));
}

function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (): boolean => true;
  // @ts-expect-error capture-only
  process.stderr.write = (): boolean => true;
  return fn().finally(() => {
    process.stdout.write = o;
    process.stderr.write = e;
  });
}

function capturedStdout<T>(fn: () => Promise<T>): Promise<{ code: T; stdout: string }> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let stdout = "";
  // @ts-expect-error capture-only
  process.stdout.write = (s: string): boolean => {
    stdout += String(s);
    return true;
  };
  // @ts-expect-error capture-only
  process.stderr.write = (): boolean => true;
  return fn()
    .then((code) => ({ code, stdout }))
    .finally(() => {
      process.stdout.write = o;
      process.stderr.write = e;
    });
}

const T0 = new Date("2026-06-06T01:02:03");

describe("findFeatureFile", () => {
  it("ID-named file wins over content mentions", () => {
    const proj = project();
    writeFileSync(join(proj, ".roll", "features", "demo", "other.md"), "mentions FIX-300 in prose\n");
    expect(findFeatureFile(proj, "FIX-300")).toContain("FIX-300.md");
  });
  it("missing story → null", () => {
    expect(findFeatureFile(project(), "US-NOPE-9")).toBeNull();
  });
  it("FIX-225: story-dir <ID>/spec.md wins over a prose mention walked earlier", () => {
    const proj = project();
    // The hijack case: an alphabetically-earlier epic mentions the ID in prose.
    mkdirSync(join(proj, ".roll", "features", "aa-epic"), { recursive: true });
    writeFileSync(join(proj, ".roll", "features", "aa-epic", "other.md"), "mentions FIX-400 in prose\n");
    mkdirSync(join(proj, ".roll", "features", "demo", "FIX-400"), { recursive: true });
    writeFileSync(join(proj, ".roll", "features", "demo", "FIX-400", "spec.md"), "# FIX-400\n\n**AC:**\n- [ ] x\n");
    expect(findFeatureFile(proj, "FIX-400")).toContain(join("demo", "FIX-400", "spec.md"));
  });
  it("FIX-1059: a card whose spec.md is a symlink to the real spec is found", () => {
    const proj = project();
    // The persistent spec lives OUTSIDE the walked features tree (the main
    // checkout's .roll); the only in-tree reference is the card's symlinked
    // spec.md — the loop worktree layout. Content-mention resolution can't see
    // the target, so the symlink is the sole path to the story.
    const realSpec = join(proj, "main-checkout-spec.md");
    writeFileSync(realSpec, "# FIX-1057\n\n**AC:**\n- [ ] x\n");
    const cardDir = join(proj, ".roll", "features", "uncategorized", "FIX-1057");
    mkdirSync(cardDir, { recursive: true });
    const linked = join(cardDir, "spec.md");
    symlinkSync(realSpec, linked);
    expect(findFeatureFile(proj, "FIX-1057")).toBe(linked);
  });
  it("FIX-1059: a broken symlinked spec.md is ignored safely (story → null)", () => {
    const proj = project();
    mkdirSync(join(proj, ".roll", "features", "uncategorized", "FIX-1058"), { recursive: true });
    symlinkSync(
      join(proj, ".roll", "features", "does-not-exist.md"),
      join(proj, ".roll", "features", "uncategorized", "FIX-1058", "spec.md"),
    );
    expect(findFeatureFile(proj, "FIX-1058")).toBeNull();
  });
  it("FIX-1059: a symlinked directory named like a card is not followed as a file", () => {
    const proj = project();
    // A symlink to a DIRECTORY whose name ends in .md must never be read as a file.
    mkdirSync(join(proj, ".roll", "features", "real-dir"), { recursive: true });
    symlinkSync(
      join(proj, ".roll", "features", "real-dir"),
      join(proj, ".roll", "features", "demo", "loop.md"),
    );
    expect(findFeatureFile(proj, "FIX-9999")).toBeNull();
  });
});

describe("roll attest audit", () => {
  it("lists dangling evidence refs for Done cards", async () => {
    const proj = project();
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      "| ID | Description | Status |\n|----|----|----|\n| FIX-300 | demo | ✅ Done |\n",
    );
    const cardDir = join(proj, ".roll", "features", "demo", "FIX-300");
    mkdirSync(join(cardDir, "latest"), { recursive: true });
    writeFileSync(join(cardDir, "latest", "FIX-300-report.html"), "<html>report</html>\n");
    writeFileSync(
      join(cardDir, "ac-map.json"),
      JSON.stringify([{ ac: "FIX-300:AC1", status: "pass", evidence: [{ kind: "screenshot", href: "screenshots/missing.png" }] }], null, 2) + "\n",
    );

    const text = await inDir(proj, () => capturedStdout(() => attestCommand(["audit"])));
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("FIX-300");
    expect(text.stdout).toContain("screenshots/missing.png");

    const json = await inDir(proj, () => capturedStdout(() => attestCommand(["audit", "--json"])));
    expect(JSON.parse(json.stdout)).toEqual({
      issues: [{ storyId: "FIX-300", missing: ["FIX-300:AC1 screenshots/missing.png"] }],
      debts: [],
    });
  });

  it("US-EVID-019 R2: lists evidence_debt Done cards separately", async () => {
    const proj = project();
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      "| ID | Description | Status |\n|----|----|----|\n| US-LEGACY-1 | old delivery | ✅ Done · evidence_debt |\n",
    );

    const text = await inDir(proj, () => capturedStdout(() => attestCommand(["audit"])));
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("attest audit: evidence debt");
    expect(text.stdout).toContain("US-LEGACY-1");
    expect(text.stdout).not.toContain("dangling evidence references\n- US-LEGACY-1");

    const json = await inDir(proj, () => capturedStdout(() => attestCommand(["audit", "--json"])));
    expect(JSON.parse(json.stdout)).toEqual({
      issues: [],
      debts: [{ storyId: "US-LEGACY-1", reason: "legacy Done row has evidence_debt" }],
    });
  });
});

describe("FIX-1059 — attest finds a symlinked card spec (FIX-1057 worktree shape)", () => {
  it("writes <ID>-report.html instead of exiting story-not-found", async () => {
    const proj = project();
    // Reproduce the worktree layout: features/<epic>/<ID>/spec.md is a symlink to
    // a persistent spec OUTSIDE the walked features tree (the main checkout's
    // .roll). Without symlink-aware lookup, the story resolves as not-found.
    const realSpec = join(proj, "persistent-FIX-1057-spec.md");
    writeFileSync(
      realSpec,
      ["# FIX-1057 — linked spec", "", "**AC:**", "- [ ] 第一条验收", "- [ ] 第二条验收", ""].join("\n"),
    );
    const cardDir = join(proj, ".roll", "features", "uncategorized", "FIX-1057");
    mkdirSync(cardDir, { recursive: true });
    symlinkSync(realSpec, join(cardDir, "spec.md"));
    const runDir = join(cardDir, "2026-06-06T01-02-03");
    mkdirSync(runDir, { recursive: true });
    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-1057", "--run-dir", runDir], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }),
      ),
    );
    expect(code).toBe(0);
    expect(existsSync(join(runDir, "FIX-1057-report.html"))).toBe(true);
    // The AC block from the linked spec is rendered (story resolved, not skipped).
    expect(readFileSync(join(runDir, "FIX-1057-report.html"), "utf8")).toContain("第一条验收");
  });
});

describe("US-META-010 doc-gap shadow check", () => {
  it("flags command-surface changes when no documentation file changed in the same diff", () => {
    expect(assessDocGapFromFiles(["packages/cli/src/commands/status.ts"])).toEqual({
      changedFiles: ["packages/cli/src/commands/status.ts"],
      visibleFiles: ["packages/cli/src/commands/status.ts"],
    });
  });

  it("does not flag the same command change when docs are updated", () => {
    expect(assessDocGapFromFiles(["packages/cli/src/commands/status.ts", "guide/en/status.md"])).toBeUndefined();
  });

  it("ignores internal-only implementation files", () => {
    expect(assessDocGapFromFiles(["packages/core/src/scoring/model.ts"])).toBeUndefined();
  });
});

describe("resolveStoryAcItems — FIX-226 stub-owner AC fallback", () => {
  // A migrate-features stub (US-META-007) owns the card folder but carries no
  // **AC:** block; the real ACs live in the multi-story epic feature file.
  function withStubAndEpic(): string {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-fix226-")));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll", "features", "bash-endgame", "US-PORT-9"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "features", "bash-endgame", "US-PORT-9", "spec.md"),
      ["---", "id: US-PORT-9", "---", "", "# US-PORT-9", "", "> Auto-generated by migrate-features.", ""].join("\n"),
    );
    writeFileSync(
      join(proj, ".roll", "features", "bash-endgame", "port-or-drop.md"),
      ["## US-PORT-9 demo ✅", "", "**AC:**", "- [x] 第一条验收", "- [x] 第二条验收", "", "## US-OTHER-1 unrelated", ""].join("\n"),
    );
    return proj;
  }

  it("falls through a content-free stub spec.md to the epic file's AC block", () => {
    const items = resolveStoryAcItems(withStubAndEpic(), "US-PORT-9");
    expect(items.map((i) => i.id)).toEqual(["US-PORT-9:AC1", "US-PORT-9:AC2"]);
  });

  it("does NOT regress FIX-225: a stub WITH its own AC block still wins", () => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-fix226b-")));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll", "features", "demo", "US-OWN-1"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "features", "demo", "US-OWN-1", "spec.md"),
      ["# US-OWN-1", "", "**AC:**", "- [ ] 自有验收", ""].join("\n"),
    );
    // A prose mention elsewhere must not hijack the owner's own AC.
    writeFileSync(join(proj, ".roll", "features", "demo", "noise.md"), "## US-OWN-1 noise\n\n**AC:**\n- [ ] 不该被选中\n- [ ] 也不该\n");
    const items = resolveStoryAcItems(proj, "US-OWN-1");
    expect(items.map((i) => i.text)).toEqual(["自有验收"]);
  });

  // FIX-374: a card-folder `<id>/spec.md` whose `##` heading mentions a SIBLING
  // card id used to re-attribute the trailing `## Acceptance Criteria` block to
  // the sibling, so the report rendered zero ACs (the FIX-214 hijack class, via
  // the directory layout). The folder owns the whole file → its ACs must resolve.
  it("FIX-374: a sibling-id heading in a card-folder spec.md does not hijack the ACs", () => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-fix374-")));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll", "features", "release-management", "FIX-372"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "features", "release-management", "FIX-372", "spec.md"),
      [
        "---",
        "id: FIX-372",
        "---",
        "",
        "# FIX-372 — Release page",
        "",
        "## Root cause (traced — FIX-368 sibling)", // foreign id in the heading
        "Some prose.",
        "",
        "## Acceptance Criteria",
        "- [ ] pending = post-tag delta",
        "- [ ] gate self-explaining",
        "",
      ].join("\n"),
    );
    const items = resolveStoryAcItems(proj, "FIX-372");
    expect(items.map((i) => i.id)).toEqual(["FIX-372:AC1", "FIX-372:AC2"]);
  });
});

describe("attestCommand", () => {
  it("writes evidence.json + report.html under a run dir and points latest at it", async () => {
    const proj = project();
    const oldLang = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "en";
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "loop", "runs.jsonl"),
      JSON.stringify({ cycle_id: "C-TOOL", story_id: "FIX-300", run_id: "C-TOOL", status: "merged", outcome: "delivered", agent: "codex" }) + "\n",
    );
    writeFileSync(
      join(proj, ".roll", "loop", "events.ndjson"),
      [
        JSON.stringify({ type: "cycle:start", cycleId: "C-TOOL", storyId: "FIX-300", agent: "codex", ts: 1 }),
        JSON.stringify({ type: "cycle:end", cycleId: "C-TOOL", outcome: "delivered", cost: { cycleId: "C-TOOL", agent: "codex", model: "gpt-5", tokensIn: 1, tokensOut: 1, estimatedCost: 0.01, revertCount: 0, effectiveCost: 0.01, currency: "USD", toolCosts: [{ toolId: "bash", invocations: 2, durationMs: 21000, failures: 0, estimatedCost: 0, currency: "USD" }] }, ts: 2 }),
      ].join("\n") + "\n",
    );
    const got = await capturedStdout(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    ).finally(() => {
      if (oldLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = oldLang;
    });
    expect(got.code).toBe(0);
    expect(got.stdout).toContain("Acceptance Review Page");
    expect(got.stdout).toContain("FIX-300-review.html");
    expect(got.stdout).toContain("legacy report alias");
    expect(got.stdout).toContain("FIX-300-report.html");
    expect(got.stdout).not.toContain("Acceptance report written");
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "evidence.json"))).toBe(true);
    expect(existsSync(join(runDir, "FIX-300-review.html"))).toBe(true);
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain("FIX-300 — Acceptance Review Page");
    expect(html).toContain("Tool cost");
    expect(html).toContain("bash×2(21s)");
    expect(lstatSync(join(storyDir, "latest")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(storyDir, "latest"))).toBe("2026-06-06T01-02-03");
    // US-V4-001: attest is story-scoped. Writing the report does NOT refresh the
    // global dossier front page (`.roll/features/index.html`) — that page is
    // rendered on demand by `roll index`, not as a delivery side effect.
    expect(existsSync(join(proj, ".roll", "features", "index.html"))).toBe(false);
  });

  it("FIX-315: ac-map evidence at the story/card dir resolves — a pass with story-level evidence is NOT downgraded to claimed", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    // The common shape: dom probes / test logs live at the STORY (card) level,
    // NOT inside the era run dir, and the ac-map references them run-dir-relative
    // (`evidence/x`) — the way agents routinely write it. Before FIX-315 the
    // render resolved evidence ONLY against the era run dir, dropped the ref,
    // emptied the AC's evidence, and enforceRedLine downgraded pass → claimed,
    // so the attest gate rejected a fully-evidenced delivery as an empty shell.
    mkdirSync(join(storyDir, "evidence"), { recursive: true });
    writeFileSync(join(storyDir, "evidence", "probe.txt"), "DOM PROBE OK — ladder grid present\n");
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        { ac: "FIX-300:AC1", status: "pass", evidence: [{ kind: "text", label: "dom probe", textFile: "evidence/probe.txt" }] },
        { ac: "FIX-300:AC2", status: "pass", evidence: [{ kind: "text", label: "dom probe", textFile: "evidence/probe.txt" }] },
      ]),
    );
    const code = await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    expect(code).toBe(0);
    const html = readFileSync(join(storyDir, "2026-06-06T01-02-03", "FIX-300-report.html"), "utf8");
    // Story-level evidence resolved → the positive verdict stands (no honesty
    // downgrade) and the probe text is inlined into the AC section.
    expect(html).toContain("DOM PROBE OK — ladder grid present");
    expect(html).toMatch(/<section class="ac s-pass"/);
    // Both ACs were `pass` with real evidence → none downgraded to claimed.
    expect(html).not.toMatch(/<section class="ac s-claimed"/);
  });

  it("FIX-332: resume with an empty run dir reuses evidence from a prior run frame", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const oldRunDir = join(storyDir, "2026-06-05T00-00-00");
    const newRunDir = join(storyDir, "2026-06-06T01-02-04");
    mkdirSync(join(oldRunDir, "evidence"), { recursive: true });
    mkdirSync(newRunDir, { recursive: true });
    writeFileSync(join(oldRunDir, "evidence", "vitest.txt"), "RESUME EVIDENCE FROM PRIOR RUN\n");
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        {
          ac: "FIX-300:AC1",
          status: "pass",
          evidence: [{ kind: "text", label: "vitest", textFile: "evidence/vitest.txt" }],
        },
      ]),
    );

    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--run-dir", newRunDir], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }),
      ),
    );

    expect(code).toBe(0);
    const html = readFileSync(join(newRunDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain("RESUME EVIDENCE FROM PRIOR RUN");
    expect(html).toMatch(/<section class="ac s-pass" id="FIX-300:AC1"/);
    // AC2 has no ac-map entry and remains honestly claimed — that is NOT a bug.
    expect(html).not.toMatch(/<section class="ac s-claimed" id="FIX-300:AC1"/);
  });

  it("FIX-332: a populated run dir uses its own evidence, not a stale sibling's", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const oldRunDir = join(storyDir, "2026-06-05T00-00-00");
    const newRunDir = join(storyDir, "2026-06-06T01-02-04");
    mkdirSync(join(oldRunDir, "evidence"), { recursive: true });
    mkdirSync(join(newRunDir, "evidence"), { recursive: true });
    writeFileSync(join(oldRunDir, "evidence", "vitest.txt"), "STALE OLD EVIDENCE\n");
    writeFileSync(join(newRunDir, "evidence", "vitest.txt"), "FRESH NEW EVIDENCE\n");
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        {
          ac: "FIX-300:AC1",
          status: "pass",
          evidence: [{ kind: "text", label: "vitest", textFile: "evidence/vitest.txt" }],
        },
      ]),
    );

    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--run-dir", newRunDir], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }),
      ),
    );

    expect(code).toBe(0);
    const html = readFileSync(join(newRunDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain("FRESH NEW EVIDENCE");
    expect(html).not.toContain("STALE OLD EVIDENCE");
  });

  it("FIX-329: `attest backfill` is removed — it errors and fabricates NO after-the-fact report", async () => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-nobackfill-")));
    dirs.push(proj);
    const features = join(proj, ".roll", "features", "demo");
    mkdirSync(join(features, "FIX-OLD"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      "| Story | Description | Status |\n|--|--|--|\n| [FIX-OLD](.roll/features/demo/FIX-OLD/spec.md) | old done | ✅ Done |\n",
    );
    writeFileSync(join(features, "FIX-OLD", "spec.md"), "# FIX-OLD\n\n**AC:**\n- [ ] legacy AC\n");

    const rc = await silenced(() =>
      inDir(proj, () => attestCommand(["backfill"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    expect(rc).toBe(1); // removed loophole → error, never silent success

    // and it must NOT fabricate a pre-evidence report / latest for the Done card
    const oldDir = join(features, "FIX-OLD");
    expect(existsSync(join(oldDir, "pre-evidence-backfill"))).toBe(false);
    expect(existsSync(join(oldDir, "latest"))).toBe(false);
    expect(existsSync(join(oldDir, "ac-map.json"))).toBe(false);
  });

  it("US-EVID-001: --run-dir reuses an already-opened evidence frame and points latest at it", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "cycle-20260608-001");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "kept.txt"), "pre-spawn proof\n");

    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--run-dir", runDir], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }),
      ),
    );

    expect(code).toBe(0);
    expect(readFileSync(join(runDir, "evidence", "kept.txt"), "utf8")).toBe("pre-spawn proof\n");
    expect(existsSync(join(runDir, "evidence.json"))).toBe(true);
    expect(existsSync(join(runDir, "FIX-300-report.html"))).toBe(true);
    expect(readlinkSync(join(storyDir, "latest"))).toBe("cycle-20260608-001");
  });

  it("US-EVID-005: --run-dir from a main-checkout .roll stays resolvable through a worktree .roll symlink", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "cycle-symlink");
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-wt-")));
    dirs.push(worktree);
    symlinkSync(join(proj, ".roll"), join(worktree, ".roll"));

    const code = await silenced(() =>
      inDir(worktree, () =>
        attestCommand(["FIX-300", "--run-dir", runDir], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }),
      ),
    );

    expect(code).toBe(0);
    const latest = join(storyDir, "latest");
    expect(lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(latest)).toBe("cycle-symlink");
    expect(existsSync(join(latest, "FIX-300-report.html"))).toBe(true);
  });

  it("US-EVID-001: ROLL_RUN_DIR is the backward-compatible frame handoff for loop agents", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "cycle-env");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    const previous = process.env["ROLL_RUN_DIR"];
    process.env["ROLL_RUN_DIR"] = runDir;
    try {
      const code = await silenced(() =>
        inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
      );
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["ROLL_RUN_DIR"];
      else process.env["ROLL_RUN_DIR"] = previous;
    }
    expect(existsSync(join(runDir, "FIX-300-report.html"))).toBe(true);
    expect(readlinkSync(join(storyDir, "latest"))).toBe("cycle-env");
  });

  it("US-V4-001: attest does NOT mount a delivery section onto a story index.html", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "index.html"),
      renderStoryPage({ id: "FIX-300", title: "demo", created: "2026-06-06", type: "fix", epic: "demo" }),
      "utf8",
    );
    const before = readFileSync(join(storyDir, "index.html"), "utf8");

    const code = await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );

    expect(code).toBe(0);
    // The pre-existing story page skeleton is left BYTE-FOR-BYTE untouched —
    // attest is story-scoped and never mounts a dossier "delivery" section.
    const after = readFileSync(join(storyDir, "index.html"), "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain('class="phase phase-done" data-phase="delivery"');
    // The story-scoped acceptance report IS written under the run dir + latest.
    expect(existsSync(join(storyDir, "2026-06-06T01-02-03", "FIX-300-report.html"))).toBe(true);
    expect(existsSync(join(storyDir, "latest", "FIX-300-report.html"))).toBe(true);
    // AC#5: attest writes NONE of the global / epic dossier index pages.
    expect(existsSync(join(proj, ".roll", "features", "index.html"))).toBe(false);
    expect(existsSync(join(proj, ".roll", "features", "demo", "index.html"))).toBe(false);
  });

  it("US-V4-001: before/after visuals render in the story REPORT, not a dossier index.html", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "cycle-visuals");
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "screenshots", "before-home.png"), "PNG");
    writeFileSync(join(runDir, "screenshots", "after-home.png"), "PNG");
    writeFileSync(join(runDir, "screenshots", "after-new-panel.png"), "PNG");

    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--run-dir", runDir], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }),
      ),
    );

    expect(code).toBe(0);
    // Visual evidence lives in the story-scoped report, not a dossier page.
    const report = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(report).toContain("before-home.png");
    expect(report).toContain("after-home.png");
    expect(report).toContain("after-new-panel.png");
    // No story index.html is created or mounted as a side effect of attest.
    expect(existsSync(join(storyDir, "index.html"))).toBe(false);
  });

  it("no ac-map.json ⇒ every AC honestly Claimed (red line, no invented evidence)", async () => {
    const proj = project();
    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    const html = readFileSync(
      join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"),
      "utf8",
    );
    expect(html).toContain(`🟧 ${bi("Claimed", "仅声明")} × 2`);
  });

  it("ac-map.json drives statuses + inline text evidence from the run dir", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "vitest.txt"), "\x1b[32m✓ 8 passed\x1b[0m\n");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        {
          ac: "FIX-300:AC1",
          status: "pass",
          evidence: [{ kind: "text", label: "vitest", textFile: "evidence/vitest.txt" }],
        },
        { ac: "FIX-300:AC2", status: "partial", note: "移动端未验", evidence: [{ kind: "ci", label: "CI", href: "https://ci/1" }] },
      ]),
    );
    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain(`✅ ${bi("Pass", "通过")} × 1`);
    expect(html).toContain(`🟨 ${bi("Partial", "部分满足")} × 1`);
    expect(html).toContain('<span class="a-fg32">✓ 8 passed</span>');
    expect(html).toContain("移动端未验");
    expect(html).not.toContain("Discrepancies"); // mapped evidence ⇒ no red-line downgrades
  });

  it("renders legacy ../evidence text refs from the current run directory", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "vitest.txt"), "✓ current run passed\n");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        {
          ac: "FIX-300:AC1",
          status: "pass",
          evidence: [{ kind: "text", label: "vitest", textFile: "../evidence/vitest.txt" }],
        },
      ]),
    );

    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );

    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain("✓ current run passed");
    expect(html).not.toContain("Discrepancies");
  });

  it("US-EVID-012 — ac-map can reference cast/video replay evidence", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "demo.cast"), '{"version":2}\n');
    writeFileSync(join(runDir, "screenshots", "flow.mp4"), "MP4");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        {
          ac: "FIX-300:AC1",
          status: "pass",
          evidence: [
            { kind: "cast", label: "terminal replay", href: "evidence/demo.cast" },
            { kind: "video", label: "web flow", href: "screenshots/flow.mp4" },
          ],
        },
      ]),
    );
    const code = await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    expect(code).toBe(0);
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain("Dynamic replay");
    expect(html).toContain("terminal replay");
    expect(html).toContain("evidence/demo.cast");
    expect(html).toContain("<video controls");
    expect(html).toContain('src="screenshots/flow.mp4"');
  });

  it("US-EVID-012 — oversized video evidence is guarded and red-line downgraded", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "screenshots", "huge.mp4"), "0123456789");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        {
          ac: "FIX-300:AC1",
          status: "pass",
          evidence: [{ kind: "video", label: "huge video", href: "screenshots/huge.mp4" }],
        },
      ]),
    );
    const prev = process.env["ROLL_EVIDENCE_MAX_VIDEO_BYTES"];
    process.env["ROLL_EVIDENCE_MAX_VIDEO_BYTES"] = "5";
    try {
      const code = await silenced(() =>
        inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
      );
      expect(code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env["ROLL_EVIDENCE_MAX_VIDEO_BYTES"];
      else process.env["ROLL_EVIDENCE_MAX_VIDEO_BYTES"] = prev;
    }
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).not.toContain("<video controls");
    expect(html).toContain(`🟧 ${bi("Claimed", "仅声明")} × 2`);
    expect(html).toContain("Discrepancies");
  });

  it("US-META-001 — ac-map read-compat: a legacy verification/<ID>/ac-map.json still drives statuses", async () => {
    const proj = project();
    // No card-folder ac-map; only the legacy location (as the un-migrated Gate writes it).
    const legacy = join(proj, ".roll", "verification", "FIX-300");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "ac-map.json"),
      JSON.stringify([{ ac: "FIX-300:AC1", status: "blocked", note: "等下游" }]),
    );
    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    // Report lands in the NEW card folder, but honoured the LEGACY ac-map.
    const html = readFileSync(
      join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"),
      "utf8",
    );
    expect(html).toContain(`⛔ ${bi("Blocked", "受阻")}`);
  });

  it("US-ATTEST-012 — ac-map fail/blocked statuses flow through to the report", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        { ac: "FIX-300:AC1", status: "fail", evidence: [{ kind: "test-pass", label: "red suite" }] },
        { ac: "FIX-300:AC2", status: "blocked", note: "等 iOS 真机" },
      ]),
    );
    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    const html = readFileSync(join(storyDir, "2026-06-06T01-02-03", "FIX-300-report.html"), "utf8");
    expect(html).toContain(`❌ ${bi("Fail", "未通过")} × 1`);
    expect(html).toContain(`⛔ ${bi("Blocked", "受阻")} × 1`);
    expect(html).toContain("等 iOS 真机");
    // blocked w/o evidence is NOT a red-line discrepancy (verified-state ≠ 嘴上 claim)
    expect(html).not.toContain("Discrepancies");
  });

  it("US-ATTEST-012 — text evidence carrying a secret is masked before it lands in the report + WARN留痕", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    writeFileSync(join(runDir, "evidence", "log.txt"), `deploy ok\ntoken=${secret}\n`);
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        { ac: "FIX-300:AC1", status: "pass", evidence: [{ kind: "text", label: "log", textFile: "evidence/log.txt" }] },
      ]),
    );
    const errs: string[] = [];
    const oErr = process.stderr.write.bind(process.stderr);
    const oOut = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stderr.write = (s: string): boolean => (errs.push(String(s)), true);
    // @ts-expect-error quiet stdout
    process.stdout.write = (): boolean => true;
    try {
      await inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }));
    } finally {
      process.stderr.write = oErr;
      process.stdout.write = oOut;
    }
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).not.toContain(secret);
    expect(html).toContain("«REDACTED");
    expect(errs.join("")).toMatch(/redact/i); // 留痕: never silent
  });

  it("US-ATTEST-012 — a report with a broken img reference exits non-zero (render smoke)", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    mkdirSync(storyDir, { recursive: true });
    // ac-map references a screenshot that was never captured → broken <img>.
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        { ac: "FIX-300:AC1", status: "pass", evidence: [{ kind: "screenshot", label: "首页", href: "screenshots/ghost.png" }] },
      ]),
    );
    const code = await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    expect(code).not.toBe(0); // broken reference → non-zero
    // report is still written (evidence preserved) even though the smoke failed
    expect(existsSync(join(storyDir, "2026-06-06T01-02-03", "FIX-300-report.html"))).toBe(true);
  });

  it("US-ATTEST-012 — a report whose img IS present passes smoke (exit 0)", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    const runDir = join(storyDir, "2026-06-06T01-02-03");
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "screenshots", "home.png"), "PNGDATA");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "ac-map.json"),
      JSON.stringify([
        { ac: "FIX-300:AC1", status: "pass", evidence: [{ kind: "screenshot", label: "首页", href: "screenshots/home.png" }] },
      ]),
    );
    const code = await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    expect(code).toBe(0);
  });

  it("re-run lands a second run dir and re-points latest (history preserved)", async () => {
    const proj = project();
    const opts = { run: quietRun, ghProbe: (): Promise<boolean> => Promise.resolve(false) };
    await silenced(() => inDir(proj, () => attestCommand(["FIX-300"], { ...opts, now: () => T0 })));
    const T1 = new Date("2026-06-06T02:00:00");
    await silenced(() => inDir(proj, () => attestCommand(["FIX-300"], { ...opts, now: () => T1 })));
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    expect(existsSync(join(storyDir, "2026-06-06T01-02-03", "FIX-300-report.html"))).toBe(true);
    expect(readlinkSync(join(storyDir, "latest"))).toBe("2026-06-06T02-00-00");
  });

  it("unknown story → exit 1; missing arg → usage exit 1", async () => {
    const proj = project();
    expect(await silenced(() => inDir(proj, () => attestCommand(["US-NOPE-9"], { run: quietRun })))).toBe(1);
    expect(await silenced(() => inDir(proj, () => attestCommand([], { run: quietRun })))).toBe(1);
  });
});

describe("US-ATTEST-013 — self-contained card context wiring", () => {
  it("readBacklogRow pulls description + status, ID-anchored", () => {
    const proj = project();
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      ["| Story | Description | Status |", "|--|--|--|", "| FIX-300 | demo 卡一句话 depends-on:FIX-1 | 🔨 In Progress |", ""].join("\n"),
    );
    const row = readBacklogRow(proj, "FIX-300");
    expect(row.description).toContain("demo 卡一句话");
    expect(row.status).toBe("🔨 In Progress");
  });

  it("FIX-1475: readBacklogRow matches the EXACT id, not a `<id>-` descendant (even when it sorts first)", () => {
    const proj = project();
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      [
        "| Story | Description | Status |",
        "|--|--|--|",
        "| [FIX-300-legacy](.roll/features/demo/FIX-300-legacy/spec.md) | descendant sorts FIRST | ✅ Done |",
        "| [FIX-300](.roll/features/demo/FIX-300/spec.md) | the real card | 🔨 In Progress |",
        "",
      ].join("\n"),
    );
    const row = readBacklogRow(proj, "FIX-300");
    // Substring/fallback matching would have returned the descendant's row.
    expect(row.description).toContain("the real card");
    expect(row.status).toBe("🔨 In Progress");
  });

  it("buildCardContext assembles one-liner / epic / summary / status / cycle id", () => {
    const proj = project();
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      ["| FIX-300 | 业务一句话 depends-on:FIX-1 | 🔨 In Progress |"].join("\n"),
    );
    // overwrite the feature file with a blockquote goal
    writeFileSync(
      join(proj, ".roll", "features", "demo", "FIX-300.md"),
      ["# FIX-300 — demo", "", "> 这是规格摘要", "> 第二行", "", "**AC:**", "- [ ] x", ""].join("\n"),
    );
    const ctx = buildCardContext(proj, join(proj, ".roll", "features", "demo", "FIX-300.md"), "FIX-300", {
      LOOP_CYCLE_ID: "cycle-xyz",
    });
    expect(ctx?.oneLiner).toBe("业务一句话"); // depends-on stripped
    expect(ctx?.epic).toBe("demo");
    expect(ctx?.summary).toBe("这是规格摘要 第二行");
    expect(ctx?.backlogStatus).toBe("🔨 In Progress");
    expect(ctx?.delivery?.cycleId).toBe("cycle-xyz");
  });

  it("detectBeforeAfter pairs before-/after- shots by stem; unmatched ignored", () => {
    const proj = project();
    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "run");
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    for (const f of ["before-home.png", "after-home.png", "before-orphan.png", "after-lonely.png", "noise.png"]) {
      writeFileSync(join(runDir, "screenshots", f), "PNG");
    }
    const pairs = detectBeforeAfter(runDir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.label).toBe("home");
    expect(pairs[0]?.before.href).toBe("screenshots/before-home.png");
    expect(pairs[0]?.after.href).toBe("screenshots/after-home.png");
    const afterOnly = detectAfterOnly(runDir);
    expect(afterOnly).toHaveLength(1);
    expect(afterOnly[0]?.label).toBe("lonely");
    expect(afterOnly[0]?.shot.href).toBe("screenshots/after-lonely.png");
  });

  it("attest renders the card-context section end to end", async () => {
    const proj = project();
    writeFileSync(join(proj, ".roll", "backlog.md"), "| FIX-300 | 端到端一句话 | 🔨 In Progress |\n");
    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    const html = readFileSync(
      join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"),
      "utf8",
    );
    expect(html).toContain(bi("Context", "卡上下文"));
    expect(html).toContain("端到端一句话");
    expect(html).toContain("Backlog：🔨 In Progress");
  });
});

describe("US-ATTEST-011 — Gate terminal self-capture lane", () => {
  // A GUI macOS host whose screencapture lands real pixels at the out path.
  function guiShot(): ShotRun {
    return (cmd, argv) => {
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Aqua\n", stderr: "" });
      if (cmd === "screencapture") {
        writeFileSync(String(argv[argv.length - 1]), "PNGDATA"); // out = last argv
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      if (cmd === "osascript" && String(argv[1] ?? "").includes("bounds of w")) {
        return Promise.resolve({ code: 0, stdout: "0, 0, 1280, 800\n", stderr: "" }); // FIX-271 window-bounds query
      }
      if (cmd === "sh" && String(argv[1] ?? "").includes("lsappinfo")) {
        return Promise.resolve({ code: 0, stdout: '"LSDisplayName"="Terminal"\n', stderr: "" }); // FIX-273 frontmost guard
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" }); // osascript etc.
    };
  }

  it("a real GUI cycle self-captures a terminal shot into the report", async () => {
    const proj = project();
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-tmux", "roll-loop-demo"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: guiShot(), platform: "darwin", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "terminal.png"))).toBe(true);
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain(bi("Gate self-capture", "Gate 自产实拍"));
    expect(html).toContain('<img src="screenshots/terminal.png"');
  });

  it("a headless host honestly skips — no shot, no self-capture block (deletion contract)", async () => {
    const proj = project();
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-tmux", "roll-loop-demo"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: guiShot(), platform: "linux", env: {} }, // not macOS → lane skips
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "terminal.png"))).toBe(false);
    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).not.toContain('<img src="screenshots/terminal.png"');
    expect(html).toContain("Capture skip");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    expect(evidence.captures).toContainEqual({ kind: "terminal", out: join(runDir, "screenshots", "terminal.png"), taken: false, skipped: "not macOS" });
  });

  it("no capture flag ⇒ lane never runs (back-compat: plain attest unchanged)", async () => {
    const proj = project();
    const calls: string[] = [];
    const recorder: ShotRun = (cmd) => {
      calls.push(cmd);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: recorder, platform: "darwin", env: {} },
        }),
      ),
    );
    expect(calls).toHaveLength(0); // no flag → dispatcher untouched
  });

  it("FIX-262: --capture-command opens Terminal in the project cwd before running the command", async () => {
    const proj = project();
    const scripts: string[] = [];
    const shotRun: ShotRun = (cmd, argv) => {
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Aqua\n", stderr: "" });
      if (cmd === "osascript") scripts.push(String(argv[1] ?? ""));
      if (cmd === "screencapture") writeFileSync(String(argv[argv.length - 1]), "PNGDATA");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-command", "node scripts/proof.js"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shotRun, platform: "darwin", env: {} },
        }),
      ),
    );

    expect(scripts[0]).toContain(`cd '${proj}' && node scripts/proof.js`);
    expect(scripts[0]).toContain("terminal.png.done");
    expect(scripts[0]).toContain("exit");
  });

  it("FIX-263: --capture-command records command exit code and returns non-zero on failure", async () => {
    const proj = project();
    const calls: string[] = [];
    const shotRun: ShotRun = (cmd, argv) => {
      calls.push(`${cmd} ${argv.join(" ")}`);
      if (cmd === "sh") return Promise.resolve({ code: 2, stdout: "before failure\n", stderr: "ERR_MODULE_NOT_FOUND\n" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-command", "node scripts/proof.js"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shotRun, platform: "darwin", env: {} },
        }),
      ),
    );

    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      capture_command?: { exitCode?: number; stdoutTail?: string; stderrTail?: string };
      captures?: Array<{ taken?: boolean; skipped?: string; failed?: boolean; error?: string }>;
    };
    expect(code).toBe(3);
    expect(calls.some((x) => x.startsWith("sh -lc "))).toBe(true);
    expect(evidence.capture_command?.exitCode).toBe(2);
    expect(evidence.capture_command?.stdoutTail).toContain("before failure");
    expect(evidence.capture_command?.stderrTail).toContain("ERR_MODULE_NOT_FOUND");
    expect(evidence.captures?.[0]?.taken).toBe(false);
    expect(evidence.captures?.[0]?.skipped).toContain("capture command exited 2");
    expect(evidence.captures?.[0]?.failed).toBe(true);
    expect(evidence.captures?.[0]?.error).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("US-EVID-023: attempted web capture errors are marked failed, not honest skips", async () => {
    const proj = project();
    let osascriptCalls = 0;
    const shotRun: ShotRun = (cmd, argv) => {
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Aqua\n", stderr: "" });
      if (cmd === "osascript") {
        osascriptCalls += 1;
        return Promise.resolve({ code: 0, stdout: osascriptCalls === 2 ? "0,0,100,100\n" : "", stderr: "" });
      }
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "Google Chrome\n", stderr: "" });
      if (cmd === "screencapture") return Promise.resolve({ code: 1, stdout: "", stderr: "Screen Recording denied" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-web", "https://app.test"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shotRun, platform: "darwin", env: {} },
        }),
      ),
    );

    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string; failed?: boolean; error?: string }>;
    };
    expect(evidence.captures?.[0]).toMatchObject({
      kind: "web",
      taken: false,
      failed: true,
    });
    expect(evidence.captures?.[0]?.error).toContain("screencapture failed");
  });

  // ── FIX-339 复核 #2: secret protection on the headless command lane ──────────
  it("复核 #2: a deliverable_cmd whose BODY carries a secret is REFUSED, never run (taken:false skip)", async () => {
    const proj = project();
    const calls: string[] = [];
    const shotRun: ShotRun = (cmd, argv) => {
      calls.push(`${cmd} ${argv.join(" ")}`);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-command", "roll status --token ghp_ABCDEFGHIJKLMNOPQRST12345"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shotRun, platform: "linux", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      capture_command?: { exitCode?: number; stderrTail?: string };
      captures?: Array<{ taken?: boolean; skipped?: string }>;
    };
    // The command never reached the shell sink (refused before spawn).
    expect(calls.some((x) => x.startsWith("sh -lc "))).toBe(false);
    expect(evidence.capture_command?.exitCode).not.toBe(0);
    expect(evidence.capture_command?.stderrTail).toContain("REDACTED");
    expect(evidence.captures?.[0]?.taken).toBe(false);
    expect(code).toBe(3); // capture command failed → non-zero exit
  });

  it("复核 #2: a secret PRINTED by the command is redacted in the persisted stdout tail", async () => {
    const proj = project();
    const shotRun: ShotRun = (cmd) => {
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "token=ghp_ABCDEFGHIJKLMNOPQRST12345 done\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300", "--capture-command", "roll status"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shotRun, platform: "linux", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      capture_command?: { stdoutTail?: string };
    };
    expect(evidence.capture_command?.stdoutTail).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST12345");
    expect(evidence.capture_command?.stdoutTail).toContain("REDACTED");
    expect(evidence.capture_command?.stdoutTail).toContain("done"); // non-secret text preserved
  });
});

describe("FIX-305 — UI/dossier web self-capture lane (real screenshot, not a skip)", () => {
  // A UI project whose AC concerns a rendered web page.
  function webProject(): string {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-web-")));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll", "features", "demo", "FIX-WEB"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "features", "demo", "FIX-WEB", "spec.md"),
      ["# FIX-WEB — dossier casting page", "", "**AC:**", "- [ ] the casting web page renders", ""].join("\n"),
    );
    return proj;
  }

  // A headless host (no GUI) where npx/playwright would be available, but attest
  // screenshot evidence must still skip because only physical windows count.
  function headlessShot(): { run: ShotRun; calls: string[] } {
    const calls: string[] = [];
    const run: ShotRun = (cmd, argv) => {
      calls.push(`${cmd} ${argv.join(" ")}`);
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Background\n", stderr: "" }); // not Aqua → skip
      if (cmd === "npx") {
        writeFileSync(String(argv[argv.length - 1]), "PNGDATA"); // out = last argv
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    return { run, calls };
  }

  it("AC: --capture-web on a non-physical host records an honest skip, no headless screenshot", async () => {
    const proj = webProject();
    const { run: shot, calls } = headlessShot();
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-WEB", "--capture-web", "https://app.test/casting"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shot, platform: "linux", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-WEB", "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "web.png"))).toBe(false);
    expect(calls.join("\n")).not.toContain("playwright");
    const html = readFileSync(join(runDir, "FIX-WEB-report.html"), "utf8");
    expect(html).not.toContain('<img src="screenshots/web.png"');
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string; failed?: boolean; error?: string }>;
    };
    expect(evidence.captures).toContainEqual({
      kind: "web",
      out: join(runDir, "screenshots", "web.png"),
      taken: false,
      skipped: "physical browser screenshots require macOS",
    });
  });

  it("ROLL_ATTEST_NO_BROWSER=1 → honest skip recorded, no placeholder image", async () => {
    const proj = webProject();
    const { run: shot } = headlessShot();
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-WEB", "--capture-web", "https://app.test/casting"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shot, platform: "linux", env: { ROLL_ATTEST_NO_BROWSER: "1" } },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-WEB", "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "web.png"))).toBe(false);
    const html = readFileSync(join(runDir, "FIX-WEB-report.html"), "utf8");
    expect(html).not.toContain('<img src="screenshots/web.png"');
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    expect(evidence.captures).toContainEqual({
      kind: "web",
      out: join(runDir, "screenshots", "web.png"),
      taken: false,
      skipped: "ROLL_ATTEST_NO_BROWSER=1",
    });
  });

  it("no --capture-web ⇒ web lane never runs (back-compat)", async () => {
    const proj = webProject();
    const { run: shot, calls } = headlessShot();
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-WEB"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shot, platform: "linux", env: {} },
        }),
      ),
    );
    expect(calls.some((c) => c.startsWith("npx "))).toBe(false);
    const runDir = join(proj, ".roll", "features", "demo", "FIX-WEB", "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "web.png"))).toBe(false);
  });
});

describe("US-PHYSICAL-004 — attest physical.screenshot provider lane", () => {
  function physicalProject(
    id = "US-PHYSICAL-004A",
    frontmatter: readonly string[] = ["physical_terminal:", "  app: Terminal.app", "  command: roll doctor --tools", "  evidence: screenshot"],
  ): string {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-physical-")));
    dirs.push(proj);
    const cardDir = join(proj, ".roll", "features", "demo", id);
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(
      join(cardDir, "spec.md"),
      [
        "---",
        `id: ${id}`,
        ...frontmatter,
        "---",
        "",
        `# ${id} — physical screenshot`,
        "",
        "**AC:**",
        "- [ ] [visual-evidence] physical screenshot proves the terminal output",
        "",
      ].join("\n"),
    );
    return proj;
  }

  function responseFor(
    captureRoot: string,
    request: RollCaptureRequestV1,
    status: "taken" | "skipped" | "failed",
    extra: Partial<RollCaptureResponseV1> = {},
  ): RollCaptureResponseV1 {
    const defaults: Partial<RollCaptureResponseV1> =
      status === "taken" && extra.imageWidth === undefined && extra.imageHeight === undefined
        ? { imageWidth: 800, imageHeight: 600 }
        : {};
    return {
      protocol: ROLL_CAPTURE_PROTOCOL_V1,
      requestId: request.requestId,
      status,
      responsePath: join(captureRoot, "responses", `response-${request.requestId}.json`),
      host: { appName: ROLL_CAPTURE_HOST_APP_NAME, bundleId: ROLL_CAPTURE_HOST_BUNDLE_ID, version: "test" },
      startedAt: "2026-06-06T01:02:03.000Z",
      finishedAt: "2026-06-06T01:02:04.000Z",
      ...defaults,
      ...extra,
    };
  }

  function physicalProviderFixture(
    captureRoot: string,
    response: (request: RollCaptureRequestV1) => RollCaptureResponseV1,
  ): { port: RollCaptureProvider; requests: RollCaptureRequestV1[] } {
    const requests: RollCaptureRequestV1[] = [];
    let clock = 0;
    return {
      requests,
      port: new RollCaptureProvider({
        root: captureRoot,
        defaultPollIntervalMs: 1,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          const inbox = join(captureRoot, "inbox");
          if (!existsSync(inbox)) return;
          const requestFiles = readdirSync(inbox).filter((name) => name.startsWith("request-") && name.endsWith(".json"));
          for (const requestFile of requestFiles) {
            const requestPath = join(inbox, requestFile);
            const request = JSON.parse(readFileSync(requestPath, "utf8")) as RollCaptureRequestV1;
            if (requests.some((seen) => seen.requestId === request.requestId)) continue;
            requests.push(request);
            const res = response(request);
            mkdirSync(join(captureRoot, "responses"), { recursive: true });
            const finalPath = join(captureRoot, "responses", `response-${request.requestId}.json`);
            const tempPath = join(captureRoot, "responses", `.response-${request.requestId}.json.tmp`);
            writeFileSync(tempPath, JSON.stringify(res), "utf8");
            renameSync(tempPath, finalPath);
            writeFileSync(
              join(captureRoot, "ledger.jsonl"),
              JSON.stringify({
                requestId: request.requestId,
                storyId: request.storyId,
                runId: request.runId,
                kind: request.kind,
                status: res.status,
                screenshotPath: res.screenshotPath,
                responsePath: res.responsePath,
                attachedToReport: false,
                ...(res.reason !== undefined ? { reason: res.reason } : {}),
                startedAt: res.startedAt,
                finishedAt: res.finishedAt,
              }) + "\n",
              { flag: "a" },
            );
            rmSync(requestPath, { force: true });
          }
        },
      }),
    };
  }

  function timeoutProvider(captureRoot: string): RollCaptureProvider {
    let clock = 0;
    return new RollCaptureProvider({
      root: captureRoot,
      defaultPollIntervalMs: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  }

  function requestFiles(captureRoot: string): string[] {
    const inbox = join(captureRoot, "inbox");
    if (!existsSync(inbox)) return [];
    return readdirSync(inbox).filter((name) => name.startsWith("request-") && name.endsWith(".json"));
  }

  const availableReadiness = {
    status: "available" as const,
    installed: { status: "installed" as const, path: "/Applications/Roll Capture.app" },
    hostPermission: { status: "granted" as const, detail: "screen recording available" },
    inbox: { status: "writable" as const, path: "/tmp/roll-capture/inbox", detail: "ok" },
    detailLines: ["installed=installed", "hostPermission=granted", "inbox=writable"],
    repairCommands: [],
  };

  it("invokes physical.screenshot, copies the PNG into the story run, and links it in the report", async () => {
    const proj = physicalProject();
    const sourcePng = join(proj, "captured-by-app.png");
    const captureRoot = join(proj, "roll-capture-root");
    writeFileSync(sourcePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    mkdirSync(captureRoot, { recursive: true });
    const fake = physicalProviderFixture(captureRoot, (request) => {
      const reportPath = join(captureRoot, "reports", `${request.requestId}.html`);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, "<html>capture report</html>");
      return responseFor(captureRoot, request, "taken", { screenshotPath: sourcePng });
    });

    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004A"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ protocol: ROLL_CAPTURE_PROTOCOL_V1, kind: "physical_terminal", target: { type: "window", appName: "Terminal.app" } });
    const request = fake.requests[0] as RollCaptureRequestV1;
    expect(existsSync(join(captureRoot, "inbox", `request-${request.requestId}.json`))).toBe(false);
    expect(readFileSync(join(captureRoot, "responses", `response-${request.requestId}.json`), "utf8")).toContain('"status":"taken"');
    const runDir = dirname(dirname(request.out));
    expect(readFileSync(join(runDir, "screenshots", "physical.png")).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const html = readFileSync(join(runDir, "US-PHYSICAL-004A-report.html"), "utf8");
    expect(html).toContain("physical.screenshot");
    expect(html).toContain("requested → taken → attached");
    expect(html).toContain('<img src="screenshots/physical.png"');
    expect(html).toContain("ledger response");
    expect(html).toContain("attachedToReport=false");
    expect(html).not.toContain(`href="${captureRoot}`);
    expect(html).not.toContain(`href="../`);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; out?: string }>;
    };
    expect(evidence.captures).toContainEqual({ kind: "physical_terminal", out: join(runDir, "screenshots", "physical.png"), taken: true });
    const browserLedger = readFileSync(join(proj, ".roll", "browser-operations", "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: { type: string; link?: { canSatisfyVisualAc?: boolean; captureRequestId?: string; captureDigest?: string } } });
    expect(browserLedger).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: "browser:capture-linked",
        link: expect.objectContaining({
          captureRequestId: request.requestId,
          canSatisfyVisualAc: true,
          captureDigest: expect.stringMatching(/^sha256:/),
        }),
      }),
    }));
    expect(collectBrowserTruth({ projectPath: proj, storyId: "US-PHYSICAL-004A" }).capture).toEqual({ status: "ready" });
    expect(collectBrowserTimeline({ projectPath: proj, storyId: "US-PHYSICAL-004A" }).rows).toContainEqual(
      expect.objectContaining({ kind: "physical-capture", presence: "present" }),
    );
  });

  it("records an invalid physical capture as degraded rather than visual-ready", async () => {
    const proj = physicalProject("US-PHYSICAL-004INVALID");
    const sourcePng = join(proj, "not-an-image.png");
    const captureRoot = join(proj, "roll-capture-root");
    writeFileSync(sourcePng, "not a PNG");
    const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "taken", { screenshotPath: sourcePng }));

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004INVALID"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(collectBrowserTruth({ projectPath: proj, storyId: "US-PHYSICAL-004INVALID" }).capture).toMatchObject({ status: "degraded" });
  });

  it("does not trigger physical.screenshot from comments, AC text, or URLs containing the token", async () => {
    const proj = physicalProject("US-PHYSICAL-004TEXT", [
      "# evidence_profile: physical",
      "deliverable_url: https://example.test/docs/physical.screenshot",
    ]);
    const captureRoot = join(proj, "roll-capture-root");
    const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "failed", { reason: "should not run" }));
    const spec = join(proj, ".roll", "features", "demo", "US-PHYSICAL-004TEXT", "spec.md");
    writeFileSync(
      spec,
      [
        "---",
        "id: US-PHYSICAL-004TEXT",
        "# evidence_profile: physical",
        "deliverable_url: https://example.test/docs/physical.screenshot",
        "---",
        "",
        "# US-PHYSICAL-004TEXT",
        "",
        "**AC:**",
        "- [ ] Documentation may mention physical.screenshot without requesting capture",
        "",
      ].join("\n"),
    );

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004TEXT"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(fake.requests).toHaveLength(0);
  });

  it("recognizes physical_terminal with an inline comment and nested list syntax", async () => {
    const proj = physicalProject("US-PHYSICAL-004INLINE", [
      "physical_terminal: # real Terminal.app capture required",
      "  - app: Terminal.app",
      "    command: roll doctor --tools",
      "    evidence: screenshot",
    ]);
    const captureRoot = join(proj, "roll-capture-root");
    const sourcePng = join(proj, "inline.png");
    writeFileSync(sourcePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
    const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "taken", { screenshotPath: sourcePng }));

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004INLINE"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ kind: "physical_terminal", target: { type: "window", appName: "Terminal.app" } });
  });

  it("honors an evidence_profile physical request even without physical_terminal frontmatter", async () => {
    const proj = physicalProject("US-PHYSICAL-004D", ["evidence_profile: physical"]);
    const captureRoot = join(proj, "roll-capture-root");
    const sourcePng = join(proj, "captured-display.png");
    writeFileSync(sourcePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]));
    const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "taken", { screenshotPath: sourcePng }));

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004D"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(fake.requests).toHaveLength(1);
    // US-PHYSICAL-006: evidence_profile:physical without capture_fullscreen defaults to window-level
    expect(fake.requests[0]).toMatchObject({ kind: "display", target: { type: "window", appName: "Terminal.app" } });
    const runDir = join(proj, ".roll", "features", "demo", "US-PHYSICAL-004D", "2026-06-06T01-02-03");
    expect(readFileSync(join(runDir, "screenshots", "physical.png")).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const html = readFileSync(join(runDir, "US-PHYSICAL-004D-report.html"), "utf8");
    expect(html).toContain("requested → taken → attached");
  });

  it("does not treat commented evidence_profile or non-physical profile values as physical requests", async () => {
    for (const [id, frontmatter] of [
      ["US-PHYSICAL-004COMMENT", ["# evidence_profile: physical"]],
      ["US-PHYSICAL-004NONPHYS", ["evidence_profile: cli_output"]],
    ] as const) {
      const proj = physicalProject(id, frontmatter);
      const captureRoot = join(proj, "roll-capture-root");
      const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "failed", { reason: "should not run" }));

      await silenced(() =>
        inDir(proj, () =>
          attestCommand([id], {
            now: () => T0,
            run: quietRun,
            ghProbe: () => Promise.resolve(false),
            rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
          }),
        ),
      );

      expect(fake.requests).toHaveLength(0);
    }
  });

  it("records not-attached, clears a stale output, and never links an external source when PNG attachment fails", async () => {
    const proj = physicalProject("US-PHYSICAL-004COPYFAIL");
    const captureRoot = join(proj, "roll-capture-root");
    const fake = physicalProviderFixture(captureRoot, (request) => {
      mkdirSync(dirname(request.out), { recursive: true });
      writeFileSync(request.out, "STALE-PARTIAL");
      return responseFor(captureRoot, request, "taken", { screenshotPath: join(proj, "missing-source.png") });
    });

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004COPYFAIL"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    const request = fake.requests[0] as RollCaptureRequestV1;
    const runDir = dirname(dirname(request.out));
    expect(existsSync(request.out)).toBe(false);
    const html = readFileSync(join(runDir, "US-PHYSICAL-004COPYFAIL-report.html"), "utf8");
    expect(html).toContain("requested → taken → not-attached");
    expect(html).not.toContain('<img src="');
    expect(html).toContain("missing-source.png");
    expect(html).not.toContain(`href="${join(proj, "missing-source.png")}`);
    const ledger = readFileSync(join(captureRoot, "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"attachedToReport":false');
  });

  it("lets --capture-command own physical_terminal capture and does not also request physical.screenshot", async () => {
    const proj = physicalProject("US-PHYSICAL-004DEDUP");
    const captureRoot = join(proj, "roll-capture-root");
    const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "failed", { reason: "duplicate lane" }));
    const shotRun: ShotRun = (cmd, argv) => {
      if (cmd === "sh" && String(argv[1] ?? "").includes("lsappinfo")) return Promise.resolve({ code: 0, stdout: '"LSDisplayName"="Terminal"\n', stderr: "" });
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "doctor ok\n", stderr: "" });
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Aqua\n", stderr: "" });
      if (cmd === "osascript" && String(argv[1] ?? "").includes("bounds of w")) return Promise.resolve({ code: 0, stdout: "0, 0, 1280, 800\n", stderr: "" });
      if (cmd === "screencapture") writeFileSync(String(argv[argv.length - 1]), "TERMINALPNG");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004DEDUP", "--capture-command", "roll doctor --tools"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: shotRun, platform: "darwin", env: {} },
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(fake.requests).toHaveLength(0);
    const runDir = join(proj, ".roll", "features", "demo", "US-PHYSICAL-004DEDUP", "2026-06-06T01-02-03");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; out?: string }>;
    };
    expect(evidence.captures?.filter((capture) => capture.kind === "physical_terminal")).toHaveLength(1);
  });

  it("records readiness skip with reason and leaves existing non-physical attest unchanged", async () => {
    const proj = physicalProject("US-PHYSICAL-004B");
    const captureRoot = join(proj, "roll-capture-root");
    const provider = new RollCaptureProvider({ root: captureRoot });

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004B"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: {
            readiness: () => ({
              ...availableReadiness,
              status: "skip",
              detailLines: ["skipped — Roll Capture.app is a macOS-only physical screenshot host."],
            }),
            provider,
            root: captureRoot,
          },
        }),
      ),
    );

    const runDir = join(proj, ".roll", "features", "demo", "US-PHYSICAL-004B", "2026-06-06T01-02-03");
    expect(requestFiles(captureRoot)).toHaveLength(0);
    const html = readFileSync(join(runDir, "US-PHYSICAL-004B-report.html"), "utf8");
    expect(html).toContain("requested → skipped → not-attached");
    expect(html).toContain("Roll Capture.app is a macOS-only physical screenshot host");

    const plain = project();
    const plainCaptureRoot = join(plain, "roll-capture-root");
    const plainProvider = new RollCaptureProvider({ root: plainCaptureRoot });
    await silenced(() =>
      inDir(plain, () =>
        attestCommand(["FIX-300"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: plainProvider, root: plainCaptureRoot },
        }),
      ),
    );
    expect(requestFiles(plainCaptureRoot)).toHaveLength(0);
  });

  it("records provider failed responses with their reason", async () => {
    const proj = physicalProject("US-PHYSICAL-004E");
    const captureRoot = join(proj, "roll-capture-root");
    const fake = physicalProviderFixture(captureRoot, (request) => responseFor(captureRoot, request, "failed", { reason: "screen recording permission denied" }));

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004E"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: fake.port, root: captureRoot },
        }),
      ),
    );

    expect(fake.requests).toHaveLength(1);
    const runDir = join(proj, ".roll", "features", "demo", "US-PHYSICAL-004E", "2026-06-06T01-02-03");
    const html = readFileSync(join(runDir, "US-PHYSICAL-004E-report.html"), "utf8");
    expect(html).toContain("requested → failed → not-attached");
    expect(html).toContain("screen recording permission denied");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    expect(evidence.captures).toContainEqual({
      kind: "physical_terminal",
      out: join(runDir, "screenshots", "physical.png"),
      taken: false,
      skipped: "screen recording permission denied",
      failed: true,
      error: "screen recording permission denied",
    });
  });

  it("surfaces provider timeout as a distinct capture failure reason", async () => {
    const proj = physicalProject("US-PHYSICAL-004C");
    const captureRoot = join(proj, "roll-capture-root");

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYSICAL-004C"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { readiness: () => availableReadiness, provider: timeoutProvider(captureRoot), root: captureRoot, timeoutMs: 5 },
        }),
      ),
    );

    const runDir = join(proj, ".roll", "features", "demo", "US-PHYSICAL-004C", "2026-06-06T01-02-03");
    const html = readFileSync(join(runDir, "US-PHYSICAL-004C-report.html"), "utf8");
    expect(html).toContain("requested → timeout → not-attached");
    expect(html).toContain("timed out after 5ms");
    expect(requestFiles(captureRoot)).toEqual([]);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string; failed?: boolean; error?: string }>;
    };
    expect(evidence.captures).toContainEqual({
      kind: "physical_terminal",
      out: join(runDir, "screenshots", "physical.png"),
      taken: false,
      skipped: `timeout: timed out after 5ms waiting for ${join(captureRoot, "responses", "response-US-PHYSICAL-004C-2026-06-06T01-02-03-physical.json")}`,
      failed: true,
      error: `timeout: timed out after 5ms waiting for ${join(captureRoot, "responses", "response-US-PHYSICAL-004C-2026-06-06T01-02-03-physical.json")}`,
    });
  });
});

describe("US-ATTEST-009 — review-score notes feed the report", () => {
  it("same-story notes render in the fold; unrelated stories don't", async () => {
    const proj = project();
    mkdirSync(join(proj, ".roll", "notes"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "notes", "2026-06-05-roll-fix-FIX-300-1780000000.md"),
      ["---", "skill: roll-fix", "story: FIX-300", "score: 8", "verdict: good", "ts: 2026-06-05T20:00:00Z", "---", "", "干净的一刀。"].join("\n"),
    );
    writeFileSync(
      join(proj, ".roll", "notes", "2026-06-05-roll-fix-FIX-999-1780000001.md"),
      ["---", "skill: roll-fix", "story: FIX-999", "score: 2", "verdict: bad", "ts: 2026-06-05T21:00:00Z", "---", "", "无关条目"].join("\n"),
    );
    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    const html = readFileSync(
      join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"),
      "utf8",
    );
    expect(html).toContain(`${bi("Review Score", "评审分")}（1）`);
    expect(html).toContain("<b>8</b>/10 · good");
    expect(html).toContain("干净的一刀。");
    expect(html).not.toContain("无关条目");
  });

  it("US-EVID-013: card-local note dimensions, trend, and full-note link feed the report", async () => {
    const proj = project();
    const storyDir = join(proj, ".roll", "features", "demo", "FIX-300");
    mkdirSync(join(storyDir, "notes"), { recursive: true });
    writeFileSync(
      join(storyDir, "notes", "2026-06-08-roll-fix-FIX-300-1780000002.md"),
      [
        "---",
        "skill: roll-fix",
        "story: FIX-300",
        "score: 5",
        "verdict: ok",
        "ts: 2026-06-08T20:00:00Z",
        "test-quality: 6",
        "---",
        "",
        "证据够用，但测试质量还要补强。",
      ].join("\n"),
    );
    mkdirSync(join(proj, ".roll", "notes"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "notes", "2026-06-01-roll-fix-FIX-100-1780000000.md"),
      "---\nskill: roll-fix\nstory: FIX-100\nscore: 9\nverdict: good\nts: 2026-06-01T20:00:00Z\n---\n\n旧好卡。\n",
    );
    writeFileSync(
      join(proj, ".roll", "notes", "2026-06-02-roll-fix-FIX-101-1780000001.md"),
      "---\nskill: roll-fix\nstory: FIX-101\nscore: 5\nverdict: ok\nts: 2026-06-02T20:00:00Z\n---\n\n旧低分。\n",
    );

    await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    const html = readFileSync(
      join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"),
      "utf8",
    );
    expect(html).toContain("<code>test-quality</code>: <b>6</b>");
    expect(html).toContain("review-score: mean 6.3 / min 5 / redo 2 (last 14)");
    expect(html).toContain('href="../notes/2026-06-08-roll-fix-FIX-300-1780000002.md"');
    expect(html).toContain("low review-score: ok 5/10");
  });
});

// ── US-ATTEST-014 — process trace wiring ────────────────────────────────────
import { resolveStoryCycle, scopeCycleEvents } from "../src/commands/attest.js";
import type { RollEvent } from "@roll/spec";

describe("resolveStoryCycle", () => {
  const runs = [
    { run_id: "c1", story_id: "FIX-300", cycle_id: "c1", agent: "claude", built: ["FIX-300"] },
    { run_id: "c2", story_id: "US-X-9", cycle_id: "c2", agent: "kimi", built: ["US-X-9"] },
  ];
  it("finds the cycle + agent for a story by story_id", () => {
    const r = resolveStoryCycle(runs, "FIX-300");
    expect(r.found).toBe(true);
    expect(r.cycleId).toBe("c1");
    expect(r.agent).toBe("claude");
  });
  it("matches via the built[] array too", () => {
    expect(resolveStoryCycle([{ run_id: "z", cycle_id: "z", built: ["US-ATTEST-014"] }], "US-ATTEST-014").cycleId).toBe("z");
  });
  it("picks the latest matching row when a story was rebuilt", () => {
    const dup = [...runs, { run_id: "c9", story_id: "FIX-300", cycle_id: "c9", agent: "pi", built: ["FIX-300"] }];
    expect(resolveStoryCycle(dup, "FIX-300").cycleId).toBe("c9");
  });
  it("no match ⇒ found:false", () => {
    expect(resolveStoryCycle(runs, "NOPE").found).toBe(false);
  });
});

describe("scopeCycleEvents", () => {
  const evs: RollEvent[] = [
    { type: "cycle:start", cycleId: "c1", storyId: "FIX-300", agent: "claude", model: "m", ts: 100 },
    { type: "cycle:tcr", cycleId: "c1", commitHash: "aa", message: "tcr: x", ts: 110 },
    { type: "cycle:tcr", cycleId: "OTHER", commitHash: "bb", message: "tcr: foreign", ts: 111 },
    { type: "pr:open", prNumber: 7, storyId: "FIX-300", ts: 120 },
    { type: "ci:pass", prNumber: 7, ts: 130 },
    { type: "ci:fail", prNumber: 99, failSummary: "other story pr", ts: 131 },
    { type: "pr:merge", prNumber: 7, storyId: "FIX-300", ts: 140 },
    { type: "alert:notify", channel: "x", message: "unattributable", ts: 150 },
  ];
  it("keeps this cycle's lifecycle/tcr + the story's PR and its CI, drops foreign", () => {
    const scoped = scopeCycleEvents(evs, "c1", "FIX-300");
    const types = scoped.map((e) => e.type);
    expect(types).toContain("cycle:start");
    expect(types).toContain("cycle:tcr"); // c1's
    expect(scoped.some((e) => e.type === "cycle:tcr" && (e as { message: string }).message.includes("foreign"))).toBe(false);
    expect(types).toContain("pr:open");
    expect(types).toContain("ci:pass"); // PR #7 → in story's pr set
    expect(scoped.some((e) => e.type === "ci:fail")).toBe(false); // PR #99 not the story's
    expect(scoped.some((e) => e.type === "alert:notify")).toBe(false); // unattributable
  });
  it("manual (no cycleId) keeps only story-scoped PR/CI", () => {
    const scoped = scopeCycleEvents(evs, undefined, "FIX-300");
    expect(scoped.every((e) => ["pr:open", "pr:merge", "ci:pass"].includes(e.type))).toBe(true);
  });
});

// ── FIX-392 — headless terminal fallback ──────────────────────────────────
describe("FIX-392 — terminal deliverable_cmd headless fallback", () => {
  function cmdProject(): string {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-attest-cmd-")));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll", "features", "demo", "FIX-CMD"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "features", "demo", "FIX-CMD", "spec.md"),
      ["# FIX-CMD — CLI deliverable", "", "**AC:**", "- [ ] CLI command works", ""].join("\n"),
    );
    return proj;
  }

  function headlessNoGui(): ShotRun {
    return (cmd, argv) => {
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "deliverable output line 1\ndeliverable output line 2\n", stderr: "" });
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Background\n", stderr: "" }); // not Aqua → headless
      if (cmd === "screencapture") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
  }

  // AC4: headless + deliverable_cmd → command stdout becomes taken:true terminal evidence → gate PASS
  it("headless (no GUI) + successful deliverable_cmd → stdout promoted to taken:true terminal capture", async () => {
    const proj = cmdProject();
    const textCapture: ShotRun = (cmd) => {
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "deliverable <script>alert(1)</script>\n", stderr: "" });
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Background\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-CMD", "--capture-command", "roll status"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: textCapture, platform: "darwin", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-CMD", "2026-06-06T01-02-03");
    // Text evidence file exists
    const txtPath = join(runDir, "screenshots", "terminal-headless.txt");
    expect(existsSync(txtPath)).toBe(true);
    expect(readFileSync(txtPath, "utf8")).toContain("deliverable <script>alert(1)</script>");
    // Evidence manifest records it as taken:true terminal capture
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; out?: string; taken?: boolean }>;
      capture_command?: { exitCode?: number; stdoutTail?: string };
    };
    expect(evidence.captures).toContainEqual({ kind: "terminal", out: txtPath, taken: true });
    // capture_command fact also recorded
    expect(evidence.capture_command?.exitCode).toBe(0);
    expect(evidence.capture_command?.stdoutTail).toContain("deliverable <script>alert(1)</script>");
    const html = readFileSync(join(runDir, "FIX-CMD-report.html"), "utf8");
    expect(html).toContain('<pre class="ansi">deliverable &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain("<pre class=\"ansi\">deliverable <script>");
    expect(html).not.toContain('<img src="screenshots/terminal-headless.txt"');
  });

  // AC4: command non-zero exit → still fails (does NOT promote)
  it("headless but command fails → terminal capture stays taken:false (no dilution)", async () => {
    const proj = cmdProject();
    const failingCmd: ShotRun = (cmd, argv) => {
      if (cmd === "sh") return Promise.resolve({ code: 1, stdout: "", stderr: "command not found" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const code = await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-CMD", "--capture-command", "roll status"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: failingCmd, platform: "darwin", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-CMD", "2026-06-06T01-02-03");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string; failed?: boolean; error?: string }>;
      capture_command?: { exitCode?: number };
    };
    // Command failed → not promoted
    expect(evidence.capture_command?.exitCode).toBe(1);
    expect(evidence.captures?.[0]?.taken).toBe(false);
    expect(evidence.captures?.[0]?.skipped).toContain("capture command exited");
    expect(evidence.captures?.[0]?.failed).toBe(true);
    expect(evidence.captures?.[0]?.error).toContain("command not found");
    expect(code).toBe(3);
    // No headless txt file
    expect(existsSync(join(runDir, "screenshots", "terminal-headless.txt"))).toBe(false);
  });

  // AC5 regression: with GUI → real terminal screenshot (not the text fallback)
  it("GUI present → real terminal screenshot (no regression to text fallback)", async () => {
    const proj = cmdProject();
    const guiRun: ShotRun = (cmd, argv) => {
      if (cmd === "sh") {
        const fullCmd = argv.join(" ");
        if (fullCmd.includes("lsappinfo")) return Promise.resolve({ code: 0, stdout: "Terminal\n", stderr: "" });
        return Promise.resolve({ code: 0, stdout: "deliverable output\n", stderr: "" });
      }
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Aqua\n", stderr: "" }); // GUI session
      if (cmd === "osascript") return Promise.resolve({ code: 0, stdout: argv[1]?.includes("bounds") ? "0, 0, 1280, 800" : "yes\n", stderr: "" });
      if (cmd === "screencapture") {
        writeFileSync(String(argv[argv.length - 1]), "PNGDATA");
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-CMD", "--capture-command", "roll status"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: guiRun, platform: "darwin", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-CMD", "2026-06-06T01-02-03");
    // Real screenshot PNG exists (not the .txt fallback)
    expect(existsSync(join(runDir, "screenshots", "terminal.png"))).toBe(true);
    expect(existsSync(join(runDir, "screenshots", "terminal-headless.txt"))).toBe(false);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean }>;
    };
    expect(evidence.captures?.[0]?.taken).toBe(true);
    expect(evidence.captures?.[0]?.kind).toBe("terminal");
    const html = readFileSync(join(runDir, "FIX-CMD-report.html"), "utf8");
    expect(html).toContain('<img src="screenshots/terminal.png"');
  });

  // AC5: not macOS → fallback promotes text evidence
  it("not macOS → stdout promoted to taken:true terminal capture via headless fallback", async () => {
    const proj = cmdProject();
    const linuxRun: ShotRun = (cmd, argv) => {
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "linux output\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-CMD", "--capture-command", "roll status"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: linuxRun, platform: "linux", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-CMD", "2026-06-06T01-02-03");
    // Headless text evidence exists
    const txtPath = join(runDir, "screenshots", "terminal-headless.txt");
    expect(existsSync(txtPath)).toBe(true);
    expect(readFileSync(txtPath, "utf8")).toContain("linux output");
    // Terminal capture is taken:true
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean }>;
    };
    expect(evidence.captures).toContainEqual({ kind: "terminal", out: txtPath, taken: true });
  });

  // AC1: the headless .txt file exists and contains the command stdout
  it("headless fallback writes stdout to screenshots/terminal-headless.txt", async () => {
    const proj = cmdProject();
    const multiOutput: ShotRun = (cmd, argv) => {
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "Line A\nLine B\nLine C\n", stderr: "" });
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Background\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["FIX-CMD", "--capture-command", "roll status"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: multiOutput, platform: "darwin", env: {} },
        }),
      ),
    );
    const runDir = join(proj, ".roll", "features", "demo", "FIX-CMD", "2026-06-06T01-02-03");
    const txt = readFileSync(join(runDir, "screenshots", "terminal-headless.txt"), "utf8");
    expect(txt).toContain("Line A");
    expect(txt).toContain("Line C");
  });
});

describe("attestCommand — process trace inline (US-ATTEST-014)", () => {
  // Pin the runtime dir to the temp project so the default reader can't fall
  // through to a real .roll/loop when the suite runs inside the loop itself.
  function withRuntimeEnv<T>(proj: string, fn: () => Promise<T>): Promise<T> {
    const save = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    process.env["ROLL_PROJECT_RUNTIME_DIR"] = join(proj, ".roll", "loop");
    return fn().finally(() => {
      if (save === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = save;
    });
  }
  function writeRuntime(proj: string, opts: { transcript?: string } = {}): void {
    const rt = join(proj, ".roll", "loop");
    mkdirSync(join(rt, "cycle-logs"), { recursive: true });
    writeFileSync(
      join(rt, "runs.jsonl"),
      JSON.stringify({ run_id: "cyc-1", story_id: "FIX-300", cycle_id: "cyc-1", agent: "claude", built: ["FIX-300"] }) + "\n",
    );
    const evs: RollEvent[] = [
      { type: "cycle:start", cycleId: "cyc-1", storyId: "FIX-300", agent: "claude", model: "opus", ts: 1000 },
      { type: "cycle:tcr", cycleId: "cyc-1", commitHash: "deadbeef00", message: "tcr: first step", ts: 1030 },
      { type: "pr:open", prNumber: 42, storyId: "FIX-300", ts: 1060 },
      { type: "cycle:end", cycleId: "cyc-1", outcome: "delivered", cost: { cycleId: "cyc-1", agent: "claude", model: "opus", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 }, ts: 1200 },
    ];
    writeFileSync(join(rt, "events.ndjson"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (opts.transcript !== undefined) writeFileSync(join(rt, "cycle-logs", "cyc-1.agent.log"), opts.transcript);
  }

  it("loop-delivered card: report carries timeline + signal + folded transcript, secrets redacted", async () => {
    const proj = project();
    writeRuntime(proj, { transcript: "starting cycle\nexport GITHUB_TOKEN=ghp_0123456789abcdef0123456789abcdef0123\ndone\n" });
    const code = await silenced(() =>
      withRuntimeEnv(proj, () => inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }))),
    );
    expect(code).toBe(0);
    const html = readFileSync(join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"), "utf8");
    expect(html).toContain(bi("Process trace", "过程档案"));
    expect(html).toContain("cyc-1");
    expect(html).toContain("first step"); // tcr signal
    expect(html).toContain("完整转录"); // folded transcript present
    expect(html).toContain("cycle-logs/cyc-1.agent.log"); // machine-original index
    // AC2: the secret went through 012's redaction pipeline before inlining
    expect(html).not.toContain("ghp_0123456789abcdef0123456789abcdef0123");
  });

  it("no process data ⇒ section trimmed, exit 0, no throw (degrade path)", async () => {
    const proj = project(); // no .roll/loop runtime written
    const code = await silenced(() =>
      withRuntimeEnv(proj, () => inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) }))),
    );
    expect(code).toBe(0);
    const html = readFileSync(join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "FIX-300-report.html"), "utf8");
    expect(html).not.toContain("过程档案");
  });
});

describe("attestCommand — US-EVID-030 CapturePlanner seam", () => {
  const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function fakeLane(source: CaptureLanePort["source"], seed: number): CaptureLanePort {
    return {
      source,
      async run(intent: CaptureIntentV2): Promise<CaptureReceiptV2> {
        mkdirSync(dirname(intent.out), { recursive: true });
        const bytes = Buffer.from([...PNG_HEADER, seed]);
        writeFileSync(intent.out, bytes);
        const captureClass = source === "roll-capture-window" ? "physical" : "rendered";
        return {
          protocol: ROLL_CAPTURE_PROTOCOL_V2,
          requestId: intent.requestId,
          storyId: intent.storyId,
          runId: intent.runId,
          surfaceId: intent.surface.id,
          source,
          captureClass,
          state: "taken",
          screenshotPath: intent.out,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          ...(captureClass === "rendered" ? { finalUrl: intent.surface.id } : {}),
          ...(captureClass === "physical" && intent.target !== undefined ? { target: intent.target } : {}),
          responsePath: `${intent.out}.response.json`,
          startedAt: "2026-07-18T10:00:01.000+08:00",
          finishedAt: "2026-07-18T10:00:02.000+08:00",
        };
      },
    };
  }

  it("plans + dispatches both lanes and folds BOTH receipts into the manifest, even with ROLL_NO_SCREENCAP=1", async () => {
    const proj = project();
    const captureRoot = join(proj, ".roll", "capture-gateway");
    const surface = { declaredUrl: "http://localhost:3000/team", expectedAcIds: ["FIX-300:AC1"], windowApp: "Google Chrome", windowTitle: "团队管理" };
    const prev = process.env["ROLL_NO_SCREENCAP"];
    process.env["ROLL_NO_SCREENCAP"] = "1"; // must NOT gate the planner
    try {
      const code = await silenced(() =>
        inDir(proj, () =>
          attestCommand(["FIX-300"], {
            now: () => T0,
            run: quietRun,
            ghProbe: () => Promise.resolve(false),
            rollCapture: { root: captureRoot, captureSurfaces: [{ surface, lanes: [fakeLane("roll-capture-window", 1), fakeLane("playwright-rendered", 2)] }] },
          }),
        ),
      );
      expect(code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env["ROLL_NO_SCREENCAP"];
      else process.env["ROLL_NO_SCREENCAP"] = prev;
    }

    const runDir = join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03");
    const manifest = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as { capture_receipts: Array<{ captureClass: string; surfaceId: string; state: string }> };
    expect(manifest.capture_receipts).toHaveLength(2);
    expect(manifest.capture_receipts.map((r) => r.captureClass).sort()).toEqual(["physical", "rendered"]);
    expect(manifest.capture_receipts.every((r) => r.surfaceId === "http://localhost:3000/team" && r.state === "taken")).toBe(true);

    const html = readFileSync(join(runDir, "FIX-300-report.html"), "utf8");
    expect(html).toContain("Roll Capture · physical");
    expect(html).toContain("Playwright · rendered");
  });

  it("is default-off: no captureSurfaces ⇒ no capture_receipts, exit 0", async () => {
    const proj = project();
    const code = await silenced(() =>
      inDir(proj, () => attestCommand(["FIX-300"], { now: () => T0, run: quietRun, ghProbe: () => Promise.resolve(false) })),
    );
    expect(code).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(proj, ".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03", "evidence.json"), "utf8"),
    ) as { capture_receipts?: unknown; evidence_health?: unknown };
    expect(manifest.capture_receipts ?? []).toEqual([]);
    // US-EVID-031 — additive/default-off: no v2 surface ⇒ no evidence_health key.
    expect(manifest.evidence_health).toBeUndefined();
  });
});

describe("attestCommand — US-EVID-031 EvidenceHealth separation (AC2/AC3/AC5/AC6)", () => {
  const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const SURFACE = "http://localhost:3000/team";
  const RUN_DIR_PARTS = [".roll", "features", "demo", "FIX-300", "2026-06-06T01-02-03"] as const;

  /** A lane that writes a real PNG and returns a taken receipt (optionally poisoned). */
  function takenLane(source: CaptureLanePort["source"], seed: number, over: (i: CaptureIntentV2) => Partial<CaptureReceiptV2> = () => ({})): CaptureLanePort {
    return {
      source,
      async run(intent: CaptureIntentV2): Promise<CaptureReceiptV2> {
        mkdirSync(dirname(intent.out), { recursive: true });
        const bytes = Buffer.from([...PNG_HEADER, seed]);
        writeFileSync(intent.out, bytes);
        const captureClass = source === "roll-capture-window" ? "physical" : "rendered";
        return {
          protocol: ROLL_CAPTURE_PROTOCOL_V2,
          requestId: intent.requestId,
          storyId: intent.storyId,
          runId: intent.runId,
          surfaceId: intent.surface.id,
          source,
          captureClass,
          state: "taken",
          screenshotPath: intent.out,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          ...(captureClass === "rendered" ? { finalUrl: intent.surface.id } : {}),
          ...(captureClass === "physical" && intent.target !== undefined ? { target: intent.target } : {}),
          responsePath: `${intent.out}.response.json`,
          startedAt: "2026-07-18T10:00:01.000+08:00",
          finishedAt: "2026-07-18T10:00:02.000+08:00",
          ...over(intent),
        };
      },
    };
  }

  /** A lane that fails for host reasons (infrastructure). */
  function throwingLane(source: CaptureLanePort["source"]): CaptureLanePort {
    return {
      source,
      run() {
        return Promise.reject(new Error("Capture.app not running"));
      },
    };
  }

  function capturedStderr<T>(fn: () => Promise<T>): Promise<{ code: T; stderr: string }> {
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    let stderr = "";
    // @ts-expect-error capture-only
    process.stdout.write = (): boolean => true;
    // @ts-expect-error capture-only
    process.stderr.write = (s: string): boolean => {
      stderr += String(s);
      return true;
    };
    return fn()
      .then((code) => ({ code, stderr }))
      .finally(() => {
        process.stdout.write = o;
        process.stderr.write = e;
      });
  }

  type HealthManifest = {
    evidence_health?: Array<{ surfaceId: string; visual: string; delivery: string; category: string; blocksGate: boolean; reschedulesBuild: boolean; markedDegraded: boolean }>;
  };

  function readHealth(proj: string): HealthManifest["evidence_health"] {
    const m = JSON.parse(readFileSync(join(proj, ...RUN_DIR_PARTS, "evidence.json"), "utf8")) as HealthManifest;
    return m.evidence_health;
  }
  function readReport(proj: string): string {
    return readFileSync(join(proj, ...RUN_DIR_PARTS, "FIX-300-report.html"), "utf8");
  }

  it("verified: both lanes taken ⇒ evidence_health=verified, renders both provenance labels under the shared surface (AC6)", async () => {
    const proj = project();
    const surface = { declaredUrl: SURFACE, expectedAcIds: ["FIX-300:AC1"], windowApp: "Google Chrome", windowTitle: "团队管理" };
    const { code, stderr } = await capturedStderr(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { root: join(proj, ".roll", "capture-gateway"), captureSurfaces: [{ surface, lanes: [takenLane("roll-capture-window", 1), takenLane("playwright-rendered", 2)] }] },
        }),
      ),
    );
    expect(code).toBe(0);
    const health = readHealth(proj)!;
    expect(health).toHaveLength(1);
    expect(health[0]!.visual).toBe("verified");
    expect(health[0]!.category).toBe("evidence-verified");
    expect(health[0]!.blocksGate).toBe(false);
    // AC6: one physical + one rendered under the shared surface, with provenance.
    const html = readReport(proj);
    expect(html).toContain("Visual evidence by surface");
    expect(html).toContain("Roll Capture · physical");
    expect(html).toContain("Playwright · rendered");
    expect(html).toContain('data-class="physical"');
    expect(html).toContain('data-class="rendered"');
    // AC5: the distinct signal reaches loop status (stderr).
    expect(stderr).toContain("evidence-health");
    expect(stderr).toContain("evidence-verified");
  });

  it("degraded-infrastructure: all lanes fail for host reasons ⇒ publishes (exit 0), NOT rebuilt, visibly marked (AC2)", async () => {
    const proj = project();
    const surface = { declaredUrl: SURFACE, expectedAcIds: ["FIX-300:AC1"], windowApp: "Google Chrome" };
    const { code, stderr } = await capturedStderr(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { root: join(proj, ".roll", "capture-gateway"), captureSurfaces: [{ surface, lanes: [throwingLane("roll-capture-window"), throwingLane("playwright-rendered")] }] },
        }),
      ),
    );
    // AC2: a broken capture machine does NOT fail the delivery (attest exits 0).
    expect(code).toBe(0);
    const health = readHealth(proj)!;
    expect(health[0]!.visual).toBe("degraded-infrastructure");
    expect(health[0]!.category).toBe("evidence-degradation");
    expect(health[0]!.delivery).toBe("passed"); // delivery independent of the machine
    expect(health[0]!.reschedulesBuild).toBe(false); // never rebuild a completed story
    expect(health[0]!.markedDegraded).toBe(true);
    // Visibly marked in the report.
    const html = readReport(proj);
    expect(html).toContain("vh-degraded");
    // AC5: distinct degradation signal in loop status.
    expect(stderr).toContain("evidence-degradation");
  });

  it("invalid-target: a poisoned lane stays BLOCKING even beside a valid image on the SAME surface (AC3, scorer_focus)", async () => {
    const proj = project();
    const surface = { declaredUrl: SURFACE, expectedAcIds: ["FIX-300:AC1"], windowApp: "Google Chrome", windowTitle: "团队管理" };
    // physical lane captures validly; rendered lane lands on a login page (poisoned).
    const poisonedRendered = takenLane("playwright-rendered", 3, () => ({ finalUrl: "http://localhost:3000/login" }));
    const { code, stderr } = await capturedStderr(() =>
      inDir(proj, () =>
        attestCommand(["FIX-300"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          rollCapture: { root: join(proj, ".roll", "capture-gateway"), captureSurfaces: [{ surface, lanes: [takenLane("roll-capture-window", 1), poisonedRendered] }] },
        }),
      ),
    );
    expect(code).toBe(0); // attest still renders the evidence; the GATE blocks on visual
    const health = readHealth(proj)!;
    // The coexisting valid physical image does NOT flip the surface to verified.
    expect(health[0]!.visual).toBe("invalid-target");
    expect(health[0]!.category).toBe("evidence-contract-failure");
    expect(health[0]!.blocksGate).toBe(true);
    // AC5: the contract-failure signal reaches loop status.
    expect(stderr).toContain("evidence-contract-failure");
  });
});
