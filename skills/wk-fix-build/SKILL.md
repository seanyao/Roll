---
hidden: true
name: cnx-fix-build
description: Execute bugfix/hotfix from backlog. Reads FIX/BUG from BACKLOG.md, delivers via TCR workflow. Lighter than story-build, focused on single-issue fixes.
---

# Fix Ship (TCR Edition)

> Follows the Architecture Constraints, Development Discipline, and Engineering Common Sense defined in the project AGENTS.md.

Execute a single `FIX-XXX` / `BUG-XXX`, suitable for small-scope fixes or hotfixes.

## Trigger

Use when:

- There is a clearly defined `FIX-XXX` or `BUG-XXX`
- It is a single issue, single hotfix, or single small enhancement
- It does not need to be split into multiple Stories / Actions to deliver

**Workflow:**
1. Read BACKLOG.md index → Find FIX/BUG row → Follow link to `docs/features/<feature>.md`
2. Single Action (no splitting)
3. Execute via TCR workflow
4. Write back: update BACKLOG.md status column + update FIX section in Feature file

Do not use for:

- Multi-step feature development
- Large changes spanning multiple subsystems
- Requirements that need planning and splitting first
- Roadmap work that should be tracked as Stories

If the issue expands beyond a single bounded change, switch to `cnx-story-build`.

## Hard Rules

1. **No local-only "done"**
   Even for a minor change, the work is not complete until it reaches:
   - TCR micro-commits (test-guaranteed working states)
   - local verification
   - Quality review (post-TCR, via code-reviewer skill)
   - commit
   - push
   - CI signal
   - deploy
   - online verification

2. **Keep it to one issue**
   This skill is for one user-visible issue, one hotfix, or one tightly related enhancement bundle.

3. **Test Design Review first**
   - Design the test/verification approach before implementation
   - Run `code-reviewer` on test design for coverage validation
   - Ensure we're testing the right thing before TCR begins

4. **TCR for all changes**
   - Follow Test → Green=Commit / Red=Revert for each micro-step
   - Even "one-liner" fixes get a TCR cycle
   - Each commit is a guaranteed working state

5. **Quality Review before final commit** (Post-TCR)
   After TCR cycles complete:
   - Run `code-reviewer` skill on the diff
   - Review focuses on **quality** (naming, patterns, scope)
   - Correctness already guaranteed by TCR
   - blocking findings (Critical issues) must be fixed via new TCR cycle

6. **Do not force backlog churn**
   By default, do not update backlog or project status files.
   Only write back project tracking if:
   - the user asked for it
   - the change affects roadmap-visible behavior
   - the fix should be tracked for follow-up work

## TCR Workflow

### 1. Lock the issue
   - state the user-visible issue or requested enhancement
   - define the scope boundary and non-goals

### 2. Define verification
   - pick the narrowest local check that proves the fix
   - define the online verification target
   - for hotfixes: include regression test to prevent recurrence
   - reference `$cnx-qa-cover` for appropriate test type (unit/integration/E2E)

### 3. Test Design Review (TCR Core)

```
🧪 Test Design for Fix:
   
   Verification Approach: {unit test | integration test | manual check}
   
   Test Scenarios:
   ├── Fix verification: {how to confirm the fix works}
   └── Regression check: {how to ensure we didn't break anything}
```

**Reference `$cnx-qa-cover` for test strategy:**
- Even for fixes, follow `$cnx-qa-cover` test pyramid
- Hotfixes may skip visual regression but must have E2E smoke test

**Run self-review on test design:**
- Is the verification approach appropriate for this fix?
- Are edge cases covered?
- Is the regression check sufficient?

### 4. TCR Implementation

```
┌─────────────────────────────────────────────────────────────────────┐
│ TCR CYCLE FOR FIX                                                    │
└─────────────────────────────────────────────────────────────────────┘

MICRO-STEP 1: {description of the fix}

   Step 1: Write/Update Test
      └── Run test → Confirm RED (bug reproduced or test fails)
   
   Step 2: Implement Fix
      └── Write minimal code to fix the issue
   
   Step 3: TCR Decision
      └── Run test
          ├── ✅ GREEN → git commit -m "tcr: fix {issue description}"
          └── ❌ RED   → git checkout -- . → Retry

For simple fixes, this may be a single TCR cycle.
For complex fixes, use multiple micro-steps.
```

### 5. Local integration check (Pre-Push CI Gate)

Run the repo's full CI check locally to catch issues before push:

```bash
# Run local CI (format + lint + build + test)
npm run ci:local 2>/dev/null || (npm run lint && npm run build && npm test -- --run)
```

**Reference `$cnx-qa-cover` for coverage requirements:**
- Fixes must not reduce overall coverage
- Hotfixes need at least regression test coverage

**If failures:**
```
❌ Local CI check failed
   ├── Run 'npm run ci:fix' to auto-fix formatting issues
   ├── Fix lint/build/test errors
   └── Re-run checks until passing
```

**Setup ci:local script (if not exists):**
Add to `package.json`:
```json
{
  "scripts": {
    "ci:local": "npm run format:check && npm run lint && npm run build && npm run test -- --run",
    "ci:fix": "npm run format && npm run lint -- --fix"
  }
}
```

**Setup pre-push hook (optional but recommended):**
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

### 6. Quality Review (Post-TCR)

**Run self-code-review on staged changes:**

```bash
$cnx-.code-review staged
```

**Review Output:**
```
🔍 Self Review Report
├── Scope: X files (+Y/-Z lines)
├── 🔴 Critical: N issues (must fix)
├── 🟡 Warnings: N issues (should fix)
├── 🟢 Suggestions: N items (optional)
└── ✅ Passed dimensions: [...]
```

**Review Dimensions** (correctness guaranteed by TCR):
- 🎯 **Code Quality**: Naming clarity, KISS, readability
- 📐 **Design**: Appropriate abstraction, codebase consistency
- ⚠️ **Scope**: Fix is minimal, no opportunistic changes
- 📝 **Hotfix-specific**: Root cause addressed

**Decision:**
```
🔴 Critical > 0 → Fix via new TCR cycle → Re-review
🟡 Warnings > 0 → Fix if quick or document
🟢/✅ All clear → Proceed to push
```

**Note:** `code-reviewer` placeholder replaced with `$cnx-.code-review` for local execution.

### 7. Commit and push

```bash
# TCR commits already made during implementation
# May squash or keep micro-commits based on repo convention

git pull origin main --rebase
git push origin main
```

Commit message:
```
{fix|hotfix|feat}: {description}

- {what was fixed}
- {root cause if known}
- {test coverage}
```

### 8. Watch CI and resolve

```
⏳ CI Running...
   ├── ✅ PASS → Proceed to deploy
   └── ❌ FAIL → 
       ├── Diagnose
       ├── TCR cycle to fix
       └── Push and retry
```

### 9. Deploy

Follow the repo's normal deployment path.

### 10. Online verification

Verify the shipped fix on the deployed target:
- confirm the issue is resolved
- confirm the previously working path still works
- for hotfixes: verify in production environment

### 10.5. Verification Gate (MANDATORY)

**Before marking as DONE, the verification gate must be passed.**

**Fresh evidence** must be provided — claiming completion based on assumptions is not acceptable.

```
🚦 Verification Gate
   
   Evidence checklist (each item must have actual output):
   ├── [ ] Tests pass: paste actual test run output
   ├── [ ] Build succeeds: paste build output
   ├── [ ] Issue resolved: screenshot / curl output / log excerpt as proof
   └── [ ] No regression: verify at least one existing feature still works
   
   Gate Decision:
   ├── ✅ All items have evidence → Can mark as DONE
   └── ❌ Any item lacks evidence → Provide evidence before passing the gate
```

**Hard Rule**: "I confirm tests passed" does not count as evidence. It must be **freshly run** command output from this session.

### 11. Write Back Status (when tracking is needed)

Only update when Hard Rule #6 conditions are met (user requested, affects roadmap-visible behavior, or needs follow-up tracking).

Both locations must be updated — neither can be skipped:

**① Update BACKLOG.md index row (Status column):**

```markdown
| [FIX-{ID}](docs/features/<feature>.md#fix-{id}) | {Title} | ✅ Done |
```

Change the Status of the corresponding row from `📋 Todo` to `✅ Done`.

**② Update `docs/features/<feature>.md` FIX section:**

```markdown
## FIX-{ID} {description} ✅

**Fixed**: {YYYY-MM-DD}

**Problem**: {problem description}
**Root Cause**: {root cause}
**Solution**: {solution}

**Files:**
- `{modified file}`
```

- Add ✅ to the title
- Add `**Fixed**` date
- Change AC (if any) from `[ ]` to `[x]`
- Update Files to reflect actual changed files

### 12. Report

Summarize:
- shipped fix/enhancement
- TCR statistics
- quality review outcome
- verification results
- any residual risk
- **BACKLOG.md updated** ✅

## Required Artifacts

The agent must explicitly output before or during execution:

- **Current Issue**: one sentence describing the bug, hotfix, or small enhancement
- **Current Fix**: the smallest shippable fix
- **Acceptance criteria**: measurable outcomes
- **Write scope**: expected files or areas
- **Test Design**: verification approach and scenarios
- **Test Design Review**: coverage validation
- **TCR Log**: micro-step(s) and commit(s)
- **Quality Review**: post-TCR review results
- **Deployment target**: where it will be verified

## Definition of Done

A minor change is only "done" when all are true:

- [ ] Issue clearly defined and scoped
- [ ] Test design reviewed and approved
- [ ] **TCR cycle(s) completed** (fix via Test && Commit)
- [ ] All commits are green states
- [ ] Local integration checks pass
- [ ] Quality review (code-reviewer) passed, blocking issues resolved via TCR
- [ ] Changes pushed
- [ ] CI is green (or explicit, recorded exception exists)
- [ ] Deployment completed
- [ ] Online verification performed
- [ ] **Verification Gate passed** (fresh evidence for tests, build, fix confirmation, no regression)

## TCR Patterns for Common Fixes

### Pattern: Bug Fix with Regression Test

```
Issue: "Search returns no results for special characters"

🧪 Test Design:
   ├── Fix verification: Search with "@#$%" returns results
   └── Regression: Normal search still works

TCR CYCLE 1: Regression test
   ├── Write test: Normal search works
   ├── Run → ✅ GREEN (expected, feature currently works)
   └── Commit: "tcr: add regression test for normal search"

TCR CYCLE 2: Bug reproduction
   ├── Write test: Special character search works
   ├── Run → ❌ RED (bug reproduced)
   └── No commit (test fails, but we keep it)

TCR CYCLE 3: Fix implementation
   ├── Fix special character handling in search query
   ├── Run tests → ✅ GREEN (both tests pass)
   └── Commit: "tcr: fix special character handling in search"
```

### Pattern: One-Liner Fix

```
Issue: "Button color is wrong"

🧪 Test Design:
   └── Verification: Visual check + CSS property assertion

TCR CYCLE:
   ├── Test: CSS property assertion
   ├── Run → ❌ RED
   ├── Fix: Change color value
   ├── Run → ✅ GREEN
   └── Commit: "tcr: fix button color"
```

### Pattern: Hotfix (Production Issue)

```
Issue: "Critical: Payment processing fails"

🧪 Test Design:
   ├── Fix verification: Payment API returns 200
   └── Regression: Invalid payments still rejected

TCR CYCLE 1: Regression test for invalid payments
   └── Commit: "tcr: ensure invalid payments are rejected"

TCR CYCLE 2: Fix payment processing
   └── Commit: "tcr: hotfix payment processing failure"

🔍 Quality Review (extra scrutiny for hotfix):
   ├── Is this the minimal safe fix?
   ├── Is there a safer workaround?
   └── Should we roll back instead?
```

## Escalation Rule

Switch from `minor-ship` to `story-ship` when:

- the issue turns into multiple shippable Actions
- the change touches multiple domains or risky integrations
- project tracking and backlog state now matter
- the user asks for a full story-driven loop

## TCR Recovery

If TCR repeatedly fails (3+ attempts on same micro-step):

```
1. Revert to clean state
2. Re-examine: Is this really a "minor" fix?
3. If not → Escalate to story-ship
4. If yes → Break into smaller micro-steps
```
