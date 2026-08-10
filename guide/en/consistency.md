# Consistency — the release gate inside `roll release`

Seven dimensions are continuously reconciled against truth anchors. A backlog
`✅ Done` row is a claim; merge evidence on `main`, acceptance reports, terminal
cycle events, and release-gate events are the facts. The dimensions are:
① code ↔ backlog claims · ② cards (every live backlog row owns
`features/<epic>/<ID>/spec.md`; evidence links never dangle; card-era delivered
stories with ACs own a `latest/<ID>-report.html`; a manually completed card
without ACs or a report must include a `manual:` reason in its Done status. A
same-ID record that was already Done before the rule is counted rather than
failed only when the tracked `.roll/policy/manual-done-epoch.json` baseline and
every later committed backlog state prove it stayed Done continuously; a missing,
damaged, or disconnected record blocks release clearly) ·
③ docs (changelog / features / guide / README / --help)
· ④ tests · ⑤ locale parity (guide en↔zh + i18n keys) · ⑥ site ·
⑦ truth-live (`ensureDeliveriesFresh` + `queryStoryDelivery` must prove each
release-delta story is actually delivered, with PR refs matching the Done row
when present).

```bash
roll release              # the ONE release flow — the gate runs inside it
roll release --dry-run    # preview the plan; nothing mutates
roll release --gate-check # machine entry (CI uses it); exit 0 = all pass
```

## The release gate

`roll release` runs the **consistency gate twice in the same place: before
anything irreversible.** Locally, the gate runs on the release branch — after
the version bump and changelog fold are committed, but **before** the PR is
opened or merged. A failing dimension aborts the release while it is still just
a local branch: the bump+changelog never reach `main`, so there is no
merged-but-untagged half-product. Remotely, every `v*` tag re-runs the same gate
in `release.yml` before the GitHub Release is created. Shipping with a known
drift requires fixing the drift — not skipping the gate.

`main` stays PR-protected, so the release opens a PR even for itself. It then
drives the merge through GitHub-native **auto-merge** (`gh pr merge --auto
--squash`) rather than waiting on a background lane: the merge completes when CI
goes green, even if you close the terminal. While it waits, the release prints a
progress line per poll and nudges CI (an empty commit) if a fresh PR's checks
never schedule. This needs **"Allow auto-merge"** enabled on the repo (Settings
→ General → Pull Requests); without it the release stops with an honest error
asking you to enable the setting or merge the PR manually — never a silent hang.

The acceptance-evidence gate is `hard` by default. `loop_safety.attest_gate: soft`
is an explicit project policy for migration windows; consistency still reports
missing or dangling evidence so the gap cannot disappear silently.

The site dimension checks the surviving public top-level command mentions in
site copy and resolves `guide/<lang>/*.md` links. It does not verify that every
completed story has a site page.

The truth-live dimension is the anti-false-Done guard. It first rebuilds the
delivery projection from `runs.jsonl` plus first-parent `main` merge commits,
then calls `queryStoryDelivery()` for every story id found in the release delta.
Backlog markdown is only the human claim; `deliveries.jsonl` is a rebuildable
cache; git merges and run events are the facts.

## Doc alignment boundary

Registry drift is already a hard red line: if the command registry, README,
guide, or `--help` disagree, the FIX-242 guard fails consistency and release.
The `doc-gap` signal in `roll attest` is shadow-only. It warns when a delivery
diff changes user-visible command or output-copy files without a README/docs/guide/site
touch in the same diff, but it does not change the report exit code or Gate
verdict yet.
