# Feedback And Issue Capture

Roll keeps two feedback paths deliberately separate:

- Use `roll idea "<one sentence>"` when the input should become a local Roll backlog card.
- Use `gh issue create` when the input belongs in GitHub Issues for a public repo or cross-project tracker.

## Local Roll Backlog

```bash
roll idea "Safari login fails after the session cookie expires"
roll idea "Add dark mode to the story report archive"
roll idea --type us "Add a release check that avoids unsupported green lights"
```

`roll idea` classifies the note, assigns the next ID, infers the epic, mints
the card folder, appends the backlog row, and refreshes the index. It is the
normal project-owner entry for turning quick feedback into tracked Roll work.
Use `--type us`, `--type fix`, or `--type idea` when you want to choose the
card family yourself. The explicit choice wins over words such as “fails”; the
command leaves nothing behind if it cannot safely create the whole card.

## GitHub Issues

For public bug reports or external collaboration, call GitHub directly:

```bash
gh issue create \
  --repo owner/repo \
  --title "Login fails on Safari" \
  --body "Repro: 1. ... 2. ..."
```

Use labels such as `bug`, `idea`, `enhancement`, `FIX`, or `US` if your project
board routes issues into Roll backlog work.
