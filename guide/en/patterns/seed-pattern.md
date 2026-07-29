> Mirror of the original Chinese source — English translation pending. See IDEA-NNN for translation status.

# Seed Pattern — 新项目的"播种"路径

> Roll 三种接入模式之一。另见 [graft-pattern.md](./graft-pattern.md)、[replant-pattern.md](./replant-pattern.md)。
>
> **核心精神：项目从第一天就携带 Roll 基因，像一粒种子在新土里发芽，所有约定、目录、工作流原生匹配。**

## 何时选这个 pattern

适合：
- 从零开始的新项目
- 有明确的产品愿景，实现细节灵活
- 想从 day 1 就用 agent 会话驱动的 Roll loop 推进交付
- 团队愿意先写 PRD / Architecture 再动代码（即使只写最薄一层）

不适合：
- 完全探索性项目，PRD 都写不出来 → 先用别的工具做原型，定型后再 seed 适配
- 极小项目（一个 100 行的 script），上 Roll 是过度工程

## 目录结构

```
my-new-project/                       ← Roll 原生项目，从 day 1 就是 .roll/ 形态
│
├── README.md                          产品门面
├── LICENSE
├── AGENTS.md                          AI 约定（roll init 生成）
├── CHANGELOG.md                       随发版生长
├── package.json                       或其他语言对应的 manifest
│
├── src/  lib/  tests/                 产品代码（最初为空，Loop 增量构建）
│
├── guide/                             用户文档（最初为空，发布前生长）
│   ├── en/  zh/
│
└── .roll/                            ← 项目管理 + 设计过程（从 day 1 存在）
    ├── backlog.md                     创始人写下的初始 Story 清单
    ├── specs/                         初始 PRD / Architecture / DDD
    │   ├── prd.md
    │   ├── architecture.md
    │   └── domain/
    ├── features/                      Story 详情
    ├── briefs/  dream/                Roll 自动产出
    └── decisions/                     ADR
```

## 数据流

```
创始人愿景 ──写入──→ .roll/specs/（初始 PRD / Architecture）
                       │
                       ▼ 拆解 Story
                   .roll/backlog.md
                       │
                       ▼ Loop 增量构建
                   src/  lib/  tests/（产品产物）
                       │
                       ▼ 发布
                   v1.0.0
```

与 replant-pattern 的本质差异：**起点不同**。
- replant：从已有 v1.x 反推规格
- seed：由人直接写规格（创始人愿景作为唯一输入）

## 三层数据角色

| 层 | 数据性质 | 何时写 |
|----|---------|------|
| `.roll/specs/` | 设计权威 | 项目启动时写第一版，演化中持续迭代 |
| `.roll/backlog.md` | 工作流入口 | specs 写完后拆解，loop 推进时增减 |
| `src/`  `lib/`  `tests/` | 产品产物 | Loop 按 backlog 增量构建 |

## 执行步骤

1. `mkdir my-new-project && cd my-new-project`
2. `roll init` 生成 `.roll/` 骨架 + `AGENTS.md`
3. **写第一版 specs**：用 `$roll-design` 或手写，在 `.roll/specs/` 完成 PRD / Architecture / DDD
4. **拆解 Story**：用 `$roll-design` 把 specs 拆成 INVEST-compliant Story 写入 `.roll/backlog.md`
5. **跑 loop**：打开一个 agent 会话，执行 `roll loop go`（先试一轮用 `roll loop go --max-cycles 1`）。这个会话就是 Supervisor；会话结束交付就停 —— 不打开会话就没有任何进展
6. 创始人持续校对、调整 specs，下一次 `roll loop go` 按新 backlog 推进

## 创始人的两种姿态

**姿态 A — specs-driven（重型）**
先把 PRD / Architecture 写得相对完整，再开 agent 会话跑 loop。
- 适合：愿景清晰、有 senior 工程师、关键决策需要前置敲定
- 风险：可能过度设计、与现实脱节

**姿态 B — seed-driven（轻型）**
specs 只写最核心的 1-2 章，backlog 只列前 3 条 Story，边跑 loop 边写。
- 适合：愿景模糊、迭代快、容错高、Hackathon 节奏
- 风险：早期决策反复，loop 可能跑出不符合最终愿景的代码

两种姿态对应**同一个目录结构**，差别只在 `.roll/specs/` 的初始完整度。

## 与其他 pattern 的对比

| 维度 | seed-pattern | replant-pattern | graft-pattern |
|------|--------------------|----------------|---------------|
| 起点 | 空目录 + 愿景 | 现有 v1.x | 现有项目 |
| 规格来源 | 人写 | 反推 v1.x + 精炼 | 不需要（用现有） |
| 历史包袱 | 无 | 反推时丢弃 | 保留 |
| 上限 | 高 | 高 | 中 |
| 启动门槛 | 中（要先写 PRD） | 高（反推 + 精炼） | 低（直接加 .roll/） |
| 适用 | 新项目、从 idea 阶段 | 包袱重、可冷藏老版本 | 仍在演化、不可停下来 |

## 实例

- 新创立的 SaaS 产品，第一天就用 Roll 管开发
- 学习型项目，"如何用 Roll 协作" 本身就是学习目标
- Hackathon 项目，48 小时内从 idea 到 demo，全程 Roll 驱动
- 个人侧项目，单人开发但想让一个 agent 会话一次啃掉多条 Story

## 演化路径

seed 项目的自然演化：

```
seed 启动
    │
    ▼ 跑 3-6 个月，积累 specs + backlog
项目进入"成熟"期
    │
    ├── 一切顺畅 → 继续 seed 节奏
    │
    ├── 发现累积了不该有的债 → 切换 replant-pattern
    │                          （把当前版本当 v1.x snapshot，反推清债）
    │
    └── 想拉新人/团队加入 → 文档或网站与实现不齐时，用 $roll-doc-audit 对账并补齐
```
