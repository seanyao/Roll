---
name: roll-jot
description: "Fast backlog capture. Analyzes a short description, classifies it as bug or idea, and appends it to BACKLOG.md with an auto-incremented ID."
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
