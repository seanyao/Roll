import { afterAll } from "vitest";

// Vitest reuses worker processes across test files. A number of CLI tests must
// exercise commands that intentionally read or mutate process-wide state, so a
// successful test can otherwise change the environment seen by an unrelated
// file scheduled later on the same worker. Restore the worker's launch state
// after every case to keep package-root, Workspace, agent-routing, and Git
// authority deterministic under the complete parallel suite. Restore only at
// file teardown because some legacy suites intentionally establish fixtures in
// beforeAll for all cases in that file.
interface WorkerLaunchState {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

const stateKey = Symbol.for("roll.cli.vitest.worker-launch-state");
const workerProcess = process as NodeJS.Process & { [stateKey]?: WorkerLaunchState };
workerProcess[stateKey] ??= { cwd: process.cwd(), env: { ...process.env } };
const launchState = workerProcess[stateKey];

afterAll(() => {
  if (process.cwd() !== launchState.cwd) process.chdir(launchState.cwd);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, launchState.env);
});
