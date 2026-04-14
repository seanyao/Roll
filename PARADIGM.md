# Cybernetix (CNX)

> AI-Native Development Workflow  
> _Let's roll, no sprints!_

---

## 一、核心思路：反馈驱动的持续交付

CNX 的核心很简单：**设定目标 → 执行 → 检查结果 → 根据反馈调整**，持续循环。

```
┌──────────────────────────────────────────────────────────────┐
│                    反馈驱动循环                                │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│   目标              感知               比较                   │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│   │   BACKLOG   │←─│  Sentinel   │←─│   Diff      │         │
│   │  (期望状态)  │  │  (实际状态)  │  │  (差距分析)  │         │
│   └──────┬──────┘  └─────────────┘  └──────┬──────┘         │
│          │                                  │                │
│          ▼                                  ▼                │
│   ┌─────────────┐                    ┌─────────────┐         │
│   │   Design    │                    │    Fix      │         │
│   │   设计+规划  │                    │   修复改进   │         │
│   └─────────────┘                    └─────────────┘         │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**工作流阶段:**

```
Design (讨论+规划) → Build (执行) → Check (巡检) → Fix (修复) → 循环
    $cnx-design       $cnx-story-build   $cnx-sentinel     $cnx-fix-build
```

---

## 二、实践层：单一智能体 + Skill 生态系统

> ⚠️ **当前状态**：基于单一 Agent（Kimi Code CLI）的实践闭环
> 
> 多智能体协同是**未来方向**，尚未实践

### 2.1 当前实践架构

```
┌─────────────────────────────────────────────────────────────────┐
│              单一 Agent + Skill 生态系统                         │
│                   （当前已实现）                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   User (人类)                                                   │
│      │                                                          │
│      ▼                                                          │
│   ┌─────────────────────────────────────┐                      │
│   │      Kimi Code CLI (Agent)          │                      │
│   │  ┌─────────┐ ┌─────────┐ ┌───────┐ │                      │
│   │  │ $cnx-design│ │$story   │ │$sentin│ │                      │
│   │  │         │ │-build   │ │el     │ │                      │
│   │  │ $project│ │$fix     │ │$bb    │ │                      │
│   │  │ -init   │ │-build   │ │-debug │ │                      │
│   │  │ $roll   │ │...      │ │...    │ │                      │
│   │  │ -build  │ │         │ │       │ │                      │
│   │  └─────────┘ └─────────┘ └───────┘ │                      │
│   │            Skill 生态系统           │                      │
│   └─────────────────────────────────────┘                      │
│      │                                                          │
│      ▼                                                          │
│   操作系统 / 文件系统 / Git / 测试 / 部署                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Skill 生态系统

当前基于 Kimi Code CLI 实现的 Skill：

| Skill | 阶段 | 功能 | 状态 |
|-------|------|------|------|
| `$cnx-init` | - | 初始化项目 | ✅ 已实现 |
| `$cnx-design` | DESIGN | 讨论方案 + 设计架构 + 规划 Stories | ✅ 已实现 |
| `$cnx-story-build` | BUILD | Story 开发交付（含并行调度） | ✅ 已实现 |
| `$cnx-spar` | BUILD | 对抗式 TDD：Attacker/Defender 攻守协同 | ✅ 已实现 |
| `$cnx-fix-build` | BUILD/FIX | Bug 修复 | ✅ 已实现 |
| `$cnx-roll-build` | DESIGN+BUILD | 一句话快速实现 | ✅ 已实现 |
| `$cnx-sentinel` | CHECK | 定时巡检 | ✅ 已实现 |
| `$cnx-bb-debug` | CHECK | 深度诊断 | ✅ 已实现 |
| `$cnx-bb-analyzer` | CHECK | 诊断分析 | ✅ 已实现 |
| `$cnx-qa-cover` | Support | 测试规范 | ✅ 已实现 |
| `$cnx-.code-review` | Support | 提交前自检 | ✅ 已实现 |

**Tools 工具集**（环境协同）：

| Tool | 类型 | 功能 | 状态 |
|------|------|------|------|
| `$cnx-fetch` | 🕵️ 情报 | 网页抓取、搜索、爬取 | ✅ 已实现 |
| `$cnx-probe` | 🔭 监控 | 节点发现、健康检查 | ✅ 已实现 |

**实践闭环**：
```bash
# 当前可运行的完整流程
$cnx-project-init my-app
$cnx-design "用户系统"
$cnx-story-build US-001
$cnx-sentinel patrol  # 自动运行
$cnx-fix-build FIX-001
# ... 持续循环
```

---

## 三、当前工作流

```
        ┌──────────┐
        │ DESIGN   │  $cnx-design
        │ 讨论+规划 │
        └────┬─────┘
             │
             ▼
        ┌──────────┐
        │  BUILD   │  $cnx-story-build / $cnx-fix-build
        │  执行    │
        └────┬─────┘
             │
             ▼
        ┌──────────┐
        │  CHECK   │  $cnx-sentinel / $cnx-bb-debug
        │  巡检    │  Sentinel: GitHub Actions 自动
        └────┬─────┘
             │
             ▼
        ┌──────────┐
        │   FIX    │  $cnx-fix-build
        │  修复    │
        └────┬─────┘
             │
             └──────── 持续循环
```

---

## 四、架构层：解耦模式

### 5.1 已实践的架构模式

| 模式 | 状态 | 说明 |
|------|------|------|
| **Domain Driven** | ✅ 已实践 | `src/domains/` 目录结构 |
| **EDA** | 🟡 部分实践 | 事件定义，待完善 |
| **API/CLI** | ✅ 已实践 | 项目模板包含 |
| **Stateless** | ✅ 已实践 | Vercel Edge 部署 |

### 5.2 项目结构（已实现）

```
my-project/  （$cnx-init 自动生成）
│
├── 📋 BACKLOG.md              # ✅ 任务索引
├── 🤖 AGENTS.md               # ✅ 约束定义
├── 📁 docs/features/          # ✅ Story 详情 & 设计文档
├── 🔌 api/                    # ✅ 接口层
├── 📦 src/domains/            # ✅ 领域解耦
├── ⚙️ .env.example            # ✅ 服务配置
└── 🧪 tests/                  # ✅ 测试结构
```

---

## 五、状态评估

| 维度 | 状态 | 说明 |
|------|------|------|
| 反馈驱动循环 | ✅ | Design → Build → Check → Fix |
| Skill 生态 | ✅ | 14 Skills + 2 Tools |
| 并行调度 | ✅ | story-build 内置 Worktree 隔离 |
| 验证门禁 | ✅ | 完成前强制提供新鲜证据 |
| 项目模板 | ✅ | $cnx-init |
| 架构约束 | ✅ | AGENTS.md |
| 自动化巡检 | ✅ | Sentinel |
| Convention 管理 | ✅ | cybernetix CLI，多工具规范统一分发 |

---

## 总结

已实现：

- 反馈驱动的持续交付循环（Design → Build → Check → Fix）
- 标准化、可复用的 Skill 生态（14 Skills + 2 Tools）
- story-build 内置并行调度 + Worktree 隔离
- 验证门禁：完成前强制提供新鲜证据
- Convention 管理：统一管理多 AI 工具的行为规范（`cybernetix` CLI）

---

## 参考

- **Agents**: Kimi Code CLI, Claude Code, Gemini CLI, Codex, Cursor
