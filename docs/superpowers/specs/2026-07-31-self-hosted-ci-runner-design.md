# Self-hosted CI Runner Design

## Goal

Run the required TypeScript CI job on BIPO's self-hosted APE runner pool
instead of GitHub's `ubuntu-latest` runner.

## Scope

Change only the `runs-on` selector for the `test-ts` job in
`.github/workflows/ci.yml`:

```yaml
runs-on: [self-hosted, linux, ape]
```

Keep the workflow triggers, permissions, concurrency behavior, timeout,
checkout settings, Node.js 22 baseline, pnpm 11 selection from `package.json`,
build commands, and test commands unchanged.

Other workflows, including release, site deployment, browser live checks, and
code review, are outside this change.

## Execution Flow

```text
[push / pull request / manual dispatch]
                    |
                    v
                [test-ts]
                    |
                    v
        [self-hosted + linux + ape]
                    |
                    v
       [existing build and test steps]
```

GitHub Actions will queue the job until an online runner matching all three
labels is available. A missing or offline matching runner is expected to leave
the job queued rather than silently fall back to a GitHub-hosted runner.

## Validation

- Parse `.github/workflows/ci.yml` as YAML.
- Assert that `jobs.test-ts.runs-on` equals
  `[self-hosted, linux, ape]`.
- Confirm the workflow diff contains no unrelated changes.
- Run `git diff --check`.

Actual runner assignment can only be proven by a GitHub Actions run after the
change is pushed.
