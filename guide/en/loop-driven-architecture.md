# Loop-Driven Agent Architecture

> Why Roll uses independent loops instead of DAG-based multi-agent orchestration — and what that means for building reliable AI software delivery systems.

---

## The Mainstream Approach: DAG + Orchestration

Most AI agent frameworks today follow a similar pattern. A design step decomposes a goal into a directed acyclic graph (DAG) of subtasks, assigns each node to a specialized agent, and an orchestrator drives execution in dependency order:

```
Goal: "Implement feature X"
         │
     Design step
         │
    ┌────┴────┐
  Agent A   Agent B    ← parallel
    │         │
    └────┬────┘
       Agent C         ← depends on A + B
         │
       Output
```

This model maps cleanly to how humans think about project management. It's easy to visualize, easy to explain, and works well in demos. Frameworks like LangGraph, AutoGen, and CrewAI have popularized it.

**Where it struggles:**

- **Brittleness**: If Agent B fails halfway, the whole graph stalls. Recovery logic is hard to write and harder to test.
- **Upfront omniscience**: Building the DAG requires knowing all dependencies before execution begins. Real software development doesn't work that way — you discover constraints as you go.
- **Synchronous coupling**: All agents must be available simultaneously. A slow agent blocks the pipeline.
- **Opaque state**: The execution state lives inside the orchestrator. When things go wrong, the trace is an abstract graph — not something a human can inspect and reason about.

These problems don't matter much for one-shot tasks ("summarize this document", "generate this report"). They matter a lot for **continuous software delivery**, where work is ongoing, requirements evolve, and humans need to stay in the loop.

---

## Roll's Approach: Independent Loops + Reconciliation

Roll coordinates AI agents differently. Instead of a central planner and a shared execution graph, Roll uses **independent loops** with one job each, plus an event-backed Delivery Reconciler that advances published work opportunistically.

```
         BACKLOG  ←──────── shared state ────────→  git / PRs / alerts
            │
    ┌───────┼──────────────┬──────────┐
    ▼       ▼              ▼          ▼
main loop  reconciler     dream      brief
  cycle    boundary/read   daily      daily
  deliver  merge + credit  scan       digest
  stories  from main       code
```

Each scheduled loop:
1. **Polls** a specific artifact (BACKLOG, open PRs, alert file)
2. **Acts** on what it finds (write code, heal CI, merge)
3. **Writes back** to shared artifacts (commits, PR comments, BACKLOG updates)
4. **Sleeps** until next interval

Loops never call each other directly. They coordinate through artifacts. Reconciliation is not a daemon: cycle boundaries, read paths, and `roll loop reconcile` all run the same idempotent truth engine.

---

## This Is Choreography, Not Orchestration

The distinction matters. In **orchestration**, a central authority tells each participant what to do and when. In **choreography**, each participant knows its own job and reacts to events in the shared environment.

| | Orchestration (DAG) | Choreography (Loop) |
|--|--|--|
| Coordination | Central design step | Shared artifacts |
| Failure domain | Whole graph | Single loop |
| State location | Orchestrator memory | git + BACKLOG + PRs |
| Human visibility | Abstract task graph | `git log`, PR list |
| Human intervention | Hard — must interrupt the graph owner | Easy — edit BACKLOG |
| Agent availability | All must be online simultaneously | Each runs independently |

Choreography is the pattern behind Unix pipelines, microservices event buses, and distributed databases. Roll applies it to AI software delivery.

---

## What This Looks Like in Practice

**DAG approach** — "Add a new agent":

```
Design step decomposes:
  → Agent 1: edit the CLI dispatch
  → Agent 2: update docs (EN)
  → Agent 3: update docs (ZH)      ← depends on Agent 2
  → Agent 4: write tests
  → Agent 5: verify CI             ← depends on 1–4
  → Orchestrator: open PR
```

If Agent 3 times out, Agents 4 and 5 wait. The orchestrator must decide: retry? skip? fail?

**Loop approach** — same task:

```
main loop fires:
  → reads BACKLOG → picks "US-AI-004: add a new agent"
  → writes code in TCR micro-steps (each step: test → commit or revert)
  → opens PR

publish-boundary reconcile tick:
  → sees PR is open, CI still running → keeps awaiting_merge

next cycle/read/explicit reconcile tick:
  → CI green, mergeable → merges PR → done
```

No orchestrator. No dependency graph. Each loop does its job when the time is right.

---

## Why Loops Are Better for Continuous Delivery

Software delivery is not a one-shot task. It is an ongoing process:

- New stories appear in BACKLOG
- Bugs surface in production
- Dependencies go stale
- CI gets slower
- PRs accumulate

A DAG is designed to execute once and terminate. A loop is designed to run forever, doing useful work whenever conditions are right. For continuous delivery, you want loops.

**Resilience**: Loops are isolated. A failed cycle does not stop other projects, and any later Roll invocation can resume reconciliation from the event ledger and main.

**Observability**: Every action a loop takes produces a git commit, a PR comment, or a BACKLOG update. The history of the system is the git log — human-readable, diffable, revertable.

**Human control**: Want to pause delivery? Set a flag in BACKLOG. Want to prioritize a story? Edit the backlog priority. Want to stop delivery? End the session, or `roll loop pause`. No need to interrupt a running orchestrator or cancel a mid-flight agent chain.

**Incremental correctness**: TCR (Test-Commit-Revert) ensures every micro-step either advances the codebase to a green state or reverts cleanly. The loop never leaves the repository in a broken state between cycles.

---

## The Specialized Loop Architecture

As the system matures, loops become more specialized:

| Loop | Cadence | Does |
|------|---------|------|
| **main loop** | 30 min | Reads BACKLOG → writes code → opens PR |
| **Delivery Reconciler** | cycle boundaries, reads, explicit command | Merges eligible green PRs and credits delivery from main evidence |
| **CI loop** | 5 min | Detects flaky tests, collects timing data, reruns failures |
| **alert loop** | 1 min | Aggregates `_LOOP_ALERT` entries, sends notifications |
| **bug loop** | 1 hour | Scans logs and error patterns, opens FIX stories |
| **dep loop** | 1 day | Checks outdated deps and CVEs, opens upgrade stories |
| **doc loop** | 1 day | Detects code/doc drift, opens docs PRs |
| **dream loop** | nightly | Reflects on recent work, refines BACKLOG priorities |

Each loop reads and writes only its own domain. The coordination between them is entirely emergent — no loop knows the others exist.

---

## Trade-offs: When to Use Each Approach

Roll's architecture is not universally superior. Choose based on your problem:

**Use DAG/orchestration when:**
- The task has a well-defined, finite scope ("build this service from scratch")
- All dependencies are knowable upfront
- You need tight sequential control (output of step N is exact input to step N+1)
- The task runs once and terminates

**Use loop/choreography when:**
- Work is continuous and ongoing (software delivery, monitoring, maintenance)
- Dependencies are discovered at runtime
- Resilience matters more than tight coupling
- Humans need to observe and intervene
- The "system" should keep running even when individual components fail

Most real software delivery systems are the second kind. That's why Roll is built on loops.

---

## The Deeper Insight

The DAG model assumes that intelligence lives in the planner — the agent that decomposes the goal. The loop model assumes that intelligence is distributed — each loop knows its domain deeply and acts autonomously.

In practice, "plan everything upfront" breaks down as soon as reality diverges from the plan. Loops don't have a plan to diverge from. They observe the current state of the world (BACKLOG, open PRs, CI status) and act accordingly. If a PR conflicts, the loop rebases it. If CI is red, the loop reruns. If a story is blocked, the loop skips it and takes the next one.

This is closer to how experienced engineers actually work: not by executing a pre-committed plan, but by continuously scanning the environment, doing the highest-value available action, and leaving everything in a clean state.

Roll encodes that behavior as loops.
