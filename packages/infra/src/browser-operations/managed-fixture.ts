/**
 * @responsibility Provides managed-lane fixture seams with a fake target.
 */
/**
 * US-BROW-004c — Managed-lane fixture seams (fake target).
 *
 * A deterministic, dependency-free set of {@link ManagedChromeAdapterDeps} that
 * drive the real US-BROW-004b {@link ManagedChromeAdapter} against a *fake*
 * target page. No real Chrome, no owner profile, no network: the launcher
 * returns a fake process, the transport returns an in-memory CDP session, and
 * the file-system seam is a `Map`. This is what makes the managed lane provable
 * end-to-end (CLI → run service → adapter → terminal result) without hardware.
 *
 * The fixture never touches the owner's Chrome profile — every run gets a fresh
 * in-memory temp profile via the fake `mkdtemp`, matching the managed-lane
 * invariant that owner state can never enter the profile.
 */
import type {
  AdapterFs,
  CdpSession,
  CdpTransportFactory,
  ChromeLauncher,
  ChromeProcess,
  ManagedChromeAdapterDeps,
} from "./managed-chrome-adapter.js";

/** A categorized failure the fixture can inject to prove pass-through (AC2). */
export type ManagedFixtureFailure = "timeout" | "crash" | "devtools-error";

export interface ManagedFixtureOptions {
  /** The fake target URL the page starts on. */
  targetUrl: string;
  /** Optional final URL after a simulated redirect (for redirect-denial proofs). */
  redirectTo?: string;
  /** DOM textContent nodes returned for a `snapshot` action. */
  domNodes?: string[];
  /** Fake base64 screenshot bytes returned for a `screenshot` action. */
  screenshotBase64?: string;
  /** Inject a categorized diagnostic failure instead of a clean pass. */
  failure?: ManagedFixtureFailure;
  /** Make performance profile collection fail, to prove graceful degradation (US-BROW-012). */
  performanceFailure?: boolean;
}

/** Records what the fixture observed, for test assertions. */
export interface ManagedFixtureRecorder {
  launched: boolean;
  profileDirs: string[];
  removedDirs: string[];
  cdpMethods: string[];
  /** Whether device emulation was applied (US-BROW-014). */
  deviceEmulated: boolean;
  /** The emulation parameters that were sent, if any. */
  emulationParams?: Record<string, unknown>;
  /** Whether the performance profile was collected (US-BROW-012). */
  performanceCollected: boolean;
}

/** A fake Chrome process — no OS process is ever spawned. */
class FakeChromeProcess implements ChromeProcess {
  readonly pid = 424242;
  private readonly onCrash: () => void;
  constructor(onCrash: () => void) {
    this.onCrash = onCrash;
  }
  async kill(): Promise<void> {
    this.onCrash();
  }
}

class FakeChromeLauncher implements ChromeLauncher {
  constructor(private readonly recorder: ManagedFixtureRecorder) {}
  async launch(options: { profileDir: string; remoteDebuggingPort: number }): Promise<ChromeProcess> {
    this.recorder.launched = true;
    this.recorder.profileDirs.push(options.profileDir);
    return new FakeChromeProcess(() => {});
  }
}

/**
 * An in-memory CDP session that simulates a single fake page. It understands
 * exactly the CDP methods the managed adapter sends and nothing else — there is
 * no arbitrary script evaluation surface.
 */
class FakeCdpSession implements CdpSession {
  private currentUrl: string;
  constructor(
    private readonly options: ManagedFixtureOptions,
    private readonly recorder: ManagedFixtureRecorder,
  ) {
    this.currentUrl = options.targetUrl;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.recorder.cdpMethods.push(method);

    // Timeout: hang forever so the adapter's withTimeout fires (category=timeout).
    if (this.options.failure === "timeout" && method === "Runtime.evaluate") {
      return new Promise<unknown>(() => {
        /* never resolves */
      });
    }
    // Crash: reject with a NON-Error so it classifies as `crash`, not devtools-error.
    if (this.options.failure === "crash" && method === "Runtime.evaluate") {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      return Promise.reject("fixture: simulated renderer crash");
    }
    // DevTools error: reject with a real Error (category=devtools-error).
    if (this.options.failure === "devtools-error" && method === "Runtime.evaluate") {
      throw new Error("fixture: simulated DevTools protocol error");
    }

    // Performance diagnostic profile (US-BROW-012): local, numeric-only metrics.
    if (method === "Performance.enable") {
      return {};
    }
    if (method === "Performance.getMetrics") {
      if (this.options.performanceFailure === true) {
        throw new Error("fixture: simulated Performance.getMetrics failure");
      }
      this.recorder.performanceCollected = true;
      // A mix of allowlisted numeric metrics plus entries the summarizer MUST
      // drop: a non-allowlisted counter and a URL-bearing name (data-min proof).
      return {
        metrics: [
          { name: "LayoutDuration", value: 1.2345678 },
          { name: "ScriptDuration", value: 3.14159 },
          { name: "TaskDuration", value: 5.5 },
          { name: "Nodes", value: 128 },
          { name: "JSHeapUsedSize", value: 10485760 },
          { name: "NavigationUrl", value: "https://crux.example.test/upload" },
          { name: "NotAllowedCounter", value: 999 },
        ],
      };
    }

    // Device emulation (US-BROW-014): record and acknowledge.
    if (method === "Emulation.setDeviceMetricsOverride") {
      this.recorder.deviceEmulated = true;
      this.recorder.emulationParams = params ?? {};
      return {};
    }
    if (method === "Network.setUserAgentOverride") {
      this.recorder.emulationParams = {
        ...(this.recorder.emulationParams ?? {}),
        userAgent: (params as Record<string, unknown>)?.["userAgent"],
      };
      return {};
    }

    switch (method) {
      case "Runtime.enable":
      case "Page.enable":
        return {};
      case "Page.navigate": {
        const requested = typeof params?.["url"] === "string" ? (params["url"] as string) : this.currentUrl;
        // A redirect lands the page on `redirectTo` instead of the requested URL.
        this.currentUrl = this.options.redirectTo ?? requested;
        return { frameId: "fixture-frame" };
      }
      case "Runtime.evaluate":
        return this.evaluate(String(params?.["expression"] ?? ""));
      case "Page.captureScreenshot":
        return { data: this.options.screenshotBase64 ?? "ZmFrZS1zY3JlZW5zaG90" };
      default:
        return {};
    }
  }

  private evaluate(expression: string): unknown {
    if (expression.includes("window.location.href")) {
      return { result: { value: this.currentUrl } };
    }
    if (expression.includes("querySelectorAll")) {
      return { result: { value: this.options.domNodes ?? ["fixture-node"] } };
    }
    if (expression.includes("__rollMessages")) {
      return { result: { value: JSON.stringify(["fixture console message"]) } };
    }
    if (expression.includes("__rollNetworkRequests")) {
      return { result: { value: JSON.stringify(["https://fixture/asset.js"]) } };
    }
    return { result: { value: "" } };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

class FakeCdpTransportFactory implements CdpTransportFactory {
  constructor(
    private readonly options: ManagedFixtureOptions,
    private readonly recorder: ManagedFixtureRecorder,
  ) {}
  async create(): Promise<CdpSession> {
    return new FakeCdpSession(this.options, this.recorder);
  }
}

function fakeAdapterFs(recorder: ManagedFixtureRecorder): AdapterFs {
  const files = new Map<string, string | Buffer>();
  let counter = 0;
  return {
    async mkdtemp(prefix: string): Promise<string> {
      const dir = `${prefix}fixture-${counter++}`;
      return dir;
    },
    async mkdir(): Promise<string | undefined> {
      return undefined;
    },
    async writeFile(path: string, data: string | Buffer): Promise<void> {
      files.set(path, data);
    },
    async rm(path: string): Promise<void> {
      recorder.removedDirs.push(path);
      files.delete(path);
    },
  };
}

/**
 * Build a full set of managed-adapter dependencies wired to a fake target.
 *
 * Returns both the `deps` (to construct a {@link ManagedChromeAdapter}) and a
 * `recorder` capturing what the fixture observed, so callers and tests can
 * assert the profile lifecycle and CDP interaction without a real browser.
 */
export function createManagedFixtureDeps(
  options: ManagedFixtureOptions,
): { deps: ManagedChromeAdapterDeps; recorder: ManagedFixtureRecorder } {
  const recorder: ManagedFixtureRecorder = {
    launched: false,
    profileDirs: [],
    removedDirs: [],
    cdpMethods: [],
    deviceEmulated: false,
    performanceCollected: false,
  };
  let idCounter = 0;
  const deps: ManagedChromeAdapterDeps = {
    launcher: new FakeChromeLauncher(recorder),
    transportFactory: new FakeCdpTransportFactory(options, recorder),
    fs: fakeAdapterFs(recorder),
    now: () => "2026-07-15T00:00:00.000Z",
    randomId: () => `fixture-id-${idCounter++}`,
    remoteDebuggingHost: "127.0.0.1",
    diagnosticsDir: "/fixture/diagnostics",
  };
  return { deps, recorder };
}
