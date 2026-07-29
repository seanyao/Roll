import type { JsonSchema } from "@roll/spec";

const STRING: JsonSchema = { type: "string" };
const NON_EMPTY_STRING: JsonSchema = { type: "string", minLength: 1 };
const BOOLEAN: JsonSchema = { type: "boolean" };
const NUMBER: JsonSchema = { type: "number" };
const INTEGER: JsonSchema = { type: "integer" };
const NULLABLE_STATUS_CODE: JsonSchema = { type: ["number", "null"] };

export function objectSchema(properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function toolResultSchema(output: JsonSchema): JsonSchema {
  const meta = objectSchema(
    {
      invocationId: STRING,
      toolId: STRING,
      caller: { type: "object", additionalProperties: true },
      startedAt: NUMBER,
      endedAt: NUMBER,
      durationMs: NUMBER,
      attempt: INTEGER,
      correlation: objectSchema({ workspaceId: NON_EMPTY_STRING, storyId: NON_EMPTY_STRING, repoId: NON_EMPTY_STRING }, ["workspaceId"]),
    },
    ["invocationId", "toolId", "caller", "startedAt", "endedAt", "durationMs"],
  );
  const warnings: JsonSchema = { type: "array", items: STRING };
  const error = objectSchema(
    {
      code: {
        type: "string",
        enum: [
          "not_found",
          "init_failed",
          "policy_denied",
          "budget_exhausted",
          "sandbox_denied",
          "timeout",
          "adapter_error",
          "invalid_input",
          "missing_execution_context",
          "invalid_execution_context",
          "unknown",
        ],
      },
      message: STRING,
      retryable: BOOLEAN,
      detail: true,
    },
    ["code", "message", "retryable"],
  );
  return {
    oneOf: [
      objectSchema({ ok: { const: true }, output, meta, warnings }, ["ok", "output", "meta"]),
      objectSchema({ ok: { const: false }, error, meta, warnings }, ["ok", "error", "meta"]),
    ],
  };
}

export const bashInputSchema = objectSchema(
  {
    command: NON_EMPTY_STRING,
    args: { type: "array", items: STRING },
    cwd: STRING,
    env: { type: "object", additionalProperties: STRING },
  },
  ["command"],
);

export const bashOutputSchema = toolResultSchema(objectSchema({ exitCode: INTEGER, stdout: STRING, stderr: STRING, timedOut: BOOLEAN }, ["exitCode", "stdout", "stderr", "timedOut"]));

const viewport = objectSchema({ width: INTEGER, height: INTEGER }, ["width", "height"]);
const browserBase = { url: NON_EMPTY_STRING, waitFor: STRING };
const browserPageOutput = { finalUrl: STRING, statusCode: NULLABLE_STATUS_CODE };

export const browserScreenshotInputSchema = objectSchema({ ...browserBase, viewport, screenshotPath: STRING }, ["url"]);
export const browserConsoleInputSchema = objectSchema(browserBase, ["url"]);
export const browserDomQueryInputSchema = objectSchema({ ...browserBase, selector: NON_EMPTY_STRING }, ["url", "selector"]);
export const browserScreenshotOutputSchema = toolResultSchema(objectSchema({ screenshotPath: STRING, ...browserPageOutput }, ["screenshotPath", "finalUrl", "statusCode"]));
export const browserConsoleOutputSchema = toolResultSchema(
  objectSchema(
    {
      consoleLogs: { type: "array", items: objectSchema({ level: STRING, text: STRING, ts: NUMBER }, ["level", "text", "ts"]) },
      ...browserPageOutput,
    },
    ["consoleLogs", "finalUrl", "statusCode"],
  ),
);
export const browserDomQueryOutputSchema = toolResultSchema(objectSchema({ domResults: { type: "array", items: STRING }, ...browserPageOutput }, ["domResults", "finalUrl", "statusCode"]));

export const fsStatInputSchema = objectSchema({ path: NON_EMPTY_STRING }, ["path"]);
export const fsReadInputSchema = objectSchema({ path: NON_EMPTY_STRING, offset: INTEGER, limit: INTEGER }, ["path"]);
export const fsWriteInputSchema = objectSchema({ path: NON_EMPTY_STRING, content: STRING }, ["path", "content"]);
export const fsStatOutputSchema = toolResultSchema(objectSchema({ exists: BOOLEAN, size: NUMBER }, ["exists", "size"]));
export const fsReadOutputSchema = toolResultSchema(objectSchema({ content: STRING, totalLines: INTEGER }, ["content", "totalLines"]));
export const fsWriteOutputSchema = toolResultSchema(objectSchema({ bytesWritten: NUMBER }, ["bytesWritten"]));

export const gitCommitInputSchema = objectSchema({ cwd: NON_EMPTY_STRING, message: NON_EMPTY_STRING, allowEmpty: BOOLEAN }, ["cwd", "message"]);
export const gitStatusInputSchema = objectSchema({ cwd: NON_EMPTY_STRING }, ["cwd"]);
export const gitPushInputSchema = objectSchema({ cwd: NON_EMPTY_STRING, branch: NON_EMPTY_STRING, remote: STRING, setUpstream: BOOLEAN }, ["cwd", "branch"]);
export const gitMergeInputSchema = objectSchema({ cwd: NON_EMPTY_STRING, ref: NON_EMPTY_STRING, ffOnly: BOOLEAN, noCommit: BOOLEAN }, ["cwd", "ref"]);
const gitCommandOutput = objectSchema({ code: INTEGER, stdout: STRING, stderr: STRING }, ["code", "stdout", "stderr"]);
export const gitCommandOutputSchema = toolResultSchema(gitCommandOutput);
export const gitStatusOutputSchema = toolResultSchema(objectSchema({ code: INTEGER, stdout: STRING, stderr: STRING, clean: BOOLEAN }, ["code", "stdout", "stderr", "clean"]));

const slug = NON_EMPTY_STRING;
export const githubPrInputSchema: JsonSchema = {
  oneOf: [
    objectSchema({ action: { const: "create" }, slug, head: NON_EMPTY_STRING, title: NON_EMPTY_STRING, body: STRING, base: STRING }, ["action", "slug", "head", "title", "body"]),
    objectSchema({ action: { const: "status" }, slug, ref: NON_EMPTY_STRING }, ["action", "slug", "ref"]),
    objectSchema({ action: { const: "merge" }, slug, ref: NON_EMPTY_STRING, mode: { type: "string", enum: ["plain", "auto", "admin"] } }, ["action", "slug", "ref"]),
  ],
};
export const githubCiInputSchema: JsonSchema = {
  oneOf: [
    objectSchema({ action: { const: "status" }, slug, commit: NON_EMPTY_STRING }, ["action", "slug", "commit"]),
    objectSchema({ action: { const: "rerun" }, slug, runId: NON_EMPTY_STRING }, ["action", "slug", "runId"]),
  ],
};
const ghCommandOutput = objectSchema({ code: INTEGER, stdout: STRING, stderr: STRING }, ["code", "stdout", "stderr"]);
export const githubPrOutputSchema = toolResultSchema({
  oneOf: [
    objectSchema({ prUrl: STRING, prNumber: STRING }, ["prUrl", "prNumber"]),
    objectSchema({ state: STRING }, ["state"]),
    ghCommandOutput,
  ],
});
export const githubCiOutputSchema = toolResultSchema(
  objectSchema(
    {
      state: { type: "string", enum: ["pass", "fail", "pending"] },
      runs: { type: "array", items: objectSchema({ status: STRING, conclusion: { type: ["string", "null"] } }) },
    },
    ["state", "runs"],
  ),
);

export const networkInputSchema = objectSchema(
  {
    url: NON_EMPTY_STRING,
    method: STRING,
    headers: { type: "object", additionalProperties: STRING },
    body: STRING,
    timeoutMs: INTEGER,
  },
  ["url"],
);
export const networkOutputSchema = toolResultSchema(objectSchema({ statusCode: INTEGER, headers: { type: "object", additionalProperties: STRING }, body: STRING, durationMs: NUMBER }, ["statusCode", "headers", "body", "durationMs"]));

export const mcpInputSchema = objectSchema(
  {
    serverName: NON_EMPTY_STRING,
    toolName: NON_EMPTY_STRING,
    arguments: { type: "object", additionalProperties: true },
  },
  ["serverName", "toolName"],
);
export const mcpOutputSchema = toolResultSchema(objectSchema({ content: { type: "array", items: objectSchema({ type: STRING, text: STRING }, ["type"]) } }, ["content"]));
