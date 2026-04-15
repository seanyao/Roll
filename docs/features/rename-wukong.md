<a id="us-wk-001"></a>
## US-WK-001 Rename CLI binary + internal variables ✅

**Created**: 2026-04-16
**Completed**: 2026-04-16

- As a user
- I want the CLI command to be `wukong` instead of `wukong`
- So that the brand is consistent end-to-end

**AC:**
- [x] `bin/wukong` renamed to `bin/wukong`
- [x] All `CNX_HOME` / `CNX_CONFIG` / `CNX_GLOBAL` / `CNX_TEMPLATES` vars → `WK_HOME` / `WK_CONFIG` / `WK_GLOBAL` / `WK_TEMPLATES`
- [x] `~/.wukong/` references → `~/.wukong/`
- [x] `[cnx]` log prefix → `[wk]`
- [x] `install.sh` updated: symlink `wukong` not `wukong`
- [x] `package.json` name field updated
- [x] Help text / version banner updated
- [x] `_link_skills` ai_dirs list keeps same paths (unchanged: ~/.claude ~/.gemini etc.)
- [x] Also delivered: US-INIT-001 (Kimi menu item), US-INIT-002 (cwd-only init), US-INIT-003 (O/K/M merge)

**Files:**
- `bin/wukong` (rename to `bin/wukong`)
- `install.sh`
- `package.json`

**Dependencies:**
- Depends on: none
- Depended on by: US-WK-002, US-WK-003, US-WK-004, US-WK-005

---

<a id="us-wk-002"></a>
## US-WK-002 Rename skill directories wk-* → wk-* 📋

**Created**: 2026-04-16

- As a developer
- I want all skills to be prefixed `wk-` instead of `cnx-`
- So that skill invocation (`$wk-design`, `$wk-story-build`) matches the new brand

**AC:**
- [ ] All 15 skill dirs under `skills/` renamed: `wk-*` → `wk-*`
  - `cnx-.changelog` → `wk-.changelog`
  - `cnx-.code-review` → `wk-.code-review`
  - `cnx-.echo` → `wk-.echo`
  - `cnx-.qa-cover` → `wk-.qa-cover`
  - `cnx-.yeah` → `wk-.yeah`
  - `wk-bb-analyzer` → `wk-bb-analyzer`
  - `wk-bb-debug` → `wk-bb-debug`
  - `wk-design` → `wk-design`
  - `wk-fix-build` → `wk-fix-build`
  - `wk-init` → `wk-init`
  - `wk-research` → `wk-research`
  - `wk-fly-build` → `wk-fly-build`
  - `wk-sentinel` → `wk-sentinel`
  - `wk-spar` → `wk-spar`
  - `wk-story-build` → `wk-story-build`
- [ ] Inside every SKILL.md: all `$wk-*` references → `$wk-*`
- [ ] `name:` frontmatter field in each SKILL.md updated
- [x] `variants/wk-oc/` removed — OpenClaw now uses shared `~/.wukong/skills/` directly

**Files:**
- `skills/wk-*/` (all dirs renamed)
- All `skills/wk-*/SKILL.md` (content updated)
- `variants/` (removed — OpenClaw unified with main skill set)

**Dependencies:**
- Depends on: US-WK-001

---

<a id="us-wk-003"></a>
## US-WK-003 Update convention templates and global conventions 📋

**Created**: 2026-04-16

- As a developer using generated convention files
- I want AGENTS.md / CLAUDE.md / GEMINI.md to reference `$wk-*` skills
- So that generated projects are consistent with the new brand

**AC:**
- [ ] `conventions/global/AGENTS.md`: `$wk-*` → `$wk-*`, `wukong` → `wukong`
- [ ] `conventions/global/CLAUDE.md`: same
- [ ] `conventions/global/GEMINI.md`: same
- [ ] All `conventions/templates/*/AGENTS.md`: same
- [ ] All `conventions/templates/*/CLAUDE.md`: same
- [ ] All `conventions/templates/*/GEMINI.md`: same

**Files:**
- `conventions/global/*.md`
- `conventions/templates/**/*.md`

**Dependencies:**
- Depends on: US-WK-001

---

<a id="us-wk-004"></a>
## US-WK-004 Update README and docs 📋

**Created**: 2026-04-16

- As a new user reading the docs
- I want all documentation to use the wukong brand
- So that there is no confusion between old and new names

**AC:**
- [ ] `README.md`: all `wukong` / `cnx-` occurrences replaced
- [ ] `docs/methodology.md`, `docs/methodology-en.md`: updated
- [ ] `docs/skill-selection-guide.md`: updated
- [ ] `docs/practices/engineering-common-sense.md`: updated
- [ ] `BACKLOG.md` and `docs/features/`: updated (this file too)
- [ ] `template/AGENTS.md`, `template/BACKLOG.md`: updated

**Files:**
- `README.md`
- `docs/**/*.md`
- `template/*.md`

**Dependencies:**
- Depends on: US-WK-001

---

<a id="us-wk-005"></a>
## US-WK-005 One-click migration script for existing users 📋

**Created**: 2026-04-16

- As an existing cybernetix user
- I want to run one script that migrates everything to wukong
- So that I don't have to manually hunt down old paths and symlinks

**AC:**
- [ ] Script: `scripts/migrate-to-wukong.sh`
- [ ] Steps performed (with confirmation prompt before each destructive step):
  1. Check `~/.wukong/` exists — warn and exit if not
  2. Copy `~/.wukong/` → `~/.wukong/` (preserve all skills, conventions, config)
  3. Rewrite `~/.wukong/config.yaml`: `wukong` paths → `wukong` paths
  4. Remove old per-skill symlinks `~/.claude/skills/wk-*`, `~/.gemini/skills/wk-*`, etc.
  5. Run `wukong sync skills` to create new `wk-*` symlinks
  6. Remove `~/.wukong/` (with final `[y/N]` confirmation)
  7. Remove old `wukong` binary from PATH locations (`~/.local/bin/wukong`)
  8. Print summary: what was migrated, what was removed, what needs manual action
- [ ] Idempotent: safe to run twice
- [ ] Dry-run mode: `--dry-run` prints what would happen without changing anything
- [ ] Script is referenced in README migration section

**Files:**
- `scripts/migrate-to-wukong.sh` (new)
- `README.md` — add "Upgrading from cybernetix" section

**Dependencies:**
- Depends on: US-WK-001, US-WK-002
