---
hidden: true
name: wk-.yeah
description: Celebration ceremony after build workflow completion 🎉 Outputs fireworks after wk-story-build / wk-fix-build / wk-roll-build finishes successfully.
---

# WK Yeah! 🎉

Celebration ceremony after a successful build completion.

## When Triggered

- After `$wk-story-build` completes US development
- After `$wk-fix-build` completes a bug fix
- After `$wk-roll-build` completes a quick implementation
- When any `$wk-*` build workflow finishes successfully

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

Called as the final step in a build skill:

```markdown
## Post-Deploy

1. Update BACKLOG.md status
2. `$wk-generate-changelog` (if needed)
3. **$wk-yeah** 🎉
```

## Note

- Only called after an actual successful completion
- Not triggered if the workflow had a revert or failure
- Part of the positive feedback loop in the WK continuous delivery cycle 🎯
