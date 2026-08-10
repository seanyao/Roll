# Delivery metrics dictionary

`roll delta metrics [--from <epoch-ms|ISO>] [--to <epoch-ms|ISO>] [--json]`
and `roll supervisor metrics [--json]` are read-only projections. They rebuild
from immutable event and delivery records; they do not keep a counter cache.
Both commands are advisory only: they never route work, select a rig, change a
backlog priority, retry a task, merge a PR, or mark a story delivered.

Each render uses one locale. The Delta window is an inclusive filter on observed
event time (`--from <= ts <= --to`), never Git author time. Supervisor reports
the minimum and maximum observed event times it read. `null` in JSON and `?` in
the terminal mean that the required fact was absent, malformed, or inconsistent;
they are not zero, success, or a model-execution claim. Percentiles use
`nearest-rank`; every timing row names its sample size.

## Feature delivery view

`roll supervisor delivery <feature-id|card-id> [--from <ISO>] [--to <ISO>] [--json]`
is the read-only unified feature delivery view. It joins loop cycles and Delta
delegations into one projection per card or feature:

- **One card has one final delivery conclusion**
  (`not_started | active | blocked | handoff_ready | delivered | attested | unknown`).
  Only a delivered/attested card is a final "done" conclusion; `handoff_ready`
  is a handoff, not a delivery.
- **Every attempt remains visible under its card.** A card repaired after an
  earlier failed attempt shows the failed earlier attempt **and** the delivering
  later attempt — the earlier attempt never erases main truth.
- **Timing, TCR, and rework numbers show their sample size** — fractions like
  `1/2`, `n/a`, and `P50 · sample N` are explicit, never bare averages.
- **Missing history stays incomplete** (`?` / `n/a` / `Incomplete:` codes in the
  terminal, `null` plus codes in `--json`), never a zero or a success. A visible
  `0` always means a known zero.

Loop cycles and Delta delegations are interleaved by time in one list — there is
no separate loop view and no separate Delta view to read as the primary
workflow. The two dictionaries below (`## Delta dictionary` /
`## Supervisor dictionary`) remain reference detail for `roll delta metrics` and
`roll supervisor metrics`; neither replaces this view.

**Safety boundary.** The command reads facts only. It opens the current backlog,
feature registry, and event ledgers read-only and projects them; it cannot route
an agent, retry work, change the backlog, merge a PR, or attest a card. Running
it never appends an event, writes a backlog row, spawns a session, or touches
git.

### Worked example: feature `delta-team`

Fixture: feature `delta-team` has two cards. Card `US-A` was repaired after an
earlier attempt — delegation `d1` was abandoned (`delta:d1 · failed`), a later
delegation `d2` handed off and the owner merged its PR, so the card is
`delivered`. Card `US-B` has one delegation `d3` that handed off without a
merge, so it is `handoff_ready`.

```
Delivery view: delta-team
Cards 2 · attempts 3
- US-A: delivered
  delta:d1 · failed · elapsed 1000ms
  delta:d2 · handoff_ready · elapsed 1000ms
- US-B: handoff_ready
  delta:d3 · handoff_ready · elapsed 1000ms
First-pass 0/0 (n/a; 1 incomplete excluded)
Rework attempts after first 1
Elapsed samples 3 · P50 1000ms · P95 1000ms
Incomplete: missing_delta_delivery_publish, missing_designer_start, missing_evaluator_start
```

Reading rules for this render:

- **Feature total**: `Cards 2 · attempts 3` — the summary counts each card's
  final state exactly once (`states: delivered 1, handoff_ready 1`) and every
  admitted attempt; totals are read across the **same** list, there is no second
  table.
- **One card, one final conclusion**: `US-A` is `delivered` because its PR merge
  is confirmed, while its attempt `delta:d2` stays visible with the delegation's
  own terminal (`handoff_ready`) — the owner merged the published PR after the
  handoff. The card conclusion comes from final truth, not from any single
  attempt.
- **First-pass 0/0 (n/a; 1 incomplete excluded)**: only delivered cards with a
  complete attempt history enter the denominator. `US-A` is delivered, but its
  earlier abandoned attempt left missing delivery evidence, so the view marks
  the card incomplete and excludes it — it renders `n/a` plus `1 incomplete
  excluded`, never a fabricated `0%`. US-A's repair is exactly why it can never
  be first-pass: its earliest attempt was `failed`.
- **Rework attempts after first 1**: the one attempt after US-A's earliest
  attempt (`delta:d2`).
- **Elapsed samples 3**: only non-null elapsed attempts; P50/P95 use nearest-rank
  over those three samples; a missing or inverted boundary would drop the sample
  and add a code instead of borrowing one.
- **Incomplete, not zero**: the `Incomplete:` line lists every diagnostic code —
  here `missing_delta_delivery_publish` (the abandoned attempt's cycle never
  published a delivery) plus `missing_designer_start` / `missing_evaluator_start`
  (this fixture's delegations carry no designer/evaluator stage records). A
  visible `0` always means a known zero.
- **Source references**: the human view hides provenance; `--json` exposes
  per-attempt and per-view `sourceRefs` (`ledgerUri` + `line` + `rawSha256`,
  e.g. `<project>/.roll/events.ndjson:10`) and every diagnostic code. Source
  labels are detail-only — they are never rendered as separate loop and Delta
  panes.

## Delta dictionary

| Metric | Source facts and calculation | Boundary and incomplete behavior | Gate? |
| --- | --- | --- | --- |
| `cards` / `attempts` / `mergedCards` | `cards` is distinct Story IDs among selected `delta:prepared` attempts; `attempts` is selected delegations; `mergedCards` is distinct Stories with a delegation-bound `delivery:reconciled` merge or a delivery record with `mergedAt`. | A delegation without a valid `delta:prepared` fact is orphaned and diagnosed. Window membership is by any selected observation, while its source facts may be outside the filter. | Advisory. |
| `firstPassMergeRate` | Numerator: merged Stories with exactly one delegation, no `owner_redelegate`, and no observed CI fail/rerun for that Story. Denominator: merged Stories. | No merged Story gives `value: null` and `reason: no_eligible_sample`, never 0%. | Advisory. |
| `redelegateRate` | Numerator: Stories whose attempts contain terminal `owner_redelegate`; denominator: all Stories with selected attempts. | An empty denominator is `null`, never 0%. | Advisory. |
| Builder wall / `phaseWallMs.builder` | Per attempt: first `delta:prepared` timestamp to first Builder `delta:artifact_published`; aggregate is the sum. `phaseSamples.builder` supplies sample size, total, P50, P95. | A missing boundary or inverted clock omits that attempt from the sample and adds a diagnostic. | Advisory. |
| Evaluator wall / `phaseWallMs.evaluator` | Per attempt: first Builder artifact publication to first Evaluator artifact publication; aggregate/sample fields use the same sum and nearest-rank rule. | Missing/inverted boundaries stay incomplete. | Advisory. |
| Merge tail / `phaseWallMs.mergeTail` | Per attempt: `delta:terminal(handoff_ready)` to delegation-bound reconciliation merge, falling back to the Story delivery `mergedAt`; aggregate/sample fields use the same rule. | A handoff is not a merge. Missing merge evidence leaves this timing incomplete. | Advisory. |
| `tcr.rounds`, `green`, `red`, `testWallMs` | `tcr:round_started`, `tcr:test_finished`, and `tcr:committed` are projected by round. Green/red count rounds with a recorded test outcome; `testWallMs` sums recorded test wall time. `completeRounds`, `incompleteRounds`, and `incompleteAttempts` expose coverage. | No TCR observations produces `null` for displayed rounds/green/red/test wall; partial rounds remain diagnosed rather than inferred. | Advisory. |
| `outcomeCauses` | Counts explicit `delta:attempt_outcome.cause` values: `implementation_gap`, `evaluator_finding`, `artifact_protocol`, `identity_or_routing`, `ci_or_test_flake`, `external_liveness`, `owner_scope_change`, or `unknown`. | No explicit outcome stays diagnosed and unclassified. A missing artifact is a missing observation, not proof of a model invocation or its absence. | Advisory. |
| `rigs` | Groups selected attempts by resolved Builder/Evaluator host and model. It reports attempts, Builder-wall sum, and model/provider diversity comparisons. | Missing role resolution renders the unknown identity and `modelDiverse` / `providerDiverse` as `null`. | Advisory; never rig selection. |
| `incomplete` / `diagnostics` | Reader diagnostics plus missing, duplicate, orphan, malformed, timestamp-inverted, or incomplete projection facts. | Any such fact sets `incomplete: true`; the projection preserves known rows instead of fabricating a clean result. | Not a gate. It asks an operator to inspect the source facts. |

## Supervisor dictionary

Supervisor creates one per-card row from immutable event records plus the current
backlog status. Aggregate timing rows (`queueWait`, `dependencyWait`,
`firstActionLatency`, `dispatchToMergeLead`, `prCiTail`, and
`reconciliationLag`) each contain `sampleSize`, `totalMs`, `p50Ms`, and `p95Ms`.
The total is the sum of non-null card values; P50/P95 use nearest-rank.

| Metric | Source facts and calculation | Boundary and incomplete behavior | Gate? |
| --- | --- | --- | --- |
| `observationWindow` / `sampleSize` | Minimum/maximum valid event timestamps and count of cards found in backlog or event boundaries. | No valid event time renders both window ends `null`; this is not an empty successful run. | Advisory. |
| `queueWait` | First `pick:ranked` that includes the Story to dispatch (`cycle:start` or `delta:prepared`). | Missing/inverted endpoints produce `null` and an `incompleteFacts` entry. | Advisory. |
| `dependencyWait` / `dependencyStates` | First `pick:blocked` or `pick:skipped` dependency observation to dispatch. It counts `blocked_by_not_done`, `not_yet_dispatched`, and `unknown`. | It is `null` when the dependency timestamp, later dispatch, required dependency status, or order is unavailable. | Advisory. |
| `firstActionLatency` | Dispatch to first `cycle:first_edit` or Builder `delta:role_started`. | Missing/inverted endpoints are `null`; it does not invent an action time. | Advisory. |
| `dispatchToMergeLead` | Dispatch to recorded `delivery:merge_confirmed` or non-superseded `delivery:reconciled`. | A `handoff_ready` does not supply a merge endpoint. | Advisory. |
| `prCiTail` | First `pr:open` or `delivery:published` to the latest `ci:pass`, `ci:fail`, or `ci:rerun`, falling back to recorded main merge. | Missing/inverted endpoints are `null`; a failed or rerun CI observation is still an observation, not a passing claim. | Advisory. |
| `reconciliationLag` | Recorded main merge to non-superseded `delivery:reconciled`. | Missing/inverted endpoints are `null`. | Advisory. |
| `delivery` / `handoffReady` | `delivery` is `delivered` only when a recorded main merge exists; `handoffReady` records a Delta handoff observation. | `handoff_ready` remains `not_delivered`; it is never a merge, attest verdict, or Done claim. | Delivery truth is reported, not changed. |
| `truth` / `truthConsistency` | Per card, compare recorded main merge, backlog Done status, and recorded attest fact. `truthConsistency.checked` counts consistent + inconsistent rows. | Missing source facts yield `unavailable` and `incomplete`; disagreement is `inconsistent`, never silently repaired. | Advisory; an operator uses it to investigate. |
| `incompleteFacts`, `incomplete`, `diagnostics` | Explicit per-card missing-source reasons plus event-reader diagnostics. | They remain visible in terminal and JSON. | Not a gate. |

## Operator example: classify facts, not imagined agent activity

Run the commands first, then inspect the event and delivery facts behind a row:

```sh
roll delta metrics --from 2026-08-01T00:00:00Z --json
roll supervisor metrics --json
```

Use the explicit outcome or recorded observation to separate these cases:

| Observation | Honest classification | What it does **not** establish |
| --- | --- | --- |
| A digest mismatch, missing required manifest field, or invalid contained artifact path is recorded by the protocol. | `artifact_protocol` | It does not establish whether a model was invoked. |
| A validated Evaluator report names a blocking finding. | `evaluator_finding` | It does not make the finding a merge decision. |
| CI records a transient fail/rerun and later evidence identifies it as flaky. | `ci_or_test_flake` | It does not turn the attempt into a first-pass merge. |
| The host, network, or required external service is unavailable and the recorded cause says so. | `external_liveness` | It does not make a product failure or an agent-health score. |
| The frame lacks an explicit outcome or another required observation. | `unknown` plus diagnostics | Missing artifacts are not proof of a model invocation. |

Host attestation likewise checks only token shape/correspondence. It is not proof
of a fresh session, the honored role/model, or a model invocation. Metrics make
measurement limits visible so a human can decide the next action; no metric
changes delivery state on its own.
