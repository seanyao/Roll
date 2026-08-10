import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  installRollCapture,
  renderRollCaptureInstallResult,
  renderRollCaptureUpdatePrompt,
  renderRollCaptureUpdateResult,
  runRollCapturePostinstall,
  updateRollCapture,
  type RollCaptureInstallDeps,
  rollCaptureInstallInternals,
} from "../src/lib/roll-capture-install.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `roll-capture-install-${tag}-`));
  dirs.push(dir);
  return dir;
}

function deps(overrides: Partial<RollCaptureInstallDeps> = {}): RollCaptureInstallDeps {
  const home = tmp("home");
  return {
    platform: "darwin",
    env: {},
    home,
    hasAquaGUI: true,
    // FIX-1242: the install detector also probes the hardcoded system
    // `/Applications/Roll Capture.app`. Default the test's existence check to see
    // ONLY sandbox paths (the tmp home + any tmp dir the test itself creates),
    // never the real machine's `/Applications` — otherwise a dev box where Roll
    // Capture IS installed reads "already installed" and false-fails the
    // not-installed scenarios (green in CI, red locally). Tests that assert on a
    // specific real-ish location still override `exists` explicitly.
    exists: (p: string) => !p.startsWith("/Applications/") && existsSync(p),
    execFile: () => ({ code: 0, stdout: "", stderr: "" }),
    fetchLatestRelease: async () => ({
      tagName: "v0.2.0",
      assets: [
        {
          name: "Roll-Capture.app.zip",
          size: 4,
          apiUrl: "https://api.github.com/repos/seanyao/roll-capture/releases/assets/1",
          browserDownloadUrl: "https://example.test/Roll-Capture.app.zip",
        },
      ],
    }),
    downloadAsset: async () => Buffer.from("ZIP!"),
    extractZip: async (_zipPath, destination) => {
      const app = join(destination, "Roll Capture.app");
      const macos = join(app, "Contents", "MacOS");
      mkdirSync(macos, { recursive: true });
      writeFileSync(join(macos, "Roll Capture"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(app, "Contents", "Info.plist"), plist("0.2.0"));
      return { ok: true };
    },
    ...overrides,
  };
}

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`;
}

function installedApp(home: string, version = "0.1.0"): string {
  const app = join(home, "Applications", "Roll Capture.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), plist(version));
  return app;
}

describe("US-PHYSICAL-005 Roll Capture installer", () => {
  it("downloads the latest release asset and installs Roll Capture.app into ~/Applications", async () => {
    const calls: string[] = [];
    const home = tmp("success-home");
    const result = await installRollCapture(
      deps({
        home,
        downloadAsset: async (asset) => {
          calls.push(asset.browserDownloadUrl);
          return Buffer.from("ZIP!");
        },
      }),
    );

    const appPath = join(home, "Applications", "Roll Capture.app");
    expect(result.status).toBe("installed");
    expect(result.appPath).toBe(appPath);
    expect(calls).toEqual(["https://example.test/Roll-Capture.app.zip"]);
    expect(statSync(join(appPath, "Contents", "MacOS", "Roll Capture")).mode & 0o111).not.toBe(0);
    expect(renderRollCaptureInstallResult(result, "en")).toContain("open it once and grant Screen Recording permission");
  });

  it("invalidates stale Roll Capture readiness cache after a successful install", async () => {
    const home = tmp("cache-home");
    const cachePath = join(home, ".roll", "cache", "roll-capture-readiness.json");
    mkdirSync(join(home, ".roll", "cache"), { recursive: true });
    writeFileSync(cachePath, '{"readiness":{"status":"degraded"}}\n');

    const result = await installRollCapture(deps({ home }));

    expect(result.status).toBe("installed");
    expect(existsSync(cachePath)).toBe(false);
  });

  it("skips an existing app without downloading and reports an optional update hint", async () => {
    const home = tmp("existing-home");
    const appPath = join(home, "Applications", "Roll Capture.app");
    mkdirSync(join(appPath, "Contents"), { recursive: true });
    writeFileSync(join(appPath, "Contents", "Info.plist"), plist("0.1.0"));
    let downloads = 0;

    const result = await installRollCapture(
      deps({
        home,
        downloadAsset: async () => {
          downloads += 1;
          return Buffer.from("ZIP!");
        },
      }),
    );

    expect(result.status).toBe("already-installed");
    expect(downloads).toBe(0);
    expect(renderRollCaptureInstallResult(result, "en")).toContain("newer release v0.2.0 is available");
  });

  it("ignores Spotlight hits outside canonical install locations when deciding whether to install", async () => {
    const home = tmp("spotlight-build-home");
    const buildArtifact = join(home, "src", "roll-capture", "build", "Roll Capture.app");
    mkdirSync(join(buildArtifact, "Contents"), { recursive: true });
    writeFileSync(join(buildArtifact, "Contents", "Info.plist"), plist("0.1.0"));
    let downloads = 0;

    const result = await installRollCapture(
      deps({
        home,
        // FIX-1242: exclude the real system /Applications so a dev box with Roll
        // Capture installed doesn't short-circuit to "already installed".
        exists: (path) => !path.startsWith("/Applications/") && existsSync(path),
        execFile: (cmd) => {
          if (cmd === "mdfind") return { code: 0, stdout: `${buildArtifact}\n`, stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        downloadAsset: async () => {
          downloads += 1;
          return Buffer.from("ZIP!");
        },
      }),
    );

    const appPath = join(home, "Applications", "Roll Capture.app");
    expect(result.status).toBe("installed");
    expect(result.appPath).toBe(appPath);
    expect(downloads).toBe(1);
    expect(existsSync(appPath)).toBe(true);
  });

  it("falls back to manual guidance when the latest release has no app zip asset", async () => {
    const result = await installRollCapture(
      deps({
        fetchLatestRelease: async () => ({ tagName: "v0.2.0", assets: [] }),
      }),
    );

    expect(result.status).toBe("manual");
    expect(result.reason).toContain("Roll-Capture.app.zip");
    expect(renderRollCaptureInstallResult(result, "zh")).toContain("请手动安装");
  });

  it("falls back to manual guidance when download fails or the zip validation fails", async () => {
    const failedDownload = await installRollCapture(
      deps({
        downloadAsset: async () => {
          throw new Error("404");
        },
      }),
    );
    const badZip = await installRollCapture(deps({ extractZip: async () => ({ ok: false, detail: "bad zip" }) }));

    expect(failedDownload.status).toBe("manual");
    expect(failedDownload.reason).toContain("404");
    expect(badZip.status).toBe("manual");
    expect(badZip.reason).toContain("bad zip");
  });

  it("skips non-macOS, CI, headless, and explicit policy-off environments", async () => {
    await expect(installRollCapture(deps({ platform: "linux" }))).resolves.toMatchObject({ status: "skipped", reason: "non-darwin" });
    await expect(installRollCapture(deps({ env: { GITHUB_ACTIONS: "true" } }))).resolves.toMatchObject({ status: "skipped", reason: "ci" });
    await expect(installRollCapture(deps({ hasAquaGUI: false }))).resolves.toMatchObject({ status: "skipped", reason: "headless" });
    await expect(installRollCapture(deps({ env: { ROLL_SKIP_CAPTURE_INSTALL: "1" } }))).resolves.toMatchObject({ status: "skipped", reason: "disabled" });
  });

  it("postinstall never throws and returns a rendered one-line outcome", async () => {
    const lines: string[] = [];
    const status = await runRollCapturePostinstall({
      deps: deps({ env: { CI: "1" } }),
      writeLine: (line) => lines.push(line),
      lang: "en",
    });

    expect(status).toBe(0);
    expect(lines.join("\n")).toContain("skipped");
  });

  it.each([
    ["non-macOS", deps({ platform: "linux" }), "non-darwin"],
    ["CI", deps({ env: { GITHUB_ACTIONS: "true" } }), "ci"],
    ["headless", deps({ hasAquaGUI: false }), "headless"],
    ["policy-off", deps({ env: { ROLL_SKIP_CAPTURE_INSTALL: "1" } }), "disabled"],
  ])("postinstall exits 0 and prints one skipped line for %s", async (_name, installDeps, reason) => {
    const lines: string[] = [];
    const status = await runRollCapturePostinstall({
      deps: installDeps,
      writeLine: (line) => lines.push(line),
      lang: "en",
    });

    expect(status).toBe(0);
    expect(lines).toEqual([`Roll Capture.app install skipped (${reason}).`]);
  });

  it("postinstall exits 0 and renders manual guidance when download lookup fails", async () => {
    const lines: string[] = [];
    const status = await runRollCapturePostinstall({
      deps: deps({
        fetchLatestRelease: async () => {
          throw new Error("offline");
        },
      }),
      writeLine: (line) => lines.push(line),
      lang: "en",
    });

    expect(status).toBe(0);
    expect(lines).toEqual([
      "Roll Capture.app automatic install failed (release lookup failed: offline); install it manually, then open it once and grant Screen Recording permission.",
    ]);
  });

  it("rejects a size mismatch before extracting", async () => {
    const home = tmp("size-home");
    const result = await installRollCapture(
      deps({
        home,
        downloadAsset: async () => Buffer.from("too large"),
      }),
    );

    expect(result.status).toBe("manual");
    expect(result.reason).toContain("size mismatch");
    expect(existsSync(join(home, "Applications", "Roll Capture.app"))).toBe(false);
  });

  it("skips zip entries that are symbolic links instead of following them", async () => {
    const home = tmp("symlink-home");
    const outside = join(home, "outside");
    const result = await installRollCapture(
      deps({
        home,
        extractZip: async (_zipPath, destination) => {
          const realApp = join(outside, "Roll Capture.app");
          const macos = join(realApp, "Contents", "MacOS");
          mkdirSync(macos, { recursive: true });
          writeFileSync(join(macos, "Roll Capture"), "#!/bin/sh\n", { mode: 0o755 });
          symlinkSync(realApp, join(destination, "Roll Capture.app"));
          return { ok: true };
        },
      }),
    );

    expect(result.status).toBe("manual");
    expect(result.reason).toBe("zip did not contain Roll Capture.app");
    expect(lstatSync(join(home, "outside", "Roll Capture.app")).isDirectory()).toBe(true);
    expect(existsSync(join(home, "Applications", "Roll Capture.app"))).toBe(false);
  });

  it("skips automatic install when running as sudo or root", async () => {
    const rootResult = await installRollCapture(deps({ uid: 0 }));
    expect(rootResult).toMatchObject({
      status: "skipped",
      reason: "run roll setup as a regular user to install Roll Capture.app",
    });
    expect(renderRollCaptureInstallResult(rootResult, "zh")).toContain("请以普通用户运行 roll setup 安装");
    await expect(installRollCapture(deps({ env: { SUDO_USER: "sean" } }))).resolves.toMatchObject({
      status: "skipped",
      reason: "run roll setup as a regular user to install Roll Capture.app",
    });
  });

  it("restores the previous app when replacing it fails after backup", async () => {
    const home = tmp("atomic-home");
    const oldApp = join(home, "Applications", "Roll Capture.app");
    mkdirSync(join(oldApp, "Contents"), { recursive: true });
    writeFileSync(join(oldApp, "Contents", "Info.plist"), plist("0.1.0"));
    let newAppMoveSeen = false;

    const result = await installRollCapture(
      deps({
        home,
        exists: () => false,
        renamePath: (from, to) => {
          if (from.endsWith("Roll Capture.app") && to === oldApp) {
            newAppMoveSeen = true;
            throw new Error("simulated replace failure");
          }
          renamePathForTest(from, to);
        },
      }),
    );

    expect(newAppMoveSeen).toBe(true);
    expect(result.status).toBe("manual");
    expect(result.reason).toContain("simulated replace failure");
    expect(readFileSync(join(oldApp, "Contents", "Info.plist"), "utf8")).toContain("0.1.0");
    expect(existsSync(`${oldApp}.bak`)).toBe(false);
  });

  describe("US-PHYSICAL-016 explicit Capture.app update", () => {
    it("shows the installed version, candidate, and target before a declined interactive update", async () => {
      const home = tmp("update-declined");
      const app = installedApp(home);
      const prompts: string[] = [];
      let downloads = 0;
      const result = await updateRollCapture(
        {
          interactive: true,
          readLine: () => "N",
          onConfirmationRequired: (details) => prompts.push(renderRollCaptureUpdatePrompt(details, "en")),
        },
        deps({
          home,
          downloadAsset: async () => {
            downloads += 1;
            return Buffer.from("ZIP!");
          },
        }),
      );

      expect(result).toMatchObject({ status: "declined", appPath: app, installedVersion: "0.1.0", releaseTag: "v0.2.0" });
      expect(prompts.join("\n")).toContain("installed 0.1.0");
      expect(prompts.join("\n")).toContain("v0.2.0");
      expect(prompts.join("\n")).toContain(app);
      expect(downloads).toBe(0);
      expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toContain("0.1.0");
      expect(renderRollCaptureUpdateResult(result, "en")).toContain("not updated");
    });

    it("requires --yes for non-interactive updates and accepts it as explicit consent", async () => {
      const declinedHome = tmp("update-noninteractive");
      const declinedApp = installedApp(declinedHome);
      const declined = await updateRollCapture({ interactive: false }, deps({ home: declinedHome }));
      expect(declined).toMatchObject({ status: "declined" });
      expect(readFileSync(join(declinedApp, "Contents", "Info.plist"), "utf8")).toContain("0.1.0");

      const home = tmp("update-yes");
      const app = installedApp(home);
      const cachePath = join(home, ".roll", "cache", "roll-capture-readiness.json");
      mkdirSync(join(home, ".roll", "cache"), { recursive: true });
      writeFileSync(cachePath, "stale\n");
      const accepted = await updateRollCapture({ interactive: false, yes: true }, deps({ home }));
      expect(accepted).toMatchObject({ status: "updated", appPath: app, releaseTag: "v0.2.0" });
      expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toContain("0.2.0");
      expect(existsSync(cachePath)).toBe(false);
      expect(renderRollCaptureUpdateResult(accepted, "zh")).toContain("roll doctor tools");
    });

    it("does not download or prompt when the release is equal, older, malformed, or lacks the expected asset", async () => {
      const cases: Array<{ name: string; release: { tagName: string; assets: readonly { name: string; size: number; browserDownloadUrl: string }[] } }> = [
        { name: "equal", release: { tagName: "v0.1.0", assets: [] } },
        { name: "older", release: { tagName: "v0.0.9", assets: [] } },
        { name: "malformed", release: { tagName: "release-next", assets: [] } },
        { name: "missing asset", release: { tagName: "v0.2.0", assets: [] } },
      ];
      for (const testCase of cases) {
        const home = tmp(`update-${testCase.name}`);
        const app = installedApp(home);
        let prompted = false;
        let downloads = 0;
        const result = await updateRollCapture(
          { interactive: true, readLine: () => "y", onConfirmationRequired: () => { prompted = true; } },
          deps({
            home,
            fetchLatestRelease: async () => testCase.release,
            downloadAsset: async () => {
              downloads += 1;
              return Buffer.from("ZIP!");
            },
          }),
        );
        expect(["no-update", "manual"]).toContain(result.status);
        expect(prompted).toBe(false);
        expect(downloads).toBe(0);
        expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toContain("0.1.0");
      }
    });

    it("keeps the old bundle and removes the temporary extraction on bad assets and replacement failure", async () => {
      const malformedHome = tmp("update-bad-asset");
      const malformedApp = installedApp(malformedHome);
      const malformed = await updateRollCapture(
        { yes: true, interactive: false },
        deps({ home: malformedHome, extractZip: async () => ({ ok: false, detail: "bad zip" }) }),
      );
      expect(malformed).toMatchObject({ status: "manual" });
      expect(readFileSync(join(malformedApp, "Contents", "Info.plist"), "utf8")).toContain("0.1.0");
      expect(readdirSync(join(malformedHome, "Applications")).filter((name) => name.startsWith(".roll-capture-update-"))).toEqual([]);

      const home = tmp("update-rollback");
      const oldApp = installedApp(home);
      const replacement = await updateRollCapture(
        { yes: true, interactive: false },
        deps({
          home,
          renamePath: (from, to) => {
            if (from.endsWith("Roll Capture.app") && to === oldApp) throw new Error("simulated update replacement failure");
            renameSync(from, to);
          },
        }),
      );
      expect(replacement).toMatchObject({ status: "manual" });
      expect(readFileSync(join(oldApp, "Contents", "Info.plist"), "utf8")).toContain("0.1.0");
      expect(existsSync(`${oldApp}.bak`)).toBe(false);
      expect(readdirSync(join(home, "Applications")).filter((name) => name.startsWith(".roll-capture-update-"))).toEqual([]);
    });
  });

  it("default downloader succeeds anonymously without probing credentials", async () => {
    const execFile = vi.fn(() => ({ code: 0, stdout: "secret-from-gh\n", stderr: "" }));
    const calls: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
      if (String(url).endsWith("/releases/latest")) {
        return Response.json({
          tag_name: "v0.2.0",
          assets: [
            {
              name: "Roll-Capture.app.zip",
              size: 4,
              url: "https://api.github.com/repos/seanyao/roll-capture/releases/assets/1",
              browser_download_url: "https://github.com/seanyao/roll-capture/releases/download/v0.2.0/Roll-Capture.app.zip",
            },
          ],
        });
      }
      return new Response("ZIP!");
    });

    const release = await rollCaptureInstallInternals.fetchLatestRelease(1_000, {}, execFile, fetchImpl);
    const bytes = await rollCaptureInstallInternals.downloadAsset(release.assets[0], 1_000, {}, execFile, fetchImpl);

    expect(Buffer.from(bytes).toString("utf8")).toBe("ZIP!");
    expect(execFile).not.toHaveBeenCalledWith("gh", ["auth", "token"], expect.anything());
    expect(calls).toEqual([
      { url: "https://api.github.com/repos/seanyao/roll-capture/releases/latest", authorization: undefined },
      { url: "https://github.com/seanyao/roll-capture/releases/download/v0.2.0/Roll-Capture.app.zip", authorization: undefined },
    ]);
  });

  it("default downloader retries anonymous 404 with an env token and downloads private assets through the API endpoint", async () => {
    const calls: Array<{ url: string; accept?: string; authorization?: string }> = [];
    const execFile = vi.fn(() => ({ code: 0, stdout: "ghp_" + "a".repeat(36) + "\n", stderr: "" }));
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        accept: headers.get("Accept") ?? undefined,
        authorization: headers.get("Authorization") ?? undefined,
      });
      if (String(url).endsWith("/releases/latest")) {
        if (headers.get("Authorization") === null) return new Response("missing", { status: 404 });
        return Response.json({
          tag_name: "v0.2.0",
          assets: [
            {
              name: "Roll-Capture.app.zip",
              size: 4,
              url: "https://api.github.com/repos/seanyao/roll-capture/releases/assets/1",
              browser_download_url: "https://github.com/seanyao/roll-capture/releases/download/v0.2.0/Roll-Capture.app.zip",
            },
          ],
        });
      }
      if (String(url).includes("/releases/download/")) return new Response("private", { status: 404 });
      return new Response("ZIP!");
    });

    const release = await rollCaptureInstallInternals.fetchLatestRelease(1_000, { GITHUB_TOKEN: "env-secret" }, execFile, fetchImpl);
    const bytes = await rollCaptureInstallInternals.downloadAsset(
      release.assets[0],
      1_000,
      { GITHUB_TOKEN: "env-secret" },
      execFile,
      fetchImpl,
    );

    expect(Buffer.from(bytes).toString("utf8")).toBe("ZIP!");
    expect(execFile).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/seanyao/roll-capture/releases/latest",
        accept: "application/vnd.github+json",
        authorization: undefined,
      },
      {
        url: "https://api.github.com/repos/seanyao/roll-capture/releases/latest",
        accept: "application/vnd.github+json",
        authorization: "Bearer env-secret",
      },
      {
        url: "https://github.com/seanyao/roll-capture/releases/download/v0.2.0/Roll-Capture.app.zip",
        accept: undefined,
        authorization: undefined,
      },
      {
        url: "https://api.github.com/repos/seanyao/roll-capture/releases/assets/1",
        accept: "application/octet-stream",
        authorization: "Bearer env-secret",
      },
    ]);
  });

  it("default downloader exhausts anonymous, env, and gh release attempts without leaking tokens", async () => {
    const calls: Array<{ authorization?: string }> = [];
    const ghToken = "ghp_" + "b".repeat(36);
    const execFile = vi.fn(() => ({ code: 0, stdout: `${ghToken}\n`, stderr: "" }));
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push({ authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
      return new Response("private", { status: 404 });
    });

    await expect(
      rollCaptureInstallInternals.fetchLatestRelease(1_000, { GITHUB_TOKEN: "env-secret" }, execFile, fetchImpl),
    ).rejects.toThrow("GitHub release API returned 404");

    expect(execFile).toHaveBeenCalledWith("gh", ["auth", "token"], { timeoutMs: 5_000 });
    expect(calls).toEqual([{ authorization: undefined }, { authorization: "Bearer env-secret" }, { authorization: `Bearer ${ghToken}` }]);
  });

  it("discards malformed gh auth token output and keeps falling back without leaking it", async () => {
    const calls: Array<{ authorization?: string }> = [];
    const execFile = vi.fn(() => ({ code: 0, stdout: "not a token\nwith spaces\n", stderr: "" }));
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push({ authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
      return new Response("private", { status: 404 });
    });

    await expect(rollCaptureInstallInternals.fetchLatestRelease(1_000, {}, execFile, fetchImpl)).rejects.toThrow(
      "GitHub release API returned 404",
    );

    expect(execFile).toHaveBeenCalledWith("gh", ["auth", "token"], { timeoutMs: 5_000 });
    expect(calls).toEqual([{ authorization: undefined }]);
  });

  it("passes a proxy dispatcher to fetch when proxy environment variables are present", async () => {
    const dispatcher = { proxy: true };
    const calls: Array<{ dispatcher?: unknown }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
      calls.push({ dispatcher: init?.dispatcher });
      return Response.json({ tag_name: "v0.2.0", assets: [] });
    });

    await rollCaptureInstallInternals.fetchLatestRelease(
      1_000,
      { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" },
      vi.fn(),
      fetchImpl,
      () => dispatcher,
    );

    expect(calls).toEqual([{ dispatcher }]);
  });

  it("postinstall exits 0 with manual guidance after anonymous, env, and gh credential download attempts fail", async () => {
    const lines: string[] = [];
    const status = await runRollCapturePostinstall({
      deps: deps({
        fetchLatestRelease: async () => ({
          tagName: "v0.2.0",
          assets: [
            {
              name: "Roll-Capture.app.zip",
              size: 4,
              apiUrl: "https://api.github.com/repos/seanyao/roll-capture/releases/assets/1",
              browserDownloadUrl: "https://github.com/seanyao/roll-capture/releases/download/v0.2.0/Roll-Capture.app.zip",
            },
          ],
        }),
        downloadAsset: async () => {
          throw new Error("asset download returned 404");
        },
      }),
      writeLine: (line) => lines.push(line),
      lang: "en",
    });

    expect(status).toBe(0);
    expect(lines).toEqual([
      "Roll Capture.app automatic install failed (download failed: asset download returned 404); install it manually, then open it once and grant Screen Recording permission.",
    ]);
  });
});

function renamePathForTest(from: string, to: string): void {
  renameSync(from, to);
}
