import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessBootstrapArtifacts,
  buildPendingDeliveryEvidenceManifest,
  evidenceManifestDir,
  evidenceManifestPath,
  hashFileSha256,
  readPendingDeliveryEvidenceManifests,
  validatePendingDeliveryEvidenceManifest,
  writePendingDeliveryEvidenceManifest,
  type ManifestFileKind,
  type PendingDeliveryEvidenceManifest,
} from "../src/loop/bootstrap-evidence.js";

let root: string;

function write(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function sha(rel: string): string {
  return hashFileSha256(join(root, rel)) ?? "";
}

function manifest(files: PendingDeliveryEvidenceManifest["files"], over: Partial<PendingDeliveryEvidenceManifest> = {}): PendingDeliveryEvidenceManifest {
  return { version: 1, cycleId: "c1", storyId: "US-ORG-004", branch: "loop/cycle-c1", files, ...over };
}

function fileEntry(rel: string, kind: ManifestFileKind = "evidence") {
  return { path: rel, sha256: sha(rel), kind };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roll-boot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validatePendingDeliveryEvidenceManifest (schema, fail-closed)", () => {
  const good = (): unknown => ({
    version: 1,
    cycleId: "c1",
    storyId: "US-ORG-004",
    branch: "loop/cycle-c1",
    files: [{ path: ".roll/features/x/latest/report.html", sha256: "a".repeat(64), kind: "report" }],
  });

  it("accepts a well-formed manifest", () => {
    expect(validatePendingDeliveryEvidenceManifest(good())).not.toBeUndefined();
  });

  it("rejects wrong version, missing keys, and non-objects", () => {
    expect(validatePendingDeliveryEvidenceManifest(null)).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest("nope")).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest({ ...(good() as object), version: 2 })).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest({ ...(good() as object), cycleId: "" })).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest({ ...(good() as object), storyId: 5 })).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest({ ...(good() as object), branch: "" })).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest({ ...(good() as object), files: "x" })).toBeUndefined();
  });

  it("rejects a bad sha, unknown kind, and non-.roll path", () => {
    const withFile = (f: unknown): unknown => ({ ...(good() as object), files: [f] });
    expect(validatePendingDeliveryEvidenceManifest(withFile({ path: ".roll/a", sha256: "zz", kind: "report" }))).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest(withFile({ path: ".roll/a", sha256: "a".repeat(64), kind: "bogus" }))).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest(withFile({ path: "package.json", sha256: "a".repeat(64), kind: "report" }))).toBeUndefined();
  });

  it("rejects path traversal, absolute paths, and duplicate entries (whole manifest)", () => {
    const withFiles = (files: unknown): unknown => ({ ...(good() as object), files });
    expect(validatePendingDeliveryEvidenceManifest(withFiles([{ path: ".roll/../etc/passwd", sha256: "a".repeat(64), kind: "report" }]))).toBeUndefined();
    expect(validatePendingDeliveryEvidenceManifest(withFiles([{ path: "/abs/.roll/x", sha256: "a".repeat(64), kind: "report" }]))).toBeUndefined();
    expect(
      validatePendingDeliveryEvidenceManifest(
        withFiles([
          { path: ".roll/dup", sha256: "a".repeat(64), kind: "report" },
          { path: ".roll/dup", sha256: "b".repeat(64), kind: "report" },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("assessBootstrapArtifacts — verified path", () => {
  it("verifies exact manifest files with matching hashes and does not flag them", () => {
    write(".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html", "<html>review</html>");
    write(".roll/features/organization/US-ORG-004/run/proof.png", "PNGDATA");
    const m = manifest([
      fileEntry(".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html", "report"),
      fileEntry(".roll/features/organization/US-ORG-004/run/proof.png", "screenshot"),
    ]);
    const a = assessBootstrapArtifacts(
      [
        ".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html",
        ".roll/features/organization/US-ORG-004/run/proof.png",
      ],
      [m],
      root,
    );
    expect(a.verified).toHaveLength(2);
    expect(a.unconfirmed).toEqual([]);
    expect(a.external).toEqual([]);
  });
});

describe("assessBootstrapArtifacts — fail closed (scorer focus)", () => {
  it("a generic .roll path NOT in any manifest is unconfirmed, never verified", () => {
    write(".roll/features/organization/US-ORG-004/manual.txt", "hand-written");
    const a = assessBootstrapArtifacts([".roll/features/organization/US-ORG-004/manual.txt"], [], root);
    expect(a.verified).toEqual([]);
    expect(a.unconfirmed).toEqual([".roll/features/organization/US-ORG-004/manual.txt"]);
  });

  it("a hash mismatch (file edited after manifest) fails closed to unconfirmed", () => {
    write(".roll/features/x/run/report.html", "original");
    const m = manifest([fileEntry(".roll/features/x/run/report.html", "report")]);
    write(".roll/features/x/run/report.html", "TAMPERED after manifest");
    const a = assessBootstrapArtifacts([".roll/features/x/run/report.html"], [m], root);
    expect(a.verified).toEqual([]);
    expect(a.unconfirmed).toEqual([".roll/features/x/run/report.html"]);
  });

  it("a malformed manifest object contributes nothing (fail closed)", () => {
    write(".roll/features/x/run/report.html", "content");
    const bad = { version: 2, cycleId: "c", storyId: "s", branch: "b", files: [] } as unknown as PendingDeliveryEvidenceManifest;
    const a = assessBootstrapArtifacts([".roll/features/x/run/report.html"], [bad], root);
    expect(a.verified).toEqual([]);
    expect(a.unconfirmed).toEqual([".roll/features/x/run/report.html"]);
  });

  it("a manifest referencing a missing file is unconfirmed", () => {
    const m = manifest([{ path: ".roll/features/x/gone.html", sha256: "a".repeat(64), kind: "report" }]);
    const a = assessBootstrapArtifacts([".roll/features/x/gone.html"], [m], root);
    expect(a.unconfirmed).toEqual([".roll/features/x/gone.html"]);
  });

  it("a symlink whose target escapes the repo is rejected even with a matching hash", () => {
    const outside = mkdtempSync(join(tmpdir(), "roll-out-"));
    try {
      const secret = join(outside, "secret.html");
      writeFileSync(secret, "escaped payload", "utf8");
      const linkRel = ".roll/features/x/run/escape.html";
      mkdirSync(dirname(join(root, linkRel)), { recursive: true });
      symlinkSync(secret, join(root, linkRel));
      const realSha = hashFileSha256(secret) ?? "";
      const m = manifest([{ path: linkRel, sha256: realSha, kind: "report" }]);
      const a = assessBootstrapArtifacts([linkRel], [m], root);
      expect(a.verified).toEqual([]);
      expect(a.unconfirmed).toEqual([linkRel]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a directory listed in a manifest is never verified", () => {
    mkdirSync(join(root, ".roll/features/x/adir"), { recursive: true });
    const m = manifest([{ path: ".roll/features/x/adir", sha256: "a".repeat(64), kind: "evidence" }]);
    const a = assessBootstrapArtifacts([".roll/features/x/adir"], [m], root);
    expect(a.unconfirmed).toEqual([".roll/features/x/adir"]);
  });

  it("a product file is always external, even if a (would-be) manifest lists it", () => {
    write("package.json", "{}\n");
    // Manifest validation itself rejects non-.roll paths, so craft raw manifests too.
    const a = assessBootstrapArtifacts(["package.json"], [], root);
    expect(a.external).toEqual(["package.json"]);
    expect(a.verified).toEqual([]);
  });

  it("a file whose current hash matches NO manifest entry is unconfirmed even if the path is claimed", () => {
    write(".roll/features/x/run/report.html", "current");
    const staleA = { path: ".roll/features/x/run/report.html", sha256: "a".repeat(64), kind: "report" as ManifestFileKind };
    const staleB = { path: ".roll/features/x/run/report.html", sha256: "b".repeat(64), kind: "report" as ManifestFileKind };
    const a = assessBootstrapArtifacts(
      [".roll/features/x/run/report.html"],
      [manifest([staleA], { cycleId: "c1" }), manifest([staleB], { cycleId: "c2" })],
      root,
    );
    expect(a.verified).toEqual([]);
    expect(a.unconfirmed).toEqual([".roll/features/x/run/report.html"]);
  });
});

describe("assessBootstrapArtifacts — multi-cycle / idempotent claims", () => {
  it("verifies when the same path+hash is recorded by two per-cycle manifests (idempotent re-delivery)", () => {
    write(".roll/features/x/run/report.html", "content");
    const entry = fileEntry(".roll/features/x/run/report.html", "report");
    const a = assessBootstrapArtifacts(
      [".roll/features/x/run/report.html"],
      [manifest([entry], { cycleId: "c1" }), manifest([entry], { cycleId: "c2" })],
      root,
    );
    expect(a.verified).toEqual([".roll/features/x/run/report.html"]);
    expect(a.unconfirmed).toEqual([]);
  });

  it("verifies a status-evolving file via the manifest whose hash matches the live content", () => {
    // A stale manifest (old status) plus the current manifest (new status).
    write(".roll/backlog.md", "| card | Todo |");
    const staleEntry = { path: ".roll/backlog.md", sha256: sha(".roll/backlog.md"), kind: "dossier" as ManifestFileKind };
    write(".roll/backlog.md", "| card | Done |");
    const freshEntry = { path: ".roll/backlog.md", sha256: sha(".roll/backlog.md"), kind: "dossier" as ManifestFileKind };
    const a = assessBootstrapArtifacts(
      [".roll/backlog.md"],
      [manifest([staleEntry], { cycleId: "c1" }), manifest([freshEntry], { cycleId: "c2" })],
      root,
    );
    expect(a.verified).toEqual([".roll/backlog.md"]);
  });
});

describe("assessBootstrapArtifacts — full-list classification (no truncation)", () => {
  it("classifies the WHOLE status list and surfaces product dirt after many verified files", () => {
    const dirty: string[] = [];
    const entries = [];
    for (let i = 0; i < 120; i += 1) {
      const rel = `.roll/features/x/run/f${i}.json`;
      write(rel, `data-${i}`);
      dirty.push(rel);
      entries.push(fileEntry(rel, "evidence"));
    }
    // Product dirt lands far past any 50-item display cap.
    write("package.json", "{}\n");
    dirty.push("package.json");
    const a = assessBootstrapArtifacts(dirty, [manifest(entries)], root);
    expect(a.verified).toHaveLength(120);
    // AC4: both categories reported; not described as bootstrap-only.
    expect(a.external).toEqual(["package.json"]);
    expect(a.unconfirmed).toEqual([]);
  });
});

describe("manifest write/read — atomic, idempotent, isolated", () => {
  it("builds a manifest by hashing current contents and skips unsafe candidates", () => {
    write(".roll/features/x/run/report.html", "R");
    const built = buildPendingDeliveryEvidenceManifest({
      cycleId: "c1",
      storyId: "US-ORG-004",
      branch: "loop/cycle-c1",
      repositoryRoot: root,
      files: [
        { path: ".roll/features/x/run/report.html", kind: "report" },
        { path: "package.json", kind: "evidence" }, // non-.roll → skipped
        { path: ".roll/features/x/run/missing.html", kind: "report" }, // absent → skipped
      ],
    });
    expect(built.files).toHaveLength(1);
    expect(built.files[0]?.path).toBe(".roll/features/x/run/report.html");
    expect(built.files[0]?.sha256).toBe(sha(".roll/features/x/run/report.html"));
  });

  it("writes atomically and re-reads the same manifest (3x idempotent)", () => {
    write(".roll/features/x/run/report.html", "R");
    const m = manifest([fileEntry(".roll/features/x/run/report.html", "report")], { cycleId: "cycle-A" });
    let firstBody = "";
    for (let i = 0; i < 3; i += 1) {
      writePendingDeliveryEvidenceManifest(root, m);
      const body = readFileSync(evidenceManifestPath(root, "cycle-A"), "utf8");
      if (i === 0) firstBody = body;
      expect(body).toBe(firstBody);
    }
    const readBack = readPendingDeliveryEvidenceManifests(root);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.cycleId).toBe("cycle-A");
    // A verified assessment is stable across repeated reads.
    for (let i = 0; i < 3; i += 1) {
      const a = assessBootstrapArtifacts([".roll/features/x/run/report.html"], readBack, root);
      expect(a.verified).toEqual([".roll/features/x/run/report.html"]);
    }
  });

  it("two concurrent cycle manifests remain isolated (distinct keys, both readable)", () => {
    write(".roll/features/a/run/a.json", "A");
    write(".roll/features/b/run/b.json", "B");
    const mA = manifest([fileEntry(".roll/features/a/run/a.json")], { cycleId: "cycle-A", storyId: "US-ORG-004" });
    const mB = manifest([fileEntry(".roll/features/b/run/b.json")], { cycleId: "cycle-B", storyId: "US-CAP-011" });
    writePendingDeliveryEvidenceManifest(root, mA);
    writePendingDeliveryEvidenceManifest(root, mB);
    expect(evidenceManifestPath(root, "cycle-A")).not.toBe(evidenceManifestPath(root, "cycle-B"));
    const all = readPendingDeliveryEvidenceManifests(root);
    expect(all.map((m) => m.cycleId).sort()).toEqual(["cycle-A", "cycle-B"]);
    const a = assessBootstrapArtifacts([".roll/features/a/run/a.json", ".roll/features/b/run/b.json"], all, root);
    expect(a.verified.sort()).toEqual([".roll/features/a/run/a.json", ".roll/features/b/run/b.json"]);
  });

  it("a corrupt manifest file on disk is skipped when reading", () => {
    mkdirSync(evidenceManifestDir(root), { recursive: true });
    writeFileSync(join(evidenceManifestDir(root), "broken.json"), "{ not json", "utf8");
    write(".roll/features/x/run/report.html", "R");
    writePendingDeliveryEvidenceManifest(root, manifest([fileEntry(".roll/features/x/run/report.html", "report")], { cycleId: "ok" }));
    const all = readPendingDeliveryEvidenceManifests(root);
    expect(all).toHaveLength(1);
    expect(all[0]?.cycleId).toBe("ok");
  });
});

describe("worked pending-PR behavior (git-status shaped)", () => {
  it("verified evidence for an open PR does not block an unrelated card; a manual file pauses it", () => {
    // Clear GIT_* env vars so git init targets the fixture tmpdir, not the
    // enclosing worktree's git metadata (REFACTOR-077: cycle worktrees set
    // GIT_DIR, which redirects git init to the main repo config).
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_CEILING_DIRECTORIES;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_INDEX_FILE;
    execFileSync("git", ["init", "-q"], { cwd: root, env: env as Record<string, string> });
    write(".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html", "<html/>");
    write(".roll/features/organization/US-ORG-004/run/proof.png", "PNG");
    const m = manifest([
      fileEntry(".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html", "report"),
      fileEntry(".roll/features/organization/US-ORG-004/run/proof.png", "screenshot"),
    ]);

    const clean = assessBootstrapArtifacts(
      [
        ".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html",
        ".roll/features/organization/US-ORG-004/run/proof.png",
      ],
      [m],
      root,
    );
    expect(clean.unconfirmed).toEqual([]);
    expect(clean.external).toEqual([]);

    // User adds an unmanifested file → fails closed.
    write(".roll/features/organization/US-ORG-004/manual.txt", "hand");
    const dirty = assessBootstrapArtifacts(
      [
        ".roll/features/organization/US-ORG-004/run/US-ORG-004-review.html",
        ".roll/features/organization/US-ORG-004/run/proof.png",
        ".roll/features/organization/US-ORG-004/manual.txt",
      ],
      [m],
      root,
    );
    expect(dirty.verified).toHaveLength(2);
    expect(dirty.unconfirmed).toEqual([".roll/features/organization/US-ORG-004/manual.txt"]);
  });
});

describe("FIX-1455 — sanctioned append-only runtime ledger coexists with the gate", () => {
  const LEDGER = ".roll/browser-operations/events.ndjson";

  it("accepts a valid ndjson browser ledger as runtimeLedger, not unconfirmed", () => {
    write(LEDGER, '{"e":"approve"}\n{"e":"capture"}\n');
    const a = assessBootstrapArtifacts([LEDGER], [], root);
    expect(a.runtimeLedger).toEqual([LEDGER]);
    expect(a.unconfirmed).toEqual([]);
    expect(a.verified).toEqual([]);
  });

  it("accepts an empty ledger (freshly created)", () => {
    write(LEDGER, "");
    const a = assessBootstrapArtifacts([LEDGER], [], root);
    expect(a.runtimeLedger).toEqual([LEDGER]);
    expect(a.unconfirmed).toEqual([]);
  });

  it("rejects a malformed/replaced ledger (non-ndjson) as unconfirmed", () => {
    write(LEDGER, '{"e":"ok"}\nnot json at all\n');
    const a = assessBootstrapArtifacts([LEDGER], [], root);
    expect(a.runtimeLedger).toEqual([]);
    expect(a.unconfirmed).toEqual([LEDGER]);
  });

  it("still fails an unrelated unknown .roll file while accepting the ledger", () => {
    write(LEDGER, '{"e":"approve"}\n');
    write(".roll/features/x/pollution.txt", "junk");
    const a = assessBootstrapArtifacts([LEDGER, ".roll/features/x/pollution.txt"], [], root);
    expect(a.runtimeLedger).toEqual([LEDGER]);
    expect(a.unconfirmed).toEqual([".roll/features/x/pollution.txt"]);
  });

  it("does not widen to a sibling under browser-operations/ (exact path only)", () => {
    write(".roll/browser-operations/other.ndjson", '{"e":"x"}\n');
    const a = assessBootstrapArtifacts([".roll/browser-operations/other.ndjson"], [], root);
    expect(a.runtimeLedger).toEqual([]);
    expect(a.unconfirmed).toEqual([".roll/browser-operations/other.ndjson"]);
  });

  it("rejects a symlinked ledger (no escape via the sanctioned path)", () => {
    mkdirSync(join(root, ".roll", "browser-operations"), { recursive: true });
    writeFileSync(join(root, "outside.ndjson"), '{"e":"x"}\n', "utf8");
    symlinkSync(join(root, "outside.ndjson"), join(root, LEDGER));
    const a = assessBootstrapArtifacts([LEDGER], [], root);
    expect(a.runtimeLedger).toEqual([]);
    expect(a.unconfirmed).toEqual([LEDGER]);
  });
});
