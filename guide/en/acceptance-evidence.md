# Acceptance Review Page — `roll attest`

Every delivered story can carry a **single-file Acceptance Review Page**: per-AC
verdicts with the artifacts that back them, openable offline, printable to PDF,
readable by non-engineers.

## Where Review Pages live

Every story has ONE home — its card folder under the epic:

```
.roll/features/<epic>/<id>/<run-id>/<id>-review.html  ← Acceptance Review Page (self-contained)
.roll/features/<epic>/<id>/<run-id>/<id>-report.html  ← legacy report alias (one release cycle)
.roll/features/<epic>/<id>/<run-id>/evidence.json     ← collected hard facts
.roll/features/<epic>/<id>/<run-id>/evidence/         ← raw command/test artifacts
.roll/features/<epic>/<id>/<run-id>/screenshots/      ← visual proof, when relevant
.roll/features/<epic>/<id>/ac-map.json                ← AC → evidence intent map
.roll/features/<epic>/<id>/latest                     ← symlink to the newest run
```

Runs are timestamped and never overwritten. The backlog `✅ Done` row links to
`latest/<id>-review.html`; CHANGELOG bullets may carry an invisible
`<!-- evidence: ... -->` marker for traceability.

**The story's `latest/<id>-review.html` is the human acceptance entry.** A
story is accepted by opening its own Acceptance Review Page — not a global archive/index page.
`roll attest` is story-scoped: it writes only this story's Review Page, the legacy report alias, and the
`latest` pointer. It does not refresh any global archive, epic, or front-page
HTML. Those board pages, when you want them, are rendered on demand with
the archive rebuild; they are a convenience/archive view, not the delivery-truth surface.

## Lifecycle in three stages

1. Open the evidence frame. At the beginning of a loop cycle the runner creates
   the timestamped run directory and exports it to the inner agent as
   `ROLL_RUN_DIR`. The derived directories `ROLL_EVIDENCE_DIR` and
   `ROLL_SCREENSHOTS_DIR` point at `<run-id>/evidence/` and
   `<run-id>/screenshots/`.
2. Collect during execution. `roll test` writes command output and summaries
   into `ROLL_EVIDENCE_DIR`; visual lanes write screenshots into
   `ROLL_SCREENSHOTS_DIR` when the surface requires inspection. The agent keeps
   `ac-map.json` in the story card root, mapping each AC to the evidence files
   that support it, with a status per AC: `pass` · `pass-with-evidence` ·
   `readonly` · `partial` · `claimed` · `missing`.
3. Close with the hard attest gate. The runner calls
   `roll attest <story-id> --run-dir "$ROLL_RUN_DIR"` at the end of delivery.
   `roll attest` sweeps the hard facts (TCR commits, latest CI run, optional
   deploy probe, test-pass proof), renders the Acceptance Review Page, and moves `latest` to the
   run. That is all it writes — it is story-scoped. It does not mount a story
   archive delivery section, regenerate `.roll/index.json`, or refresh any global
   archive/epic/front page (run the archive rebuild on demand for those board pages).

`roll attest` also runs standalone — without an intent map every AC renders as
🟧 Claimed, honestly.

Captured artifacts render by their actual media type, not the capture lane that
produced them. Image files (`png`, `jpg`, `jpeg`, `webp`, or `gif`, including a
recognised image signature without an extension) render as images; text output
such as `.txt` or `.log` is escaped and shown inline in a readable `<pre>`
block. A terminal capture may therefore appear in either form.

## Gate policy

The attest gate is **hard by default**. A delivered story with ACs but no fresh,
contentful report is blocked rather than marked `✅ Done`. During an explicit
migration window a project may set `.roll/policy.yaml` to soft mode:

```yaml
loop_safety:
  attest_gate: soft
```

Soft mode records the gap and raises the same audit signal, but it does not
block the delivery cycle. Treat it as temporary compatibility, not the default.

The merge gate reads structured evidence, not prose. A delivery can be refused
when any of these facts are true:

- `attest render` exits non-zero;
- `ac-map.json` references a path that does not resolve under the story run or
  card archive, except allowed GitHub PR/commit/check URLs for this repository;
- an AC remains `claimed`, which means the Builder asserted completion without
  pass/fail evidence;
- an AC remains `needs-confirmation`, which means the harness draft still needs
  Builder review;
- a positive AC (`pass`, `pass-with-evidence`, `readonly`, or `partial`) has no
  real evidence reference;
- a non-exempt visual card has no captured screenshot or recorded machine
  capture skip;
- a declared `deliverable_url`, `deliverable_cmd`, or `physical_terminal`
  surface was not really captured;
- an AC is `fail`, which means a check ran and went red.

The PR body carries a `Roll-Evidence` trailer that points reviewers to the
story-scoped evidence. Treat that trailer as the entry point for human review:
open the Acceptance Review Page, then follow the AC map and referenced files.

Use the audit command before release or when a Done row looks suspicious:

```bash
roll attest audit
roll attest audit --json
```

It scans Done stories for missing reports, missing or empty `ac-map.json`,
dangling evidence references, and `evidence_debt` rows. A clean audit exits 0;
any issue exits 1 and lists the story IDs and missing references.

## The red line

An AC with **zero evidence** can never claim `pass` or `pass-with-evidence`: the
renderer forces it down to 🟧 Claimed and lists it under **Discrepancies**.
`pass-with-evidence` is a harness-confirmed status backed by strong on-disk
evidence; it is explicitly not the same as an agent-confirmed `pass`. Verbal
completion ("I confirmed it works") is exactly what this rules out.

## Outward behavior verification

Some ACs describe behavior Roll cannot prove locally — a real
`npm i -g github:owner/repo`, a published CLI's first run, a live OAuth
callback. A build or `npm pack` succeeding does **not** prove any of these; a
simulation is not the outward promise. Marking such an AC "manual-only" and
letting it render green is the same as substituting *not run* for *passed*.

When a story or fix documents an external install / publish / login channel, the
relevant AC must declare **one** explicit verification path in its Evaluation
contract — Roll never infers "outward" from prose:

```yaml
expected_evidence:
  - kind: external-smoke                     # real command in an isolated env
    target: npm i -g github:owner/repo#<commit> && repo --version
    proves: the documented git-install channel installs and starts clean
    outward:
      mode: external-smoke
      command: npm i -g github:owner/repo#<commit> && repo --version
      environment: release                   # ci | nightly | release
      timeout_sec: 180
  - kind: owner-attested                     # human sign-off when no smoke can cover it
    proves: the production OAuth callback round-trips
    outward:
      mode: owner-attested
      reason: needs a real third-party account; no safe automated path exists
      approvalRef: https://github.com/owner/repo/issues/1343
```

The attest report renders an **Outward verification** banner and table near the
top. Only a real smoke pass (or a valid, unexpired owner attestation) is green:

| Resolved state | Report line | Green? |
|----------------|-------------|--------|
| `verified` | `VERIFIED (external smoke)` / `VERIFIED (owner-attested)` | yes |
| `verified-in-simulation` | `verified-in-simulation — simulation only, NOT accepted` | **no** |
| `unverified-external` | `UNVERIFIED — external smoke not run` (or `owner attestation pending`) | **no** |
| `failed-external` | `FAILED — external smoke` | **no** |

A single non-`verified` outward AC turns the banner red — the delivery cannot
overstate its outward behavior. `npm pack`–style simulation evidence is kept and
labeled `verified-in-simulation`, but it never substitutes for a real smoke.

### Release / nightly smoke setup

External smoke runs in an **isolated** environment — a fresh temporary
`HOME`/`PREFIX`/working directory — and executes only the exact command template
declared in the spec, with controlled variables. Its artifact records exit code,
version, and a redacted stdout/stderr summary; credentials are never written.

Point the runner at an environment with `ROLL_SMOKE_ENV=release` (or `ci` /
`nightly`); a declaration whose `environment` does not match the current one is
reported `unverified`, never silently skipped. **No real publish or account
action is ever automatic**: nothing that pushes a package, mutates a remote
account, or spends money runs without a declared authority (an `external-smoke`
command you wrote into the spec, or an `owner-attested` approval reference). If no
matching smoke environment exists, the AC stays `unverified` and the report stays
non-green — it is never auto-promoted to a manual pass.

## Declaring visual evidence at design time

`roll story validate` checks, at design time, that a spec is *born* with a
visual-evidence AC (and, for a web surface, a declared product page to capture).
If the spec has a visual-evidence AC but no declared surface
(`deliverable_url`, `deliverable_cmd`, `physical_terminal`, or
`screenshot_exempt`), validation prints a soft must-declare warning and still
exits 0. Runtime gates carry the same must-declare signal as a diagnostic only;
they do not block or mark the delivery skipped for that reason alone.
Two rules decide what the validator recognises:

- **The `[visual-evidence]` marker is authoritative.** An AC item that opens with
  a literal `[visual-evidence]` marker *is* a visual-evidence AC — on its own, no
  matter what words follow. You do not need to also write "screenshot" / "截图":
  the marker is your explicit declaration. (Without the marker, the validator
  still recognises unambiguous nouns like `screenshot` / `截图` / `录屏`.)

  ```markdown
  - [ ] [visual-evidence] headless capture of the Now landing and each tab
  ```

- **The declared surface wins over AC text.** Once a spec has a visual-evidence
  AC, its surface is read from the frontmatter first:
  - a declared `deliverable_url:` (alias `screenshot_url:`) ⇒ **web** — the card
    has committed to a real product page, so it owes a web screenshot;
  - a declared `physical_terminal:` ⇒ **terminal** with a stricter contract — the
    report must contain a real macOS `Terminal.app` screenshot captured from
    screen pixels. Headless stdout, transcript-rendered images, and HTML replays
    are rejected for this contract. `roll attest` also asks the
    `physical.screenshot` provider for this evidence when available, copies the
    returned PNG into the story run, and shows the status chain
    `requested -> taken/skipped/failed/timeout -> attached/not-attached`;
  - else a declared `deliverable_cmd:` ⇒ **terminal** — a CLI deliverable that
    rides the terminal-capture lane;
  - else the AC text decides (web / terminal / ambiguous).

  So a card that declares `deliverable_url: .roll/features/agents.html` is judged
  a **web** surface even when its AC prose mentions a `roll` command.

## Evidence Modes

Stories may declare `evidence_mode:` in frontmatter, or an Evaluation contract
may declare `- evidence_mode: ...`. Roll also derives a mode for Evaluator
prompts, but only an explicit non-visual mode changes the screenshot gate.
That explicit mode is not a blank override: a declared URL, terminal command,
physical terminal, or visual-evidence AC still escalates to the relevant capture
gate.

| Mode | Required proof | Screenshot policy |
|------|----------------|-------------------|
| `visual_ui` | rendered visual capture, functional/smoke check, CI | required |
| `cli_output` | stdout/stderr snapshot, exit code, command fixture or focused test, CI | conditional; required for terminal/TUI visual changes |
| `refactor_contract` | focused tests, typecheck/build, grep/no-old-symbol checks, CI | not required unless visual risk is present |
| `data_state` | fixture replay, event assertions, idempotency/concurrency coverage, CI | not required unless visual risk is present |
| `docs_content` | rendered text checks, link checks, diff review, CI | conditional; required for layout changes |

`screenshot_exempt:` should name or imply the alternate matrix, preferably by
pairing it with `evidence_mode: refactor_contract`, `data_state`, or
`docs_content`. QA/Evaluator may escalate any non-visual mode back to a screenshot
gate when a visual surface changed, an AC explicitly asks for visual evidence, or
prior evidence exposes rendering/layout risk; the escalation reason must be
recorded.

## External tool readiness

Visual evidence uses machine-level tools that are declared explicitly and probed
at startup:

- `macOS screencapture` — physical Terminal.app / browser-window screenshot
  capture. It is built into macOS, but Terminal.app, the stable roll capture
  host, must have Screen Recording permission. Missing permission means attest
  records an honest screenshot skip; headless, transcript-rendered, and HTML
  reproduction images do not count as screenshot evidence. A successful
  interactive `Terminal.app` permission probe is cached under `ROLL_HOME` so
  repeated `roll doctor` / setup checks do not keep re-triggering the macOS
  prompt; if permission was just granted, restart Terminal.app before trusting
  the cache.
- `Roll Capture.app` / `physical.screenshot` — the provider path for physical
  screenshot requests. If readiness is unavailable, `roll attest` records an
  honest skip with the setup reason instead of blocking report generation; if
  the provider times out, the report surfaces timeout as its own failure reason.
  On macOS npm installs, Roll tries to install the app from the latest
  `seanyao/roll-capture` Release into `~/Applications`; `roll setup` can retry
  that repair unless `--no-capture-install` is set.

  **Capture default strategy (US-PHYSICAL-006):** Physical screenshot requests
  default to **window-level** capture — they only capture the tested application's
  window (Terminal.app for terminal/CLI evidence, Google Chrome for web evidence),
  not the full screen. Full-screen capture requires an explicit
  `capture_fullscreen: true` frontmatter declaration in the card spec. This
  privacy-first design prevents evidence chains from including irrelevant on-screen
  content (chat, email, other projects). If the target window is not found, Roll
  Capture.app returns a documented fallback with the reason recorded in the
  response and evidence ledger — no silent expansion of capture scope.

### Capture v2 gateway — per-source readiness (US-PHYSICAL-010..013)

Roll's capture host speaks two protocols. `roll capture status` reports readiness
**per source**, so it never claims a blanket "v2 ready" when a lane is still v1:

- **rendered (`playwright-rendered`)** — served **in-process** by Roll via headless
  Playwright: a declared web surface is rendered to a PNG and turned into a
  `roll.capture.v2` receipt with a `sha256` digest. It advertises v2 **only when
  Chromium is installed**; otherwise status shows it `unavailable` with an
  actionable reason (never a fabricated capability).
- **physical (`roll-capture-window`)** — the native `Roll Capture.app`, honestly
  **v1** today (the file-drop protocol). Physical v2 is a separate follow-on
  (US-PHYSICAL-014); status labels it `v1` rather than over-claiming v2.

Wiring it up:

- `roll capture refresh` probes the real machine and writes an honest
  `capabilities.json` (rendered → v2 when the renderer is present; physical → v1).
- `roll capture status` then shows `v2 playwright-rendered — ready` alongside
  `v2 roll-capture-window — unavailable` (legacy), instead of one blanket line.
- `roll capture migrate` enables `best_effort` only when the rendered v2 lane is
  genuinely served; otherwise it retains the current policy with an explicit
  reason. With `best_effort` on, a declared surface is dispatched through the
  in-process rendered lane, producing a taken v2 receipt on the CaptureSet; a
  login / foreign-redirect / disallowed target is recorded as `skipped`, never a
  fabricated taken.
- `Playwright Chromium` — optional headless web capture for `roll attest` and
  archive screenshots. Install with `npx playwright install chromium`.

`roll doctor` always prints the current availability, permission state, impact,
and repair command for these tools. Use `roll doctor --tools` when you only want
the focused tool and Terminal.app Screen Recording readiness view. `roll init`
and `roll loop go` run the same probe at startup; in an interactive terminal they ask whether to install/open
the missing setup steps, and in automation they stay silent unless
`ROLL_EXTERNAL_TOOLS=yes` or `ROLL_EXTERNAL_TOOLS=no` is set. Choosing `no`
prints the evidence impact and continues without changing the machine.

The machine Agents page (`.roll/features/agents.html`) includes the same tool
status block so a reviewer can see whether evidence capture depends on
machine setup rather than story code.

## Best-effort capture, evidence health, and repair

Visual evidence is a **best-effort** delivery capability: every declared visual
surface is attempted through every eligible capture lane, and a capture-service
outage is never misread as a product regression. Delivery correctness and
visual-evidence health are kept as **separate facts**.

### Source labels

Every accepted image carries the lane that produced it:

- **Roll Capture · physical** — a physical screenshot of your real terminal or
  app window, taken by Roll Capture.app. It proves what was on screen; it never
  claims a URL it cannot observe.
- **Playwright · rendered** — a rendered receipt whose `finalUrl` equals the
  declared surface after approved redirect normalization. A target-bound rendered
  receipt is eligible visual evidence — distinct from a diagnostic screenshot.

A target-bound rendered receipt can satisfy a visual AC on its own. A physical
Roll Capture image is one eligible source for a visual AC; a target-bound
rendered receipt is another, equally valid one.

### The four visual states

| State | Meaning | Gate action |
|-------|---------|-------------|
| `verified` | at least one valid, target-bound image (physical or rendered) | publish normally |
| `degraded-infrastructure` | every configured lane was attempted; only host/provider/tooling failures occurred | publish, visibly marked degraded; **do not rebuild** — repairable by an evidence-only rerun |
| `invalid-target` | a lane reached login, an unapproved redirect, the wrong target, a corrupt image, or a forged receipt | block as an evidence failure; repair the target/configuration |
| `absent-contract` | no declared surface, no planned attempt, or the planner was bypassed | block as a design/execution failure |

`degraded-infrastructure` is intentionally not a green screenshot claim. It
separates code delivery from a broken evidence machine so the same completed
story is never repeatedly rebuilt.

### Privacy boundaries

- Receipts never include credentials, cookies, DOM dumps, or network bodies.
- Window capture is window-scoped by default; a missing target produces a typed
  failure, never a silent expansion to full-screen.
- `ROLL_NO_SCREENCAP=1` bans only the Runner's direct native `screencapture` /
  AppleScript path. It does not disable the Roll Capture gateway request or the
  Playwright rendered attempt.

### Controlled local-window capture

When a physical web receipt needs a browser window but no safe window exists,
use the restricted local lane:

```bash
roll capture local-window --story FIX-005 --url http://127.0.0.1:4173/team
```

For a synthetic local UI that needs a visible state change before capture, add a
restricted `--prepare` JSON list:

```bash
roll capture local-window --story FIX-1435 --url http://127.0.0.1:4173/ \
  --prepare '[{"kind":"click","selector":"#synthetic-checkbox"},{"kind":"wait","ms":300},{"kind":"scroll","selector":"#synthetic-result"}]'
```

`--prepare` permits only bounded `click`, `fill`, `wait`, and `scroll` actions.
Unknown fields or action kinds, arbitrary JavaScript, navigation, and excessive
lists or waits are rejected before Chrome launches. A temporary Playwright
connection attaches only to the disposable loopback Chrome, resolves exactly
the already-discovered page and its one exact original target frame, and verifies
that frame remains at that exact URL after every action. The connection then
detaches without closing the capture window. `click` resolves a visible element
through the browser UI path, so controlled React inputs receive their normal
event path. A prepare failure sends no capture request. `fill` accepts only
non-password `input` and `textarea` controls; contenteditable targets are
rejected.

This is not general browser automation: it cannot use an owner profile or open
remote URLs. The prepare API exposes no cookie or storage read/write/import/
export operation and does not inject credentials; ordinary local application UI
interactions still behave normally. `fill` rejects password controls and must
be used only for non-sensitive synthetic local values; never place credentials
or personal data in a command line.

It accepts only loopback HTTP(S) pages. Roll starts a disposable Chrome profile
and a nonce-titled local wrapper window, asks Roll Capture.app for that exact
window title, then closes the wrapper, Chrome, and profile. It never opens a
remote URL, connects to an owner Chrome profile, or falls back to a full-screen
capture. The JSON result includes the physical receipt and exact selector.

The real local controlled-input regression is opt-in because it opens a visible
disposable Chrome window; it serves only a temporary synthetic React page and
fails loud when the desktop Chrome host is unavailable:

```bash
ROLL_BROWSER_LIVE=1 pnpm test:controlled-capture-live
```

### Evidence-only repair

A `degraded-infrastructure` delivery can be repaired without reopening the build:

```bash
roll capture repair <story-id>
```

This re-runs **only** the capture lanes and re-resolves evidence health. It never
touches the TCR / build cycle and never reopens the completed delivery. It
refuses (and still does not rebuild) for a failed delivery or any non-degraded
state. A `verified` result publishes the newly captured image; a still-degraded
result stays publishable and marked degraded.

### Enabling best-effort capture

The default for new visual stories is `best_effort`. Existing projects keep their
recorded policy until an explicit, capability-aware, reversible migration enables
it:

```bash
roll capture migrate            # enable best_effort ONLY when the v2 gateway AND renderer are ready
roll capture migrate --dry-run  # preview without writing
roll capture migrate --revert   # restore the previously recorded policy
```

The migration is idempotent. It enables `best_effort` only when **both** the v2
Roll Capture gateway and the browser renderer are ready; otherwise it retains the
existing policy with an explicit reason (`provider_v2_unavailable` /
`renderer_unavailable`) — never a guessed fallback. It never force-flips an
existing project.

### Readiness

`roll doctor` (and `roll capture status`, and `roll loop status --capture`)
report the v2 gateway readiness, the renderer readiness, and the effective
capture policy — each with an actionable reason:

```bash
roll doctor              # includes a "Capture policy readiness" section
roll capture status      # the same readiness, standalone (add --json for machines)
roll loop status --capture
```

## Review Score fold

When `.roll/notes/` carries the story's Review Score entry, the report ends
with a collapsed *Review Score · 评审分* section. No entry → no section. The
Review Score is produced by a fresh-session peer Reviewer, never by the
building agent.

## Where cards come from — `roll idea`

Add a card with one natural-language sentence:

```bash
roll idea "Refund flow is broken for partial payments"
```

`roll idea` auto-classifies it (bug → FIX / feature → IDEA), assigns the
next id in that family, lint-checks the description, infers the right epic
folder, and mints the full card folder (spec.md + story page + index
refresh). All in one command.

For explicit control over id and epic, the internal `roll story new` is
available:

```bash
roll story new US-PAY-001 --title "Refund flow" --epic payments
# the ONE minting entry: card folder + backlog row + index refresh in one step.
# Batch minting: add --no-index per card, finish with a single the archive rebuild.
```

Both channels write the frontmatter'd `spec.md`, the story page skeleton,
and refresh `.roll/index.json`. They refuse to overwrite an existing card —
cards are born once, then evolved by hand. Skills never hand-create card
files; the `cards` consistency dimension fails the release gate on any
live backlog row without a card.

## Static Archive — the archive rebuild

the archive rebuild is an on-demand repair/archive renderer. It regenerates browsable,
three-layer static HTML pages (every page is self-contained, localized with one
visible language at a time, theme-aware, printable):

```
.roll/features/index.html              ← archive front page (Story / Cycle /
                                         Release), truth strip, searchable epic cards
.roll/features/<epic>/index.html       ← epic page: epic ledger + stories in three
                                         groups (merged / in a cycle / in backlog)
.roll/features/<epic>/<id>/index.html  ← story archive: five stations — Definition,
                                         Design, Execution, Delivery (attest banner
                                         + per-AC evidence blocks), Retrospective
```

Every figure is computed from the truth model — anchors -> selectors -> adapter
-> projections — never typed in. Story facts compare backlog claims with merge
and evidence truth; Cycle facts use TerminalOutcome records; Release facts use
the latest gate verdict and active waiver. The guiding line: **backlog is wish,
main is truth, done ≡ merged.**

The archive front page keeps unknown visible. `?` means the fact is absent
or outside the known schema; `0` means a known zero. A premature backlog
`✅ Done` row is treated as a claim that conflicts with truth and is rendered as
drift, not as delivered work.

On story archive pages, screenshot evidence remains a thumbnail linked to the
full image. Text evidence such as Vitest output is read from the referenced
evidence file and shown inline under the AC in a folded, scrollable block; if
the file is missing or unreadable, the page shows an explicit unavailable state.

The current delivery truth remains story-scoped attest plus CLI-first
observability (`roll status`, `roll loop watch`, `roll loop runs`,
`roll loop cycle <id>`). Use the archive rebuild by hand for reconciliation, archive
export, CI artifacts, or migration repair; rebuild mode re-renders every story
page from source after hand-merges or history migrations.
