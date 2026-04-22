---
hidden: true
name: roll-.clarify
description: 'Passive scope clarification. Auto-invoked by roll-build and roll-design when user input is a single vague sentence, missing what/who/when/where boundaries, or contains ambiguous terms like "优化一下", "改一下", "加个东西", "做个设计". Typical triggering inputs: "改一下那个页面", "优化下搜索", "加个功能". Flow: summarize clarified intent in 1-2 sentences → assess complexity (small/medium/large) → ask 3–5 targeted questions → wait for answers before planning or coding. Do NOT activate: intent already clear and actionable, input is a specific skill command with concrete args, user is answering a prior question. Never announce "I''m using roll-.clarify" — just do it naturally: summarize, ask, wait.'
---

# roll-.clarify

> Understand first, build second.

## Trigger

Auto-invoked by `roll-build` (Fly mode) when the user input is:
- A single vague sentence
- Missing clear boundaries (what/who/when/where)
- Contains ambiguous terms like "优化一下", "改一下", "加个东西"
- Could be interpreted in multiple ways

**Do NOT activate when:**
- Intent is already clear and actionable
- User gives a specific command with a skill trigger (e.g. `$roll-jot ...`)
- User is answering a clarification question you just asked
- The task is simple enough that misinterpretation risk is negligible

## Behavior

1. **Summarize** the user's intent in 1–2 sentences.
2. **Assess complexity** (small / medium / large).
3. **Ask 3–5 targeted questions** to fill the biggest gaps. Focus on:
   - Scope: what exactly is in / out?
   - User: who is the actor?
   - Data: what changes or persists?
   - Edge cases: what could go wrong?
   - Verification: how will we know it's done?

## Output format

```
🎯 Clarified Intent: {1-2 sentences}

📏 Complexity: {small|medium|large}

❓ Open Questions:
1. {question 1}
2. {question 2}
3. {question 3}
...

➡️  Please answer the questions above and I'll proceed to planning / building.
```

## Rules

- Do **not** start coding or planning until the user replies.
- Questions must be concrete and answerable in one sentence each.
- If the input is already clear enough, silently return and let `roll-build` continue.
- Never announce "I'm using roll-.clarify."
