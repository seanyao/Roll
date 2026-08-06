/**
 * @responsibility Probes screen-lock state for the machine.
 */
/**
 * FIX-1268a — Screen-lock probe primitive.
 *
 * Reads macOS `ioreg -n Root -d1 -a` JSON output and checks
 * `IOConsoleLocked`. Injectable so the picker and tests can
 * substitute a stub; non-macOS platforms always return `false`
 * (the console is never locked in CI / Linux).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable probe contract: resolve to `true` when the console is locked. */
export type ScreenLockProbe = () => Promise<boolean>;

/** Raw macOS probe — runs `ioreg`, parses JSON, reads IOConsoleLocked. */
async function macOSScreenLocked(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-n", "Root", "-d1", "-a"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    if (!stdout || stdout.trim() === "") return false;
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    const root = parsed[0];
    // IOConsoleLocked is 1 (locked) or 0 (unlocked / absent).
    // Some macOS versions omit the key entirely when unlocked.
    return root?.IOConsoleLocked === 1;
  } catch {
    // ioreg missing, JSON parse failure, timeout — not locked.
    return false;
  }
}

/**
 * Default screen-lock probe: macOS calls `ioreg`; non-macOS always `false`.
 * This is the production probe. Tests inject their own.
 */
export const isScreenLocked: ScreenLockProbe = async () => {
  if (process.platform !== "darwin") return false;
  return macOSScreenLocked();
};
