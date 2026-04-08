---
hidden: true
name: cnx-.yeah
description: Build 流程完成后的庆祝仪式 🎉 在 cnx-story-build / cnx-fix-build / cnx-roll-build 成功完成后输出礼花。
---

# CNX Yeah! 🎉

Build 成功完成后的庆祝仪式。

## 触发时机

- `$cnx-story-build` 完成 US 开发后
- `$cnx-fix-build` 完成 Bug 修复后
- `$cnx-roll-build` 完成快速实现后
- 任何 `$cnx-*` Build 流程成功结束时

## Output

```
═══════════════════════════════════════════════════════════
                   🎉 BUILD COMPLETE! 🎉
═══════════════════════════════════════════════════════════

     ✨  ✨  ✨  ✨  ✨  ✨  ✨  ✨  ✨  ✨

           Let's roll, not sprints!

═══════════════════════════════════════════════════════════
```

## Usage

在 Build Skill 的最后一步调用：

```markdown
## Post-Deploy

1. Update BACKLOG.md status
2. `$cnx-generate-changelog` (if needed)
3. **$cnx-yeah** 🎉
```

## Note

- 仅在实际成功完成后调用
- 如果流程中有 revert 或失败，不触发
- 属于 CNX 控制论循环的正反馈环节 🎯
