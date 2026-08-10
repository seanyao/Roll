# Roll — Agent 操作手册

> **roll 的引擎是 TypeScript（`packages/`），CLI 全 TS-native；`main` 即发布线。**
> **The engine is TypeScript (`packages/`), the CLI is fully TS-native; `main` ships.**
> 按"反馈闭环 + 能力域分层"设计。给在本仓干活的 agent / loop 读。

## 0. 这是什么（一句话）

roll 是一个**按反馈闭环设计的 agent harness**：把 LLM agent 当黑盒，用反馈闭环优化对它的控制力。它是一台分层的 TS 控制器——把目标拆成 cycle、调度 agent 执行、感知结果、按主干对账修正。

## 1. 当前形态

CLI 全 TypeScript：`packages/cli/bin/roll.js` → `dispatch()`，未知命令打 usage（无回落引擎）。发布为单一 npm 包 `@seanyao/roll`，CLI 经 esbuild 打平成 `dist/roll.mjs`。

| 包 | 能力域 |
|---|---|
| `spec` | 类型 + i18n catalog（层间契约的单一真相） |
| `core` | 领域逻辑：编排、backlog、对账、评分、成本、dossier（纯函数为主） |
| `infra` | 副作用适配：git / gh / 文件系统 / 进程 |
| `cli` | 命令面 + loop runner + 桥接 |
| `web` | 站点 |

`lib/` 是运行时伴生数据（价格快照、i18n 文案目录）。`skills/` 是 submodule（见 §6）。分层与不变量详见 [docs/architecture.md](docs/architecture.md)。

## 2. 沟通

- 用用户语言回答；代码/git/注释用英文；UI 输出跟随多语言设置（locale 单语呈现，不混排）。
- 简洁，讲结果（outcome），不复述实现、不走查代码。
- 自然、同事口吻；成功失败一致的温度。

## 3. 架构不变量（动手前必须守）

1. **反馈闭环是脊柱**：核心作动（编排）→ 控制平面传感/评分/限幅（可观测/Evals/Guardrails）→ 反哺。别把功能做成互不相干的孤岛。
2. **能力域分层 = 每个能力域一个家**：Orchestration / Sandboxing / Tool Use / Context Engineering / Observability / Evals / Guardrails。新代码先问"它属哪个域"，进那个域的包（6 包：spec/core/infra/daemon/cli/web），别又摊回多载体。
3. **守黑盒边界（外层 harness）**：token 级压缩、工具 schema 强制、单次 ReAct 委派内层 agent。
4. **event-driven，不中央编排**：多 loop 独立、经 artifact 协调，单 loop 故障不塌全局。
5. **主干即真相**：Done ≡ 已合进 `main` 分支；退出码不算数，事后对账。
6. **失败要响（fail-loud）**：连续失败 → PAUSE + 记录 + 问 owner；不做静默自愈/自动 fallback 链。
7. **持久优先**：状态从不可变事件流重建，不存独立缓存；写在前、原子 append。
8. **有界且可逆**：一 cycle 一小故事、fresh 上下文、TCR green-or-revert、feature 可整体回退。
9. **反馈带 Goodhart 护栏**：评分信号不自动激活，只生成"待人确认"候选；human-on-the-loop。

## 4. 标准

- **TS**：strict、禁 `any`、函数式、早返回。**类型是层与层之间的契约**——不退回 stdout 文本解析 / heredoc 生成脚本。
- **TCR**：Test → 绿则 commit / 红则 revert。无 WIP commit。
- **测试**：单测覆盖每个公共入口；行为契约用 Vitest 冻结快照（`toMatchSnapshot`）守护——见 [docs/difftest-freeze-paradigm.md](difftest-freeze-paradigm.md)。
- **Git**：`main` 走 PR + 2 checks（fix/feat/refactor 一律建分支）；不 `--no-verify`；不提交密钥；身份动态读 `git config`。
- **DoD：docs = code = product**：凡改变用户可见行为、命令面、输出文案、站点或交付视图的 story/fix，同一交付必须更新所触及的 README/docs/guide/site/help；文档漂移按缺陷处理。
- **DoD: docs = code = product**: any story/fix that changes user-visible behavior, commands, output copy, site, or delivery views must update the touched README/docs/guide/site/help in the same delivery; doc drift is a defect.
- **不做**：无关重构、投机抽象、改变现有命令的可观察行为而不带测试。

## 5. 测试：冻结快照（行为契约）

测试守护的是**可观察契约**（入参 / stdout / 副作用 / 退出码 / 写的文件与事件），而非实现细节。CLI 命令的输出用 Vitest 快照冻结：跑一次确认正确，`toMatchSnapshot()` 锁住；含时间戳 / 临时路径 / 版本号 / 平台 locale 的易变片段先 scrub 成稳定占位再快照（CI 在 Linux/UTC 是跨平台闸）。测试期不 spawn 任何外部引擎。范式与可移植性陷阱见 [docs/difftest-freeze-paradigm.md](difftest-freeze-paradigm.md)。

新增任何持久化状态前先答 8 问（缺失/并发写/被测试踩/被外部清/版本不兼容/id 不匹配/PID 复用/超时）——答不到五项先别加。

## 6. skills（不重写）

skills 是 markdown + shell，在独立仓 `seanyao/roll-skills`（submodule 挂 `skills/` 原路径），经桥接 `spawn` 调用。**它们是灵魂/契约，不翻成 TS。** clone 后 `skills/` 为空时跑一次 `roll setup` 或 `git submodule update --init --recursive`。

## 7. 与 `.roll/`（嵌套私有仓 roll-meta）

`.roll/` 是独立私有 git 仓（`seanyao/roll-meta`），**非 submodule**。roll-meta 与本仓同步翻车：它的 `main` 现在是实时 backlog——backlog/features/notes 改动 `cd .roll` 后 commit+push 到 **main**。

## 8. 完成 = 上线

完成 ≡ 已合进 `main`。`main` 是 PR-protected（PR + 2 checks），`@seanyao/roll` 从这里发版。退出码、自我声明都不算数——事后按主干对账才算。发布永远人点头（见 §3.9 的 human-on-the-loop）。

## 9. Where to Look

- 领域上下文与真相边界见 `.roll/domain/context-map.md`。

## 10. Prime (supervise role)

If you are coordinating the backlog as **Prime** (project-level `supervise` role),
not implementing a Story as Builder:

1. Load the **`roll-prime`** skill (`skills/roll-prime/SKILL.md`).
2. Read project overlay **`.roll/prime.local.md`** when present (roll-meta).
3. Prefer **`roll supervisor next/why --json`** and event-backed facts over intuition.
4. Pair with **`roll-loop`** for scheduler mechanics only; Prime owns reconcile,
   dispatch, watch, and meta reconciliation discipline.
5. Do not mix Prime coordination with default Builder work on the same card.
