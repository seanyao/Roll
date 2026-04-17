---
hidden: true
name: roll-.echo
description: |
  Passive intent clarification skill. Automatically activates when user input is vague, rambling, contradictory, or unclear. Restates the user's intent in structured, concise form and confirms before proceeding. Does NOT activate when intent is already clear — in that case, just execute directly.
  This is a passive skill. Never announce "I'm using roll-.echo." Just do it naturally: restate, confirm, proceed.
---

# Echo

> Passive intent clarification — restate messy thoughts as clear intent, confirm, then act.

## When to Activate

This skill fires **automatically** when the AI detects unclear intent. It should feel natural — not like a skill invocation, but like a thoughtful colleague saying "let me make sure I got that right."

**Activation signals** (any of these):
- Input is long and rambling (>3 sentences without a clear ask)
- Multiple ideas tangled together with no clear priority
- Contradictory statements ("I want X but also not-X")
- Hedging language: "maybe", "sort of", "I think", "not sure but", "something like"
- Vague scope: "make it better", "fix this area", "do something about"
- The intent could reasonably be interpreted in 2+ very different ways

**Do NOT activate when**:
- Intent is already clear and actionable ("add a login button to the header")
- User gives a specific command with a skill trigger ("$roll-story US-001")
- User is answering a question you asked (they're clarifying, not initiating)
- The task is simple enough that misinterpretation risk is negligible

**When in doubt**: If you're 80%+ confident you understand correctly, just execute. Echo is for the 50/50 situations where getting it wrong would waste real effort.

## How to Echo

### Step 1: Listen completely

Let the user finish. Don't interrupt a stream of consciousness — the clearest signal often comes at the end.

### Step 2: Distill

Extract the core intent from the noise. Structure it as:

```
What I'm hearing:
- **Goal**: {what they want to achieve — one sentence}
- **Scope**: {what's in / what's out}
- **Priority**: {if multiple things mentioned, which comes first}
- **Constraints**: {any specific requirements or limitations mentioned}
```

Only include fields that are relevant. A simple clarification might just be:

```
So you want: {one clear sentence restating the intent}
```

### Step 3: Surface ambiguity (if any)

If there are genuine decision points the user needs to resolve:

```
One thing I want to confirm: {the specific ambiguity, with 2-3 concrete options}
```

Don't manufacture ambiguity. If you understood fine, skip this.

### Step 4: Confirm and proceed

End with a natural confirmation prompt, then act on the response:
- If confirmed → route to the appropriate skill or start working
- If corrected → update understanding, optionally echo again if the correction introduces new ambiguity

## Style

- **Be brief.** The echo should be shorter than the original input, not longer.
- **Be concrete.** Replace vague language with specific interpretations. "Make it better" → "Improve the search response time" or "Redesign the search UI."
- **Be natural.** This is a conversation, not a form. Don't use the template rigidly.
- **No jargon.** Mirror the user's vocabulary, not technical framework terms.
- **No patronizing.** Don't echo things that are already obvious. The user will feel like you're not listening.

## Anti-Patterns

- Echoing when intent is already clear (wastes the user's time)
- Echoing every single message (becomes annoying fast)
- Adding your own ideas to the echo (scope creep — echo is for understanding, not suggesting)
- Using the echo as a stall tactic when you should just do the work
- Turning a simple ask into a complex questionnaire

## Examples

### Good Echo (vague input)

**User**: "I've been thinking about the search, it's kind of slow and the results aren't great, maybe we need elasticsearch or something, and also the UI is weird on mobile, the filters don't work right, I don't know, just... it needs work"

**Echo**: "Got it — sounds like two separate issues: (1) search quality and performance (results aren't relevant + slow), and (2) mobile UI broken filters. Want me to tackle them as two separate stories, or is one more urgent?"

### Good Echo (contradictory input)

**User**: "Make the dashboard simpler, but also add the analytics charts we discussed, and the export feature, oh and notifications"

**Echo**: "Those pull in opposite directions — simpler dashboard vs. adding 3 new features. Which do you mean: strip the current dashboard down and then selectively add these features? Or keep what's there and add the new stuff on top?"

### No Echo Needed (clear input)

**User**: "Add a dark mode toggle to the settings page"

*→ Just do it. No echo needed.*

### No Echo Needed (skill trigger)

**User**: "$roll-design search improvements"

*→ Route to roll-design. No echo needed.*
