---
hidden: true
name: cnx-init
description: Initialize a new AI-Coding project with complete PDCA workflow support. Creates standard directory structure, BACKLOG.md, CHANGELOG.md, docs/plans/, and GitHub Actions for sentinel patrols.
---

# Project Init

初始化一个支持 CNX 工作流的项目骨架。

## When to Use

- 新建一个采用 CNX 工作流的项目
- 需要生成 `BACKLOG.md`、`docs/plans/`、`AGENTS.md`、CI/CD、Sentinel 基础结构

## What It Sets Up

- `BACKLOG.md` 作为核心工作区
- `docs/plans/` 作为方案设计目录
- `AGENTS.md` 作为约束与路由入口
- `.github/workflows/` 作为 CI/CD 与巡检入口

## Generated Project Structure

```
my-project/
│
├── 📋 PROJECT MANAGEMENT (PDCA核心)
│   ├── BACKLOG.md              # Story backlog (主要工作区)
│   ├── CHANGELOG.md            # 发布历史
│   └── README.md               # 项目介绍
│
├── 🤖 AI WORKFLOW CONFIG
│   ├── AGENTS.md               # Skill routing & conventions
│   └── .github/
│       ├── workflows/
│       │   ├── ci.yml          # CI/CD pipeline
│       │   └── sentinel.yml    # ⭐ 定时巡检 (Check)
│       └── cnx-sentinel-config.yml # 巡检配置
│
├── 📁 DOCUMENTATION
│   └── docs/
│       ├── setup.md            # 开发环境搭建
│       ├── architecture.md     # 架构设计
│       ├── conventions.md      # 代码规范
│       └── plans/              # 设计方案 (Plan阶段产出)
│           └── README.md       # Plan目录说明
│
├── 🧪 TESTING
│   └── tests/
│       ├── unit/               # 单元测试
│       ├── e2e/                # E2E测试 (Sentinel用)
│       └── regression/         # 回归测试套件
│
├── ⚙️ CONFIG & SERVICES
│   ├── .env.example            # 环境变量模板
│   ├── .env.local              # 本地环境 (gitignored)
│   ├── vercel.json             # Vercel部署配置
│   └── docker-compose.yml      # 本地服务 (可选)
│
├── 📦 SOURCE CODE (Frontend - 纯展示层)
│   └── src/
│       ├── components/       # React 展示组件
│       │   └── ui/           # shadcn/ui 纯UI组件
│       ├── domains/          # DDD 领域 - 仅UI逻辑
│       │   └── auth/
│       │       ├── components/   # 认证相关UI
│       │       └── hooks/        # UI状态管理
│       ├── shared/
│       │   ├── api/          # API客户端 (调用后端)
│       │   ├── types/        # 与后端共享的类型
│       │   └── utils/
│       ├── App.tsx
│       └── main.tsx
│
├── 🔌 API (Backend - 业务逻辑层)
│   └── api/                  # API First: 所有功能先暴露为API
│       ├── index.ts          # API入口
│       ├── routes/           # RESTful路由
│       │   ├── auth.ts       # /api/auth/*
│       │   └── stories.ts    # /api/stories/*
│       ├── services/         # 业务逻辑服务
│       ├── models/           # 数据模型/Schema
│       └── types.ts          # API契约类型
│
├── 🖥️ CLI (Command Line - API封装)
│   └── cli/                  # CLI工具：API的直接封装
│       ├── index.ts          # CLI入口
│       └── commands/         # 命令实现
│           └── sync.ts       # 例如：数据同步命令
│
├── 📋 SCHEMA (Data First - 数据结构定义)
│   └── schema/               # 核心数据契约
│       ├── index.ts          # 统一导出
│       ├── auth.ts           # 认证相关类型
│       ├── story.ts          # 故事数据类型
│       └── api.ts            # API请求/响应类型
│
└── package.json
```

## PDCA Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                      PDCA 循环流程                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────┐                                               │
│   │    PLAN     │                                               │
│   │   计划阶段   │                                               │
│   │             │  Input: 需求/想法/问题                         │
│   │ $cnx-backlog    │  Output: Plan.md → Stories → BACKLOG.md       │
│   │             │                                               │
│   │ 1. 分析需求  │  docs/plans/YYYY-MM-DD-feature.md             │
│   │ 2. 设计方案  │       ↓                                       │
│   │ 3. 拆分Story │  BACKLOG.md 新增 US-XXX                      │
│   └──────┬──────┘                                               │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐                                               │
│   │     DO      │                                               │
│   │   执行阶段   │                                               │
│   │             │  Input: BACKLOG.md 中的 Story                  │
│   │ $story      │  Output: 完成的代码 + 测试 + 文档              │
│   │ -build      │                                               │
│   │             │  1. TCR开发 (Test && Commit || Revert)         │
│   │ 1. 读取Story│  2. Local CI检查                              │
│   │ 2. TCR开发   │  3. Push → Deploy                             │
│   │ 3. 部署     │                                               │
│   │             │  BACKLOG.md: 📋 → 🔄 → ✅                      │
│   └──────┬──────┘                                               │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐                                               │
│   │    CHECK    │                                               │
│   │   检查阶段   │                                               │
│   │             │  Input: 生产环境 / 代码变更                    │
│   │ $cnx-sentinel   │  Output: 巡检报告 / 发现问题                   │
│   │ patrol      │                                               │
│   │             │  • 定时随机抽检 (GitHub Actions)               │
│   │ 1. 功能验收  │  • 回归测试                                   │
│   │ 2. 数据检查  │  • 数据完整性                                 │
│   │ 3. AI抽查   │                                               │
│   │             │  发现问题 → BACKLOG.md 新增 FIX-XXX            │
│   └──────┬──────┘                                               │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐                                               │
│   │     ACT     │                                               │
│   │   改进阶段   │                                               │
│   │             │  Input: BACKLOG.md 中的 FIX/Story              │
│   │ $cnx-fix-build  │  Output: 修复后的系统                          │
│   │             │                                               │
│   │ 1. 读取FIX   │  TCR → CI/CD → Deploy                         │
│   │ 2. TCR修复   │                                               │
│   │ 3. 验证     │  BACKLOG.md: FIX-XXX ✅                        │
│   │             │                                               │
│   └──────┬──────┘                                               │
│          │                                                      │
│          └──────────────────────┬───────────────────────────────┘
│                                 │
│                                 ▼
│                      持续改进 (Continuous Improvement)
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## File Details

### BACKLOG.md (核心工作区)

项目的唯一真实来源 (Single Source of Truth)：

```markdown
# Project Backlog

## 🎯 Active
当前迭代的 Stories

| ID | Title | Status | Priority | Est |
|----|-------|--------|----------|-----|
| US-001 | 用户登录 | 🔄 | P0 | 3d |

## 📋 Todo
待开发，已规划好

- [ ] **US-002** 用户注册 - 依赖: US-001

## ✅ Completed
已完成的 Stories (Sentinel会定期回归检查)

- **US-001** 用户登录 - 2024-01-15

## 🐛 Bug Fixes
缺陷修复记录

| ID | Problem | Status | Source |
|----|---------|--------|--------|
| FIX-001 | 登录超时 | 📋 | Sentinel |

## 🔍 Sentinel Findings
Sentinel 巡检发现的问题

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| SEN-001 | 音频加载慢 | 🟡 | Watching |

## 📈 Stats
- Total Stories: 10
- Completed: 5
- Active: 1
- Sentinel Coverage: 85%
```

### CHANGELOG.md

对外发布历史：

```markdown
# Changelog

## [1.2.0] - 2024-01-15

### Features
- 用户登录功能 (US-001)
- 故事播放器 (US-003)

### Fixes
- 修复音频加载问题 (FIX-002)

## [1.1.0] - 2024-01-01
...
```

### docs/plans/

设计方案存档 (Plan阶段产出)：

```
docs/plans/
├── README.md                    #  Plans目录说明
├── 2024-01-15-user-system/      #  用户系统设计
│   ├── design.md               #  总体设计
│   ├── auth-flow.md            #  认证流程
│   └── db-schema.md            #  数据库设计
└── 2024-01-10-player-redesign/  #  播放器重构设计
    └── ...
```

### 默认技术栈

前端项目默认使用：

```
Frontend Stack:
├── React 18+          # UI框架
├── TypeScript         # 类型安全
├── Vite               # 构建工具
├── Tailwind CSS       # 原子化CSS
├── shadcn/ui          # UI组件库
├── Lucide React       # 图标库
└── React Router       # 路由
```

```bash
# shadcn/ui 初始化
npx shadcn@latest init

# 添加常用组件
npx shadcn add button card input dialog dropdown-menu
```

## Architecture Principles

### DDD 领域驱动设计

```
src/
├── domains/              # 按业务领域划分
│   ├── auth/            # 认证领域 (登录/注册/权限)
│   │   ├── components/  # 领域组件
│   │   ├── hooks/       # 领域逻辑 hooks
│   │   ├── services/    # API 服务
│   │   ├── types.ts     # 领域类型
│   │   └── utils.ts     # 领域工具
│   ├── story/           # 故事领域
│   └── user/            # 用户领域
│
├── shared/              # 共享基础设施
│   ├── api/            # HTTP client, interceptors
│   ├── hooks/          # 通用 hooks (useLocalStorage...)
│   ├── utils/          # 工具函数
│   └── types/          # 共享类型
│
└── components/ui/      # 纯 UI 组件 (shadcn)
```

**原则**: 按业务领域组织代码，而非技术类型

### Clean Architecture 整洁架构

```
┌─────────────────────────────────────┐
│           UI Layer                  │  ← Components
│      (React Components)             │
├─────────────────────────────────────┤
│        Application Layer            │  ← Hooks, State
│       (Business Logic)              │
├─────────────────────────────────────┤
│         Domain Layer                │  ← Entities, Types
│      (Core Business Rules)          │
├─────────────────────────────────────┤
│       Infrastructure Layer          │  ← API, Storage
│    (External Interfaces)            │
└─────────────────────────────────────┘

依赖方向: 内层不依赖外层
```

### Decoupling 解耦原则

| 层级 | 解耦方式 | 示例 |
|------|---------|------|
| UI ↔ Logic | Custom Hooks | `useAuth()` 封装认证逻辑 |
| Logic ↔ API | Service Layer | `authService.login()` |
| Component ↔ Component | Props/Events | 单向数据流 |
| Domain ↔ Domain | Event Bus | 领域事件通信 |

### Frontend-Backend Separation 前后端分离

```
Frontend (React)          Backend (API)
     │                         │
     ├─── HTTP/REST ───────────┤
     │    JSON exchange        │
     │                         │
     ├─── Auth (JWT) ──────────┤
     │    Token in header      │
     │                         │
     └─── Error handling ──────┤
          Unified format       │

契约: OpenAPI/Swagger 文档
```

### Test Coverage 测试覆盖

```
tests/
├── unit/                 # 单元测试 (Jest/Vitest)
│   ├── domains/
│   │   └── auth/
│   │       └── auth.service.test.ts
│   └── utils/
│
├── integration/          # 集成测试
│   └── api/
│       └── auth.api.test.ts
│
├── e2e/                  # E2E 测试 (Playwright)
│   └── flows/
│       └── auth.flow.spec.ts
│
└── regression/           # 回归测试 (Sentinel)
    └── critical-paths/
        └── story-playback.spec.ts

Coverage Requirements:
- Unit: >80% business logic
- Integration: All API endpoints
- E2E: Critical user flows
```

### AGENTS.md

AI助手工作指南：

```markdown
# Project Agents Configuration

## PDCA Workflow

### Plan → $cnx-backlog
- 需求分析、方案设计
- 拆分 Stories
- 写入 BACKLOG.md
- **必须检查**: 依赖完整性 & 数据流完整性

### Do → $cnx-story-build / $cnx-fix-build / $cnx-roll-build
- 读取 BACKLOG 执行
- TCR 开发
- CI/CD 部署
- **必须验证**: 数据流集成测试通过

### Check → $cnx-sentinel / $cnx-bb-debug
- Sentinel: 定时巡检
- cnx-bb-debug: 深度诊断
- **数据完整性**: 验证生产者→消费者数据流

### Act → $cnx-fix-build / $cnx-backlog
- 修复问题
- 或重新规划

## Architecture Constraints

### AI-Era Architecture Principles

AI时代的软件架构原则：

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI-First Architecture                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🎯 Agent First (Agent优先)                                      │
│     ├── 系统为AI Agent设计，Agent是第一用户                        │
│     ├── 所有能力对Agent完全开放 (API/CLI)                         │
│     ├── Agent可理解、操作、自动化一切                              │
│     └── UI只是人类的辅助界面                                       │
│                                                                 │
│  📋 Data Schema (数据契约)                                       │
│     ├── 清晰的数据结构定义，让Agent能理解                          │
│     ├── Type/Schema是人与Agent的契约                              │
│     └── 先定义Schema，再写业务逻辑                                 │
│                                                                 │
│  3. Domain Driven (领域驱动)                                     │
│     ├── 按业务领域建模，非数据库表设计                            │
│     ├── 领域间通过标准接口通信                                    │
│     └── 每个领域可独立理解和改造                                  │
│                                                                 │
│  4. Frontend-Backend Decoupling (前后端解耦)                      │
│     ├── 前端是纯展示层，无业务逻辑                                │
│     ├── 通过RESTful/GraphQL通信                                   │
│     ├── 契约优先：OpenAPI/Swagger                                │
│     └── 支持多端接入(Web/APP/AI)                                 │
│                                                                 │
│  5. Stateless & Scalable (无状态可扩展)                          │
│     ├── 业务逻辑无状态，状态外存                                  │
│     ├── 水平扩展优先                                             │
│     └── 支持AI弹性调度资源                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### DDD - Domain Driven Design
- 按业务领域组织代码: `src/domains/{domain}/`
- 每个领域包含: components/, hooks/, services/, types.ts
- 禁止跨领域直接调用，通过共享模块通信

### Clean Architecture
- 依赖方向: UI → Application → Domain ← Infrastructure
- 核心业务逻辑不依赖框架
- 使用依赖注入解耦

### Decoupling Rules
- UI 层只负责渲染，逻辑在 Hooks
- API 调用封装在 services/
- 共享类型放在 shared/types/
- 禁止组件间直接状态共享

### Frontend-Backend Contract
- API 变更必须同步更新 shared/types/
- 错误处理统一格式
- 认证使用 JWT，存储在 httpOnly cookie

### Testing Requirements
- 所有业务逻辑必须有单元测试
- API 有集成测试
- 关键流程有 E2E 测试
- **数据流必须有集成测试** (Producer → Consumer)
- Sentinel 会定期回归测试

## Engineering Common Sense (强制要求)

**底线原则 - 违反即 Bug：**

See [Cybernetix Engineering Common Sense](https://github.com/seanyao/cybernetix/blob/main/docs/practices/engineering-common-sense.md)

### 快速检查清单
```markdown
- [ ] **幂等性**: 可重复运行吗？重复3次结果一致吗？
- [ ] **跨模块契约**: ID/格式/算法在所有模块一致吗？
- [ ] **数据流**: 生产者→消费者链路完整吗？有集成测试吗？
- [ ] **原子性**: 部分失败会回滚吗？
- [ ] **输入验证**: 所有外部输入都验证了吗？
- [ ] **优雅降级**: 依赖失败时系统还能工作吗？
- [ ] **可观测性**: 用户能看到进度/状态吗？
- [ ] **并发安全**: 多线程/多进程访问安全吗？
```

### 教训案例
- **ingest 幂等性失败**: 重复运行7次，文件被添加7次
- **ID 生成不一致**: scanner 和 inbox 用不同 ID 算法，去重失效
- **数据流断裂**: ingest 不写 state，status 读取不到

## Architecture Evolution Checklist

当引入新核心架构（State, Cache, EventBus等）时：

### 前置检查
- [ ] 识别所有数据生产者（写入新架构的模块）
- [ ] 识别所有数据消费者（读取新架构的模块）
- [ ] 创建 Follow-up Stories 更新每个受影响模块
- [ ] 添加数据流集成测试

### 数据流测试模板
```typescript
// tests/integration/data-flow.test.ts
describe('Data Flow: {Module} -> State -> {Consumer}', () => {
  it('should write data that can be read back', async () => {
    // 1. Write via producer
    await producerModule.write(testData)
    
    // 2. Read via consumer
    const result = await consumerModule.read()
    
    // 3. Verify
    expect(result).toMatchObject(testData)
  })
})
```

### 常见错误预防
```markdown
❌ 错误: 只测试了"读取"，假设"写入"已完成
✅ 正确: 先验证"写入"，再实现"读取"

❌ 错误: 引入 State 架构但 ingest 没更新写入
✅ 正确: State 引入后，创建 Follow-up 更新所有生产者
```

## Service Configurations

### .env.example (常用服务模板)

```bash
# ============================================
# AI Services
# ============================================
# Moonshot AI (Kimi) - 故事生成
KIMI_API_KEY=sk-your-kimi-api-key
KIMI_BASE_URL=https://api.moonshot.cn/v1

# OpenAI (备用)
OPENAI_API_KEY=sk-your-openai-key

# Alibaba DashScope - 万相/语音
DASHSCOPE_API_KEY=sk-your-dashscope-key

# ============================================
# Cloud Storage (OSS)
# ============================================
# Aliyun OSS
OSS_ACCESS_KEY_ID=your-access-key
OSS_ACCESS_KEY_SECRET=your-secret
OSS_BUCKET=your-bucket
OSS_REGION=oss-cn-hangzhou
OSS_ENDPOINT=https://your-bucket.oss-cn-hangzhou.aliyuncs.com

# ============================================
# Deployment
# ============================================
# Vercel (自动注入，本地开发不需要)
# VERCEL_URL=https://your-app.vercel.app

# Railway (如果使用后端的Railway部署)
# RAILWAY_TOKEN=your-railway-token

# ============================================
# Database (如需要)
# ============================================
# Supabase / PostgreSQL
DATABASE_URL=postgresql://user:pass@host:5432/db

# Redis (缓存)
REDIS_URL=redis://localhost:6379

# ============================================
# Auth (如需要)
# ============================================
# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-secret

# JWT Secret
JWT_SECRET=your-jwt-secret-key
```

### vercel.json (Vercel部署配置)

```json
{
  "version": 2,
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" }
  ]
}
```

### 常用服务 Quick Reference

| 服务 | 用途 | 配置位置 |
|------|------|----------|
| **Kimi API** | AI生成内容 | KIMI_API_KEY |
| **Aliyun OSS** | 文件存储 | OSS_* |
| **Vercel** | 前端部署 | vercel.json |
| **Supabase** | PostgreSQL数据库 | DATABASE_URL |
| **Upstash Redis** | 缓存 | REDIS_URL |

## Auto-Generated Files

`$cnx-init` 会自动创建以下文件：

### ✅ 项目管理文件
- `BACKLOG.md` - PDCA核心工作区
- `CHANGELOG.md` - 发布历史模板
- `README.md` - 项目介绍

### ✅ AI工作流配置
- `AGENTS.md` - Skill路由和架构约束
- `.github/workflows/ci.yml` - CI/CD
- `.github/workflows/sentinel.yml` - 定时巡检
- `.github/cnx-sentinel-config.yml` - 巡检配置

### ✅ 架构配置文件
- `.env.example` - 环境变量模板(含Kimi/OSS等)
- `vercel.json` - Vercel部署配置
- `docker-compose.yml` - 本地服务(可选)

### ✅ 源码目录结构
- `src/` - React前端 (shadcn/ui + Tailwind)
- `api/` - 业务API层
- `cli/` - CLI工具
- `schema/` - 数据契约定义

### ✅ 测试结构
- `tests/unit/` - 单元测试
- `tests/e2e/` - E2E测试
- `tests/regression/` - 回归测试

### ✅ 文档目录
- `docs/setup.md` - 开发环境
- `docs/architecture.md` - 架构设计
- `docs/conventions.md` - 代码规范
- `docs/plans/` - 设计方案目录

## Conventions
- All work tracked in BACKLOG.md
- Sentinel patrols every 6 hours
- TCR required for all changes
- **Engineering Common Sense**: See [Cybernetix Practices](https://github.com/seanyao/cybernetix/blob/main/docs/practices/engineering-common-sense.md)
  - Idempotency, Cross-Module Contract, Data Flow Integrity
  - Atomicity, Input Validation, Graceful Degradation
  - Observability, Concurrency Safety
```

## Usage Flow

### 1. Start New Project

```bash
$cnx-init
# 回答几个问题...
# ✅ 项目创建完成
```

### 2. Plan Phase

```bash
# 设计新功能
$cnx-backlog "用户系统设计方案"

# 输出:
# - docs/plans/2024-01-20-user-system/design.md
# - BACKLOG.md 新增:
#   * US-001 用户注册
#   * US-002 用户登录
#   * US-003 密码重置
```

### 3. Do Phase

```bash
# 开发 Story
$cnx-story-build US-001

# 流程:
# 1. 读取 BACKLOG.md US-001
# 2. TCR 开发
# 3. CI/CD Deploy
# 4. 更新 BACKLOG.md: US-001 ✅
```

### 4. Check Phase (Automated)

```yaml
# .github/workflows/sentinel.yml 自动运行
name: Sentinel Patrol
on:
  schedule:
    - cron: '0 */6 * * *'  # 每6小时

jobs:
  patrol:
    steps:
      - run: $cnx-sentinel patrol --mode=normal
      # 随机抽检10个 ✅ Stories
      # 生成报告
      # 如发现问题，创建 GitHub Issue
```

### 5. Act Phase (if needed)

```bash
# 如果 Sentinel 发现 FIX-001
$cnx-fix-build FIX-001

# TCR修复 → Deploy → Sentinel验证
```

## Quick Commands Reference

| Phase | Command | Purpose |
|-------|---------|---------|
| Plan | `$cnx-backlog "需求"` | 规划设计，拆分 Stories |
| Do | `$cnx-story-build US-XXX` | 开发 Story |
| Do | `$cnx-fix-build FIX-XXX` | 修复 Bug |
| Do | `$cnx-roll-build "一句话"` | 快速实现 |
| Check | `$cnx-sentinel patrol` | 定时巡检 |
| Check | `$cnx-bb-debug URL` | 深度诊断 |
| Act | (自动) | 创建 FIX，回到 Do |

## Best Practices

1. **BACKLOG 是核心** - 所有工作必须在 BACKLOG 中跟踪
2. **Plan 先设计** - 复杂功能先写 docs/plans/ 再开发
3. **TCR 开发** - 所有代码变更用 Test && Commit || Revert
4. **Sentinel 守护** - 发布后自动巡检，发现问题
5. **持续改进** - 问题驱动，不断优化
