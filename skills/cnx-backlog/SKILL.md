---
name: cnx-backlog
description: Unified entry for planning and backlog management. Analyzes requirements, designs solutions, splits into INVEST-compliant user stories, and writes to BACKLOG.md. Use when user wants to plan, create stories, or manage project backlog.
---

# Backlog

一站式需求规划与 Backlog 管理。

## When to Use

- "帮我规划一下这个功能"
- "分析一下需求"
- "拆分成 Stories"
- "创建 Backlog"
- "plan approved, 开始执行"

## Quick Start

```bash
# 规划新需求 → 设计方案 → 拆分 Stories → 写入 BACKLOG
$cnx-backlog "用户系统设计方案"

# 从已有 Plan 拆分 Stories
$cnx-backlog --from-plan docs/plans/auth-system.md

# 直接创建 Story
$cnx-backlog --story "用户登录功能"
```

## Workflow

```
User: "帮我设计用户系统"
    │
    ▼
┌─────────────────────────────┐
│ 1. Understand & Analyze     │
│    - 需求理解                │
│    - 可行性分析              │
│    - 技术方案设计            │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 2. Solution Design          │
│    - 架构设计                │
│    - 模块划分                │
│    - 依赖梳理                │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 3. Split into Stories       │
│    - INVEST 原则             │
│    - DDD 领域拆分            │
│    - 优先级排序              │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ 4. Write to BACKLOG.md      │
│    - 创建 US-XXX             │
│    - 定义 AC                 │
│    - 保存方案文档            │
└─────────────┬───────────────┘
              │
              ▼
    "确认后执行?"
    │
    ├── 是 ──→ $cnx-story-build US-XXX
    │
    └── 否 ──→ 等待用户确认
```

## Story Format

```markdown
### US-{DOMAIN}-{N} {Story Title} 📋
**Created**: {YYYY-MM-DD}

- As a {role}
- I want {action}
- So that {benefit}

**AC:**
- [ ] {measurable criteria 1}
- [ ] {measurable criteria 2}
- [ ] {measurable criteria 3}

**Files:**
- `{file1}`
- `{file2}`

**Dependencies:**
- 依赖: {前置 US-XXX}
- 被依赖: {后续 US-XXX}

**Notes:**
{design notes}
```

## Integration

### With story-build

```
$cnx-backlog "登录功能" → 创建 US-AUTH-001
User: "执行 US-AUTH-001"
    ↓
$cnx-story-build US-AUTH-001 → TCR → CI/CD → Deploy
```

### With fix-build

```
$cnx-bb-debug 发现问题 → 建议创建 FIX
$cnx-backlog --fix "修复登录 API 404" → 创建 FIX-AUTH-001
$cnx-fix-build FIX-AUTH-001 → 快速修复
```

## INVEST Principles

Each story must be:
- **Independent**: 可独立实现
- **Negotiable**: 范围可协商
- **Valuable**: 对用户有价值
- **Estimable**: 可估算工作量
- **Small**: 足够小，快速交付
- **Testable**: 可测试验证

## Backlog Structure

```markdown
# Project Backlog

## 🎯 Active Stories
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| US-XXX | ... | 📋 Todo | P0 |

## ✅ Completed
...

## 🐛 Bug Fixes
...
```
