---
name: cnx
description: Unified entry for Cybernetix (CNX) AI-Coding workflow. Routes to backlog planning, story delivery, bug fixes, code review, and project initialization. Use for structured AI-assisted software development with PDCA cycle.
---

# CNX (Cybernetix)

**AI-Coding 统一入口** - 结构化软件开发的完整工作流。

## 快速帮助

```bash
$cnx <command> [options]
```

### 命令总览

| 命令 | 用途 | 示例 |
|------|------|------|
| `backlog` | 需求规划 | `$cnx backlog "用户登录功能"` |
| `build` | 执行 Story | `$cnx build US-001` |
| `fix` | 修复 Bug | `$cnx fix "登录按钮无响应"` |
| `roll` | 一句话交付 | `$cnx roll "添加深色模式"` |
| `review` | 代码审查 | `$cnx review` |
| `fetch` | 单页抓取 | `$cnx fetch https://example.com` |
| `crawl` | 全站爬取 | `$cnx crawl https://docs.example.com` |
| `probe` | 节点检查 | `$cnx probe find orin` |
| `init` | 初始化项目 | `$cnx init my-project` |
| `changelog` | 生成日志 | `$cnx changelog` |

### 场景速查

**获取网页内容**
```bash
# 单篇文章 → 用 fetch（快速）
$cnx fetch https://blog.example.com/article

# 整个文档站 → 用 crawl（批量）
$cnx crawl https://docs.example.com --depth 2
```

**开发工作流**
```bash
# 1. 规划需求
$cnx backlog "用户登录功能"

# 2. 执行开发
$cnx build US-001

# 3. 代码审查
$cnx review

# 4. 发布上线
$cnx changelog
```

---

## 详细文档

### When to Use

| 场景 | 调用 |
|------|------|
| "规划新功能" / "拆分成 Stories" | `$cnx backlog "需求描述"` |
| "执行 US-001" / "开始开发" | `$cnx build US-001` |
| "修复这个 Bug" | `$cnx fix "Bug 描述"` |
| "快速实现一个功能" | `$cnx roll "一句话需求"` |
| "代码审查" | `$cnx review` |
| "初始化项目" | `$cnx init project-name` |
| "生成更新日志" | `$cnx changelog` |
| "抓取网页" / "爬取网站" | `$cnx fetch https://...` |
| "检查节点" / "发现机器" | `$cnx probe find <machine>` |

### Workflow

```
User: "帮我做一个登录功能"
    │
    ▼
┌─────────────────────────────────────┐
│ $cnx backlog "登录功能"             │
│  → cnx-backlog                      │
│  → 分析需求 → 拆分 Stories          │
│  → 写入 BACKLOG.md                  │
└─────────────┬───────────────────────┘
              │
              ▼
    "创建 US-AUTH-001"
    │
    ▼
┌─────────────────────────────────────┐
│ $cnx build US-AUTH-001              │
│  → cnx-story-build                  │
│  → TCR 工作流 → CI/CD → Deploy      │
│  → 更新 BACKLOG.md                  │
└─────────────┬───────────────────────┘
              │
              ▼
    "✅ US-AUTH-001 已完成"
```

### Commands

#### `backlog` - 需求规划
```bash
$cnx backlog "用户系统设计方案"
$cnx backlog --from-plan docs/plans/auth.md
$cnx backlog --story "登录功能"
$cnx backlog --fix "修复 API 404"
```

#### `build` - 执行 Story
```bash
$cnx build US-001          # 执行指定 Story
$cnx build --latest        # 执行最新的 Story
```

#### `fix` - 快速修复
```bash
$cnx fix "登录按钮不响应"
$cnx fix BUG-001           # 执行已有 Bug
```

#### `roll` - 一句话交付
```bash
$cnx roll "加个深色模式"
# 自动: 规划 → 拆分 → 执行 → 交付
```

#### `review` - 代码审查
```bash
$cnx review                 # 审查 staged changes
$cnx review --staged       # 同上
$cnx review --unstaged     # 审查所有修改
$cnx review files src/     # 审查指定文件
```

#### `fetch` - 网页抓取/情报收集
```bash
$cnx fetch https://example.com           # 单页提取
$cnx crawl https://docs.example.com      # 全站爬取
$cnx crawl https://site.com --depth 2    # 指定深度
```

**三层策略：**
1. **Tavily API** - AI 提取，质量最佳（需要 `TAVILY_API_KEY`）
2. **LLM Native Fetch** - 使用内置 FetchURL 能力
3. **Browser Automation** - 本地 browser-use 优先，云端兜底（需要 `BROWSER_USE_API_KEY`）

**环境变量配置（每台机器独立）：**
```bash
export TAVILY_API_KEY=tvly-...
export BROWSER_USE_API_KEY=bu-...  # 可选，本地 browser-use 优先
```

#### `probe` - 节点发现与健康检查
```bash
$cnx probe find orin              # 发现机器 (Bonjour/mDNS)
$cnx probe health seanclaw.local  # 健康检查
$cnx probe diagnose apeclaw       # 完整诊断
```

**功能:**
- 局域网节点发现 (支持 .local 主机名)
- OpenClaw Gateway 状态检查
- 端口监听验证
- 日志查看

#### `init` - 项目初始化
```bash
$cnx init my-project       # 创建新项目
$cnx init .                # 初始化当前目录
```

#### `changelog` - 生成更新日志
```bash
$cnx changelog             # 从 BACKLOG.md 生成
$cnx changelog --draft     # 预览，不写入文件
```

### Project Structure

Cybernetix 项目需要以下结构：

```
project/
├── BACKLOG.md          # Story  backlog
├── CHANGELOG.md        # 发布历史
├── docs/
│   └── plans/          # 设计方案
└── .github/
    └── workflows/      # CI/CD
```

### Integration

#### 与 OpenClaw 集成
```yaml
# ~/.openclaw/openclaw.yaml
skills:
  cybernetix:
    workspace: ~/workspace/cybernetix
    commands:
      - backlog
      - build
      - fix
      - roll
      - review
      - init
      - changelog
```

#### 环境变量
```bash
export CYBERNETIX_WORKSPACE=~/workspace/cybernetix
```

### Requirements

- Node.js 18+
- 项目目录需包含 `BACKLOG.md`（可由 init 创建）
- Git 仓库（用于 TCR 工作流）

### Related

- `cnx-backlog` - Backlog 管理
- `cnx-story-build` - Story 交付
- `cnx-fix-build` - Bug 修复
- `cnx-roll-build` - 快速交付
- `cnx-.code-review` - 代码审查
- `cnx-init` - 项目初始化
- `cnx-.changelog` - 更新日志
