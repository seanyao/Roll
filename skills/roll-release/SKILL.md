---
name: roll-release
description: "Release skill for roll maintainers. Calculates next version (YYYY.MMDD.N format, auto-increments N from today's git tags), updates VERSION in bin/roll and package.json, commits, tags, and pushes to trigger npm auto-publish via GitHub Actions. Trigger: release, publish, 发版, 发布新版本."
---

# Release (roll-release)

One-command publish flow for roll maintainers.

## Version Format

`YYYY.MMDD.N` — e.g. `2026.419.1`

- `YYYY.MMDD` = today's date, month has **no leading zero** (e.g. `420` not `0420`)
- `N` = auto-incremented from existing git tags for today (starts at 1)

## Execution Steps

### Step 1: Calculate Version

First, inspect recent tags to confirm the actual format in use:

```bash
git tag | sort -V | tail -5
```

Then calculate:

```bash
today=$(date +%Y.%-m%d)
last_n=$(git tag | grep "^v${today}\." | sed "s/^v${today}\.//" | sort -n | tail -1)
n=$(( ${last_n:-0} + 1 ))
version="${today}.${n}"
```

Show the proposed version to the user:
```
Recent tags: v2026.419.1  v2026.419.2  v2026.420.3
Proposed version: 2026.420.4
Proceed? [y/N]
```

Wait for confirmation before continuing.

### Step 2: Update Version Fields

**`bin/roll`** — update the VERSION line:
```bash
sed -i '' "s/^VERSION=.*/VERSION=\"${version}\"/" bin/roll
```

**`package.json`** — update the version field:
```bash
npm version "${version}" --no-git-tag-version
```

Verify both files show the new version before continuing.

### Step 3: Commit

```bash
git add bin/roll package.json
git commit -m "[release] v${version}"
```

### Step 4: Tag and Push

```bash
git tag "v${version}"
git push && git push --tags
```

### Step 5: Publish to npm

```bash
npm publish --access public
```

This will open a browser for 2FA verification. Wait for it to complete before continuing.

### Step 6: Confirm

After publish, show:
```
✅ Released v{version}
🏷  Tag: v{version} pushed to origin
📦 npm published: @seanyao/roll@{version}
🔗 https://www.npmjs.com/package/@seanyao/roll
```

## Abort Conditions

- Uncommitted changes in `bin/roll` or `package.json` → warn and abort
- Tag already exists for today's N → increment N and re-propose
- `git push` fails → show error, do not leave a dangling local tag (run `git tag -d v{version}`)
