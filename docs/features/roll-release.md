# Feature: roll-release

<a id="us-rel-001"></a>
## US-REL-001 Add roll-release skill — one-command publish flow ✅

**Created**: 2026-04-19

- As a roll maintainer
- I want to run `$roll-release` to publish a new version
- So that releasing is a single command with no manual version calculation

**AC:**
- [ ] Skill file `skills/roll-release/SKILL.md` created
- [ ] Version format: `YYYY.MMDD.N` (e.g. `2026.0419.1`); N auto-increments from existing git tags for today
- [ ] Updates `VERSION="..."` in `bin/roll`
- [ ] Updates `"version"` field in `package.json`
- [ ] Commits with message `[release] vYYYY.MMDD.N`
- [ ] Creates git tag `vYYYY.MMDD.N` and pushes with `git push && git push --tags`
- [ ] GitHub Actions `publish.yml` picks up the tag and auto-publishes to npm
- [ ] Skill shows proposed version and asks for confirmation before making any changes
- [ ] Added to README skill list

**Files:**
- `skills/roll-release/SKILL.md` (new)
- `README.md`

**Dependencies:**
- `.github/workflows/publish.yml` must exist (already done in US-DIST-004)
