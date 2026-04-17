# Project Backlog

## Epic: Demo
### Feature: hello-world
| Story | Description | Status |
|-------|-------------|--------|
| [US-HELLO-001](docs/features/hello-world.md#us-hello-001) | Hello World demo story to verify roll-design workflow | 📋 Todo |

## Epic: Brand Rename (cybernetix → wukong)
### Feature: rename-wukong
| Story | Description | Status |
|-------|-------------|--------|
| [US-WK-001](docs/features/rename-wukong.md#us-wk-001) | Rename CLI binary + internal vars (cybernetix → wukong, CNX_ → WK_) | ✅ Done |
| [US-WK-002](docs/features/rename-wukong.md#us-wk-002) | Rename skill dirs cnx-* → wk-*, update all $cnx- refs in SKILL.md | ✅ Done |
| [US-WK-003](docs/features/rename-wukong.md#us-wk-003) | Update convention templates + global conventions | ✅ Done |
| [US-WK-004](docs/features/rename-wukong.md#us-wk-004) | Update README and all docs | ✅ Done |
| [US-WK-005](docs/features/rename-wukong.md#us-wk-005) | One-click migration script for existing users (`migrate-to-wukong.sh`) | ✅ Done |

## Epic: CLI UX
### Feature: init command improvements
| Story | Description | Status |
|-------|-------------|--------|
| [US-INIT-001](docs/features/init-ux.md#us-init-001) | Add Kimi to tool selection menu (UI only, reuses AGENTS.md) | ✅ Done |
| [US-INIT-002](docs/features/init-ux.md#us-init-002) | Simplify `init` — current dir only, remove batch refresh | ✅ Done |
| [US-INIT-003](docs/features/init-ux.md#us-init-003) | 3-way conflict resolution for convention files (O/K/M) | ✅ Done |
| [US-INIT-004](docs/features/init-ux.md#us-init-004) | Scaffold new projects via CLI (no AI agent needed) | ✅ Done |
| [US-INIT-005](docs/features/init-ux.md#us-init-005) | Interactive per-component scaffold for legacy projects | ✅ Done |

## Epic: Brand Rename (wukong → roll) + Skill Consolidation
### Feature: rename-roll
| Story | Description | Status |
|-------|-------------|--------|
| [US-ROLL-001](docs/features/rename-roll.md#us-roll-001) | Rename CLI binary `roll` + all internal wukong paths + tests | ✅ Done  |
| [US-ROLL-002](docs/features/rename-roll.md#us-roll-002) | Rename wk-* skills → roll-*, delete wk-.yeah + wk-init | ✅ Done |
| [US-ROLL-003](docs/features/rename-roll.md#us-roll-003) | Update README + docs + migration script for existing users | ✅ Done |
| [US-ROLL-004](docs/features/rename-roll.md#us-roll-004) | Merge roll-debug (bb-debug + bb-analyzer → one skill) | ✅ Done |
| [US-ROLL-005](docs/features/rename-roll.md#us-roll-005) | Implement roll-build — unified delivery entry (fly + story merged) | ✅ Done |
| [US-ROLL-006](docs/features/rename-roll.md#us-roll-006) | Fold wk-init into `roll init` CLI, remove standalone skill | ✅ Done |

## Epic: CLI Simplification
### Feature: cli-simplification
| Story | Description | Status |
|-------|-------------|--------|
| [US-CLI-001](docs/features/cli-simplification.md#us-cli-001) | 精簡 cmd_init() — 移除類型/scaffold，三步極簡 init | ✅ Done |
| [US-CLI-002](docs/features/cli-simplification.md#us-cli-002) | conventions/templates 重新定位為 skills 參考資料 | ✅ Done |
| [US-CLI-003](docs/features/cli-simplification.md#us-cli-003) | skills 加入 Project Context Rule — 觀察再行動 | ✅ Done |

## Epic: Skill Ecosystem
### Feature: new-skills
| Story | Description | Status |
|-------|-------------|--------|
| [US-SKILL-001](docs/features/new-skills.md#us-skill-001) | Add `roll-jot` — fast backlog capture for bugs and ideas | ✅ Done |
| [US-SKILL-002](docs/features/new-skills.md#us-skill-002) | Add `roll-.clarify` — passive scope clarification for vague build requests | ✅ Done |

## Epic: Engineering Discipline Refactor
### Feature: refactor
| Story | Description | Status |
|-------|-------------|--------|
| [US-REF-001](docs/features/refactor.md#us-ref-001) | 搭建 bats 测试框架 + helper 函数单测（6 个核心 helpers） | ✅ Done |
| [US-REF-002](docs/features/refactor.md#us-ref-002) | command 级集成测试（setup/sync/init/status 全覆盖） | ✅ Done |
| [US-REF-003](docs/features/refactor.md#us-ref-003) | 拆解 cmd_init() 165 行 → 单职责函数 | ✅ Done |
| [US-REF-004](docs/features/refactor.md#us-ref-004) | 统一 AI 工具数据源 — config.yaml 单一来源，消除硬编码 | ✅ Done |
| [US-REF-005](docs/features/refactor.md#us-ref-005) | 修复 merge_convention() 内容更新静默跳过 | ✅ Done |
| [US-REF-006](docs/features/refactor.md#us-ref-006) | 删除 docs/plans/ scaffold — 对齐 AGENTS.md 约定 | ✅ Done |
