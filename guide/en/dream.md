# roll-.dream — Code Health Scanner

`roll-.dream` scans the codebase for architectural friction, dead code, and technical
debt, and deposits `REFACTOR-NNN` entries into the backlog for the loop to pick up.

You run it: `roll dream run-once` resolves the `roll-.dream` skill and spawns the agent
in place. Nothing runs it for you — there is no schedule and no background process, so
a scan happens when you ask for one.

## What Dream Does

Dream runs one full scan per night and produces these outputs:

1. **`.roll/dream/YYYY-MM-DD.md`** — detailed report in Chinese (one file per night)
2. **BACKLOG.md entries** — actionable `REFACTOR-NNN` items appended to the `## ♻️ Refactor` table
3. **`.roll/dream/structure-scan.json`** — deterministic TypeScript/AST evidence for code-structure findings

The report covers:

- Dead code and unused functions, seeded by TypeScript Language Service references
- Duplicated logic across modules, seeded by normalized AST fingerprints
- Module boundary violations (one concern leaking into another)
- Missing tests for shipped behavior
- Documentation coverage gaps (missing EN/ZH guides, stale references)

Code-structure findings now come from the deterministic pre-scan first: dead exports,
unreachable branches, duplicate AST shapes, single-implementation abstractions, and
undocumented env variables are written to `structure-scan.json` before the agent runs.
The agent consumes that artifact instead of re-running grep-style heuristics. Document
coverage, freshness, and existence-drift checks stay in the existing Dream flow.

## How to Read Dream Logs

```bash
# See last 3 nights
ls -lt .roll/dream/ | head -4

# Read latest report
cat .roll/dream/$(ls -1t .roll/dream/ | head -1)
```

Each report section ends with a priority classification:

- **P0** — blocks other work, should be addressed this sprint
- **P1** — significant friction, address within 2 weeks
- **P2** — low severity, address when convenient

## REFACTOR Item Generation

When dream finds a concrete, actionable issue it appends a row to BACKLOG.md:

```markdown
| REFACTOR-005 | Extract _for_each_ai_tool() — 4 duplicate iteration loops | 📋 Todo |
```

Loop picks these up at normal priority (after FIX-XXX, alongside US-XXX).

Dream does **not** generate REFACTOR entries for:
- Issues that would take >1 day to fix (escalates as IDEA instead)
- Purely stylistic preferences
- Issues already in BACKLOG as US or FIX items

## Running a Scan

```bash
roll dream run-once   # scan now

# or drive the skill from your agent session directly
$roll-.dream
```

Run it whenever a scan is useful — before a planning pass, after a large refactor, or
as the first step of a session that will work through REFACTOR cards. Nothing runs it
for you.

想扫就扫:做规划之前、大重构之后,或者在准备处理 REFACTOR 卡的会话开头跑一次。没有任何
东西会替你跑。

Dream always writes to today's date file and always appends to BACKLOG.md —
running it twice in one day appends a second pass (safe but redundant).
Each run also refreshes `.roll/dream/structure-scan.json`; inspect that file when you
need machine-readable evidence behind code-structure REFACTOR rows.
