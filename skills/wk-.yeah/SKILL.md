---
hidden: true
name: cnx-.yeah
description: Celebration ceremony after build workflow completion 🎉 Outputs fireworks after cnx-story-build / cnx-fix-build / cnx-roll-build finishes successfully.
---

# CNX Yeah! 🎉

Celebration ceremony after a successful build completion.

## When Triggered

- After `$cnx-story-build` completes US development
- After `$cnx-fix-build` completes a bug fix
- After `$cnx-roll-build` completes a quick implementation
- When any `$cnx-*` build workflow finishes successfully

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
2. `$cnx-generate-changelog` (if needed)
3. **$cnx-yeah** 🎉
```

## Note

- Only called after an actual successful completion
- Not triggered if the workflow had a revert or failure
- Part of the positive feedback loop in the CNX continuous delivery cycle 🎯
