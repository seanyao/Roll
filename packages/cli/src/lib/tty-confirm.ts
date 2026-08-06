/**
 * @responsibility Prompts the operator for a synchronous terminal y/N confirmation.
 */
/**
 * Synchronous interactive y/N confirm — used by `release ship` (FIX-228/229)
 * and any other command that needs a blocking terminal prompt.
 *
 * The hard-won lesson (FIX-229): read the CONTROLLING TERMINAL `/dev/tty` as a
 * fresh BLOCKING file description, NOT fd 0. On Node v26 + macOS an interactive
 * stdin (fd 0) is non-blocking / Node-managed, so `readSync(0)` returns EAGAIN
 * before the typed line lands and a naive byte loop silently aborts. A freshly
 * opened `/dev/tty` blocks until the user answers; fd 0 is the piped/CI
 * fallback (EOF-terminated). EAGAIN is polled (bounded), never bailed on.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** Synchronous sleep (ms) via Atomics — polls a non-blocking fd without busy-spin. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// EAGAIN polling budget — 18000 × 10ms ≈ 3 min of patience for a non-blocking
// fd before giving up. A blocking fd (the /dev/tty path) never hits this; it
// waits on the kernel for as long as the user takes to answer.
const EAGAIN_MAX_WAITS = 18_000;

/** One-byte reader: returns bytes read (0 = EOF), throws on error (e.g. EAGAIN). */
export type ByteReader = (fd: number, buf: Buffer) => number;
const defaultByteReader: ByteReader = (fd, buf) => readSync(fd, buf, 0, 1, null);

/**
 * Read one line from a fd synchronously, stopping at the FIRST newline or EOF.
 * An EAGAIN sleeps briefly and retries (bounded) so a non-blocking fd waits for
 * the line instead of being read as empty; any other error or an exhausted
 * budget breaks. `readByte` is injectable so the semantics are unit-testable.
 */
export function readLineSyncFromFd(fd: number, readByte: ByteReader = defaultByteReader): string {
  const byte = Buffer.alloc(1);
  let line = "";
  let eagainWaits = 0;
  for (let i = 0; i < 1_000_000; i++) {
    let n: number;
    try {
      n = readByte(fd, byte);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN" && eagainWaits < EAGAIN_MAX_WAITS) {
        eagainWaits++;
        sleepSync(10);
        continue; // data not ready yet on a non-blocking fd — wait, don't bail
      }
      break; // other error, or polling budget exhausted
    }
    if (n === 0) break; // EOF (piped stdin closed)
    const ch = byte.toString("utf8");
    if (ch === "\n") break; // end of an interactive line
    if (ch === "\r") continue;
    line += ch;
  }
  return line;
}

/**
 * Read one line from the controlling terminal `/dev/tty` (blocking), falling
 * back to fd 0 when there is no tty (CI / piped). Both seams are injectable so
 * tests never read the runner's real stdin (which can block/hang).
 */
export function readConfirmLine(
  openTty: () => number = () => openSync("/dev/tty", "r"),
  fallbackFd = 0,
): string {
  let fd = fallbackFd;
  let opened = false;
  try {
    fd = openTty();
    opened = true;
  } catch {
    fd = fallbackFd; // no /dev/tty — read piped stdin instead
  }
  try {
    return readLineSyncFromFd(fd);
  } finally {
    if (opened) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** True iff the answer is an affirmative y/yes (case-insensitive, trimmed). */
export function isAffirmative(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

/**
 * Prompt + read a y/N answer interactively. `write` emits the prompt (caller
 * chooses stdout/stderr to match the bash oracle). `read` resolves the answer
 * line (default: the /dev/tty reader). Returns true only on y/yes.
 */
export function confirmYesNo(
  prompt: string,
  write: (s: string) => void,
  read: () => string = () => readConfirmLine(),
): boolean {
  write(prompt);
  try {
    return isAffirmative(read());
  } catch {
    return false;
  }
}
