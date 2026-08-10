# Roll Skill Selection Guide

Quickly select the right skill or tool.

## Core Skills

| User Intent | Skill | Description |
|---------|-----------|------|
| **"Not sure how to do it"** / **"There are several options"** | `roll-design` | Explore solutions, compare options, human decision-making |
| **"Help me build a..."** / **"Implement US-001"** / **"Fix FIX-001"** | `roll-build` | Universal entry: US-XXX story mode, FIX-XXX fix mode, or free-text fly mode — all in one skill |
| **"This logic is critical"** / **"Involves payment"** | `roll-spar` | Adversarial TDD, activate for high-risk scenarios |
| **"Fix a bug"** / **"Change some copy"** | `roll-fix` | Quick fix, no full workflow |
| **"Plan requirements"** / **"Split into stories"** | `roll-design` | Plan only, no implementation, outputs BACKLOG.md |
| **"Run several Actions in parallel"** | `roll-build` | Auto-determines parallelism after splitting Actions |
| **"What shipped / what's queued?"** | `roll status` / `roll loop cycle` / story reports | CLI-first delivery state, cycle trace, and story-scoped evidence |
| **"Debug this page"** | `roll-debug` | Deep diagnosis, collect logs/network/DOM |
| **"Retrieve an external page"** / **"Help with an anti-bot page or CAPTCHA"** | `roll-browse` | Isolated external acquisition with owner-mediated takeover; it is not project diagnosis or acceptance evidence |

## roll-browse — External Page Acquisition

Use `roll-browse` only to retrieve material from an external page, including an
anti-bot page or a CAPTCHA that needs the owner's help. Run its sanctioned
`browse.sh` wrapper and keep the returned material as notes, not delivery
evidence.

Its hard boundaries are:

- Chrome mode, owner profiles, cookies, and CDP attachment are prohibited.
- An external retrieval result is never acceptance or visual evidence.
- Roll never installs or upgrades browser-act automatically; missing tooling
  stops and tells the owner where to install it.
- Login takeover uses a URL credential controlled by the owner. Roll never
  takes, persists, forwards, or handles that URL or any credential.

For a page this project owns, use `roll-debug` instead: it diagnoses the
project's console, network, DOM, and source. `roll-browse` acquires material
from an external page. Ownership beats protection: an owned staging page behind
a login wall is still a `roll-debug` case, not a `roll-browse` case.

## Support Skills

| Scenario | Skill | Trigger Timing |
|------|-------|---------|
| Code self-review | `roll-.review` | Before Commit, or manually triggered |
| Generate Changelog | `roll-.changelog` | Auto-triggered after successful Deploy |
| QA test reference | `roll-.qa` | Referenced when writing tests |
| Intent clarification | `roll-.echo` | Auto-activates when user input is vague or unclear |
| Documentation/product audit | `roll-doc-audit` | Check README, guides, site pages, CLI help and docs against implemented behavior; optionally index docs and fill gaps |

## roll-doc-audit — Documentation/Product Consistency Audit

`roll-doc-audit` first checks user-facing documentation surfaces against real
behavior: README, guides, site pages, CLI help, tests, and source. For inventory
work it still runs the four-phase docs pipeline — scan/index → gap analysis →
fill → report — plus a deep-read **Phase 3b**. Phase 3 fills directory-level
gaps; Phase 3b builds a full project symbol table and detects **6
cross-directory topics** that directory-level filling alone cannot find:

| Topic | Triggers when | Output |
|-------|---------------|--------|
| Data flow / call chain | An import chain spans ≥ 3 source directories | `docs/data-flows.md` |
| State machine | A `*State` / `*Status` enum is referenced by ≥ 2 files | `docs/state-machines.md` |
| External integrations | `fetch` / `axios` / `*_URL` constants are present | `docs/integrations.md` |
| Deployment pipeline | A CI config file plus a deploy URL pattern exists | `docs/deployment.md` |
| Agent entrypoint | No `AGENTS.md` and the source root has ≥ 3 subdirs | `AGENTS.md` |
| High fan-in directory | A directory is imported by ≥ 5 source files | `<dir>/README.md` |

`$roll-doc-audit --dry-run` runs Phases 1–2 and prints the Phase 3 / 3b plan without
writing; `$roll-doc-audit --force` regenerates drafts even when targets already exist.
Full guide: [roll-doc-audit.md](roll-doc-audit.md).

## Quick Decision Tree

```
User Input
    |
+----------------------+
| "Unsure about        |
|  the approach?"      |--> roll-design
+----------------------+
    | No
+----------------------+
| "One-sentence        |
|  request?"           |--> roll-build (fly mode)
+----------------------+
    | No
+----------------------+
| "Has a US-XXX ID?"   |--> roll-build (story mode)
+----------------------+
    | No
+----------------------+
| "Has a FIX-XXX ID?"  |--> roll-fix
+----------------------+
    | No
+----------------------+
| "Fix a bug?"         |--> roll-fix
+----------------------+
    | No
+----------------------+
| "Plan/split?"        |--> roll-design
+----------------------+
    | No
+----------------------+
| "High-risk logic?"   |--> roll-spar
+----------------------+
    | No
  Manual judgment
```

## Review Score (US-SKILL-010..014, FIX-343)

Skills do **not** self-score. The working agent never grades its own story;
the **Review Score** is a runner-side peer outcome, produced by a Reviewer in
a fresh, separate session (never a sub-agent of the builder). After a
`roll-build` or `roll-fix` cycle delivers, the runner casts a fresh-session
Reviewer and writes one structured Review Score note into the story's card
folder (US-META-008 — the card folder is the story's single home; the flat
`.roll/notes/` keeps the project diary and pre-migration history, and both
the dashboard trend and the story archive merge the two sources):

```
.roll/features/<epic>/US-AUTH-001/notes/2026-05-29-roll-build-US-AUTH-001-1717000000.md
.roll/features/<epic>/FIX-072/notes/2026-05-29-roll-fix-FIX-072-1717000123.md
```

Each note is YAML frontmatter + rationale:

```markdown
---
skill: roll-build
story: US-AUTH-001
score: 8
verdict: good
ts: 2026-05-29T03:14:15Z
---

Story shipped cleanly; AC fully met. One TCR retry on the auth-cookie test
(missing setup). Peer review surfaced one nit, addressed inline.
```

`roll loop status` rolls up the trend at the bottom of the ROLLUP block:

```
review-score: mean 7.8 / min 4 / redo 2 (last 14)
```

`redo` counts entries whose `verdict` is `regression`, or whose `verdict`
is `ok` with `score < 6` — both signal that a follow-up look is
warranted. Mean and min cover the whole window so a single bad cycle
doesn't get hidden by the average.

The notes are part of `.roll/` and therefore commit-tracked, so the
quality trail is reproducible across machines and visible to anyone
reading the project history.

`roll loop status` summarizes the Review Score trend at the bottom of its
status panel: `review-score: mean 7.8 / min 4 / redo 2 (last 14)`. `redo`
includes `regression` outcomes and low-confidence `ok` outcomes with a score
below 6, marking cycles worth revisiting. A peer Reviewer from a fresh,
independent session produces the score; the working agent never scores itself.

## Adding a New Skill

A skill is a directory under `skills/<name>/` with a `SKILL.md` whose YAML
frontmatter declares at least `name` and `description`. To register a new
skill, follow these steps — you never hand-maintain a catalog list:

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`,
   `license`, and `allowed-tools` — see below).
2. Regenerate the capability catalog:

   ```bash
   roll setup skills
   ```

   This rescans every `skills/*/SKILL.md` and rewrites `guide/skills.md` from
   the frontmatter. `guide/skills.md` is a **generated artifact** — its header
   says `GENERATED by roll setup skills — do not edit by hand`. Adding or
   removing a skill is reflected automatically on the next regenerate; never
   edit `guide/skills.md` by hand.
3. Commit both the new `SKILL.md` and the regenerated `guide/skills.md`.

### Drift guard

The committed catalog cannot silently drift from the actual skills:

- `roll doctor skills` rescans and fails (non-zero exit, prints a diff) if
  `guide/skills.md` no longer matches `skills/*/SKILL.md`. CI runs this gate,
  so a hand-edit or a forgotten regenerate is caught before merge.
- `roll doctor` prints a non-failing nudge in its skills section when the
  catalog is stale, as a local reminder to run `roll setup skills`.

The scan is bash 3.2 compatible (awk-based parser; no `declare -A`, `mapfile`,
or `${var^^}`), so it runs on the macOS system bash.

## Declaring Tool Scope (`allowed-tools`)

Every `SKILL.md` frontmatter should declare an `allowed-tools` line listing the
tools the skill is permitted to use:

```yaml
---
name: roll-design
license: MIT
allowed-tools: "Read, Edit, Write, Glob, Grep, Bash(git:*), WebSearch, WebFetch, Skill"
description: ...
---
```

- **What to write**: the comma-separated set of tools the skill actually needs
  (e.g. `Read, Edit, Write, Glob, Grep`), narrowing Bash where possible with
  the `Bash(git:*)` glob form rather than granting unscoped `Bash`.
- **Why declare it**: the declaration documents each skill's intended tool
  surface so the scope is auditable and reviewable per skill, consistent across
  the catalog.
- **What this is for Roll**: a **declaration + lint** only. Roll surfaces the
  declaration and lints for its presence; the actual tool **enforcement**
  happens in the inner agent harness, not in Roll. Writing `allowed-tools` does
  not by itself sandbox the skill.

## Auto-Trigger Keywords

| Skill | Trigger Keywords |
|-------|-----------|
| `roll-design` | "discuss", "compare options", "how to choose", "trade-offs", "not sure what to use", "design", "plan", "split", "write stories", "requirements analysis" |
| `roll-build` | "help me build", "add a feature", "change this", "refactor", "implement US-", "do this story", "complete Action", "parallel", "develop simultaneously" |
| `roll-fix` | "fix bug", "change copy", "adjust color", "error", "FIX-", "BUG-" |
| `roll-spar` | "adversarial", "attack-defense", "high-risk", "critical logic", "payment", "permissions", "security" |
| `roll-debug` | "debug", "diagnose", "page has issues", "black-box analysis" |
