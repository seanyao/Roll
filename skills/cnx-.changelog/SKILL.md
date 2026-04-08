---
hidden: true
name: cnx-.changelog
description: Build 完成后，从 BACKLOG.md 提取已完成的 Stories 生成 CHANGELOG.md。在 Deploy 成功后自动触发，保持对外更新日志与内部 backlog 同步。
---

# CNX Generate Changelog

Build & Deploy 成功后，从 BACKLOG.md 提取已完成的 Stories，生成对外友好的 `CHANGELOG.md`。

## 触发时机

- **自动触发**：`$cnx-story-build` 或 `$cnx-fix-build` 成功 Deploy 后
- **手动触发**：用户要求 "更新 changelog"、"生成发布日志" 时

## Workflow

### 1. 读取 BACKLOG.md

```
读取项目根目录的 BACKLOG.md
提取状态为 ✅ Completed / Done / 已完成 的 Stories
```

### 2. 过滤对外内容

**移除内部信息：**
- 进度表格、完成度百分比
- "As a / I can / So that" 格式
- 详细 AC 检查清单
- 技术债务、内部文件路径
- 测试用例数量、架构图

**保留用户价值：**
- 新功能（一句话描述）
- Bug 修复（用户可见影响）
- UX 改进（布局、交互优化）
- 性能/可靠性提升

### 3. 版本号格式

```
YYYY.MM.DD
YYYY.MM.DD-1  (同日多次发布)
YYYY.MM.DD-2
```

### 4. 生成 CHANGELOG.md

```markdown
# 更新日志

## 2026.04.03
- **新增**：<从 BACKLOG 提取的已完成功能>
- **修复**：<已解决的 Bug>
- **改进**：<UX/性能优化>

## 2026.04.01
- ...
```

**排序**：最新的版本在前（逆序）

### 5. 提交更新

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for release $(date +%Y.%m.%d)"
git push
```

## Integration

在 `$cnx-story-build` / `$cnx-fix-build` / `$cnx-roll-build` 的 Deploy 成功后：

```markdown
**Post-Deploy:**
- `$cnx-changelog` - 同步更新对外日志
```
