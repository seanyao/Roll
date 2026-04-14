# Cybernetix (CNX)

> AI-Native Development Workflow — _Let's roll, no sprints!_

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 安装

```bash
git clone https://github.com/seanyao/cybernetix.git ~/CodeSpace/cybernetix

# 添加 CLI 到 PATH
ln -sf ~/CodeSpace/cybernetix/bin/cybernetix ~/.local/bin/cybernetix

# 初始化全局配置（新机器首次运行）
cybernetix setup
```

---

## Convention 管理

统一管理 Claude Code / Kimi Code / Gemini CLI / Codex / Cursor 的行为规范。

### 命令

| 命令 | 场景 |
|------|------|
| `cybernetix setup` | 新机器首次初始化 `~/.cybernetix/` |
| `cybernetix sync` | 编辑全局规范后，分发到各 AI 工具 |
| `cybernetix update` | 打开编辑器改规范，保存后自动 sync |
| `cybernetix init [dir] [type] [tools]` | 为项目生成规范文件 |
| `cybernetix reset` | 从 repo 重置全局规范 |
| `cybernetix status` | 查看当前状态和同步情况 |

### 操作步骤

```bash
# 1. 新机器 — 一次性设置
cybernetix setup          # 创建 ~/.cybernetix/，生成全局规范和模板
cybernetix sync           # 分发到 ~/.claude/、~/.gemini/、~/.codex/

# 2. 新建项目 — 选择项目类型和 AI 工具
cybernetix init . fullstack claude       # fullstack 项目，只用 Claude
cybernetix init my-app cli claude,cursor # CLI 项目，Claude + Cursor
cybernetix init .                        # 交互式选择

# 3. 修改全局规范
cybernetix update         # 编辑 → 自动 sync
# 或手动编辑后:
vim ~/.cybernetix/conventions/global/AGENTS.md
cybernetix sync

# 4. 改坏了？重置
cybernetix reset          # 从 repo 恢复默认，自动 sync
```

### 分层机制

```
全局  ~/.claude/CLAUDE.md            ← cybernetix sync 管理
  ↓  自动叠加
项目  <project>/AGENTS.md            ← cybernetix init 生成
项目  <project>/.claude/CLAUDE.md
```

全局规范自动生效，现有项目不需要额外操作。

### 目录结构

```
~/.cybernetix/
├── config.yaml                  # sync 路径配置
└── conventions/
    ├── global/                  # 全局规范 (single source of truth)
    │   ├── AGENTS.md            # master 文档
    │   ├── CLAUDE.md / GEMINI.md / .cursor-rules
    └── templates/               # 项目类型模板
        ├── fullstack/
        ├── frontend-only/
        ├── backend-service/
        └── cli/
```

---

## Skill 系统

### 工作流

```
Design → Build → Check → Fix → 循环
```

### Skill 速查

| 场景 | 命令 |
|------|------|
| 不确定方案，需要讨论 | `$cnx-design "话题"` |
| 一句话需求 | `$cnx-roll-build "帮我加个..."` |
| 执行已有 Story | `$cnx-story-build US-001` |
| 修 bug / 小改动 | `$cnx-fix-build FIX-001` |
| 高风险逻辑（支付/权限） | `$cnx-spar "功能描述"` |
| 初始化新项目 | `$cnx-init` |
| 巡检线上 | `$cnx-sentinel patrol` |
| 调试页面 | `$cnx-bb-debug <URL>` |

### 操作步骤

```bash
# 新项目
cybernetix init my-app fullstack claude  # 生成规范文件
$cnx-init my-app                         # 生成项目骨架（BACKLOG、目录结构、CI）

# 日常开发
$cnx-design "用户登录功能"               # 规划 → 产出 BACKLOG Stories
$cnx-story-build US-001                  # 开发 → TCR → CI → Deploy
$cnx-fix-build FIX-001                   # 修复
$cnx-roll-build "给后台加个搜索"          # 一句话 → 自动拆分 → 交付
```

### 完整 Skill 列表

| Skill | 阶段 | 功能 |
|-------|------|------|
| `$cnx-design` | DESIGN | 讨论方案 + 设计架构 + 规划 Stories |
| `$cnx-story-build` | BUILD | 执行 Story（含并行调度） |
| `$cnx-spar` | BUILD | 对抗式 TDD |
| `$cnx-fix-build` | BUILD/FIX | Bug 修复 |
| `$cnx-roll-build` | DESIGN+BUILD | 一句话快速实现 |
| `$cnx-sentinel` | CHECK | 定时巡检 |
| `$cnx-bb-debug` | CHECK | 页面深度诊断 |
| `$cnx-bb-analyzer` | CHECK | 诊断报告分析 |
| `$cnx-.code-review` | Support | 提交前代码自检 |
| `$cnx-.qa-cover` | Support | 测试规范参考 |
| `$cnx-.changelog` | Support | 自动生成 CHANGELOG |
| `$cnx-init` | - | 项目骨架初始化 |

---

## 项目结构（$cnx-init 生成）

```
my-project/
├── BACKLOG.md           # 任务索引
├── AGENTS.md            # 项目约束 & Skill 路由
├── .claude/CLAUDE.md    # Claude Code 配置
├── docs/features/       # Story 详情
├── src/domains/         # DDD 领域代码
├── api/                 # API 层
├── tests/               # 测试
└── .github/workflows/   # CI/CD + Sentinel
```

---

## License

MIT
