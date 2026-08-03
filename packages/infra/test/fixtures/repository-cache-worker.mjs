import { writeFileSync } from "node:fs";
import { ensureRepositoryCache, git } from "../../dist/index.js";

const [rollHome, remote, repoId, outputPath] = process.argv.slice(2);
if (rollHome === undefined || remote === undefined || repoId === undefined || outputPath === undefined) {
  process.exitCode = 2;
} else {
  const binding = {
    schema: "roll.repository-binding/v1",
    repoId,
    alias: "primary",
    remote,
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
  try {
    const result = await ensureRepositoryCache({
      rollHome,
      binding,
      integrationRefspec: "+refs/heads/main:refs/remotes/origin/main",
      runGit: async (args, cwd, options) => {
        if (args[0] === "fetch") await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
        return git(args, cwd, options);
      },
    });
    writeFileSync(outputPath, `${JSON.stringify({ ok: true, result })}\n`, "utf8");
  } catch (error) {
    writeFileSync(outputPath, `${JSON.stringify({
      ok: false,
      error: { name: error?.name, code: error?.code, message: error?.message },
    })}\n`, "utf8");
    process.exitCode = 1;
  }
}
