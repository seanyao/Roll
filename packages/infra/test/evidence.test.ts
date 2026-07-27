/**
 * US-ATTEST-003 — evidence collector pins. All process seams faked through the
 * injectable runner (argv recorded); fs fixtures for proof/artifacts. The
 * collector's contract: facts only, never throws, absent shapes over errors.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectEvidence, writeEvidenceJson, type EvidenceRun, type RunOut } from "../src/evidence.js";
import { openEvidenceFrame } from "../src/evidence.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});
function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `roll-ev-${tag}-`)));
  dirs.push(d);
  return d;
}

const NOW = "2026-06-06T00:00:00.000Z";

function fakeRun(canned: Partial<Record<string, RunOut>>): { run: EvidenceRun; calls: string[] } {
  const calls: string[] = [];
  const run: EvidenceRun = (tool, argv) => {
    calls.push(`${tool} ${argv.join(" ")}`);
    return Promise.resolve(canned[tool] ?? { code: 1, stdout: "", stderr: "" });
  };
  return { run, calls };
}

describe("collectEvidence", () => {
  it("TCR commits: tcr-grepped log filtered to subjects naming the story", async () => {
    const { run } = fakeRun({
      git: {
        code: 0,
        stdout: [
          "aaa1\ttcr: FIX-200 修正偏移",
          "bbb2\ttcr: US-OTHER-001 unrelated",
          "ccc3\ttcr: FIX-200 第二刀",
          "",
        ].join("\n"),
        stderr: "",
      },
    });
    const m = await collectEvidence({
      storyId: "FIX-200",
      projectPath: tmp("p"),
      runDir: tmp("r"),
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(false),
    });
    expect(m.tcr_commits).toEqual([
      { hash: "aaa1", subject: "tcr: FIX-200 修正偏移" },
      { hash: "ccc3", subject: "tcr: FIX-200 第二刀" },
    ]);
    expect(m.ci.available).toBe(false);
  });

  it("CI: gh present → url+conclusion; malformed json degrades to unavailable", async () => {
    const { run } = fakeRun({
      git: { code: 0, stdout: "", stderr: "" },
      gh: { code: 0, stdout: '[{"url":"https://ci/run/1","conclusion":"success"}]', stderr: "" },
    });
    const m = await collectEvidence({
      storyId: "X-1",
      projectPath: tmp("p"),
      runDir: tmp("r"),
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(true),
    });
    expect(m.ci).toEqual({ available: true, url: "https://ci/run/1", conclusion: "success" });
  });

  it("deploy probe: HEAD status classifies ok; absent url → null", async () => {
    const { run, calls } = fakeRun({
      git: { code: 0, stdout: "", stderr: "" },
      curl: { code: 0, stdout: "302", stderr: "" },
    });
    const base = { storyId: "X-1", projectPath: tmp("p"), runDir: tmp("r"), now: () => NOW, run, ghProbe: () => Promise.resolve(false) };
    const probed = await collectEvidence({ ...base, deployUrl: "https://app.example" });
    expect(probed.deploy).toEqual({ url: "https://app.example", status: 302, ok: true });
    expect(calls.some((c) => c.startsWith("curl -sI"))).toBe(true);

    const skipped = await collectEvidence(base);
    expect(skipped.deploy).toBeNull();
  });

  it("test-pass proof: presence + age from mtime vs injected clock", async () => {
    const proj = tmp("p");
    mkdirSync(join(proj, ".roll"), { recursive: true });
    const proof = join(proj, ".roll", "last-test-pass");
    writeFileSync(proof, "vitest\n");
    const mtime = new Date(Date.parse(NOW) - 90_000); // 90s before NOW
    utimesSync(proof, mtime, mtime);
    const { run } = fakeRun({ git: { code: 0, stdout: "", stderr: "" } });
    const m = await collectEvidence({
      storyId: "X-1",
      projectPath: proj,
      runDir: tmp("r"),
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(false),
    });
    expect(m.test_pass.present).toBe(true);
    expect(m.test_pass.age_seconds).toBe(90);
  });

  it("artifacts: screenshots/*.png and evidence/*.txt listed sorted, rel paths", async () => {
    const runDir = tmp("r");
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    writeFileSync(join(runDir, "screenshots", "b.png"), "");
    writeFileSync(join(runDir, "screenshots", "a.png"), "");
    writeFileSync(join(runDir, "screenshots", "skip.txt"), "");
    writeFileSync(join(runDir, "evidence", "curl.txt"), "");
    const { run } = fakeRun({ git: { code: 0, stdout: "", stderr: "" } });
    const m = await collectEvidence({
      storyId: "X-1",
      projectPath: tmp("p"),
      runDir,
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(false),
    });
    expect(m.screenshots).toEqual(["screenshots/a.png", "screenshots/b.png"]);
    expect(m.texts).toEqual(["evidence/curl.txt"]);
  });

  it("passes capture failed/error metadata through to the manifest", async () => {
    const { run } = fakeRun({ git: { code: 0, stdout: "", stderr: "" } });
    const m = await collectEvidence({
      storyId: "US-EVID-023",
      projectPath: tmp("p"),
      runDir: tmp("r"),
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(false),
      captures: [
        {
          kind: "web",
          out: "screenshots/web.png",
          taken: false,
          skipped: "capture errored: headless timeout",
          failed: true,
          error: "headless timeout",
        },
      ],
    });
    expect(m.captures[0]).toMatchObject({
      taken: false,
      skipped: "capture errored: headless timeout",
      failed: true,
      error: "headless timeout",
    });
  });
});

describe("writeEvidenceJson", () => {
  it("writes a stable 2-space manifest into the run dir", async () => {
    const runDir = tmp("r");
    const { run } = fakeRun({ git: { code: 0, stdout: "", stderr: "" } });
    const m = await collectEvidence({
      storyId: "FIX-9",
      projectPath: tmp("p"),
      runDir,
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(false),
    });
    const p = writeEvidenceJson(m, runDir);
    const text = readFileSync(p, "utf8");
    expect(p.endsWith("evidence.json")).toBe(true);
    expect(JSON.parse(text)).toEqual(m);
    expect(text).toContain('  "story_id": "FIX-9"');
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("openEvidenceFrame", () => {
  it("creates the run frame plus evidence/ and screenshots/ directories", () => {
    const runDir = join(tmp("frame"), "US-EVID-001-run");
    const frame = openEvidenceFrame({ runDir });
    expect(frame.runDir).toBe(runDir);
    expect(frame.evidenceDir).toBe(join(runDir, "evidence"));
    expect(frame.screenshotsDir).toBe(join(runDir, "screenshots"));
    expect(statSync(runDir).isDirectory()).toBe(true);
    expect(statSync(frame.evidenceDir).isDirectory()).toBe(true);
    expect(statSync(frame.screenshotsDir).isDirectory()).toBe(true);
  });

  it("is idempotent and never clears an already-opened frame", () => {
    const runDir = join(tmp("frame-idem"), "cycle-1");
    const frame = openEvidenceFrame({ runDir });
    writeFileSync(join(frame.evidenceDir, "kept.txt"), "proof\n");
    const again = openEvidenceFrame({ runDir });
    expect(again).toEqual(frame);
    expect(readFileSync(join(frame.evidenceDir, "kept.txt"), "utf8")).toBe("proof\n");
  });
});

/**
 * US-EVID-033 — the card-level delivery-CI lane. Every forge touch goes through
 * the injected runner (argv asserted); the classification itself is the pure core
 * resolver's, so a probe failure can never surface as a pass. Codex review r1
 * cases are pinned here: full pagination, legacy commit statuses, merged-PR +
 * merge-sha agreement, and target validation.
 */
describe("collectEvidence — delivery_ci (US-EVID-033)", () => {
  /** Runner that dispatches on argv, recording every call. */
  function forgeRun(handlers: Array<[RegExp, RunOut]>): { run: EvidenceRun; calls: string[] } {
    const calls: string[] = [];
    const run: EvidenceRun = (tool, argv) => {
      const line = `${tool} ${argv.join(" ")}`;
      calls.push(line);
      for (const [pattern, out] of handlers) if (pattern.test(line)) return Promise.resolve(out);
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    return { run, calls };
  }

  const MERGE_SHA = "32195061fb3ec0f31a26ced91c4c375168ec2dfb";
  const HEAD_SHA = "aaaabbbbccccddddeeeeffff0000111122223333";
  const REMOTE: [RegExp, RunOut] = [
    /^git remote get-url origin$/,
    { code: 0, stdout: "git@github.com:seanyao/roll.git\n", stderr: "" },
  ];
  const LOG: [RegExp, RunOut] = [/^git log /, { code: 0, stdout: "", stderr: "" }];
  const RUN_LIST: [RegExp, RunOut] = [/^gh run list/, { code: 0, stdout: "[]", stderr: "" }];
  const PR_MERGED: [RegExp, RunOut] = [
    /^gh api repos\/seanyao\/roll\/pulls\/1490 /,
    {
      code: 0,
      stdout: `{"head":"${HEAD_SHA}","merged":true,"merge_commit_sha":"${MERGE_SHA}","merged_at":"2026-06-01T10:00:00Z","base":"main"}`,
      stderr: "",
    },
  ];
  const NO_STATUSES: [RegExp, RunOut] = [/\/statuses/, { code: 0, stdout: "", stderr: "" }];
  /** The base branch requires `test-ts` (roll's real protection shape). */
  const REQUIRED: [RegExp, RunOut] = [
    /protection\/required_status_checks/,
    { code: 0, stdout: "test-ts\t\n", stderr: "" },
  ];
  /** Every green check finished 5 minutes BEFORE the merge. */
  const PRE_MERGE = "2026-06-01T09:55:00Z";
  const record = { prNumber: 1490, mergeCommit: "32195061" };
  const base = (run: EvidenceRun) => ({
    storyId: "FIX-1475",
    projectPath: tmp("p"),
    runDir: tmp("r"),
    now: () => NOW,
    run,
    ghProbe: () => Promise.resolve(true),
  });

  it("binds THIS card's merged PR: head sha from the PR, checks from that sha ⇒ verified", async () => {
    const { run, calls } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [new RegExp(`commits/${HEAD_SHA}/check-runs`), { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
      NO_STATUSES,
      REQUIRED,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: { ...record, headSha: "1111111stale" } });
    expect(m.delivery_ci?.state).toBe("verified");
    // The PR's head sha WINS over the stale recorded one — checks are queried on
    // the sha they actually ran on.
    expect(m.delivery_ci?.headSha).toBe(HEAD_SHA);
    expect(m.delivery_ci?.prNumber).toBe(1490);
    expect(m.delivery_ci?.postHoc).toBe("yes");
    expect(calls.some((c) => c.includes(`--paginate repos/seanyao/roll/commits/${HEAD_SHA}/check-runs`))).toBe(true);
    // The legacy repo-wide lane is untouched by this card's fact.
    expect(m.ci.conclusion).toBe("");
  });

  it("reads EVERY page (--paginate): a red beyond page 1 makes the fact red", async () => {
    // gh --paginate concatenates pages; a red arriving in the later page must land.
    const paged = [...Array(30)]
      .map((_, i) => `check-${i}\tsuccess\t${PRE_MERGE}`)
      .concat([`late-check\tfailure\t${PRE_MERGE}`])
      .join("\n");
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `${paged}\n`, stderr: "" }],
      NO_STATUSES,
      REQUIRED,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("red");
    expect(m.delivery_ci?.reason).toBe("checks_failed:late-check");
    expect(m.delivery_ci?.checks).toHaveLength(31);
  });

  it("folds in LEGACY commit statuses — a red status is not invisible", async () => {
    const { run, calls } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
      [/\/statuses/, { code: 0, stdout: `legacy/deploy\terror\t${PRE_MERGE}\n`, stderr: "" }],
      REQUIRED,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(calls.some((c) => c.includes("/statuses"))).toBe(true);
    expect(m.delivery_ci?.state).toBe("red");
    expect(m.delivery_ci?.reason).toContain("legacy/deploy");
  });

  it("a pending REQUIRED status leaves the delivery unproven (an optional one does not)", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
      [/\/statuses/, { code: 0, stdout: `legacy/deploy\tpending\t${PRE_MERGE}\n`, stderr: "" }],
      // `legacy/deploy` IS required here, so its pending state blocks.
      [/protection\/required_status_checks/, { code: 0, stdout: "test-ts\t\nlegacy/deploy\t\n", stderr: "" }],
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("required_missing:legacy/deploy");
  });

  it("a pending OPTIONAL status does not block, but a failing one still reds", async () => {
    const mk = (state: string): EvidenceRun =>
      forgeRun([
        REMOTE,
        LOG,
        RUN_LIST,
        PR_MERGED,
        [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
        [/\/statuses/, { code: 0, stdout: `optional/deploy\t${state}\t${PRE_MERGE}\n`, stderr: "" }],
        REQUIRED,
      ]).run;
    const pending = await collectEvidence({ ...base(mk("pending")), deliveryRecord: record });
    expect(pending.delivery_ci?.state).toBe("verified");
    const failing = await collectEvidence({ ...base(mk("failure")), deliveryRecord: record });
    expect(failing.delivery_ci?.state).toBe("red");
    expect(failing.delivery_ci?.reason).toBe("checks_failed:optional/deploy");
  });

  it("a partially-read list is NOT complete ⇒ unknown, never verified", async () => {
    // check-runs read fine, the statuses call failed → a red could be hiding.
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
      [/\/statuses/, { code: 1, stdout: "", stderr: "HTTP 500" }],
      REQUIRED,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("checks_list_incomplete");
  });

  it("an OPEN PR can never be verified, however green", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      [
        /pulls\/1490 /,
        { code: 0, stdout: `{"head":"${HEAD_SHA}","merged":false,"merge_commit_sha":null,"merged_at":null}`, stderr: "" },
      ],
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
      NO_STATUSES,
      REQUIRED,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("pr_not_merged");
  });

  it("a PR whose merge sha disagrees with the ledger is refused (wrong delivery)", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      [
        /pulls\/1490 /,
        {
          code: 0,
          stdout: `{"head":"${HEAD_SHA}","merged":true,"merge_commit_sha":"9999999999999999","merged_at":"2026-06-01T10:00:00Z"}`,
          stderr: "",
        },
      ],
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\n`, stderr: "" }],
      NO_STATUSES,
      REQUIRED,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("merge_sha_mismatch");
  });

  it("a malformed repo slug is refused before any forge call", async () => {
    const { run, calls } = forgeRun([
      [/^git remote get-url origin$/, { code: 0, stdout: "git@github.com:evil/../../roll.git\n", stderr: "" }],
      LOG,
      RUN_LIST,
    ]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("invalid_target");
    expect(calls.some((c) => c.includes("check-runs"))).toBe(false);
  });

  it("no delivery record ⇒ the lane is omitted entirely (never faked)", async () => {
    const { run, calls } = forgeRun([REMOTE, LOG, RUN_LIST]);
    const m = await collectEvidence({ ...base(run), storyId: "US-NEW-001" });
    expect(m.delivery_ci).toBeUndefined();
    expect(calls.some((c) => c.includes("check-runs"))).toBe(false);
  });

  it("a failed checks query degrades to unknown — never a pass", async () => {
    const { run } = forgeRun([REMOTE, LOG, RUN_LIST, PR_MERGED, [/check-runs|\/statuses/, { code: 1, stdout: "", stderr: "HTTP 404" }], REQUIRED]);
    const m = await collectEvidence({ ...base(run), deliveryRecord: record });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("checks_unavailable");
  });

  it("offline host (no gh) ⇒ unknown:gh_unavailable, no forge calls", async () => {
    const { run, calls } = forgeRun([REMOTE, LOG]);
    const m = await collectEvidence({
      ...base(run),
      ghProbe: () => Promise.resolve(false),
      deliveryRecord: record,
    });
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("gh_unavailable");
    expect(calls.some((c) => c.startsWith("gh "))).toBe(false);
  });
});

/** Codex review r2 — required-check set and the delivery-time boundary, live wiring. */
describe("collectEvidence — delivery_ci required checks + merge boundary (US-EVID-033 r2)", () => {
  function forgeRun(handlers: Array<[RegExp, RunOut]>): { run: EvidenceRun; calls: string[] } {
    const calls: string[] = [];
    const run: EvidenceRun = (tool, argv) => {
      const line = `${tool} ${argv.join(" ")}`;
      calls.push(line);
      for (const [pattern, out] of handlers) if (pattern.test(line)) return Promise.resolve(out);
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    return { run, calls };
  }
  const MERGE_SHA = "32195061fb3ec0f31a26ced91c4c375168ec2dfb";
  const HEAD_SHA = "aaaabbbbccccddddeeeeffff0000111122223333";
  const REMOTE: [RegExp, RunOut] = [
    /^git remote get-url origin$/,
    { code: 0, stdout: "git@github.com:seanyao/roll.git\n", stderr: "" },
  ];
  const LOG: [RegExp, RunOut] = [/^git log /, { code: 0, stdout: "", stderr: "" }];
  const RUN_LIST: [RegExp, RunOut] = [/^gh run list/, { code: 0, stdout: "[]", stderr: "" }];
  const PR_MERGED: [RegExp, RunOut] = [
    /pulls\/1490 /,
    {
      code: 0,
      stdout: `{"head":"${HEAD_SHA}","merged":true,"merge_commit_sha":"${MERGE_SHA}","merged_at":"2026-06-01T10:00:00Z","base":"main"}`,
      stderr: "",
    },
  ];
  const NO_STATUSES: [RegExp, RunOut] = [/\/statuses/, { code: 0, stdout: "", stderr: "" }];
  const record = { prNumber: 1490, mergeCommit: "32195061" };
  const base = (run: EvidenceRun) => ({
    storyId: "FIX-1475",
    projectPath: tmp("p"),
    runDir: tmp("r"),
    now: () => NOW,
    run,
    ghProbe: () => Promise.resolve(true),
    deliveryRecord: record,
  });

  it("reads the base branch's required contexts (both .contexts and .checks shapes)", async () => {
    const { run, calls } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: "test-ts\tsuccess\t2026-06-01T09:55:00Z\n", stderr: "" }],
      NO_STATUSES,
      [/protection\/required_status_checks/, { code: 0, stdout: "test-ts\t\n", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(calls.some((c) => c.includes("repos/seanyao/roll/branches/main/protection/required_status_checks"))).toBe(true);
    expect(m.delivery_ci?.state).toBe("verified");
  });

  it("a green produced by a POST-MERGE rerun cannot verify the delivery", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      // Rerun finished days after the merge — the delivery-time result is gone.
      [/check-runs/, { code: 0, stdout: "test-ts\tsuccess\t2026-06-05T00:00:00Z\n", stderr: "" }],
      NO_STATUSES,
      [/protection\/required_status_checks/, { code: 0, stdout: "test-ts\t\n", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("checks_after_merge:test-ts");
  });

  it("an absent REQUIRED check is not covered by an optional green", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: "optional-lint\tsuccess\t2026-06-01T09:55:00Z\n", stderr: "" }],
      NO_STATUSES,
      [/protection\/required_status_checks/, { code: 0, stdout: "test-ts\t\n", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("required_missing:test-ts");
  });

  it("'Branch not protected' + a clean empty ruleset read ⇒ nothing declared", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: "test-ts\tsuccess\t2026-06-01T09:55:00Z\n", stderr: "" }],
      NO_STATUSES,
      [/protection\/required_status_checks/, { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" }],
      // Rulesets must also be consulted before concluding "nothing required" (r3).
      [/rules\/branches\/main/, { code: 0, stdout: "", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("verified");
    expect(m.delivery_ci?.requiredChecksSource).toBe("none_declared");
  });

  it("any OTHER protection-read failure leaves 'green' undefined ⇒ unknown", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: "test-ts\tsuccess\t2026-06-01T09:55:00Z\n", stderr: "" }],
      NO_STATUSES,
      [/protection\/required_status_checks/, { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("required_checks_unknown");
  });

  it("a check with no reported finish time cannot be placed before the merge", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: "test-ts\tsuccess\t\n", stderr: "" }],
      NO_STATUSES,
      [/protection\/required_status_checks/, { code: 0, stdout: "test-ts\t\n", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("check_time_unknown:test-ts");
  });
});

/** Codex review r3 — rulesets and App-pinned requirements, live wiring. */
describe("collectEvidence — delivery_ci rulesets + app pinning (US-EVID-033 r3)", () => {
  function forgeRun(handlers: Array<[RegExp, RunOut]>): { run: EvidenceRun; calls: string[] } {
    const calls: string[] = [];
    const run: EvidenceRun = (tool, argv) => {
      const line = `${tool} ${argv.join(" ")}`;
      calls.push(line);
      for (const [pattern, out] of handlers) if (pattern.test(line)) return Promise.resolve(out);
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    return { run, calls };
  }
  const MERGE_SHA = "32195061fb3ec0f31a26ced91c4c375168ec2dfb";
  const HEAD_SHA = "aaaabbbbccccddddeeeeffff0000111122223333";
  const PRE_MERGE = "2026-06-01T09:55:00Z";
  const REMOTE: [RegExp, RunOut] = [
    /^git remote get-url origin$/,
    { code: 0, stdout: "git@github.com:seanyao/roll.git\n", stderr: "" },
  ];
  const LOG: [RegExp, RunOut] = [/^git log /, { code: 0, stdout: "", stderr: "" }];
  const RUN_LIST: [RegExp, RunOut] = [/^gh run list/, { code: 0, stdout: "[]", stderr: "" }];
  const PR_MERGED: [RegExp, RunOut] = [
    /pulls\/1490 /,
    {
      code: 0,
      stdout: `{"head":"${HEAD_SHA}","merged":true,"merge_commit_sha":"${MERGE_SHA}","merged_at":"2026-06-01T10:00:00Z","base":"main"}`,
      stderr: "",
    },
  ];
  const NO_STATUSES: [RegExp, RunOut] = [/\/statuses/, { code: 0, stdout: "", stderr: "" }];
  const NOT_PROTECTED: [RegExp, RunOut] = [
    /protection\/required_status_checks/,
    { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" },
  ];
  const base = (run: EvidenceRun) => ({
    storyId: "FIX-1475",
    projectPath: tmp("p"),
    runDir: tmp("r"),
    now: () => NOW,
    run,
    ghProbe: () => Promise.resolve(true),
    deliveryRecord: { prNumber: 1490, mergeCommit: "32195061" },
  });

  it("an unprotected branch still honours a RULESET-required check", async () => {
    const { run, calls } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `optional\tsuccess\t${PRE_MERGE}\t\n`, stderr: "" }],
      NO_STATUSES,
      NOT_PROTECTED,
      [/rules\/branches\/main/, { code: 0, stdout: "ruleset-check\t\n", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(calls.some((c) => c.includes("rules/branches/main"))).toBe(true);
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("required_missing:ruleset-check");
    expect(m.delivery_ci?.requiredChecksSource).toBe("ruleset");
  });

  it("unprotected + no rulesets ⇒ nothing declared, verifies on the observed green", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\t\n`, stderr: "" }],
      NO_STATUSES,
      NOT_PROTECTED,
      [/rules\/branches\/main/, { code: 0, stdout: "", stderr: "" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("verified");
    expect(m.delivery_ci?.requiredChecksSource).toBe("none_declared");
  });

  it("an unreadable RULESET query leaves 'green' undefined ⇒ unknown", async () => {
    const { run } = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\t\n`, stderr: "" }],
      NO_STATUSES,
      NOT_PROTECTED,
      [/rules\/branches\/main/, { code: 1, stdout: "", stderr: "HTTP 403" }],
    ]);
    const m = await collectEvidence(base(run));
    expect(m.delivery_ci?.state).toBe("unknown");
    expect(m.delivery_ci?.reason).toBe("required_checks_unknown");
    expect(m.delivery_ci?.requiredChecksSource).toBe("unknown");
  });

  it("an App-pinned requirement is only satisfied by that App's check", async () => {
    const pinned: [RegExp, RunOut] = [
      /protection\/required_status_checks/,
      { code: 0, stdout: "test-ts\t15368\n", stderr: "" },
    ];
    const wrong = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\t99\n`, stderr: "" }],
      NO_STATUSES,
      pinned,
    ]).run;
    const mWrong = await collectEvidence(base(wrong));
    expect(mWrong.delivery_ci?.state).toBe("unknown");
    expect(mWrong.delivery_ci?.reason).toBe("required_missing:test-ts@app15368");
    const right = forgeRun([
      REMOTE,
      LOG,
      RUN_LIST,
      PR_MERGED,
      [/check-runs/, { code: 0, stdout: `test-ts\tsuccess\t${PRE_MERGE}\t15368\n`, stderr: "" }],
      NO_STATUSES,
      pinned,
    ]).run;
    const mRight = await collectEvidence(base(right));
    expect(mRight.delivery_ci?.state).toBe("verified");
  });
});

/** GitHub reports one requirement in both shapes; the pinned form must win. */
describe("collectEvidence — required-check dedupe (US-EVID-033)", () => {
  it("keeps one entry per context, preferring the App-pinned form", async () => {
    const calls: string[] = [];
    const run: EvidenceRun = (tool, argv) => {
      const line = `${tool} ${argv.join(" ")}`;
      calls.push(line);
      if (/^git remote/.test(line)) return Promise.resolve({ code: 0, stdout: "git@github.com:seanyao/roll.git\n", stderr: "" });
      if (/^git log/.test(line)) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      if (/^gh run list/.test(line)) return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
      if (/pulls\/1490 /.test(line))
        return Promise.resolve({
          code: 0,
          stdout: '{"head":"aaaabbbbccccddddeeeeffff0000111122223333","merged":true,"merge_commit_sha":"32195061fb3ec0f31a26ced91c4c375168ec2dfb","merged_at":"2026-06-01T10:00:00Z","base":"main"}',
          stderr: "",
        });
      if (/check-runs/.test(line))
        return Promise.resolve({ code: 0, stdout: "test-ts\tsuccess\t2026-06-01T09:55:00Z\t15368\n", stderr: "" });
      if (/\/statuses/.test(line)) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      if (/protection\/required_status_checks/.test(line))
        // Both shapes for the SAME requirement, as GitHub really returns it.
        return Promise.resolve({ code: 0, stdout: "test-ts\t\ntest-ts\t15368\n", stderr: "" });
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    const m = await collectEvidence({
      storyId: "FIX-1475",
      projectPath: tmp("p"),
      runDir: tmp("r"),
      now: () => NOW,
      run,
      ghProbe: () => Promise.resolve(true),
      deliveryRecord: { prNumber: 1490, mergeCommit: "32195061" },
    });
    expect(m.delivery_ci?.requiredChecks).toEqual([{ context: "test-ts", appId: 15368 }]);
    expect(m.delivery_ci?.state).toBe("verified");
  });
});
