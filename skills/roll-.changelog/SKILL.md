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

Must match `roll-release` format — read the most recent git tag to determine the version this CHANGELOG entry belongs to:

```bash
git describe --tags --abbrev=0   # e.g. v2026.420.7
```

Strip the leading `v` and use as the heading. Format: `YYYY.MMDD.N` (month has no leading zero, N auto-increments per day).

### 4. Generate CHANGELOG.md

```markdown
# Changelog

## 2026.420.7
- **Added**: <completed feature extracted from BACKLOG>
- **Fixed**: <resolved bug>
- **Improved**: <UX/performance optimization>

## 2026.419.1
- ...
```

**Ordering**: Most recent version first (reverse chronological). Versions must match published git tags — this is how users cross-reference CHANGELOG entries to `npm install @seanyao/roll@<version>`.

### 5. Commit Update

```bash
version=$(git describe --tags --abbrev=0 | sed 's/^v//')
git add CHANGELOG.md
git commit -m "docs: update changelog for ${version}"
git push
```

## Integration

After successful deploy in `$roll-build` / `$roll-fix`:

```markdown
**Post-Deploy:**
- `$roll-.changelog` - Sync external changelog
```
