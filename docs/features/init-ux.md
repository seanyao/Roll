<a id="us-init-001"></a>
## US-INIT-001 Add Kimi to `init` tool selection (UI only) 📋

**Created**: 2026-04-16

- As a developer using Kimi
- I want to see Kimi listed when running `wukong init`
- So that I know Kimi is supported (it reuses AGENTS.md — no extra file needed)

**AC:**
- [ ] Tool selection menu adds `k) Kimi  (uses AGENTS.md)` 
- [ ] `a) All of the above` includes Kimi in its label
- [ ] Selecting `k` does NOT generate any new file — AGENTS.md already serves Kimi
- [ ] No changes to `detect_tools`, templates, or sync logic

**Files:**
- `bin/wukong` — `cmd_init` tool selection block only (~5 lines)

**Dependencies:**
- Depends on: none
- Depended on by: none

---

<a id="us-init-002"></a>
## US-INIT-002 Simplify `init` — current dir only, remove batch refresh 📋

**Created**: 2026-04-16

- As a developer
- I want `wukong init [type]` to always operate on the current directory
- So that the command is simpler and I'm forced to `cd` into the project first

**AC:**
- [ ] `cmd_init` signature: `wukong init [type]` — no `[dir]` arg
- [ ] Always resolves to `$(pwd)` — no mkdir, no cd logic
- [ ] Batch refresh (scan subdirs for AGENTS.md) removed
- [ ] Auto-refresh single project (detects existing AGENTS.md in cwd) retained
- [ ] Help text updated: `wukong init [type]`
- [ ] README / docs updated to reflect new signature

**Files:**
- `bin/wukong` — `cmd_init`, argument parsing, help block

**Dependencies:**
- Depends on: none
- Depended on by: US-INIT-004, US-INIT-005

---

<a id="us-init-003"></a>
## US-INIT-003 3-way conflict resolution for convention files 📋

**Created**: 2026-04-16

- As a developer with customised convention files
- I want to choose Overwrite / Keep / Merge when a file already exists
- So that my project-specific edits are never silently lost

**AC:**
- [ ] `merge_convention` prompts: `[o] Overwrite  [k] Keep  [M] Merge (default)`
- [ ] Overwrite: replace file with global+template merged content
- [ ] Keep: skip, no changes
- [ ] Merge: keep existing file content, append any `## ` headings from template that are missing
- [ ] Default (Enter) = Merge
- [ ] `safe_copy` (used by `sync`) retains its own Y/N/diff flow (different context)
- [ ] Consistent with skill Step 3 table

**Files:**
- `bin/wukong` — `merge_convention` function

**Dependencies:**
- Depends on: none
- Depended on by: none

---

<a id="us-init-004"></a>
## US-INIT-004 Scaffold new projects via CLI 📋

**Created**: 2026-04-16

- As a developer starting a new project
- I want `wukong init` to scaffold the full directory structure after writing convention files
- So that I don't need an AI agent session just to get a standard skeleton

**AC:**
- [ ] Triggered only when cwd has no existing source structure (no package.json / go.mod / src/ / api/)
- [ ] After convention files written, prompts scaffold phase
- [ ] Scaffold creates per project type (fullstack example):
  - `BACKLOG.md`, `CHANGELOG.md`, `README.md`
  - `docs/features/`, `docs/plans/`
  - `src/components/ui/`, `src/domains/`, `src/shared/`
  - `api/routes/`, `api/services/`, `api/models/`
  - `tests/unit/`, `tests/e2e/`
  - `.env.example`, `.gitignore`
- [ ] Each dir gets a `.gitkeep`; template files (BACKLOG.md, .env.example) get starter content
- [ ] Scaffold output matches `wk-init` skill Step 4A structure (single source of truth)
- [ ] Skill `wk-init` Step 4A updated to call `wukong init` rather than recreate the structure itself

**Files:**
- `bin/wukong` — `scaffold_new_project` new function, called from `cmd_init`
- `conventions/templates/*/scaffold/` — optional: per-type starter file templates
- `skills/wk-init/SKILL.md` — Step 4A updated to delegate to CLI

**Dependencies:**
- Depends on: US-INIT-002

---

<a id="us-init-005"></a>
## US-INIT-005 Interactive scaffold for legacy projects 📋

**Created**: 2026-04-16

- As a developer onboarding a legacy project into CNX
- I want the CLI to walk me through scaffold options one-by-one with benefit explanations
- So that I can selectively adopt CNX structure without breaking existing code

**AC:**
- [ ] Triggered when cwd has existing source (package.json / src/ / etc.) but no AGENTS.md
- [ ] After convention files written, enters interactive scaffold mode
- [ ] Asks each component separately, shows benefit, user answers y/N:
  ```
  Add BACKLOG.md?  (track stories & bugs in one place)  [Y/n]
  Add docs/features/?  (design docs live next to code)  [Y/n]
  Add tests/ scaffold?  (unit/ e2e/ regression/ structure)  [Y/n]
  Add .env.example?  (document required env vars)  [Y/n]
  Add .github/workflows/ci.yml?  (automated CI on push)  [Y/n]
  Add .github/workflows/sentinel.yml?  (scheduled patrol every 6h)  [Y/n]
  ```
- [ ] Each selected item is created; skipped items are silently ignored
- [ ] Summary printed at end: "Added: BACKLOG.md, docs/features/, tests/"
- [ ] Does NOT touch existing src/, api/, or any file not in the above list

**Files:**
- `bin/wukong` — `scaffold_legacy_project` new function, called from `cmd_init`

**Dependencies:**
- Depends on: US-INIT-002, US-INIT-004 (shared scaffold helpers)
