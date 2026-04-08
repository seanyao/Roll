---
hidden: true
name: cnx-.code-review
description: TCR 流程中的代码自审查环节。每个 micro-step 完成后、Commit 前执行，检查代码质量、安全性和设计问题。
---

# CNX Self Code Review

**TCR 循环的质量门禁** - 在每个 micro-step 完成后、Commit 前进行自我审查。

## 在 CNX 中的位置

```
TCR Loop:
  Write Test → Run Test → ✅ Green → Self Review → Commit
                                          ↓
                                     Critical?
                                   Yes → Fix → Redo
                                    No → Proceed
```

## 触发时机

- **自动触发**：`$cnx-story-build` / `$cnx-fix-build` / `$cnx-roll-build` 的每个 TCR micro-step 后
- **手动触发**：用户想要检查当前修改时

## 审查范围

```bash
# 默认：审查 staged changes（TCR 推荐）
$cnx-code-review staged

# 审查所有未提交修改
$cnx-code-review unstaged

# 审查指定文件
$cnx-code-review files src/utils.ts
```

## 审查维度（6 个核心维度）

```
┌─────────────────────────────────────────────────────────┐
│  CNX Quality Checklist                                  │
├─────────────────────────────────────────────────────────┤
│  ✅ Correctness     - 逻辑正确，无 bug                   │
│  ✅ Security        - 无安全漏洞，输入验证               │
│  ✅ Maintainability - 命名清晰，结构合理                 │
│  ✅ Performance     - 无性能隐患                        │
│  ✅ Testability     - 易于测试，边界覆盖                 │
│  ✅ Scope           - 聚焦当前任务，无无关修改           │
└─────────────────────────────────────────────────────────┘
```

## 严重等级与决策

| 等级 | 定义 | 决策 |
|------|------|------|
| 🔴 **Critical** | Bug、安全漏洞 | **必须修复**，重新 TCR |
| 🟡 **Warning** | 可维护性问题 | **建议修复** 或记录 |
| 🟢 **Suggestion** | 小优化 | 可选，继续提交 |
| ✅ **Pass** | 无问题 | 继续提交 |

## 输出格式

```markdown
## Self Review Report
**Scope**: staged (2 files, +45/-12 lines)

### 🔴 Critical (Must Fix)
| File | Line | Issue | Action |
|------|------|-------|--------|
| auth.ts | 23 | SQL injection | Use parameterized query |

### 🟡 Warnings
- utils.ts:45 - Magic number, consider: `const MAX_RETRY = 3`

### ✅ Passed
- Naming conventions
- Error handling
```

## TCR 集成

在 `$cnx-*-build` 的每个 micro-step 中：

```markdown
**Micro-Step X: [Description]**

1. Write/Update Test
2. Run Test → ✅ Green
3. **$cnx-code-review staged**
   - 🔴 Critical? → Fix → Redo step
   - 🟡 Warning? → Quick fix or document
   - ✅ Pass? → Proceed
4. git commit -m "tcr: description"
```

## CNX 原则对齐

- **Agent-First**: 结构化审查清单，AI 可执行
- **PDCA**: Check 阶段的本地质量控制
- **Micro-steps**: 小步快跑，每次审查 < 100 行
- **TCR**: 通过自检后才能 Commit，保证仓库质量
