# Project Agents Configuration

## Workspace Configuration

### Plan Documents Location
**All Plan documents must be stored under the project directory. Writing to the `.kimi/` directory is prohibited.**

```yaml
# Plan file storage configuration
plans:
  base_dir: docs/plans/          # Relative to the project root
  auto_create: true              # Auto-create directory if it doesn't exist
  naming_convention: "{topic}.md" # Naming convention
```

**Rules:**
1. **Preferred location**: `{project_root}/docs/plans/`
2. **Auto-create**: If `docs/plans/` doesn't exist, create the directory automatically
3. **Prohibited location**: Absolutely no writing to `~/.kimi/` or any global config directory
4. **Non-project Plans**: Only allowed to use a temporary location when there is no project context

**Examples:**
- ✅ `my-project/docs/plans/auth-system.md`
- ✅ `my-project/docs/plans/api-redesign.md`
- ❌ `~/.kimi/skills/some-plan.md`
- ❌ Any global location outside the project

## Workflow

### Design → $wk-design
- Solution exploration, architecture design
- Split into Stories
- Write to BACKLOG.md

### Build → $wk-story-build / $wk-fix-build / $wk-roll-build
- Read BACKLOG and execute
- TCR development (independent Actions auto-parallelized + Worktree isolation)
- CI/CD deployment

### Check → $wk-sentinel / $wk-bb-debug
- Sentinel: Scheduled patrol
- wk-bb-debug: Deep diagnosis

### Fix → $wk-fix-build / $wk-design
- Fix issues
- Or re-plan

## Architecture Constraints

### Agent First
- System designed for AI Agents
- Agent is the primary user
- UI is only a supplementary interface

### Data Schema
- Clear data structure definitions
- Type/Schema is the contract between humans and Agents
- Define Schema first, then write business logic

### Domain Driven
- Model by business domain
- Not database table design
- Help Agents understand the business

### Decoupling Rules
- UI layer only handles rendering; logic lives in Hooks
- API calls encapsulated in services/
- Shared types placed in shared/types/

### Testing Requirements
- All business logic must have unit tests
- APIs have integration tests
- Critical flows have E2E tests
- Sentinel runs periodic regression tests

## Conventions

- All work tracked in BACKLOG.md
- Sentinel patrols every 6 hours
- TCR required for all changes
