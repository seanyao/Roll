---
name: cnx-story-build
description: Execute User Story from backlog. Reads US from BACKLOG.md, splits into Actions, delivers via TCR workflow through commit + push + CI + deploy + verification. Updates backlog status on completion.
---

# Story Ship (TCR Edition)

Use this skill to turn "development" into "delivery" by enforcing a tight, repeatable shipping loop per User Story / Action using **TCR (Test && Commit || Revert)** workflow.

This skill is intentionally narrow and strict. It does not provide domain knowledge; it enforces delivery rhythm with atomic, test-guaranteed commits.

## Trigger

Use when the user asks for any of:

- "执行 backlog 里的 US-XXX"
- "开始 User Story XXX"
- "开发 [backlog 中已有的功能]"
- shipping a US from backlog end-to-end

**Workflow:**
1. Read BACKLOG.md → Find specified US
2. Split US into Actions
3. Execute via TCR workflow
4. Update BACKLOG.md on completion

Do not use for:

- one-line changes or tiny local refactors (use `cnx-fix-build`)
- pure investigation without landing code
- experiments that are explicitly not meant to deploy

## Hard Rules

1. **No local-only "done"**
   If this skill is used, the work is not complete until it reaches:
   - commit (via TCR micro-steps)
   - push
   - CI signal (pass or known exception explicitly stated)
   - deploy
   - online verification
   - project status/backlog update

2. **Always split into Story → Action**
   Do not take a vague large request and implement it in one go.
   Always state:
   - Current User Story
   - Current Action (smallest shippable step)
   - Acceptance criteria / completion standard for this Action

3. **Test Design Review before any implementation**
   - Design test scenarios and edge cases first
   - Run `code-reviewer` on test design to verify coverage
   - TCR only works if tests are correct — validate test design early

4. **TCR for every micro-step**
   - Each behavior change follows: Test → Green=Commit / Red=Revert
   - Each commit is a guaranteed working state
   - Accumulate 3-5 micro-commits per Action
   - No "WIP" commits, no broken commits

5. **Every step must be shippable**
   Each Action must be:
   - independently deployable
   - non-breaking to existing behavior
   - safe to stop after completion

6. **Commit is blocked by quality review (post-TCR)**
   After TCR cycles complete:
   - Run `code-reviewer` skill on the Action's diff
   - Review focuses on **quality** (not correctness — TCR guarantees that)
   - blocking findings (Critical issues) must be fixed via new TCR cycle
   - after meaningful fixes, rerun quality review

7. **Always write back project status**
   At the end of each shipped Action, update at least:
   - `progress/status.md` (or the repo's status file)
   - backlog item status (or a clearly named backlog file)
   - any minimal notes needed for the next Action

If these files do not exist in the repo, create the minimal equivalents as part of the first Action.

## TCR Workflow (One Action Loop)

For each loop, the agent must produce the artifacts listed below and then execute the loop end-to-end.

### 1. Clarify and lock the Story
   - define user value and scope boundary
   - list non-goals (what will not be done in this Action)

### 2. Split into Actions
   - write 2-6 candidate Actions
   - pick the smallest shippable Action

### 3. Define verification
   - test matrix (at least: happy path + one edge/failure/regression where relevant)
   - what "online verification" means for this repo (URL, endpoint, UI flow, log signal)
   - reference `$cnx-qa-cover` for test pyramid strategy (unit/E2E/visual/smoke)

### 4. Test Design Review (NEW - TCR Core)

```
🧪 Test Design for Action: {Action name}
   
   Scenarios:
   ├── {Happy path scenario}
   ├── {Edge case scenario}
   └── {Failure/regression scenario}
   
   Test Types:
   ├── Unit tests for: {logic components}
   ├── Integration tests for: {API flows}
   └── Manual verification for: {UI/visual elements}
```

**Reference `$cnx-qa-cover` for test strategy:**
- Unit tests for: {logic components} - see `$cnx-qa-cover` Unit Tests section
- E2E tests for: {user flows} - see `$cnx-qa-cover` E2E Tests section
- Visual regression for: {UI stability} - see `$cnx-qa-cover` Visual Regression section

**Run self-review on test design:**
- Check: Are we testing the right things?
- Check: Are edge cases covered?
- Check: Are tests independent and deterministic?

**Output**: Approved test design or revisions needed

### 5. TCR Implementation (Micro-Step Loop)

```
┌─────────────────────────────────────────────────────────────────────┐
│ TCR IMPLEMENTATION                                                   │
│ For each micro-step in the Action:                                  │
└─────────────────────────────────────────────────────────────────────┘

MICRO-STEP {N}: {description}

   Step 1: Write/Update Test
      └── Run test → Confirm RED
   
   Step 2: Implement Minimal Code
      └── Write just enough to pass
   
   Step 3: TCR Decision
      └── Run test
          ├── ✅ GREEN → git commit -m "tcr: {description}"
          └── ❌ RED   → git checkout -- . → Retry
   
   Step 4: Refactor (optional, while green)
      └── Run test → ✅ GREEN → Amend or continue
```

**Accumulate 3-5 micro-commits per Action.** Each commit is a guaranteed working state.

### 6. Local Integration Check (Pre-Push CI Gate)
After all micro-steps, run full CI locally before push:

```bash
# Run local CI (format + lint + build + test)
npm run ci:local 2>/dev/null || (npm run lint && npm run build && npm test -- --run)
```

**Reference `$cnx-qa-cover` for coverage requirements:**
- Unit test coverage threshold
- E2E test critical path coverage
- Visual regression baseline check

**Result:**
```
├── ✅ All pass → Continue to push
└── ❌ Failures → TCR cycle to fix (new micro-step)
   ├── Run 'npm run ci:fix' for auto-fixable issues
   ├── Fix remaining errors
   └── Re-run ci:local until green
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

**Setup pre-push hook (recommended):**
```bash
cat > .git/hooks/pre-push << 'EOF'
#!/bin/bash
echo "🔍 运行本地 CI 检查..."
if ! npm run ci:local 2>/dev/null && ! (npm run lint && npm run build); then
    echo "❌ CI 检查失败，推送已阻止"
    exit 1
fi
echo "✅ CI 检查通过"
EOF
chmod +x .git/hooks/pre-push
```

### 7. Quality Review (Post-TCR)

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
- 🎯 **Code Quality**: Naming clarity, DRY, function size, readability
- 📐 **Design & Architecture**: Abstraction level, separation of concerns
- ⚠️ **Scope Discipline**: No opportunistic changes
- 📝 **Documentation**: Comments where needed

**Decision:**
```
🔴 Critical > 0 → Fix via new TCR cycle → Re-review
🟡 Warnings > 0 → Fix if quick (< 5 min) or document
🟢 Suggestions only → Proceed, consider for future
✅ All clear → Proceed to push
```

**Note:** `code-reviewer` placeholder replaced with `$cnx-.code-review` for local execution without external dependencies.

### 8. Commit and push

```bash
# All TCR micro-commits are already made
# Squash or keep as-is based on repo convention

git log --oneline -{n}  # Review TCR commits

# Push to remote so CI runs
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

### 9. Watch CI and resolve

```
⏳ CI Running...
   ├── ✅ PASS → Proceed to deploy
   └── ❌ FAIL → 
       ├── Diagnose failure
       ├── Create new TCR micro-step to fix
       └── Retry CI
```

Do not claim delivery until CI is green (or the exception is explicitly accepted by the user).

### 10. Deploy

Follow the repo's deployment path (e.g. Vercel) and record the deployed target.

### 11. Runtime verification

Perform the agreed verification in the runtime environment:
- For **Web apps**: verify on deployed URL (happy path, edge cases, no regression)
- For **CLI tools**: verify via command execution (`kkb ingest && kkb compile`)
- For **Libraries**: verify via test usage or example scripts
- confirm happy path works
- confirm edge case handled
- confirm no regression for previously working paths

### 12. Write back status/backlog (REQUIRED)

**Update BACKLOG.md with strict format:**

```markdown
### US-{ID} {Story 名称} ✅
**Completed**: {YYYY-MM-DD}

- As a {角色}
- I want {需求}
- So that {价值}

**AC:**
- [x] {完成的验收标准1}
- [x] {完成的验收标准2}

**Files:**
- `{新增/修改的文件1}`
- `{新增/修改的文件2}`

**Dependencies:**
- 依赖: {前置 US-XXX}
- 被依赖: {后续 US-XXX}
```

**Must also update:**
- `progress/status.md` - 当前 Action 完成状态
- 指标统计（Completed Stories 计数等）
- Next Action 候选

**If BACKLOG.md doesn't exist, create it.**

### 13. Report

Summarize:
- shipped behavior
- TCR statistics (micro-commits, any reverts)
- quality review outcome
- verification performed
- next Action

## Required Artifacts (per Action)

The agent must explicitly output (in text) before or during execution:

- **Current User Story**: 1-3 sentences, INVEST-lean (independent and testable)
- **Current Action**: smallest shippable increment
- **Acceptance criteria**: measurable outcomes for this Action
- **Write scope**: what files/areas are expected to change
- **Test Design**: scenarios, edge cases, test types
- **Test Design Review**: coverage validation results
- **TCR Log**: micro-step descriptions and commit count
- **Quality Review**: post-TCR code review results
- **Deployment target**: where it will be verified

## Definition of Done (per Action)

An Action is only "done" when all are true:

- [ ] Story and Action clearly defined
- [ ] Test design reviewed and approved
- [ ] **TCR cycles completed** (all micro-steps via Test && Commit)
- [ ] All commits are green states (no broken commits in history)
- [ ] Local integration tests pass
- [ ] Quality review (code-reviewer) passed, blocking issues resolved via TCR
- [ ] Changes pushed to remote
- [ ] CI is green (or explicit, recorded exception exists)
- [ ] Deployment completed
- [ ] Online verification performed
- [ ] **BACKLOG.md updated with US-{ID}** (REQUIRED - not optional)

## TCR in CI Failure Recovery

When CI fails after push:

```
1. Diagnose: Is it environment-specific or real failure?
   
2. If real failure:
   ├── Revert to pre-push state: git reset --soft HEAD~{n}
   ├── Create TCR micro-step to fix the issue
   ├── Run local test to verify fix
   ├── TCR commit the fix
   └── Push again

3. If environment-specific:
   ├── Document the exception
   ├── Get user approval to proceed
   └── Record in status
```

## Recommended Pairing

- Use `cnx-fix-build` when the work is a single small shipped fix, hotfix, or enhancement and backlog tracking is unnecessary.
- Use `$plan` when the Story is unclear or the Action split is ambiguous.
- Use `$testing-quality-gate` when the repo needs stronger gates added.

## Example TCR Flow

### Example: User Story with Multiple Actions

```
User: "Add user authentication to the app"

🎯 Story: Users can sign up and log in to access protected content

📋 Actions identified:
   1. Add login form UI (this Action)
   2. Implement login API endpoint
   3. Add session management
   4. Protect routes with auth guard

═══════════════════════════════════════════════════════════════
ACTION 1: Add login form UI
═══════════════════════════════════════════════════════════════

🧪 Test Design:
   ├── Happy: Form renders with email/password fields
   ├── Edge: Form validates empty inputs
   └── Edge: Form shows loading state during submit

🔍 Test Design Review: Approved

┌──────────────────────────────────────────────────────────────┐
│ TCR MICRO-STEPS                                               │
└──────────────────────────────────────────────────────────────┘

MICRO-STEP 1: Login form skeleton
   [Test: Form renders → Fail → Implement → Pass → Commit]
   → git commit -m "tcr: add login form component skeleton"

MICRO-STEP 2: Email/password inputs
   [Test: Inputs render with correct types → Fail → Implement → Pass → Commit]
   → git commit -m "tcr: add email and password input fields"

MICRO-STEP 3: Form validation
   [Test: Empty inputs show error → Fail → Implement → Pass → Commit]
   → git commit -m "tcr: implement form validation"

MICRO-STEP 4: Submit handler
   [Test: Submit calls onSubmit callback → Fail → Implement → Pass → Commit]
   → git commit -m "tcr: add form submit handler"

MICRO-STEP 5: Loading state
   [Test: Shows loader during submit → Fail → Implement → Pass → Commit]
   → git commit -m "tcr: add loading state to login form"

🔍 Quality Review:
   ├── ✅ Correctness: All scenarios verified by TCR
   ├── 🎯 Quality: Extract validation logic, consistent naming
   └── No blocking issues

⏳ CI: ✅ PASSED
🚀 Deployed: https://app.vercel.app/login
✅ Online Verification: Form renders, validates, submits correctly
📝 Status Updated: Action 1 complete

═══════════════════════════════════════════════════════════════
ACTION 2: Implement login API endpoint
═══════════════════════════════════════════════════════════════
[Continue with TCR workflow...]
```
