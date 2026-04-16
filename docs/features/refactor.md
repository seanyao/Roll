# Feature: Engineering Discipline Refactor

> Design: [refactor-plan.md](refactor-plan.md)

---

<a id="us-ref-001"></a>
## US-REF-001 搭建 bats 测试框架 + helper 函数单测 ✅

**Created**: 2026-04-16  
**Completed**: 2026-04-16  
**Plan**: [refactor-plan.md](refactor-plan.md)

- As a contributor to Wukong
- I want helper functions covered by automated unit tests
- So that I can refactor with confidence, knowing regressions are caught immediately

**AC:**
- [x] bats-core 安装到 devDependency，`npm test` 可运行所有测试
- [x] `config_get` 单测：正常 key、缺失 key、`~` 展开、默认值返回
- [x] `ai_tool_name` 单测：普通路径、`.openclaw/workspace` 嵌套路径
- [x] `scan_project_type_from_files` 单测：8 种 frontend/backend/cli 组合（含 express）
- [x] `detect_project_type` 单测：4 种 AGENTS.md 标记 + fallback 到文件扫描
- [x] `is_fresh_project` 单测：新目录 vs 有 package.json/go.mod 的目录
- [x] 所有测试在 CI 中运行并通过（GitHub Actions）

**Files:**
- `tests/helpers/bats-core/` (git submodule)
- `tests/unit/sanity.bats`
- `tests/unit/config_get.bats`
- `tests/unit/ai_tool_name.bats`
- `tests/unit/is_fresh_project.bats`
- `tests/unit/scan_project_type.bats`
- `tests/unit/detect_project_type.bats`
- `tests/fixtures/configs/basic.yaml`
- `tests/integration/.gitkeep`
- `package.json` (添加 test script)
- `.github/workflows/ci.yml` (新建)
- `bin/wukong` (BASH_SOURCE guard + 修复 multiline grep bug)

**Dependencies:**
- Depends on: —
- Depended on by: US-REF-002, US-REF-003, US-REF-004, US-REF-005, US-REF-006

**TCR Stats**: 8 micro-commits, 0 reverts  
**Bonus**: 顺手修复了 `scan_project_type_from_files` 多行 grep 在 source 时失效的潜在 Bug

---

<a id="us-ref-002"></a>
## US-REF-002 command 级集成测试 ✅

**Created**: 2026-04-16  
**Completed**: 2026-04-16  
**Plan**: [refactor-plan.md](refactor-plan.md)

- As a contributor to Wukong
- I want each CLI command covered by integration tests using temp directories
- So that command-level regressions are caught before any refactoring lands

**AC:**
- [x] `cmd_setup` 集成测试：`~/.wukong/` 目录结构正确生成，幂等（运行两次结果一致）
- [x] `cmd_sync conventions` 集成测试：`wk.md` 写入目标目录，`@wk.md` 追加到主配置
- [x] `cmd_sync skills` 集成测试：skill symlinks 正确创建，stale symlinks 被清理
- [x] `cmd_init` 集成测试覆盖三路径：fresh 项目、legacy 项目、refresh（已有 AGENTS.md）
- [x] `cmd_init` 集成测试验证 scaffold 不创建 `docs/plans/` 目录
- [x] `cmd_status` 集成测试：输出包含正确的 sync 状态文字
- [x] 所有测试使用临时目录，不影响真实 `~/.wukong/`

**Files:**
- `tests/integration/helpers.bash` (新建：共享 helper)
- `tests/integration/cmd_setup.bats` (新建：13 tests)
- `tests/integration/cmd_sync.bats` (新建：8 tests)
- `tests/integration/cmd_init.bats` (新建：13 tests)
- `tests/integration/cmd_status.bats` (新建：5 tests)
- `bin/wukong` (WK_HOME overridable + git config exit code fix)

**Dependencies:**
- Depends on: US-REF-001（bats 框架已就绪）
- Depended on by: US-REF-003, US-REF-004, US-REF-005

**TCR Stats**: 6 micro-commits（含 4 parallel agents）  
**Bonus**: 顺手修复 `cmd_status` 中 git config exit code 导致 set -e abort 的 Bug

---

<a id="us-ref-003"></a>
## US-REF-003 拆解 cmd_init() — 单职责函数 ✅

**Created**: 2026-04-16  
**Completed**: 2026-04-16  
**Plan**: [refactor-plan.md](refactor-plan.md)

- As a contributor to Wukong
- I want cmd_init() split into focused single-responsibility functions
- So that each execution path is independently readable and testable

**AC:**
- [x] `cmd_init()` 入口函数 ≤30 行，只做参数解析和分发
- [x] `_init_auto()` 独立函数：无交互扫描模式
- [x] `_init_refresh()` 独立函数：已有项目重新合并模式
- [x] `_init_new()` 独立函数：新初始化（选类型 + 选工具 + merge + scaffold）
- [x] `_select_project_type()` 独立函数：交互式类型选择
- [x] `_select_tools()` 独立函数：交互式工具选择
- [x] `_pick_override` 内嵌函数定义被消除，逻辑合入 `_select_project_type()`
- [x] 原有集成测试全部通过（行为不变）
- [x] `wukong init --help` 输出不变

**Files:**
- `bin/wukong` (重构 `cmd_init` 及相关函数，约 `line 446–611`)

**Dependencies:**
- Depends on: US-REF-001, US-REF-002（有测试网才能安全重构）
- Depended on by: —

---

<a id="us-ref-004"></a>
## US-REF-004 统一 AI 工具数据源 — 消除两处硬编码 ✅

**Created**: 2026-04-16  
**Completed**: 2026-04-16  
**Plan**: [refactor-plan.md](refactor-plan.md)

- As a user of Wukong
- I want to add a new AI tool by editing config.yaml only
- So that I don't need to modify the script code when new AI clients appear

**AC:**
- [x] `config.yaml` 新增 `ai_tools:` 结构（6 个工具：claude/gemini/kimi/codex/cursor/openclaw）
- [x] `_link_skills()` 从 config 读取工具列表，删除硬编码的 `ai_dirs` 数组
- [x] `_sync_conventions()` 从 config 读取工具列表，删除硬编码的 4 个 target 变量
- [x] `_install_local()` 生成的默认 `config.yaml` 包含 `ai_tools:` 结构
- [x] 向 config.yaml 添加新工具条目后，`wukong sync all` 自动处理该工具（不改代码）
- [x] 原有集成测试全部通过

**Files:**
- `bin/wukong` (重构 `_link_skills`, `_sync_conventions`, `_install_local`)
- `conventions/global/` 下无需修改（行为不变，只是数据来源改了）

**Dependencies:**
- Depends on: US-REF-001, US-REF-002
- Depended on by: —

---

<a id="us-ref-005"></a>
## US-REF-005 修复 merge_convention() 内容更新静默跳过 ✅

**Created**: 2026-04-16  
**Completed**: 2026-04-16  
**Plan**: [refactor-plan.md](refactor-plan.md)

- As a user of Wukong
- I want to be notified when a template section I already have has been updated
- So that I don't silently miss convention improvements after `wukong init`

**AC:**
- [x] Merge 模式下，已存在且内容相同的节：静默跳过（原行为保持）
- [x] Merge 模式下，已存在且内容不同的节：显示 diff，提示 `[u] update  [k] keep`
  - 选 `u`：用模板内容替换该节
  - 选 `k`：保留用户版本，不改动
- [x] `merge_convention.bats` 新增测试用例覆盖"内容不同"分支（2 tests）
- [x] 原有 Overwrite / Keep 模式行为不变
- [x] 原有"不存在节则追加"行为不变

**Files:**
- `bin/wukong` (修改 `merge_convention()` 的 Merge 分支，约 `line 655–675`)
- `tests/unit/merge_convention.bats` (新增测试用例)

**Dependencies:**
- Depends on: US-REF-001, US-REF-002
- Depended on by: —

---

<a id="us-ref-006"></a>
## US-REF-006 删除 docs/plans/ scaffold — 对齐 AGENTS.md 约定 ✅

**Created**: 2026-04-16  
**Completed**: 2026-04-16  
**Plan**: [refactor-plan.md](refactor-plan.md)

- As a user initializing a new project with Wukong
- I want the scaffold to only create directories that match AGENTS.md conventions
- So that I don't get a misleading docs/plans/ directory that contradicts the documented structure

**AC:**
- [x] `scaffold_new_project()` 不再创建 `docs/plans/` 目录（删除 `bin/wukong` 中那行）
- [x] `wukong init fullstack/frontend-only/backend-service/cli` 后，只有 `docs/features/` 存在
- [x] 集成测试验证 scaffold 后无 `docs/plans/` 目录（cmd_init.bats test #3 绿灯）
- [x] 无任何文档引用 `docs/plans/` 作为存放路径（refactor-plan.md 已更新）

**Files:**
- `bin/wukong:822` (删除 `_mkscaffold "$dir/docs/plans"`)
- `docs/` 下相关文档（如有引用 `docs/plans/` 则修正为 `docs/features/`）

**Dependencies:**
- Depends on: US-REF-001（需要测试覆盖才能验证行为）
- Depended on by: —
