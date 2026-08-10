# Contributing to Roll

Thanks for your interest. Roll is small enough that small focused PRs are the easiest to land — keep each change to one thing.

## Development setup

```bash
git clone https://github.com/seanyao/roll.git
cd roll
./install.sh
```

`install.sh` builds the workspace and symlinks the TS launcher (`packages/cli/bin/roll.js`) into `~/.local/bin/roll`, so a rebuild (`pnpm -r build`) and `skills/` edits take effect immediately for any project on the same machine. After changing CLI source, run `pnpm -r build` before using that local command; it will stop rather than quietly use an older build.

## Tests

All changes must keep CI green. The suite is **Vitest** across the pnpm workspace.

```bash
pnpm -r test                                                  # full suite (pre-push / CI / release)
pnpm --filter @roll/cli test                                  # one package
pnpm --filter @roll/cli exec vitest run test/<file>.test.ts   # one file
pnpm test:cov                                                 # with v8 coverage
roll test                                                     # affected-only — the TCR micro-step gate; writes the test-pass proof
```

- Tests live beside their package in `packages/<pkg>/test/`: pure logic in
  `spec`/`core`, command + integration surface in `cli`/`infra`.
- Sandbox filesystem state in a temp dir (`mkdtempSync`) — never assert on paths
  outside the repo.
- When you change behaviour, add or update tests in the same PR. CI-only fixes
  are fine, but a PR that adds code without exercising it gets a review request.

### Test quality gate (US-QA-012/013)

After CI goes green and before auto-merge, loop runs `roll loop
test-quality-check` over the changed test files for two **blocking** rubric
categories:

- **❼ Inline external-tool behaviour** — `sed` / `awk` / `grep -oE` / `find` /
  `cut` / `tr` pipelines inside a test body that re-implement what a project
  helper already does. Call the helper instead.
- **❽ Paths outside this repo** — `~/.codex`, `~/.kimi`, `~/.roll/`, `/etc/…`
  in assertions. Sandbox in a temp dir instead.

If the gate finds violations the PR's auto-merge is held and
`~/.shared/roll/loop/ALERT-<slug>.md` records the file/line/category. Fix the
test, or bypass with `[skip-test-quality]` in the PR description (use sparingly —
a bypass still ships and the violation goes to dream's REFACTOR queue). Rules:
[guide/en/testing/quality-rubric.md](guide/en/testing/quality-rubric.md).

## PR conventions

- Title: `<type>: <description>` — `fix:` / `feat:` / `refactor:` / `docs:` / `chore:`. For story execution use `Story N: …`.
- Keep PRs small and reviewable. If you find yourself touching three different areas, that's three PRs.
- Reference the BACKLOG id (US-XXX / FIX-XXX / REFACTOR-XXX) in the title or body so the changelog can pick it up.
- Branch from `main` and rebase before requesting review.

## Backlog discipline

If you want to add a new Story, FIX, or REFACTOR, do it via:

```bash
roll idea "<one sentence describing what you want>"
```

Don't edit `.roll/backlog.md` by hand for new items — `roll idea` assigns the id and classifies the type. For descriptions, follow the convention in `conventions/global/AGENTS.md` §4: plain language, no file paths, no function names, no architecture jargon.

`roll backlog lint` (warn-only as of REFACTOR-041) flags violations for you.

## Reporting bugs

Use [GitHub Issues](https://github.com/seanyao/roll/issues) for bugs and feature requests. Please include:

- Your OS + `roll --version`.
- The exact commands you ran.
- The full output (redact anything sensitive).

For security-sensitive issues, see [SECURITY.md](SECURITY.md).
