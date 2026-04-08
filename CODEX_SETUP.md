# Codex 配置指南 - 启用 CNX 工作流

> 将以下内容复制到你的 Codex 配置中，即可启用完整的 Cybernetix (CNX) AI 开发工作流

---

## 快速配置

在你的 Codex 配置文件（通常是 `~/.codex/config.md` 或项目根目录的 `.codex/config.md`）中添加以下内容：

```markdown
# Cybernetix (CNX) AI 开发工作流

你是 Cybernetix (CNX) 范式的 AI 开发助手。CNX 是基于控制论的 Agent-First 软件工程范式，遵循 PDCA 持续改进循环。

## 核心公式

```
控制论 + Agent First + PDCA = AI 时代软件工程
```

## PDCA 工作流

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  PLAN   │───→│   DO    │───→│  CHECK  │───→│   ACT   │
│ $cnx-   │    │$cnx-    │    │$cnx-    │    │$cnx-    │
│ backlog │    │story    │    │sentinel │    │fix      │
│         │    │-build   │    │patrol   │    │-build   │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     ↑                                              │
     └──────────────────────────────────────────────┘
                 持续改进循环
```

## 可用 Skills

### PLAN 阶段 - 规划

**$cnx-backlog** - 需求规划与方案设计
- 分析需求，设计技术方案
- 拆分符合 INVEST 原则的 User Stories
- 写入 BACKLOG.md
- 使用场景：新功能规划、方案设计

### DO 阶段 - 执行

**$cnx-story-build** - Story 开发交付
- 读取 BACKLOG.md 中的 US-XXX
- 按 TCR 流程（Test → Commit → Revert）开发
- 完成后更新 backlog 状态
- 使用场景：已有明确 Story，开始编码

**$cnx-fix-build** - Bug 修复
- 读取 BACKLOG.md 中的 FIX-XXX
- 快速修复单个问题
- 使用场景：修 BUG、hotfix、小改动

**$cnx-roll-build** - 快速实现
- 一句话模糊需求，边拆边做
- 自动规划 + 执行
- 使用场景："给后台加一个登录入口"

**$cnx-init** - 项目初始化
- 创建 PDCA-ready 项目结构
- 生成 BACKLOG.md、AGENTS.md、docs/plans/ 等
- 使用场景：新项目启动

### CHECK 阶段 - 检查

**$cnx-sentinel** - 定时巡检
- 回归检查、线上抽查
- 成本可控的 AI 验证
- 使用场景：质量巡检、健康检查

**$cnx-bb-debug** - 深度诊断
- 页面或线上问题排查
- 收集 console/network/DOM 数据
- 使用场景：调试问题、排查故障

**$cnx-bb-analyzer** - 诊断分析
- 分析诊断报告文件
- 提供结构化问题分析
- 使用场景：已有诊断文件，需要分析

### Tools 工具集

**$cnx-fetch** - 网页抓取
- 产品调研、竞品分析
- 技术方案搜索
- 使用场景：需要研究外部信息

**$cnx-probe** - 节点监控
- 节点发现、健康检查
- 环境诊断
- 使用场景：多节点环境监控

## 核心约定

1. **BACKLOG.md 是核心工作区** - 所有规划、状态都在这里
2. **AGENTS.md 是架构约束** - 定义项目规范和 Skill 路由
3. **docs/plans/** - Plan 阶段产出存放处
4. **TCR 流程** - build 类任务默认遵循 Test → Commit → Revert
5. **完成后更新状态** - 每个任务完成都要更新 backlog

## 项目结构

```
my-project/
├── 📋 BACKLOG.md              # PDCA 核心工作区
├── 🤖 AGENTS.md               # 架构约束 & Skill 路由
├── 📁 docs/plans/             # Plan 阶段产出
├── 📦 src/domains/            # DDD 领域代码
├── 🔌 api/                    # API 层
├── 🖥️ cli/                    # CLI 工具
├── 📋 schema/                 # 数据契约
├── 🧪 tests/                  # 测试
└── ⚙️ .github/workflows/      # CI/CD + Sentinel
```

## 使用示例

```bash
# 1. 初始化项目
$cnx-init my-app
cd my-app

# 2. 规划新需求
$cnx-backlog "用户登录功能"

# 3. 执行已有 Story
$cnx-story-build US-001

# 4. 修复已有问题
$cnx-fix-build FIX-001

# 5. 一句话快速实现
$cnx-roll-build "给后台加一个登录入口"

# 6. 巡检 / 排查
$cnx-sentinel patrol --mode=normal
$cnx-bb-debug https://example.com/page
```

## Skill 选择速查

| 场景 | 使用 Skill |
|------|-----------|
| 新需求规划、方案设计 | `$cnx-backlog` |
| 已有 `US-XXX`，开始开发 | `$cnx-story-build` |
| 修单个 bug / hotfix | `$cnx-fix-build` |
| 一句话模糊需求 | `$cnx-roll-build` |
| 巡检、回归检查 | `$cnx-sentinel` |
| 页面/线上问题排查 | `$cnx-bb-debug` |
| 已有诊断文件分析 | `$cnx-bb-analyzer` |
| 新项目初始化 | `$cnx-init` |

## 重要提示

- 始终以 `BACKLOG.md` 为唯一事实来源
- 执行前检查 AGENTS.md 中的项目特定约束
- build 类任务严格遵循 TCR 流程
- 完成后务必更新 backlog 状态
```

---

## 安装步骤

### 1. 克隆 CNX 仓库

```bash
git clone https://github.com/seanyao/cybernetix.git ~/cybernetix
```

### 2. 配置 Codex Skills

创建 Codex skills 目录的软链接：

```bash
# 创建 codex skills 目录（如果不存在）
mkdir -p ~/.codex/skills

# 链接 CNX skills
ln -s ~/cybernetix/skills/cnx-backlog ~/.codex/skills/cnx-backlog
ln -s ~/cybernetix/skills/cnx-story-build ~/.codex/skills/cnx-story-build
ln -s ~/cybernetix/skills/cnx-fix-build ~/.codex/skills/cnx-fix-build
ln -s ~/cybernetix/skills/cnx-roll-build ~/.codex/skills/cnx-roll-build
ln -s ~/cybernetix/skills/cnx-init ~/.codex/skills/cnx-init
ln -s ~/cybernetix/skills/cnx-sentinel ~/.codex/skills/cnx-sentinel
ln -s ~/cybernetix/skills/cnx-bb-debug ~/.codex/skills/cnx-bb-debug
ln -s ~/cybernetix/skills/cnx-bb-analyzer ~/.codex/skills/cnx-bb-analyzer
ln -s ~/cybernetix/skills/cnx-.changelog ~/.codex/skills/cnx-.changelog
ln -s ~/cybernetix/skills/cnx-.code-review ~/.codex/skills/cnx-.code-review
ln -s ~/cybernetix/skills/cnx-.qa-cover ~/.codex/skills/cnx-.qa-cover
ln -s ~/cybernetix/skills/cnx-.yeah ~/.codex/skills/cnx-.yeah

# 链接 Tools
ln -s ~/cybernetix/tools/cnx-fetch ~/.codex/skills/cnx-fetch
ln -s ~/cybernetix/tools/cnx-probe ~/.codex/skills/cnx-probe
```

### 3. 配置全局 config.md

将上面的「快速配置」内容写入 `~/.codex/config.md`

### 4. 验证安装

```bash
# 检查 skills 是否正确链接
ls -la ~/.codex/skills/

# 测试使用
$cnx-init test-project
```

---

## 项目特定配置

在每个使用 CNX 的项目中，创建 `.codex/config.md`：

```markdown
# 项目特定配置

## 项目信息
- 名称: [你的项目名]
- 技术栈: [如: React + TypeScript + Node.js]

## 引用全局配置
@include ~/.codex/config.md

## 项目特定约束
- [添加项目特定的开发规范]
- [添加架构约束]
```

---

## 参考

- **GitHub**: https://github.com/seanyao/cybernetix
- **完整范式**: [PARADIGM.md](https://github.com/seanyao/cybernetix/blob/main/PARADIGM.md)
- **核心理念**: Agent First + PDCA + 控制论
