# Feature: Trae IDE Support

> Design: [trae-support-plan.md](trae-support-plan.md)

---

<a id="us-trae-001"></a>
## US-TRAE-001 Add project_rules.md convention files (global + 4 templates) ✅

**Created**: 2026-04-24
**Plan**: [trae-support-plan.md](trae-support-plan.md)

- As a developer using Trae IDE on a Roll-managed project
- I want Roll convention files for Trae to exist in global and all templates
- So that `roll init` and `roll sync` can generate `.trae/rules/project_rules.md`

**AC:**
- [x] `conventions/global/project_rules.md` created with Trae-specific global rules
- [x] `conventions/templates/cli/project_rules.md` created
- [x] `conventions/templates/frontend-only/project_rules.md` created
- [x] `conventions/templates/fullstack/project_rules.md` created
- [x] `conventions/templates/backend-service/project_rules.md` created
- [x] Each file follows the same structure as peer GEMINI.md files in the same directory

**Files:**
- `conventions/global/project_rules.md`
- `conventions/templates/cli/project_rules.md`
- `conventions/templates/frontend-only/project_rules.md`
- `conventions/templates/fullstack/project_rules.md`
- `conventions/templates/backend-service/project_rules.md`

**Dependencies:**
- Depends on: —
- Depended on by: US-TRAE-002

---

<a id="us-trae-002"></a>
## US-TRAE-002 bin/roll integration — detect Trae, refresh project, config template ✅

**Created**: 2026-04-24
**Plan**: [trae-support-plan.md](trae-support-plan.md)

- As a developer running `roll init` or `roll refresh` on a Trae project
- I want Roll to detect Trae and generate `.trae/rules/project_rules.md`
- So that Trae Solo reads Roll conventions automatically

**AC:**
- [x] `detect_tools()` detects `.trae/rules/project_rules.md` and returns `"trae"` in the tools string
- [x] `refresh_project()` has a Trae branch: `mkdir -p .trae/rules` + `merge_convention "project_rules.md" … "$project_dir/.trae/rules"`
- [x] Default `config.yaml` template includes `ai_trae: ~/.trae|user_rules.md|project_rules.md`
- [x] `roll refresh` on a project containing `.trae/rules/project_rules.md` generates the file
- [x] `npm test` passes (72/72)

**Files:**
- `bin/roll`

**Dependencies:**
- Depends on: US-TRAE-001
- Depended on by: —
