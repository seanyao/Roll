# 验收契约权属 / Acceptance Contract Ownership

> Category: process. The design-owned acceptance contract, the evidence taxonomy,
> and the honest ceiling of what the harness can guarantee. Companion to
> `docs/verification.md` (which specifies per-story AC + evidence shape).

## 1. 契约是设计层拥有的冻结产物 / The contract is a design-owned, frozen artifact

A story's **acceptance contract** is the set of things its delivery is judged
against: its **AC criteria** and its **evidence surface** (`deliverable_url` /
`deliverable_cmd` / physical screenshot / `screenshot_exempt`). Ownership is
strict and one-directional:

- **Designer owns it.** The contract is authored with the story and does not
  change during a build.
- **Builder only satisfies it.** The builder produces code + evidence to meet
  the contract; it never authors or edits the contract.
- **Evaluator only reads and judges it.** Attest reads the contract and decides
  Done; it never lets the builder's own edits redefine the bar.

**Enforced by topology, not per-agent tool permissions.** Roll runs a
heterogeneous agent fleet; there is no uniform per-agent write-lock. Instead the
contract is **frozen at cycle start** into a snapshot (a projection of the
evidence-surface frontmatter + the set of AC criteria texts, hashed), taken from
**design truth** — not the builder-writable worktree copy. The attest gate
judges against that frozen snapshot; a worktree spec whose contract projection
no longer matches the snapshot is **drift** and is surfaced as an alert. The
projection deliberately EXCLUDES completion claims (checkbox state, the `✅`
tick, the `**Status**` line, Delivery/narrative sections) so the ordinary
stale-claim reset is never mistaken for tampering.

**Ingest is shift-left and soft.** A story with an AC block must declare a
capture surface OR a `screenshot_exempt` reason. A card that declares neither is
recorded to a hold list and alerted at authoring time — never a hard block of
ingestion, and runtime `pick_story` is never blocked (a false positive must not
stall the loop).

**Exemptions are design-time and audited.** `screenshot_exempt` is part of the
frozen contract (a builder cannot introduce one that counts). "Exempt from
screenshot" is not "exempt from evidence": an exempt card still owes another
capturable evidence form (command output or named tests). The existing
exemption rate is an observability smell signal (surfaced overall + per epic);
legacy per-card exemptions and any policy epic-level blanket exempt
(`acceptance.screenshot_exempt_epics`) are auditable read-only for batch review,
forward-enforced and never retroactively blocked.

## 2. 证据分类 / Evidence taxonomy

Every AC-bearing story binds **at least one real, gate-resolvable capturable
evidence**. There is no "give nothing" path. Screenshot is one kind, not the
only kind:

| Surface | Capture | Bound by |
|---|---|---|
| Web page (`deliverable_url`) | headless screenshot | harness |
| CLI/terminal (`deliverable_cmd`, read-only roll command) | captured terminal output | harness |
| Physical desktop / real terminal | **roll-capture** (real screen pixels) | harness |
| Library / pure backend | named test-pass references | builder (non-captured) |

For **captured** artifacts (the first three), the harness — which knows what it
captured — is the intended owner of the ac-map binding, so the builder does not
type or confirm those paths; the builder's ac-map covers only **non-captured**
evidence (named tests, manual verification notes). "No screenshot" therefore
still requires a declared `deliverable_cmd` or named tests — not silence.

## 3. 能力天花板 / What this guarantees — and what it does not

These mechanisms guarantee, structurally:

- the contract cannot be silently tampered by the builder (frozen snapshot +
  drift detection);
- an AC-bearing card cannot enter the backlog with no declared way to produce
  evidence (shift-left ingest);
- captured evidence is bound to real on-disk artifacts, not invented paths.

They do **not** guarantee that the evidence CONTENT actually proves the AC. A
`deliverable_cmd: echo ok` or a vacuous test resolves as "evidence present" yet
demonstrates nothing. **Judging whether the evidence genuinely satisfies the
criterion is the Evaluator's semantic job** — read the content, score it — and
is out of scope for the existence/binding/ownership guarantees above. The
harness makes tampering hard and evidence necessarily present and correctly
bound; it does not replace the reviewer reading the proof.

## 4. 现状 / Implementation status (honest, not target-washed)

This model is delivered incrementally; the doc describes the intended contract,
and this section states what is LIVE vs DESIGNED so nothing above is read as
more-enforced than it is.

- **Live** (US-EVID-020/021/022): the contract PROJECTION + cycle-start frozen
  snapshot (`contract-projection.ts`, `contract-snapshot.ts`); the attest gate's
  worktree-vs-snapshot **drift alert** (`attest-gate.ts`, alert-only); the
  **shift-left ingest** surface check + hold list (`ingest-gate.ts`), phased and
  **default observe-only** (`metric`) — `alert`/`block` are opt-in via policy.
- **Function delivered, surfacing pending** (US-EVID-026/027): the exemption-rate
  computation (`exemption-stats.ts`) and read-only audit (`exemption-audit.ts`)
  are implemented and unit-tested, but not yet wired into a board/`roll status`
  line or a CLI command — they have no production caller yet.
- **Designed / in progress**: harness-owned binding of captured artifacts into
  the ac-map (US-EVID-023 — the read primitive exists; the draft-generator
  wiring + capture-failure surfacing are not yet wired); the confirmed-ac-map
  dangling-evidence remediation trigger (US-EVID-024); design-time hetero-
  consensus confirmation of exemptions + the enforced substitute-evidence
  requirement (US-EVID-025). Until those land, "no give-nothing path" and
  "harness owns the binding" are the DESIGN intent, not a runtime guarantee.

## 5. Delta Team 证据期望 / Delta Team evidence expectations

A **Delta Team** delivery (host-guided Designer → Builder → Evaluator, driven
through `roll delta`) does **not** get a stronger acceptance guarantee than an
ordinary Story — it gets a narrower, honestly-labelled one. Do not read Delta
protocol events as delivery or Done.

- **The Evaluator report is the acceptance judgment surface**, authored by a
  host-attested Evaluator sub-agent whose opaque session token differs from the
  Builder's. It carries the usual separate dimensions (blocking findings,
  advisory findings, independent score where available, attest/evidence status,
  design-contract-vs-delivered mapping, recommendation) plus explicit
  `## Inputs checked` and `## Rationale` sections, so it is demonstrably authored
  judgment, not a mechanical assembly. Roll never synthesizes it from
  score/attest fields.
- **Host attestation is structural validation only.** `roll delta validate`
  checks that the host-supplied tokens are non-empty, unique where required, and
  correspond across resolution/event/manifest. It is **never** proof of a fresh
  session, honored role/model, or actual model execution. Verification language
  is "host-attested / structurally valid," never "Roll proved a fresh session ran"
  or "the model executed."
- **Terminal binding is Option C (handoff-only).** `delta:terminal(handoff_ready)`
  is not Done, a merge, an attest verdict, or a DeliveryRecord. The sole Done
  terminal remains the Story path in §1–§4: accepted evidence via `roll attest`,
  delivery reconciled from a PR merged into `main`. An Evaluator recommendation
  never changes those facts; after handoff the owner runs the existing procedure
  manually.
- **Host-guided cost is unobservable.** Status renders `? (host_unobservable)`;
  no host-guided delegation writes a usage row or derives a per-role/total cost.
- **Full Delta Team** shares this contract but uses adapter-launched distinct
  role sessions and adapter-observed provenance; its multi-role cost stays
  `? (usage_authority_unavailable)` until a usage-authority schema is approved.
  Independent agents/hosts are never described as an ordinary Delta Team.
