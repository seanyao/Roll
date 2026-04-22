---
hidden: true
name: roll-.changelog
description: 'Auto-triggered after successful deploy of roll-build or roll-fix to regenerate user-facing CHANGELOG.md from BACKLOG completed Stories. Triggers: automatic post-deploy, or manual "update changelog", "生成 release notes", "refresh CHANGELOG". Flow: read most recent git tag (YYYY.MMDD.N via git describe) → scan BACKLOG for ✅ Done since last release → group by Added / Fixed / Improved → prepend new version section (reverse chronological) → commit "docs: update changelog for <version>" → push. Do NOT use for: internal engineering notes (they stay in BACKLOG), unreleased items (wait for next deploy), marketing copy, version bump (use roll-release).'
---

# WK Generate Changelog

After successful Build & Deploy, extracts completed Stories from BACKLOG.md to generate a user-friendly `CHANGELOG.md`.

## When Triggered

- **Auto-triggered**: After successful deploy of `$roll-build` or `$roll-fix`
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

After successful deploy in `$roll-build` / `$roll-fix`:

```markdown
**Post-Deploy:**
- `$roll-.changelog` - Sync external changelog
```
