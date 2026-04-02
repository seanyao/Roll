---
name: cnx-roll-build
description: Convert vague one-sentence request into stories, insert into BACKLOG.md, then execute like cnx-story-build. Auto-clarifies, plans, splits into US/Actions, delivers via TCR workflow.
---

# Roll (TCR Edition)

Convert vague one-sentence requests into structured stories and execute.

Unlike `story-build` (reads existing US from backlog) or `fix-build` (reads existing FIX), `roll-build` **creates** the stories first, inserts them into BACKLOG.md, then executes like `story-build`.

## Trigger

Use when the user asks:

- "帮我加个登录功能" (vague, no US exists)
- "这个页面有点问题修一下" (no BUG exists)
- "把这个改成异步的"
- "重构一下这个模块"
- Any vague, one-line request without clear scope

**Workflow:**
1. Clarify & analyze the vague request
2. Create US/Actions (insert into BACKLOG.md)
3. Execute via TCR workflow (same as cnx-story-build)
4. Update BACKLOG.md on completion

Do not use for:

- Explicit "ship this to prod" requests (use `cnx-story-build`)
- Single obvious one-liners that are clearly tiny (use `cnx-fix-build`)
- Pure investigation without code changes

## Core Philosophy

1. **Clarity over assumptions** — When scope is unclear, clarify first
2. **Just enough planning** — Plan to the level the uncertainty demands
3. **TCR rhythm** — Test-first, micro-steps, auto-commit on green, auto-revert on red
4. **Push to GitHub** — Complete implementation, commit, and push; code is on remote
5. **Stay reversible** — Every micro-step leaves the repo in a clean, green state

## TCR Workflow

### The Core Loop

```
┌─────────────────────────────────────────────────────────────┐
│  TCR CYCLE (Test && Commit || Revert)                        │
│  ─────────────────────────────────────                       │
│                                                              │
│  1. Define micro-step (smallest testable change)             │
│  2. Write/update test for this micro-step                    │
│  3. Run test                                                 │
│       ├── ✅ PASS → Auto-commit the micro-step               │
│       └── ❌ FAIL → Auto-revert to last green state          │
│                       ↓                                      │
│                  Retry with new approach                     │
└─────────────────────────────────────────────────────────────┘
```

**Key Principle**: Each commit represents a **guaranteed working state**. No "WIP" commits, no broken commits.

## Adaptive Workflow

### Phase 1: Clarify & Test Design Review (Always)

Before any code, output:

```
🎯 Clarified Goal: {1-2 sentences capturing user intent}
📏 Complexity Assessment: {small|medium|large}
🔍 Uncertainty Areas: {list what needs investigation/decision}
```

**Complexity Rules (AI Coding Time):**

- **Small** (≤3 files, 5-15 min, single concern) → Skip detailed planning, implement directly
- **Medium** (crosses modules, needs trade-offs, 15-30 min) → Mini-plan then implement  
- **Large** (multi-step, architectural, 30-60 min+) → Full plan + split into Actions

### Phase 2: Test Design Review (NEW - TCR Addition)

**Before writing implementation code, design and review the tests:**

```
🧪 Test Design:
   ├── Test scenarios: {what to test}
   ├── Edge cases: {boundary conditions}
   └── Verification method: {unit|integration|manual script}
```

**Reference `$cnx-qa-cover` for test strategy:**
- Follow `$cnx-qa-cover` test pyramid (unit → E2E → visual → smoke)
- Each created US should define its test coverage requirements

**Run self-review on test design:**
- Review focus: Coverage completeness, edge case identification

**Why**: Catch "testing the wrong thing" early. TCR only guarantees the code passes tests — we must ensure tests are correct first.

### Phase 3: TCR Implementation Loop

**For each micro-step, follow strict TCR:**

```
┌────────────────────────────────────────────────────────────┐
│ MICRO-STEP {N}: {description of smallest testable change}   │
└────────────────────────────────────────────────────────────┘

Step 1: Write/Update Test
   └── Run test → Confirm RED (test fails as expected)

Step 2: Implement
   └── Write minimal code to make test pass

Step 3: TCR Decision
   └── Run test
       ├── ✅ GREEN → "git commit -m 'tcr: {micro-step description}'"
       └── ❌ RED   → "git checkout -- ." (revert) → Retry

Step 4: Refactor (if needed, while staying green)
   └── Run test → ✅ GREEN → Amend commit or new TCR cycle
```

**Micro-Step Guidelines:**

| Change Type | Typical Micro-Steps |
|-------------|---------------------|
| Logic/algorithm | 1 function = 1-2 micro-steps |
| API endpoint | Route → Handler → Validation → Response |
| UI component | Skeleton → Props → Interaction → Styling |
| Bug fix | Regression test → Fix → Verify |
| Refactor | Extract method → Update calls → Remove old |

### Phase 4: Pre-Push Quality Gate (NEW - CI Check)

Before pushing, run local CI checks to catch issues early:

```bash
# Check if project has CI scripts
if package.json has "ci:local" script:
   npm run ci:local  # format + lint + build + test
else:
   npm run lint && npm run build && npm test -- --run
```

**Reference `$cnx-qa-cover` for coverage requirements:**
- Unit test coverage threshold
- E2E test critical path coverage
- Visual regression baseline check

**If CI fails locally:**
```
❌ 本地 CI 检查失败
   ├── 运行 'npm run ci:fix' 或 'npm run format' 自动修复
   ├── 修复 lint/build/test 错误
   └── 重新运行检查直到通过
```

**Set up pre-push hook (one-time per repo):**
```bash
# .git/hooks/pre-push
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

**Add CI scripts to package.json (if not exists):**
```json
{
  "scripts": {
    "ci:local": "npm run format:check && npm run lint && npm run build && npm run test -- --run",
    "ci:fix": "npm run format && npm run lint -- --fix"
  }
}
```

**Remote CI failure notification:**
GitHub automatically sends email notifications for failed Actions if enabled in user settings.
No extra configuration needed in workflow.

### Phase 5: Pre-Push Code Review

After CI passes locally:

**Run self-code-review on staged changes:**

```bash
$self-code-review staged
```

**Review Output:**
```
🔍 Self Review Report
├── Scope: X files (+Y/-Z lines)
├── 🔴 Critical: N issues (must fix)
├── 🟡 Warnings: N issues (should fix)
├── 🟢 Suggestions: N items (optional)
└── ✅ Passed dimensions: [Quality, Design, Scope, ...]
```

**Review Focus (post-TCR):**
- ✅ **Correctness**: Assumed verified by TCR
- 🎯 **Quality**: Naming, patterns, DRY, readability
- 📐 **Design**: Architecture, abstraction level
- ⚠️ **Scope**: No opportunistic changes

**Decision:**
```
🔴 Critical > 0 → Fix via new TCR cycle → Re-review
🟡 Warnings > 0 → Fix if quick (< 5 min) or document
🟢/✅ All clear → Proceed to push
```

**Note**: `code-reviewer` placeholder replaced with `$self-code-review` for local execution without external dependencies.

### Phase 6: Update BACKLOG.md (REQUIRED)

**Every change must be recorded in BACKLOG.md:**

```markdown
### US-XXX-{N} {简短描述} ✅
**Completed**: {YYYY-MM-DD}

- As a {角色}
- I want {需求}
- So that {价值}

**AC:**
- [x] {完成的验收标准}

**Files:**
- `{修改的文件}`
```

**Rules:**
- 如果是新功能 → 添加到 "Completed Stories" 或 "In Progress"
- 如果是 bug 修复 → 添加到 "🐛 Bug Fixes" 表格
- 如果涉及多个文件 → 列出所有关键文件
- 如果创建了新的 Plan → 链接到 `docs/plans/`

### Phase 7: Commit & Push

```bash
# All TCR micro-commits are already made
# Squash or keep as-is based on repo convention

git log --oneline -{n}  # Review TCR commits

# Push to remote so CI runs
git pull origin main --rebase
git push origin main
```

### Phase 8: Watch CI & Deploy

**Watch CI:**
```
⏳ CI Running...
   ├── ✅ PASS → Proceed to deploy
   └── ❌ FAIL → 
       ├── Diagnose
       ├── TCR cycle to fix
       └── Push and retry
```

**Deploy:**
Follow repo's deployment path (Vercel/Railway/etc).

**Online Verification:**
- Confirm happy path works
- Confirm edge cases handled
- Confirm no regression

### Phase 9: Update BACKLOG & Report

```bash
# Update BACKLOG.md with completion status
git add BACKLOG.md
git commit -m "docs: mark US-XXX-{N} as completed"
git push
```

**Celebrate & Output Summary:**

```
✅ Pushed to GitHub: origin/main
🚀 Deployed: <url>
✅ Verified: <what was checked>
📦 Changes: <summary>
🔢 Commits: <count> micro-commits via TCR
🧪 Tests: <what tests were added/modified>
📊 TCR Stats: <success rate, revert count if any>
📋 Review Gate: <self-review findings summary>
📝 BACKLOG: Updated with US-XXX-{N}

🔄 Next Options:
1. Continue to next Action (if Story has more)
2. Start next US (if created multiple from vague request)
3. Done (if all completed)
```

## Hard Rules

1. **TCR is non-negotiable**
   - Every micro-step must follow: Test → Green=Commit / Red=Revert
   - No "I'll fix it in the next step" — revert and retry
   - Each commit is a guaranteed working state

2. **Test Design Review before implementation**
   - Review test coverage before writing implementation
   - Ensure tests verify the right behavior
   - TCR only works if tests are correct

3. **Micro-steps only**
   - If a step feels "a bit complex", split it
   - Each micro-step should be completable in 1-3 minutes
   - Prefer 5 small commits over 1 medium commit

4. **Complete delivery like cnx-story-build**
   - Code reaches GitHub (`git push origin main`)
   - CI passes (or explicitly handled failures)
   - Deployed to production
   - Online verification performed
   - User can choose to batch multiple Actions before deploy/verify

5. **Pre-push self-review required**
   - Run `$self-code-review staged` on final diff
   - Fix blocking (Critical) issues via TCR cycle
   - Review focuses on quality, not correctness

6. **No hidden work**
   - Every file changed must relate to current Action
   - No "while I'm here" refactors unless in separate TCR cycle

## Definition of Done (per Action)

- [ ] Goal clarified and complexity assessed
- [ ] Test design reviewed (coverage and edge cases)
- [ ] **TCR cycles completed** (all micro-steps committed via Test && Commit)
- [ ] All micro-commits are green states (no broken commits)
- [ ] Local CI checks passed (format + lint + build + test)
- [ ] Self-code-review passed, blocking issues fixed via TCR
- [ ] Pushed to GitHub (`origin/main`)
- [ ] CI is green (or explicit, recorded exception)
- [ ] Deployed to production
- [ ] Online verification performed
- [ ] BACKLOG.md updated with completion status
- [ ] Summary reported to user

## TCR Recovery Patterns

### Pattern 1: Red After Multiple Attempts

```
If same micro-step fails 3 times:
   1. Revert to clean state
   2. Escalate planning: "This micro-step is actually medium complexity"
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
   2. Go back to Phase 2 (Test Design Review)
   3. Update test design
   4. Resume TCR cycles
```

### Pattern 4: Complex State vs Simple Reset

**真实案例**: 游戏关卡切换导致黑屏/卡死

```
初始方案（复杂，有 Bug）:
nextLevel() {
  this.level++;
  this.saveProgress();      // 状态保存
  this.resetState();        // 部分重置
  this.initLevel();         // 初始化
  this.updateUI();          // UI 更新
  // 多步骤容易出错，状态不一致导致 Infinity
}

简化方案（可靠）:
onLevelComplete() {
  showConfetti(3000);       // 庆祝动画
  
  setTimeout(() => {
    this.level++;
    localStorage.setItem('level', this.level);
    this.initLevel();       // 完全重新初始化
  }, 2000);
}

结果: 代码减少 60%，Bug 归零
```

**决策原则**:
- 如果复杂状态管理容易出错 → 考虑完全重置 + 重新初始化
- 用户体验不应被技术复杂度绑架
- 有时"闪一下"的重置比"卡顿的过渡"更好

## When to Escalate

Switch to `story-ship` when:
- User explicitly asks for "ship to production"
- Multiple Actions must be coordinated for remote release
- Project tracking/backlog updates are required

Switch to `minor-ship` when:
- The issue turns out to be a single obvious one-liner
- No planning uncertainty remains after clarification

## Example TCR Flow

### Example: Small Fix

```
User: "这个按钮颜色不对"

🎯 Clarified Goal: Fix button color on login page
📏 Complexity Assessment: Small (1 file, ~5 min)

🧪 Test Design:
   ├── Scenario: Button renders with correct color
   └── Verification: Visual check + CSS property assertion

🔍 Test Design Review: Approved (single property change)

┌────────────────────────────────────────────────────────┐
│ MICRO-STEP 1: Update button background color            │
└────────────────────────────────────────────────────────┘

Step 1: Write test (verify color property)
   └── Run test → ❌ RED (expected, color is wrong)

Step 2: Implement (change CSS value)
   └── Update background-color: #667eea

Step 3: TCR
   └── Run test → ✅ GREEN
   └── git commit -m "tcr: fix login button background color"

🔍 Pre-push Code Review:
   ├── ✅ Correctness: Verified by test
   ├── 🎯 Quality: Color constant used, readable
   └── No blocking issues

✅ Committed: a1b2c3d (1 TCR cycle)
🚀 Pushed: origin/main
📦 Changes: Updated primary button color from #333 to #667eea
🧪 Tests: CSS property assertion added
🔢 Commits: 1 micro-commit
```

### Example: Medium Feature with Multiple TCR Cycles

```
User: "加个搜索功能"

🎯 Clarified Goal: Add product search to catalog page
📏 Complexity Assessment: Medium (UI + state, ~20 min)

🧪 Test Design:
   ├── Scenario 1: Search input renders
   ├── Scenario 2: Input change triggers search callback
   ├── Scenario 3: Debounce prevents excessive calls (300ms)
   └── Scenario 4: Loading state displays during search

🔍 Test Design Review: Approved

┌────────────────────────────────────────────────────────┐
│ MICRO-STEP 1: SearchBar component skeleton              │
└────────────────────────────────────────────────────────┘
[Write render test → Fail → Implement skeleton → Pass → Commit]
→ git commit -m "tcr: add SearchBar component skeleton"

┌────────────────────────────────────────────────────────┐
│ MICRO-STEP 2: Search input with change handler          │
└────────────────────────────────────────────────────────┘
[Write interaction test → Fail → Implement handler → Pass → Commit]
→ git commit -m "tcr: implement search input with change handler"

┌────────────────────────────────────────────────────────┐
│ MICRO-STEP 3: Debounce logic                            │
└────────────────────────────────────────────────────────┘
[Write timing test → Fail → Implement debounce → Pass → Commit]
→ git commit -m "tcr: add 300ms debounce to search input"

🔍 Pre-push Code Review:
   ├── ✅ Correctness: All scenarios verified
   ├── 🎯 Quality: Extract debounce to utils/, consistent naming
   └── No blocking issues

✅ Pushed: origin/main
📦 Changes: SearchBar component with debounced input
🧪 Tests: SearchBar.test.js (4 test scenarios)
🔢 Commits: 3 micro-commits via TCR
```

## Artifacts

No required status files. Optional:
- `notes/dev-log.md` — if user wants to track progress across sessions
- Inline code comments — for decisions made during implementation
- TCR log — optional record of revert reasons for learning
