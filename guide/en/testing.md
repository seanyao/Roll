# Roll — Testing Workflow

Roll enforces a test-first discipline throughout delivery:

- **TCR** (Test && Commit || Revert) — every micro-step passes tests before committing.
- **E2E Deposit** — each completed Story leaves an E2E test covering its golden path.
- **CI E2E Gate** — the deposited E2E runs on every push, blocking merges on failure.
- **proof-of-pass** — pre-commit hook physically blocks commits that haven't passed tests.

## E2E Deposit

After TCR micro-steps pass, `$roll-build` Phase 5.5 deposits an E2E test:

1. Detects your project's existing E2E infrastructure (framework, directory, naming).
2. Writes one E2E test covering the Story's critical user path.
3. Runs it — fixes via TCR if red.
4. Commits: `tcr: e2e deposit for <story-id>`.

The deposited test becomes a durable regression guard that CI replays on every
push, blocking merges on failure.

## Pre-commit Hook (proof-of-pass)

Roll's pre-commit hook blocks commits unless tests passed within the last 60 seconds
**on the exact tree being committed**:

```bash
# Proof written by test runner:
# .roll/last-test-pass  ← timestamp + tree hash

# Hook checks at commit time:
# - elapsed < 60 s
# - tree hash matches current staged tree
```

To satisfy the hook, run your tests immediately before committing. If you use TCR
(which roll-build does), this is automatic.

## CI E2E Gate

PR CI also publishes a named `doc-drift` check. It fetches `origin/main`,
compares the PR with `merge-base HEAD origin/main`, and evaluates the shared,
registry-driven verdict from [`policy/rules.yaml`](../../policy/rules.yaml).
With `gates.doc_drift: soft`, a hit is observable as an annotation and exits 0;
there is no exemption path. A missing base or invalid registry fails closed. CI
never writes `.roll` events. In this repository shape the result remains advisory
for manual GitHub UI merges: it records a result, not a trusted merge decision.

Hard doc-drift mode is not enabled. It remains blocked on a trusted owner
authorization and calibration design; a peer session, TTY, or `actor` field does
not authenticate an owner. Flipping the mode to hard is tracked as US-RULE-006,
which is on Hold: the loop must not auto-pick it, and activation requires a
trusted-owner authorization and calibration design first. If that design is
completed and the registry enables hard mode, the named check can join
Roll-driven exact-SHA merge gating alongside `test-ts`. The audit reports only
that the **registered N** rules are live, not complete repository coverage; see
the generated [responsibility maps](../../docs/maps/) for the source-derived
ownership view.
[`policy/rules-inventory.yaml`](../../policy/rules-inventory.yaml) is the audited
coverage predicate over rule-candidate files: declared roots, include patterns,
and reasoned exclusions, with every candidate classified registered or
out-of-scope. Coverage is that audited predicate plus its exclusions — never a
keyword-search completeness claim; the audit fails on unclassified candidates
and orphan anchors rather than assuming every rule is already registered.

The template CI workflow (`.github/workflows/ci.yml`) runs E2E tests as a
separate job that must pass before merge. If E2E fails:

1. Check the failing test name — it corresponds to a Story ID.
2. Run the test locally to reproduce.
3. Open a `FIX-XXX` entry in `BACKLOG.md`, or use `$roll-fix` to fix immediately.

## Failure Triage

`$roll-.qa` provides structured guidance for diagnosing test failures at each
layer of the test pyramid:

| Layer | Run command | Triage starting point |
|-------|-------------|-----------------------|
| Unit | `pnpm --filter @roll/<pkg> test` | Failing test file → function name |
| Integration | `pnpm --filter @roll/cli test` | Captured stdout/exit, fixture cwd |
| E2E | `<project E2E command>` | User path, environment |
| Smoke | `roll doctor` | Toolchain health |

## TCR Test Strategy (Phase 3.0)

Each TCR micro-step needs second-level feedback. The suite is **Vitest** across
the pnpm workspace; the gate runs only what the diff touched.

### `roll test` — run only the tests touched by the diff

```bash
roll test               # affected-only (the TCR micro-step gate); writes the test-pass proof
pnpm --filter @roll/cli exec vitest run test/<file>.test.ts   # one file
pnpm -r test            # the full suite (pre-push / CI / release)
pnpm test:cov           # full suite with v8 coverage
```

`roll test` maps the diff to affected Vitest files, runs them, and writes the
proof the commit gate checks (see below). A doc-only change has no affected
tests and exits 0. Pre-push / CI / release always run the full `pnpm -r test`.

### Runner compatibility & the conservative fallback

`roll test` resolves the gate command from the **target project** rather than
assuming one flag, so it stays compatible with the project's installed test
runner (FIX-1274):

- Roll's own wrapper keeps its `--affected` token.
- A plain Vitest project uses the version-supported `--changed` changed-test
  mode. Roll never passes `--affected` to Vitest — Vitest's CLI rejects it as an
  unknown option, which would otherwise strand the commit.
- When no safe changed mode can be verified (undetectable/too-old Vitest, a
  non-Vitest runner), or when a `--changed` run matches **zero** tests, roll
  runs the project's **full** test command instead. The fallback is always
  *stricter* than the affected-only gate — never a partial or empty pass.

**Proof guarantee:** `.roll/last-test-pass` is written **only after** a supported
command actually executes and returns zero, recording the tested tree hash, the
executed command, the selected mode, and a timestamp. A failed, unknown-option,
or zero-test run never mints a proof, so a proof always represents a real green
test run bound to the exact committed tree. An unresolvable project (a
`package.json` with no `scripts.test`) fails loud with a structured diagnostic
and a safe next step instead of silently passing.

## Test Quality Rubric

`guide/en/testing/quality-rubric.md` (referenced from `$roll-.dream` Scan 7)
catalogs eight recurring antipatterns the dream scan flags as
`REFACTOR-XXX [test-quality:❶|❷|...|❽]`:

| # | Antipattern | Fix |
|---|-------------|-----|
| ❶ | Hard-coded business data (prices, version strings, product copy) | Inject fixture data via monkey-patch or constructor; assert behaviour, not the data table itself |
| ❷ | Over-mocking (database, filesystem, real boundary) | Use real subsystems behind small adapter mocks; prefer in-memory test doubles |
| ❸ | Asserting implementation details (private symbol names, internal data shape) | Assert observable behaviour through the public API |
| ❹ | Fixture order coupling (shared mutable state between tests) | Setup/teardown each test independently; use immutable fixtures |
| ❺ | Testing private functions / bypassing the public API | Re-route through the public entry point; if it's hard to reach, the API is wrong |
| ❻ | Asserting framework behaviour (testing Vitest itself) | Delete the test; trust the framework |
| ❼ | Inlining external-tool behaviour (`sed`/`grep`/`awk` pipelines duplicated in test bodies) | Call the project helper that owns the parsing, or extract into a test helper module |
| ❽ | Asserting on a file outside this repo (`~/.codex`, `~/.kimi`, `~/.roll`, system paths) | Sandbox in a temp dir (`mkdtempSync`), redirect env vars there, never touch live config |

The dream skill emits at most 5 REFACTOR entries per scan, so the backlog
doesn't drown in noise. Refactor them in priority order.

### Categories ❼ and ❽

These two are the ones reviewers reject most often, so treat them as hard rules when
you write a test: a test that cannot fail, and a test that asserts its own fixture.
Nothing blocks a merge on them automatically — `roll dream run-once` surfaces
violations as REFACTOR rows, and a reviewer (human or Evaluator) is expected to catch
them in the diff.

这两类是评审最常打回的:不可能失败的测试、以及断言自己夹具的测试。写测试时当硬规则守。
没有任何东西会因此自动拦合并 —— `roll dream run-once` 会把违规报成 REFACTOR 行,评审
(人或 Evaluator)应当在 diff 里抓住它。

Categories ❶..❻ remain advisory: dream flags them as REFACTOR entries but
the gate doesn't block on them. Triage them in your usual queue.

Lines with `# test-quality:allow` are skipped by the scanner — reserved for
doc-validation tests that legitimately inline `awk` to parse markdown
without ever touching production code.

`packages/core/test/prices.difftest.test.ts` is the canonical ❶ exemplar —
assertions that read live production rates broke every time the rate card moved,
even when the arithmetic was unchanged. It now feeds a fixed fixture price table
for the arithmetic and asserts only structural invariants (cache_read < input,
etc.) on the production rates.

## See Also

- [loop.md](loop.md) — how loop enforces TCR discipline per story
- [skills.md](skills.md) — `$roll-build` (delivers + deposits E2E)
