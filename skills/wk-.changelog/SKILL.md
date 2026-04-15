---
hidden: true
name: cnx-.changelog
description: After build completion, extracts completed Stories from BACKLOG.md to generate CHANGELOG.md. Auto-triggered after successful deploy, keeping the external changelog in sync with the internal backlog.
---

# CNX Generate Changelog

After successful Build & Deploy, extracts completed Stories from BACKLOG.md to generate a user-friendly `CHANGELOG.md`.

## When Triggered

- **Auto-triggered**: After successful deploy of `$cnx-story-build` or `$cnx-fix-build`
- **Manual trigger**: When user requests "update changelog" or "generate release notes"

## Workflow

### 1. Read BACKLOG.md

```
Read BACKLOG.md from the project root directory.
Extract Stories with status ✅ Completed / Done.
```

### 2. Filter for External Content

**Remove internal information:**
- Progress tables, completion percentages
- "As a / I can / So that" format
- Detailed AC checklists
- Technical debt, internal file paths
- Test case counts, architecture diagrams

**Keep user-facing value:**
- New features (one-sentence description)
- Bug fixes (user-visible impact)
- UX improvements (layout, interaction enhancements)
- Performance/reliability improvements

### 3. Version Number Format

```
YYYY.MM.DD
YYYY.MM.DD-1  (multiple releases on the same day)
YYYY.MM.DD-2
```

### 4. Generate CHANGELOG.md

```markdown
# Changelog

## 2026.04.03
- **Added**: <completed feature extracted from BACKLOG>
- **Fixed**: <resolved bug>
- **Improved**: <UX/performance optimization>

## 2026.04.01
- ...
```

**Ordering**: Most recent version first (reverse chronological)

### 5. Commit Update

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for release $(date +%Y.%m.%d)"
git push
```

## Integration

After successful deploy in `$cnx-story-build` / `$cnx-fix-build` / `$cnx-roll-build`:

```markdown
**Post-Deploy:**
- `$cnx-changelog` - Sync external changelog
```
