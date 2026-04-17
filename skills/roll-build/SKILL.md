---
name: roll-build
description: "Universal delivery skill. Handles any input: a US-XXX ID executes from BACKLOG via TCR; a FIX-XXX redirects to roll-fix; any other text auto-clarifies, designs, and ships as a new Story."
---

# Roll Build (Universal Delivery)

> Follows the Architecture Constraints, Development Discipline, and Engineering Common Sense defined in the project AGENTS.md.

One entry point. Any input. Full delivery.

## Trigger

**Input detection:**

```
Input received
  ├── matches "US-[A-Z]+-[0-9]+"  → Story mode: read BACKLOG → TCR workflow
  ├── matches "FIX-[A-Z]+-[0-9]+" → redirect to $roll-fix
  └── anything else               → Fly mode: clarify → design → execute
```

**Story mode** — use when:
- The user provides a `US-XXX` identifier
- An existing backlog Story needs to be executed

**Fly mode** — use when:
- The user has a vague one-sentence request
- No `US-XXX` exists yet; planning and execution are both needed
- No input at all — ask the user what they want to build

**Redirect to `$roll-fix`** when:
- Input matches `FIX-XXX` or `BUG-XXX` pattern

Do not use for:
- Pure analysis or research with no code changes (use `$roll-design`)
- Single-line hotfix with no planning needed (use `$roll-fix`)

## Core Philosophy

1. **Clarity over assumptions** — When scope is unclear, clarify first
2. **Just enough planning** — Plan to the level the uncertainty demands
3. **TCR rhythm** — Test-first, micro-steps, auto-commit on green, auto-revert on red
4. **Push to GitHub** — Complete implementation, commit, and push; code is on remote
5. **Stay reversible** — Every micro-step leaves the repo in a clean, green state

---

## Mode A: Story Mode (US-XXX input)

Activate when input is a `US-[A-Z]+-[0-9]+` identifier.

### Step 1: Read the Story

1. Open `BACKLOG.md`, find the US row, follow the link to `docs/features/<feature>.md`
2. Read the full AC / Files / Dependencies section
3. If a plan doc (`<feature>-plan.md`) exists, read it for context

### Step 2: Split into Actions

- Write 2–6 candidate Actions
- Pick the smallest shippable Action first
- **Granularity constraint**: Each Action completable in 2–5 minutes; split if larger
- **No placeholders**: Action descriptions must be specific and directly executable

#### 2.5 Parallel Dispatch (auto-determined)

After splitting Actions, check if they can run in parallel:

```
Conflict detection:
  ├── List files involved in each Action
  ├── Same file → cannot parallelize, must run sequentially
  ├── Same directory, different files → can parallelize
  └── Different directories → safe to parallelize
```

**If 2+ Actions can run in parallel, automatically enable Worktree isolation:**

```bash
git worktree add .worktrees/{action-id} -b dispatch/{action-id}
```

- Each sub-agent executes TCR in its own worktree
- Sub-agent briefs must be **self-contained** (include: what to do, where, how to verify, what not to do)
- After all complete: review each → merge to main → run integration tests → clean up worktrees

**Status notifications (required):**

```
🔀 Parallel Dispatch: N Actions running in parallel

  Agent 1 [Action: ...]  ⏳ Running...
  Agent 2 [Action: ...]  ⏳ Running...

  Agent 1 [Action: ...]  ✅ Done (N TCR commits)
  Agent 2 [Action: ...]  ✅ Done (N TCR commits)

🔀 Merge: N/N succeeded, merging...
🧪 Integration tests: running...
```

When parallel conditions are not met, execute Actions sequentially.

### Step 3: Define Verification

- Test matrix: happy path + edge/failure/regression cases
- What "online verification" means for this repo (URL, endpoint, UI flow, log signal)
- Reference `$roll-.qa` for test pyramid (unit → E2E → visual → smoke)

Proceed to the **Shared TCR Workflow** (Phase 4 onward).

---

## Mode B: Fly Mode (free-text or no-input)

Activate when input does not match any `US-XXX` / `FIX-XXX` pattern, or when no input is given.

### Phase 1: Clarify & Assess

Before any code, output:

```
🎯 Clarified Goal: {1-2 sentences capturing user intent}
📏 Complexity Assessment: {small|medium|large}
🔍 Uncertainty Areas: {list what needs investigation/decision}
```

**Complexity Rules (AI coding time):**

| Level | Scope | Action |
|-------|-------|--------|
| Small | ≤3 files, 5–15 min, single concern | Skip detailed planning, implement directly |
| Medium | Crosses modules, needs trade-offs, 15–30 min | Mini-plan then implement |
| Large | Multi-step, architectural, 30–60 min+ | Full plan + split into Actions via `$roll-design` |

### Phase 2: Create US / Actions

- Use `$roll-design` to split vague request into INVEST-compliant User Stories
- Insert US into `BACKLOG.md` under the relevant Epic > Feature group
- If a new `docs/features/<feature>.md` is needed, create it

After creation, switch to **Story mode** and execute the first US immediately.

Proceed to the **Shared TCR Workflow** (Phase 4 onward).

---

## Shared TCR Workflow

The following phases apply to both Story mode and Fly mode after planning is complete.

### Phase 4: Test Design Review

Before writing implementation code:

```
🧪 Test Design for Action: {Action name}

   Scenarios:
   ├── {Happy path scenario}
   ├── {Edge case scenario}
   └── {Failure/regression scenario}

   Test Types:
   ├── Unit tests for: {logic components}
   ├── Integration tests for: {API/data flows}
   └── Manual verification for: {UI/visual elements}
```

**Self-review on test design:**
- Are we testing the right behavior?
- Are edge cases covered?
- Are tests independent and deterministic?

Reference `$roll-.qa` for coverage requirements and test pyramid strategy.

**Why this phase**: TCR only guarantees code passes tests — verify tests are correct first.

### Phase 5: TCR Implementation Loop

```
┌────────────────────────────────────────────────────────────┐
│  TCR CYCLE (Test && Commit || Revert)                       │
└────────────────────────────────────────────────────────────┘

MICRO-STEP {N}: {description of smallest testable change}

   Step 1: Write/Update Test
      └── Run test → Confirm RED (expected failure)

   Step 2: Implement Minimal Code
      └── Write just enough to make test pass

   Step 3: TCR Decision
      └── Run test
          ├── ✅ GREEN → git commit -m "tcr: {micro-step description}"
          └── ❌ RED   → git checkout -- .  → Retry with new approach

   Step 4: Refactor (optional, while green)
      └── Run test → ✅ GREEN → Amend or new TCR cycle
```

**Micro-step guidelines:**

| Change Type | Typical Micro-Steps |
|-------------|---------------------|
| Logic / algorithm | 1 function = 1–2 micro-steps |
| API endpoint | Route → Handler → Validation → Response |
| UI component | Skeleton → Props → Interaction → Styling |
| Bug fix | Regression test → Fix → Verify |
| Refactor | Extract method → Update calls → Remove old |

Accumulate 3–5 micro-commits per Action. Each commit is a guaranteed working state.

### Phase 6: Pre-Push CI Gate

After all micro-steps, run full CI locally before pushing:

```bash
npm run ci:local 2>/dev/null || (npm run lint && npm run build && npm test -- --run)
```

**If CI fails:**
```
❌ Local CI check failed
   ├── Run 'npm run ci:fix' or 'npm run format' for auto-fixable issues
   ├── Fix remaining lint/build/test errors via new TCR cycle
   └── Re-run until all pass
```

**Setup `ci:local` script (if not in `package.json`):**
```json
{
  "scripts": {
    "ci:local": "npm run format:check && npm run lint && npm run build && npm run test -- --run",
    "ci:fix":   "npm run format && npm run lint -- --fix"
  }
}
```

**Setup pre-push hook (recommended, one-time):**
```bash
cat > .git/hooks/pre-push << 'EOF'
#!/bin/bash
echo "🔍 Running local CI checks..."
if ! npm run ci:local 2>/dev/null && ! (npm run lint && npm run build); then
    echo "❌ CI check failed, push blocked"
    exit 1
fi
echo "✅ CI check passed"
EOF
chmod +x .git/hooks/pre-push
```

### Phase 7: Pre-Push Code Review

```bash
$roll-.review staged
```

**Review output:**
```
🔍 Self Review Report
├── Scope: X files (+Y/-Z lines)
├── 🔴 Critical: N issues (must fix)
├── 🟡 Warnings: N issues (should fix)
├── 🟢 Suggestions: N items (optional)
└── ✅ Passed dimensions: [Quality, Design, Scope, ...]
```

**Review dimensions** (correctness guaranteed by TCR):
- 🎯 **Quality**: Naming clarity, DRY, function size, readability
- 📐 **Design**: Architecture, abstraction level, separation of concerns
- ⚠️ **Scope**: No opportunistic changes
- 📝 **Documentation**: Comments where needed

**Decision:**
```
🔴 Critical > 0 → Fix via new TCR cycle → Re-review
🟡 Warnings > 0 → Fix if quick (< 5 min) or document
🟢 Suggestions / ✅ All clear → Proceed to push
```

### Phase 8: Commit & Push

```bash
# All TCR micro-commits are already made
# Squash or keep as-is based on repo convention

git log --oneline -{n}  # Review TCR commits

git pull origin main --rebase
git push origin main
```

Commit message (if squashing):
```
{story-id}: {action description}

- {what changed}
- {why}
- {test coverage}
- TCR: {n} micro-commits
```

### Phase 9: Watch CI & Deploy

```
⏳ CI Running...
   ├── ✅ PASS → Proceed to deploy
   └── ❌ FAIL →
       ├── Diagnose failure
       ├── Create new TCR micro-step to fix
       └── Push and retry
```

Follow the repo's deployment path (Vercel / Railway / etc.) and record the deployed target.

**CI failure recovery:**
```
1. Diagnose: environment-specific or real failure?

2. If real failure:
   ├── git reset --soft HEAD~{n}
   ├── TCR micro-step to fix
   └── Push again

3. If environment-specific:
   ├── Document exception
   └── Get user approval to proceed
```

### Phase 10: Runtime Verification

- **Web apps**: verify on deployed URL (happy path, edge cases, no regression)
- **CLI tools**: verify via command execution
- **Libraries**: verify via test usage or example scripts

### Phase 10.5: Verification Gate (MANDATORY)

**Before marking as DONE, fresh evidence must be provided.**

```
🚦 Verification Gate

   Evidence checklist (each item must have actual output):
   ├── [ ] Tests passed: paste actual test run output
   ├── [ ] Build succeeded: paste build output
   ├── [ ] Online verification: screenshot / curl output / log snippet
   └── [ ] No regression: verify at least one existing feature still works

   Gate Decision:
   ├── ✅ All items have evidence → Can mark as DONE
   └── ❌ Any item missing evidence → Gather evidence before passing the gate
```

**Hard Rule**: "I confirmed the tests passed" does not count as evidence. Must be **freshly run** command output from this session.

### Phase 11: Write Back Status (REQUIRED)

Both locations must be updated — neither can be skipped:

**① Update BACKLOG.md index row (Status column):**

```markdown
| [US-{ID}](docs/features/<feature>.md#us-{id}) | {Title} | ✅ Done |
```

Change the Status from `📋 Todo` to `✅ Done`.
For Fly mode: first append an index row under the appropriate Epic > Feature group, then mark it done.

**② Update `docs/features/<feature>.md` US section:**

```markdown
## US-{ID} {Story Title} ✅

**Completed**: {YYYY-MM-DD}

**AC:**
- [x] {Completed acceptance criterion 1}
- [x] {Completed acceptance criterion 2}

**Files:**
- `{added/modified file 1}`
- `{added/modified file 2}`
```

- Add ✅ to the heading
- Add `**Completed**` date
- Change AC items from `[ ]` to `[x]`
- Update Files to reflect actual changed files

If the US section does not yet exist, create the full section (AC / Files / Dependencies).

```bash
git add BACKLOG.md docs/features/
git commit -m "docs: mark {US-ID} as completed"
git push
```

### Phase 12: Report & Celebrate

```
✅ Pushed to GitHub: origin/main
🚀 Deployed: <url>
✅ Verified: <what was checked>
📦 Changes: <summary>
🔢 Commits: <count> micro-commits via TCR
🧪 Tests: <what tests were added/modified>
📊 TCR Stats: <success rate, revert count if any>
📋 Review Gate: <self-review findings summary>
📝 BACKLOG: <US-ID> marked ✅ Done

🎉 Shipped.

🔄 Next Options:
1. Continue to next Action (if Story has more)
2. Start next US (if Fly mode created multiple)
3. Done (if all completed)
```

---

## Project Context Rule

Before creating any file or directory:

1. **Read existing project structure** — check for `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, existing `src/`, `api/`, `cmd/` directories
2. **Infer conventions from evidence** — don't assume a project type; observe what already exists
3. **Follow what already exists** — introduce new patterns only when the current structure has no precedent

> `roll init` no longer asks for project type. Skills are responsible for reading context and acting accordingly.

---

## Hard Rules

1. **No local-only "done"**
   Work is not complete until it reaches:
   commit → push → CI signal → deploy → online verification → backlog update

2. **TCR for every micro-step**
   - Each behavior change: Test → Green=Commit / Red=Revert
   - No "I'll fix it in the next step" — revert and retry
   - Each commit is a guaranteed working state

3. **Test Design Review before implementation**
   - Design test scenarios and edge cases first
   - TCR only works if tests are correct — validate early

4. **Micro-steps only**
   - If a step feels "a bit complex", split it
   - Each micro-step completable in 1–3 minutes
   - **No placeholders**: Action/AC descriptions must be specific — no "TBD"

5. **Pre-push self-review required**
   - Run `$roll-.review staged` on final diff
   - Fix blocking (Critical) issues via new TCR cycle

6. **No hidden work**
   - Every file changed must relate to the current Action
   - No "while I'm here" refactors unless in a separate TCR cycle

7. **Always update BACKLOG status**
   - BACKLOG.md index row and `docs/features/<feature>.md` US section are both required
   - Neither can be skipped

---

## Definition of Done (per Action)

- [ ] Story and Action clearly defined
- [ ] Test design reviewed and approved
- [ ] **TCR cycles completed** (all micro-steps via Test && Commit)
- [ ] All commits are green states (no broken commits)
- [ ] Local CI checks passed (format + lint + build + test)
- [ ] Self-code-review passed, blocking issues fixed via TCR
- [ ] Changes pushed to remote
- [ ] CI is green (or explicit, recorded exception)
- [ ] Deployed to production
- [ ] Online verification performed
- [ ] **Verification Gate passed** (fresh evidence for tests, build, deploy, no regression)
- [ ] **BACKLOG.md index status updated** (📋 → ✅, REQUIRED)
- [ ] **`docs/features/<feature>.md` US section updated** (Completed date + [x] ACs, REQUIRED)
- [ ] Summary reported to user

---

## TCR Recovery Patterns

### Pattern 1: Red After Multiple Attempts

```
If same micro-step fails 3 times:
   1. Revert to clean state
   2. Escalate: "This micro-step is actually medium complexity"
   3. Split into smaller micro-steps
   4. Retry TCR
```

### Pattern 2: Refactoring While Green

```
If refactoring during green state:
   Option A: Amend last commit (if refactor is tiny)
   Option B: New TCR cycle (treat as new micro-step)
```

### Pattern 3: Test Design Was Wrong

```
If implementation reveals test design flaw:
   1. Revert current micro-step
   2. Return to Phase 4 (Test Design Review)
   3. Update test design
   4. Resume TCR cycles
```

### Pattern 4: Complex State vs Simple Reset

```
When complex state management is error-prone → consider full reset + re-initialization.
60% less code, zero bugs is better than an elegant but fragile transition.
```

---

## When to Use What

```
roll-build  → ship anything (new idea, US-ID, free-text request)
roll-fix    → fix a specific known bug (FIX-XXX / BUG-XXX)
roll-design → plan and design before building (no code output)
```

---

## Required Artifacts (per Action)

The agent must explicitly produce (in text) before or during execution:

- **Current User Story**: 1–3 sentences, INVEST-lean
- **Current Action**: smallest shippable increment
- **Acceptance criteria**: measurable outcomes for this Action
- **Write scope**: files/areas expected to change
- **Test Design**: scenarios, edge cases, test types
- **Test Design Review**: coverage validation result
- **TCR Log**: micro-step descriptions and commit count
- **Quality Review**: post-TCR code review result
- **Deployment target**: where it will be verified
