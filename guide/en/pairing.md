# Cross-Agent Pairing — heterogeneous second eyes, in the loop

Pairing makes a **different** agent (a different vendor) cross-check your work
automatically. The primitive is the **pair**, not the review: a working agent
delivers, and a heterogeneous peer reviews it for perspective diversity. A code
bug that one model's blind spot hides, another model's catches.

Roll treats reviewer assignment as the `evaluate` role in the scoped Agent
model: `Scope -> Role -> Binding -> Agent -> optional Model`. The agent is the
finite seven-name identity (`claude`, `kimi`, `codex`, `pi`, `agy`, `reasonix`, `cursor`);
the model is optional data carried by that agent.

Pairing is distinct from [`$roll-peer`](peer.md): peer is an on-demand,
multi-round negotiation you (or the loop's risk gate) trigger; pairing is an
always-available, one-way second pass wired into the cycle and governed by the
Project Scope `evaluate` binding.

## Turning it on — explicit, never silent

```bash
roll agent                         # inspect story.evaluate
roll agent migrate --dry-run       # preview one-time migration of old agent config
```

New projects should author the evaluator pool in `.roll/agents.yaml`:

```yaml
# .roll/agents.yaml
schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [claude, codex, kimi, pi, agy, reasonix]
        require: [evaluate]
        strategy: health-aware
```

`.roll/pairing.yaml` is not a runtime input. The scoped `evaluate` role is the
only source for pairing candidates. Static config lists fair candidates; runtime
auth/network/VPN/account failures skip candidates only for the current resolution.

## Seeing what it does — observability

Loop cycle evidence and role views show the pool (who can pair, their vendor,
declared capability, and **why** an agent is excluded), plus **how much pairing
has cost**:

```
  Cross-Agent Pairing — pool status

  enabled: true · stages: [code]

    ✓ claude  model=claude-opus-5 vendor=anthropic · [code]
    ✓ codex   model=gpt-5.3-codex vendor=openai · [code]
    · pi      model=deepseek-v4-pro vendor=deepseek · [code]

  pairings to date: 7 (codex×4, kimi×3) · total cost $0.94 · 11 findings
```

Cost is recorded on every pairing from day one — you always know what the
second pair of eyes is spending, even without budget-adaptive throttling.

## How selection works

When a stage fires, the selector keeps **only** agents that are installed,
available, declared capable for that stage, able to run as a headless reviewer,
and a **different vendor** from the working agent (computed from the resolved
model — see below) — then rotates among them
(seeded by the cycle id, so it is replayable). Agents with a track record are
gently preferred (ε-greedy, ε≈0.2), but exploration is always preserved so no
single pair monopolizes. If no qualified heterogeneous peer exists, that absence
is itself recorded (`pair:none-available`) — never a silent skip.

## What counts as "a different agent" — the model, not the name

Isolation distance is computed from the **resolved model**, and the vendor is
derived from that model. It is never inferred from the agent-entry name, because
the name is wrong in both directions:

- **Two entries, one model.** If `agents.yaml` pins two rigs to the same model,
  they are NOT a heterogeneous pair. In this repo `pi` and `reasonix` both resolve
  to `deepseek-v4-pro`, so pairing them would have one model reviewing its own
  family's work while reporting "independently reviewed".
- **One entry, many vendors.** `cursor` can run `claude-opus-5-thinking-high`
  (anthropic) or `gpt-5.3-codex` (openai), and defaults to `auto`. Calling that
  "one vendor" is fiction.

Four distances, strongest to weakest:

| Distance | Meaning |
|---|---|
| `vendor` | the reviewer's model is from a different, **known** vendor |
| `model` | a different model (possibly the same vendor) |
| `session` | the same model, but a freshly started session |
| `off` | nothing required (must be written out explicitly) |

**An unrecognised vendor can never satisfy `vendor`.** It degrades to the
strongest distance that can be proven, and records why. "We could not tell" is
never reported as "they differ". Adding a new agent or model means adding its
model prefix in the same change, or every comparison involving it quietly drops a
tier.

**Selection reads configuration, not observation.** The model a peer will run is
known before the spawn (its rig, else its registered default). Several agents ship
deliberately stubbed usage extractors, so if selection depended on the observed
model those agents could never satisfy a model/vendor distance at all. What the
peer's own output claims it ran is reconciled afterwards and **warns** on a
mismatch — it never revisits the decision.

## Effort — one table for both axes

Review strength and isolation strength are both facts about rigs, so one table
expresses both: the gates that appear are the review strength, and each gate's
value is the required distance.

```yaml
# .roll/agents.yaml
effort:
  code:  vendor      # code review: require a different vendor
  score: vendor      # scoring: require a different vendor
```

Presets expand to the same thing: `standard` (both gates at `vendor` — the
default), `light` (`code: vendor`, `score: off`), `off` (both off). A per-gate
entry overrides the preset it sits on.

Two deliberate refusals:

- **The default is never `off`.** A missing section, an unknown preset, or an
  invalid value all fall back to `standard` **and report an error** — switching
  review off has to be typed out.
- **Only `code` and `score` can be configured.** `design`, `test` and `cycle`
  exist in the stage enum but have no production path; configuring one is a loud
  error rather than a setting that silently never runs.

## Reading the trade-off — `roll effort`

```bash
roll effort           # per (gate x achieved distance): samples, hits, cost
roll effort --json
```

Read-only. Two things it refuses to do, both on purpose:

- **A cell with fewer than 10 samples gets no hit rate**, and is named in the
  output. A rate over a handful of samples reads like a trend and is not one; a
  zero-sample cell rendered as "0%" is the "nobody reported a problem, therefore
  there are none" fallacy.
- **Observable and unobservable cost are never averaged together.** A cost of `0`
  used to mean both "free" and "could not parse the usage" — those are now
  separate columns, because a peer whose usage footer is unreadable did not work
  for free.

Verdicts recorded before the achieved distance existed as a field are counted
apart (`untieredSamples`) rather than being assigned a distance that was never
measured.

## Safety — pairing never blocks a cycle

- **30s hard timeout** on the peer review (belt-and-braces in the executor), so
  a slow peer never stalls the cycle.
- **Non-blocking**: a timeout, error, or missing peer is recorded and the cycle
  proceeds. Pairing is an enhancement, never a gate.
- **Never touches main on its own**: pairing produces evidence and events, not
  merges.

## Events & evidence

Each pairing emits `pair:selected`, then `pair:verdict` (with the verdict,
findings count, cost, and stage) or `pair:none-available`. The verdict is also
written as evidence under the run's `peer/cycle-<id>.pair.json`. A score
pairing emits `pair:score` (score, verdict, cost) and writes
`peer/cycle-<id>.score.pair.json`.

## Stages

`code` and `score` are the defaults — a heterogeneous peer reviews the
delivered diff, and another scores the finished cycle. `design`, `test`, and
`cycle` extend the same mechanism to other checkpoints; enable them in
`stages` when you want earlier or broader second eyes.

## Review Score — a peer grades the cycle, never the author

An agent grading its own delivery is a conflict of interest, so the cycle's
quality score — the **Review Score** — is always produced by a Reviewer in a
**fresh, separate session**, never by the building agent (the agent does NOT
self-score):

- **In the loop**: after the acceptance gate passes, the runner casts a
  fresh-session Reviewer to score the delivery. The note lands in the card's
  `notes/` with provenance — `scoring: pair`, `scored-by: <agent>`, and the
  fresh-session id (so independence is verifiable).
- **Loop delivery**: after the acceptance gate passes, the runner triggers the
  same adapter from a fresh session.
- **Design output** (`roll-design`, no loop cycle): the design workflow can
  trigger a fresh-session Reviewer to grade the **design** (INVEST split,
  visual-AC completeness, `deliverable_url` correctness, domain/spec
  consistency) — not code. It stamps the score `stage=design`. The designing
  agent triggers but never grades its own work; no peer available → honest
  unscored (fail-loud), never a self-grade.
- **The builder's own agent never scores its own cycle when an independent peer
  exists**: whenever any other agent is installed, the builder is excluded from
  the score pool entirely — an independent Evaluator grades the delivery or the
  cycle fails loud (no self-score fallback, even from a fresh same-vendor
  session). The builder's own agent is the scorer **only** in a true
  single-agent install, where a fresh same-vendor session is the minimum
  acceptable independence. Independence is still verified by session id (a
  different `agent × model × session` rig is encouraged), so the single-agent
  case never deadlocks.
  A score sharing the builder's session — including any sub-agent of it — is
  rejected as a self-score. No independent candidate, a timeout, or a
  protocol miss does **not** fall back to a self-score; the absence is audited
  via a `pair:none-available` event and the story owes a fresh-session Review
  Score before it can attest (`review_score_missing`).
- **Real agent output is normalized before scoring**: an Evaluator's reply is
  accepted even when its stdout carries terminal control bytes, ANSI startup
  banners, a JSONL stream-json wrapper, or a bullet/markdown prefix — the parser
  normalizes these away, then still requires one complete, in-order
  `SCORE`/`VERDICT`/`RATIONALE` block (score 1..10, supported verdict). Prose
  that merely mentions the markers is still rejected.
- **Repeated final blocks are tolerated when they agree**: some Evaluators repaint
  their terminal (so the final block appears twice) or print the reply template and
  their analysis before the real block. The parser isolates the **final usable
  block** and accepts it when every valid `SCORE` line agrees and every valid
  `VERDICT` line agrees — a redraw is a resolved answer. Genuinely conflicting
  duplicate blocks (different scores or verdicts), template `<placeholder>` echoes,
  out-of-range scores, and unsupported verdicts are still rejected.
- **Rejections are observable, not generic**: when a reply is not accepted, the
  cycle records a specific reason instead of a bare "unparseable". `roll loop cycle
  <id> --roles` distinguishes an Evaluator that **returned score-like text but was
  not accepted** (e.g. conflicting duplicate blocks, a missing field) from one that
  **returned no score content** at all, with the precise reason on the role line.
