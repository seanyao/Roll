---
name: roll-jot
description: 'Use when capturing a thought to BACKLOG without starting work. Triggers: "记一下", "先存 backlog", "加到待办", "先不做", "临时想到", "quick jot", "capture this idea", "log a bug for later". Typical: "$roll-jot 评价页面要支持星星", "记一下 HOD 加批量导出", "先存 backlog 别做". Flow: classify one-liner as FIX-NNN (bug) or IDEA-NNN (idea) → assign next ID → append single row to BACKLOG.md without touching existing entries. Do NOT trigger: fix named FIX-XXX (use roll-fix), implement feature (use roll-build), discuss approach (use roll-design), diagnose page (use roll-debug).'
---

# roll-jot

> One-liner in, backlog entry out. No questions asked.

## Trigger

User explicitly invokes `roll-jot` with a free-text description.

```
$roll-jot 评价页面的星星也要纳入到 draft 的 scope 里
$roll-jot 手机端星星指标一行一个从上往下排
$roll-jot 给 HOD 加一个批量导出 PDF 的功能
```

## Behavior

1. **Read** `BACKLOG.md` from the project root.
2. **Classify** the input:
   - If it describes a defect, regression, broken behavior, or "也要/没/不/bug" → **bug**
   - Otherwise → **idea**
3. **Assign ID**:
   - Bug → next `FIX-NNN`
   - Idea → next `IDEA-NNN`
4. **Append** a new row to the appropriate table in `BACKLOG.md`:
   - Bug → `## 🐛 Bug Fixes` table
   - Idea → `## 💡 Ideas` table (create the section if it doesn't exist)
5. **Update stats** line if present (e.g. `Bug Fixes: N`, `Ideas: N`).
6. **Report** the assigned ID and where it was recorded.

## Output format

```
📝 Recorded as {ID}

Type:   {bug|idea}
Table:  {Bug Fixes|Ideas}
Text:   {description}
```

## Rules

- Do **not** ask the user for clarification.
- If the description is vague, record it verbatim and append `(细节待确认)`.
- Never modify existing entries — only append new rows.
- If `BACKLOG.md` does not exist, report an error and stop.
