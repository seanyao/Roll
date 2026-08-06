/**
 * @responsibility Provides the default Node child-process implementation of the delivery ExecPort.
 * Default Node child-process implementation of the {@link ExecPort} the delivery
 * domain (pr.ts / tcr.ts) uses to run `gh` / git invocations.
 *
 * Like backlog/infra-default.ts (FileStore), the delivery decision logic is
 * pure: it builds command PLANs ({@link PublishStep}) and verdicts but never
 * spawns a process. An adapter executes the plan so the pure logic stays
 * unit-testable (an in-memory fake records the argv) and the integration path
 * wraps `execFileSync`.
 */
import { execFileSync } from "node:child_process";

const EXEC_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Result of running one command: captured stdout + the exit status. */
export interface ExecResult {
  /** Trimmed stdout (the oracle reads `gh`/git stdout as single values). */
  stdout: string;
  /** Process exit code (0 = success). */
  code: number;
}

/**
 * Minimal exec port used by the delivery adapter. `run` MUST NOT throw on a
 * non-zero exit — it returns the code so the adapter can mirror the oracle's
 * `|| ...` tier handling. Stdout is captured and trimmed.
 */
export interface ExecPort {
  run(tool: string, argv: readonly string[]): ExecResult;
}

/** Node-backed {@link ExecPort}: `execFileSync`, capturing stdout, never
 *  throwing on a non-zero exit (returns the status instead). */
export const nodeExecPort: ExecPort = {
  run(tool: string, argv: readonly string[]): ExecResult {
    try {
      const stdout = execFileSync(tool, [...argv], {
        encoding: "utf8",
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
      });
      return { stdout: stdout.trim(), code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; status?: number | null };
      const out = e.stdout === undefined ? "" : e.stdout.toString();
      return { stdout: out.trim(), code: typeof e.status === "number" ? e.status : 1 };
    }
  },
};
