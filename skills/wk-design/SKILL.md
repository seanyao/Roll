---
hidden: true
name: wk-design
description: Unified entry for discussion, design and planning. Explores options when uncertain, designs solutions, splits into INVEST-compliant user stories, and writes to BACKLOG.md. Use when user wants to discuss approaches, design solutions, plan features, or create stories.
---

# Design

> Follows the Architecture Constraints, Development Discipline, and Engineering Common Sense defined in the project AGENTS.md.

Discuss approaches, design architecture, plan requirements, and write to `BACKLOG.md`.

## When to Use

- Requirements or approach are uncertain and multiple options need to be compared
- Requirements have not yet entered the backlog
- A solution needs to be designed before splitting into Stories
- An existing plan needs to be written into `BACKLOG.md`

## Use This Skill For

- Approach exploration and comparison (discuss phase)
- New requirement planning
- Solution design
- Splitting into Stories
- Creating US / FIX entries

## Quick Start

```bash
# Approach is uncertain → discuss first, then plan
$wk-design "What approach should we use for search? Postgres FTS or Meilisearch?"

# Plan new requirement → design solution → split into Stories → write to BACKLOG
$wk-design "user system design"

# Split Stories from an existing Plan
$wk-design --from-plan docs/features/auth-plan.md

# Directly create a Story
$wk-design --story "user login feature"
```

## Workspace Configuration

Document structure (two-layer separation):

```
BACKLOG.md                        # US index page (status + one-liner + link)
docs/features/
  <feature>.md                    # US details (AC / Files / Dependencies)
  <feature>-plan.md               # Design document (why / how)
```

**Important rules:**
1. Plan files go in `docs/features/<feature>-plan.md` (**no longer using** `docs/plans/`)
2. US details go in the corresponding `docs/features/<feature>.md`
3. BACKLOG.md only contains index rows (one row per US), **do not write** AC / Files / Notes
4. **Do not** write to `~/.kimi/` or any global config directory

**File path resolution order:**
1. Determine Feature ownership (based on the requirement domain: compiler / ingest / qa / ...)
2. Feature file: `docs/features/<feature>.md` (create if it doesn't exist)
3. Plan file: `docs/features/<feature>-plan.md` (create if it doesn't exist)
4. BACKLOG.md index row goes under the corresponding Epic > Feature group

## Workflow

```
User: "Help me design the user system" / "What approach should we use for search?"
    │
    ▼
┌─────────────────────────────┐
│ 0. Discuss (when uncertain) │  ← Automatically triggered when approach is uncertain
│    - List 2-4 viable options │
│    - Each: approach + pros/cons │
│    - Comparison matrix       │
│    - Recommendation + rationale │
│    - Human makes final decision │
└─────────────┬───────────────┘
              │ Approach confirmed
              ▼
┌─────────────────────────────┐
│ 1. Understand & Analyze     │
│    - Requirement analysis    │
│    - Feasibility assessment  │
│    - Technical solution design │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 2. Solution Design          │
│    - Architecture design     │
│    - Module decomposition    │
│    - Dependency analysis     │
│    - Write to docs/features/ │
│      <feature>-plan.md       │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 3. Split into Stories       │
│    - INVEST principles       │
│    - DDD domain splitting    │
│    - Priority ordering       │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 4. Write to BACKLOG.md      │
│    - Create US-XXX           │
│    - Define AC               │
│    - Link design documents   │
└─────────────┬───────────────┘
              │
              ▼
    "Confirm and execute?"
    │
    ├── Yes ──→ $wk-story-build US-XXX
    │
    └── No  ──→ Wait for user confirmation
```

**Discuss phase trigger conditions** — automatically enters if any of these are met:
- User is explicitly asking "how to choose" or "what approach to use"
- More than 2 viable technical paths exist
- Requirement involves an unfamiliar tech stack or new domain

**Discuss phase can stop at any time** — if after discussion the user says "let's not do it" or "let me think about it", there's no need to continue to the planning phase.

**Operation sequence for creating a new Story:**

```bash
# 1. Determine Feature ownership (e.g., compiler / ingest / qa)
FEATURE="compiler"

# 2. Write Plan document (if there is a solution design)
PLAN_FILE="docs/features/${FEATURE}-plan.md"

# 3. Append US section in docs/features/<feature>.md (with full AC)
FEATURE_FILE="docs/features/${FEATURE}.md"

# 4. Append index row under the corresponding Epic > Feature group in BACKLOG.md
# | [US-XXX](docs/features/compiler.md#us-xxx) | One-line description | 📋 Todo |
```

## Story Format

**BACKLOG.md index row (only write this one line):**

```markdown
| [US-{DOMAIN}-{N}](docs/features/<feature>.md#us-{domain}-{n}) | {one-line description} | 📋 Todo |
```

**US section in docs/features/\<feature\>.md (full details):**

```markdown
<a id="us-{domain}-{n}"></a>
## US-{DOMAIN}-{N} {Story Title} 📋

**Created**: {YYYY-MM-DD}
**Plan**: [{feature}-plan.md]({feature}-plan.md)  ← if a design document exists

- As a {role}
- I want {action}
- So that {benefit}

**AC:**
- [ ] {measurable criteria 1}
- [ ] {measurable criteria 2}
- [ ] {measurable criteria 3}

**Files:**
- `{file1}`
- `{file2}`

**Dependencies:**
- Depends on: {prerequisite US-XXX}
- Depended on by: {subsequent US-XXX}

**Data Flow (if applicable):**
- Producer: {which module writes data}
- Consumer: {which module reads data}
- Integration test: `tests/integration/{flow}.test.ts`
```

## Integration

### With story-build

```
$wk-design "login feature" → Create US-AUTH-001
User: "Execute US-AUTH-001"
    ↓
$wk-story-build US-AUTH-001 → TCR → CI/CD → Deploy
```

### With fix-build

```
$wk-bb-debug discovers issue → Suggest creating FIX
$wk-design --fix "fix login API 404" → Create FIX-AUTH-001
$wk-fix-build FIX-AUTH-001 → Quick fix
```

## INVEST Principles

Each story must be:
- **Independent**: Can be implemented independently
- **Negotiable**: Scope is negotiable
- **Valuable**: Provides value to the user
- **Estimable**: Effort can be estimated
- **Small**: Small enough for fast delivery
- **Testable**: Can be tested and verified

## Backlog Structure

```markdown
# Project Backlog

## Epic Name
### Feature Name
| Story | Description | Status |
|-------|-------------|--------|
| [US-XXX](docs/features/<feature>.md#us-xxx) | One-line description | 📋 Todo |
| [US-YYY](docs/features/<feature>.md#us-yyy) | One-line description | ✅ Done |
```

**Note**: BACKLOG.md only contains index rows; full AC / Files / Dependencies go in `docs/features/<feature>.md`.
