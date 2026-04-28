---
name: roll-notes
license: MIT
description: "Project diary skill. Records development moments — successes, failures, discoveries — appended chronologically to a daily notes file."
---

# roll-notes

> 项目日记技能。记录开发过程中的成功、失败、感受和任何值得记住的事情。
> Append-only, timeline-driven, no fixed format.

## Trigger

- User says "记一下"、"写进日记"、"append 到日记"
- User asks to record a feeling, finding, or moment
- A project milestone is reached and worth capturing

```
$roll-notes 终于搞定了那个 WebSocket 断线重连的 bug
$roll-notes 今天的 code review 给了很好的反馈
```

## When Not to Use

- Capturing a bug or feature idea into BACKLOG (use `$roll-jot`)
- Generating user-facing release notes (use `$roll-.changelog`)
- Writing design documents or AC (use `$roll-design`)

## Behavior

1. **Determine file path**: `notes/YYYY-MM-DD.md` relative to project root
2. **Get current time**: Use `Asia/Shanghai` timezone (`TZ=Asia/Shanghai date`)
3. **Append**: Add new entry at end of file — never overwrite existing content
4. **Create if missing**: If file doesn't exist, create with a `# YYYY-MM-DD — <one-line summary>` header
5. **Free format**: Paragraph, list, code block — whatever fits the moment

## File format

```markdown
# YYYY-MM-DD — 一句话概括今天

> 时间：北京时间 HH:MM

---

## HH:MM — 事件标题

发生了什么、怎么解决的、什么感受。

---

## HH:MM — 另一个事件

...
```

## 写作风格（强制）

**禁止干巴巴的 checklist。禁止只有结论没有过程。必须有人的声音。**

### 叙事驱动
以时间线和事件推进为主线，像讲故事一样记录。不是 `补了功能，pytest 绿`，而是 `"电池剩余电量在哪里看？"我一愣，US-PLAT-003 的 AC 明明写了...`

### 技术细节嵌入叙事
代码、数据、命令行是故事的一部分，自然插入，不是附录。

### 对话与互动
记录用户的反馈、提问、情绪。日记是对话记录，不是独白。

### 诚实记录错误
失败、困惑、教训比成功更值得记录。

### 标题有画面感
不是功能清单。如 `每秒 20 行的噪音`、`22 个文件挤在一个抽屉里`。

### 结尾有收束
最后一段回到人的状态。如 `"值了"。"睡了"。push。`

## Rules

- **No planning**: Never write "明日待办" or "下一步"
- **No summaries**: Never write "今日收获" or "经验教训"
- **Pure record**: What happened, as-is — honest, immediate, rough is fine
- **Append freely**: Multiple entries per day is normal

## File location

```
notes/
  └── YYYY-MM-DD.md
```
