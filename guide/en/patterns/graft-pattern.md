> Mirror of the original Chinese source — English translation pending. See IDEA-NNN for translation status.

# Graft Pattern — Legacy 项目的"续写"路径

> Roll 三种接入模式之一。另见 [replant-pattern.md](./replant-pattern.md)、[seed-pattern.md](./seed-pattern.md)。
>
> **核心精神：原架构零侵入，Roll 作为接穗嫁接进来，与项目共生演化。**

## 何时选这个 pattern

适合：
- 项目仍在快速演化，不能停下来重建
- 团队风险偏好低，想小步增量验证
- 想先试用 Roll 一段时间再决定是否深入采用
- 原项目代码质量尚可，只是缺少 AI 辅助的项目管理与 agent 驱动的交付

不适合：
- 项目本身架构腐烂，"续写" 等于继续累积债 → 选 replant
- 团队希望借机做架构跃迁 → 选 replant
- 项目尚未开始 → 选 seed

## 目录结构

```
my-legacy-project/                    ← 砧木：现有项目，零侵入
│
├── src/  lib/  tests/  docs/           原有结构，全部不动
├── package.json                        不动
├── README.md                           不动
│
├── AGENTS.md                         ← 嫁接接口：新增或 section-merge（非破坏）
│
└── .roll/                            ← 接穗：Roll 工具栖息地
    ├── backlog.md                      项目管理增量（新故事走这里）
    ├── features/                       Story 详情
    ├── dream/                          Roll 自动产出（代码健康扫描）
    ├── specs/                          可选：增量沉淀的规格文档
    └── (可选 .gitignore)               团队决定是否公开
```

## 数据流

```
现有项目（砧木） ──持续演化──→ 项目继续生长，原有工作流不变
                                  ↓
                              .roll/（接穗）嫁接进来
                                  ↓
                              Roll 工具链接管新故事的管理与执行
                              （loop / dream / peer review / status·cycle 可观测）
```

Roll 不会在后台自己动：新故事只在你打开 agent 会话跑 `roll loop go` 时才推进。

## 砧木与接穗的边界

| 内容 | 砧木的职责 | 接穗的职责 |
|------|----------|----------|
| 现有源码 | ✓ 团队手动维护 | — |
| 现有测试 / CI | ✓ 不动 | — |
| 现有 issue tracker | ✓ 继续用 | — |
| 新功能的设计 / 拆解 | — | ✓ Roll 接管（`$roll-design` → backlog） |
| 新故事的实现 | — | ✓ agent 会话里跑 `roll loop go` 增量执行 |
| 文档新鲜度巡检 | — | ✓ `roll dream run-once` 按需巡一遍 |
| 跨 agent 评审 | — | ✓ Peer review 入循环 |
| 交付可观测 | — | ✓ `roll status` / `roll loop cycle` / story reports |

**`.roll/` 完全可以被 `rm -rf` 整体移除，项目回到嫁接前的状态。**
这是 graft-pattern 与 replant-pattern 的根本区别——嫁接是**可逆**的。

## 执行步骤

1. `cd my-legacy-project && roll init`
2. Roll 检测到 Legacy 结构（有源码、无 `AGENTS.md`），进入 onboarding 引导
3. 用户在 AI agent 里运行 `$roll-onboard`
4. Skill 读代码、理解项目、走三组九问、产出 `.roll/onboard-plan.yaml`
5. `roll init --apply` 先打印计划操作检查点并等待确认，再按 plan 落盘 `.roll/` 结构
6. 团队 review 生成的 backlog，调整后开始用 `$roll-build` 推新故事
7. 想让 Roll 连着啃 backlog：打开 agent 会话跑 `roll loop go`（先试一轮用 `roll loop go --max-cycles 1`）。会话结束就停，后台不会有任何东西继续跑

## 渐进式深入（L1 → L5）

graft 不是一次性事件，可以分阶段加深采用：

| 阶段 | 做了什么 | 砧木受影响程度 |
|------|---------|-------------|
| L1: 工具链 | 装 Roll CLI，`AGENTS.md` 同步 AI 工具约定 | 零（仅追加文件） |
| L2: 项目管理 | `.roll/backlog.md` 接管新故事 | 零（新故事走新流，老故事不动） |
| L3: 健康扫描 | 用 `roll dream run-once` 跑代码健康扫描 | 零（仅读、产出独立文件） |
| L4: Loop 执行 | 在 agent 会话里用 `roll loop go` 连着啃 Todo | 低（loop 会改源码，但走 PR 流程） |
| L5: Peer review | 跨 agent 评审入流 | 低（评审是 gating，非自动 merge） |

团队可以停在任一层。**L1+L2 已经能拿到 70% 的 Roll 价值。**

## 与其他 pattern 的对比

| 维度 | graft-pattern | replant-pattern | seed-pattern |
|------|--------------|----------------|---------------------|
| 对原架构的态度 | 保留并嫁接 | 推翻重建 | 无原架构（从零） |
| 风险 | 低 | 高 | 低 |
| 上限 | 中（受历史约束） | 高（彻底清债） | 高（无包袱起步） |
| 可逆性 | 高（`rm -rf .roll/` 即可） | 低（覆盖发布后） | 不适用 |
| 启动门槛 | 低 | 高 | 中 |
| 适用 | 仍在演化、不可停下来 | 包袱重、可冷藏老版本 | 新项目、从 idea 阶段 |

## 实例

任何使用 Roll 的已有代码库都是 graft 的实例。典型场景：

- 5 年的 Django 项目，团队装 Roll 只为给新功能做管理与交付
- Spring Boot 微服务集群，装 Roll 给跨服务的 PR 评审做 peer
- Long-lived bash 工具链，装 Roll 给文档新鲜度做 dream 扫描
- 任何已有 `git log` 但缺方法论的项目
