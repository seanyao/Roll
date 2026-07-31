# Self-hosted CI Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the required `test-ts` CI job on BIPO's self-hosted APE runner pool.

**Architecture:** Keep the existing CI job and every build/test step intact. Replace only its GitHub-hosted runner selector with the same three-label selector used by ERP Requirement Service.

**Tech Stack:** GitHub Actions YAML, Ruby/Psych YAML parser, Git

## Global Constraints

- Change only `.github/workflows/ci.yml` as implementation; this plan is the
  sole supporting artifact.
- Set `jobs.test-ts.runs-on` to `[self-hosted, linux, ape]`.
- Keep Node.js 22 and the repository's `pnpm@11.1.3` package-manager selection.
- Keep all workflow triggers, permissions, concurrency settings, timeouts, and job steps unchanged.
- Do not change any other workflow.

---

### Task 1: Route the TypeScript CI Gate to the APE Runner Pool

**Files:**
- Modify: `.github/workflows/ci.yml:26`
- Reference: `docs/superpowers/specs/2026-07-31-self-hosted-ci-runner-design.md`

**Interfaces:**
- Consumes: GitHub Actions runner labels `self-hosted`, `linux`, and `ape`
- Produces: `jobs.test-ts.runs-on` as the ordered YAML sequence `[self-hosted, linux, ape]`

- [ ] **Step 1: Run the selector assertion and verify the current workflow fails it**

```bash
ruby -e 'require "yaml"; actual = YAML.load_file(".github/workflows/ci.yml").fetch("jobs").fetch("test-ts").fetch("runs-on"); expected = ["self-hosted", "linux", "ape"]; abort "expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected'
```

Expected: command exits non-zero with
`expected ["self-hosted", "linux", "ape"], got "ubuntu-latest"`.

- [ ] **Step 2: Apply the minimal workflow change**

Replace:

```yaml
runs-on: ubuntu-latest
```

with:

```yaml
runs-on: [self-hosted, linux, ape]
```

- [ ] **Step 3: Re-run the selector assertion**

```bash
ruby -e 'require "yaml"; actual = YAML.load_file(".github/workflows/ci.yml").fetch("jobs").fetch("test-ts").fetch("runs-on"); expected = ["self-hosted", "linux", "ape"]; abort "expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected'
```

Expected: command exits zero with no output.

- [ ] **Step 4: Verify YAML parsing and diff hygiene**

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml")'
git diff --check
git diff -- .github/workflows/ci.yml
```

Expected: both validation commands exit zero, and the workflow diff contains
exactly one changed line: the `runs-on` selector.

- [ ] **Step 5: Commit the implementation**

```bash
git add .github/workflows/ci.yml docs/superpowers/plans/2026-07-31-self-hosted-ci-runner.md
git commit -m "ci: use self-hosted APE runner"
```

Expected: one commit containing the implementation plan and the single-line
workflow change.
