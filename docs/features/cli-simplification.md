# Feature: CLI Simplification — roll init 極簡化

> Design: [cli-simplification-plan.md](cli-simplification-plan.md)

---

<a id="us-cli-001"></a>
## US-CLI-001 精簡 cmd_init() — 移除類型選擇和 scaffold，三步極簡 init ✅

**Created**: 2026-04-16
**Completed**: 2026-04-16
**Plan**: [cli-simplification-plan.md](cli-simplification-plan.md)

- As a developer starting a new project
- I want `roll init` to just set up workflow files without asking questions
- So that I can start working in under 5 seconds with zero friction

**AC:**
- [x] `roll init`（新項目）：創建 AGENTS.md + BACKLOG.md + docs/features/，無任何交互提示
- [x] `roll init`（已有 AGENTS.md）：re-merge 全局約定，提示 `roll sync`
- [x] `roll init` 不再問類型（fullstack/cli 等）
- [x] `roll init` 不再問工具（claude/gemini/cursor）
- [x] `roll init` 不再 scaffold 任何 src/api/cmd/ 目錄
- [x] 刪除函數：`_select_project_type`, `_select_tools`, `scaffold_new_project`, `scaffold_legacy_project`, `_init_auto`, `_init_new`, `_init_refresh`, `_detect_and_prompt_type`
- [x] `cmd_init()` 函數體 ≤ 35 行 (實際 24 行)
- [x] `tests/integration/cmd_init.bats` 重寫：6 個精準測試覆蓋新行為
- [x] `npm test` 全部通過

**Files:**
- `bin/roll` (cmd_init 重寫 24 行，刪除 8 函數，淨減 ~300 行)
- `tests/integration/cmd_init.bats` (重寫，13 → 6 tests)

**Dependencies:**
- Depends on: —
- Depended on by: US-CLI-002, US-CLI-003

---

<a id="us-cli-002"></a>
## US-CLI-002 conventions/templates 重新定位為 skills 參考資料 📋

**Created**: 2026-04-16
**Plan**: [cli-simplification-plan.md](cli-simplification-plan.md)

- As a skill (AI agent) executing a story
- I want type-specific conventions available as reference material
- So that I can infer the right patterns without the user having to declare their project type

**AC:**
- [ ] 每個 `conventions/templates/<type>/AGENTS.md` 頂部加說明：`# Reference Template — used by skills, not by users`
- [ ] `conventions/global/AGENTS.md` 移除所有「類型選擇」相關說明（已由 roll init 負責的部分）
- [ ] README.md 更新：`roll init` 段落移除 type 參數說明，改為「無參數，即時完成」
- [ ] `roll --help` init 那行更新，移除 `[type]` 參數
- [ ] `npm test` 全部通過

**Files:**
- `conventions/templates/*/AGENTS.md`（加說明 header）
- `conventions/global/AGENTS.md`（清理）
- `README.md`（更新 init 說明）
- `bin/roll`（usage() 裡 init 那行）

**Dependencies:**
- Depends on: US-CLI-001
- Depended on by: —

---

<a id="us-cli-003"></a>
## US-CLI-003 skills 加入 Project Context Rule — 觀察再行動 ✅

**Created**: 2026-04-16
**Completed**: 2026-04-16
**Plan**: [cli-simplification-plan.md](cli-simplification-plan.md)

- As a developer using `$roll-build` or `$roll-design`
- I want skills to infer project structure from existing files
- So that they create files in the right place without me having to explain the project type

**AC:**
- [x] `roll-build/SKILL.md` 加入 Project Context Rule 章節（位於 Hard Rules 之前）
- [x] `roll-design/SKILL.md` 加入同樣的 Project Context Rule
- [x] `roll-fix/SKILL.md` 加入同樣的 Project Context Rule
- [x] Rule 內容：讀 package.json、現有目錄結構、語言文件（go.mod/Cargo.toml 等），推斷慣例，不假設類型，沿用已有模式
- [x] `npm test` 全部通過（skills 是 .md 文件，測試不受影響）

**Files:**
- `skills/roll-build/SKILL.md`
- `skills/roll-design/SKILL.md`
- `skills/roll-fix/SKILL.md`

**Dependencies:**
- Depends on: US-CLI-001
- Depended on by: —
