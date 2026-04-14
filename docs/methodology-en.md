# Cybernetix (CNX) Engineering Methodology: A Standardized AI Agent Delivery Framework

> **Version:** 1.0
> **Date:** 2026-04-15
> **Status:** Internal Engineering Whitepaper

---

## Abstract

As AI coding assistants evolve from point tools into team infrastructure, engineering organizations face an underappreciated challenge: **inconsistent behavior across AI clients (Claude Code, Gemini CLI, Cursor, Codex), fragmented environment configuration, and the absence of auditable quality gates on deliverables**. One developer writes code with Claude that passes local tests; another uses Cursor and bypasses those same tests — not because of a capability gap between the models, but because the two received entirely different engineering constraints.

Cybernetix (CNX) is an **instruction and workflow management framework for AI Agents**. It does not invent new methodology. Instead, it encodes proven software engineering practices (Scrum, TDD, TCR, SRE) as standardized, AI-executable Skill definitions, and enforces cross-client configuration consistency through a CLI tool.

This document describes CNX's three-loop engineering architecture and its corresponding technical implementation.

---

## 1. Architecture Overview: Three Interlocking Loops

CNX decomposes the software delivery lifecycle into three loops, each independently operable yet mutually reinforcing. Every loop inherits a set of classical methodologies and automates their execution through concrete Skills.

```mermaid
graph TB
    subgraph "Loop A: Research & Design"
        A1["$cnx-research<br/>HV 竞品与技术调研"] --> A2["$cnx-design<br/>需求原子化 → INVEST Stories"]
        A2 --> A3["BACKLOG.md<br/>状态索引"]
        A3 --> A4["docs/features/<br/>验收标准 & 设计方案"]
    end

    subgraph "Loop B: Implementation & Iteration"
        B1["$cnx-init<br/>工程脚手架"] --> B2["$cnx-story-build<br/>TCR 驱动开发"]
        B2 --> B3["$cnx-.code-review<br/>提交前自审"]
        B3 --> B4["CI / Deploy"]
        B4 --> B5["Verification Gate<br/>鲜活证据验收"]
        B5 --> B6["$cnx-.changelog<br/>变更沉淀"]
        B2 -.->|高风险路径| B7["$cnx-spar<br/>对抗式 TDD"]
        B7 --> B3
    end

    subgraph "Loop C: Observability & Maintenance"
        C1["$cnx-sentinel<br/>随机巡检"] --> C2{"异常?"}
        C2 -->|Yes| C3["$cnx-bb-debug<br/>现场取证"]
        C3 --> C4["$cnx-bb-analyzer<br/>根因诊断"]
        C4 --> C5["$cnx-fix-build<br/>回归修复"]
        C5 --> C1
        C2 -->|No| C1
    end

    A4 -->|"Story 流入"| B2
    B6 -->|"交付完成"| C1
    C5 -->|"问题升级"| A2
    C4 -->|"新需求发现"| A2

    style A1 fill:#e8f4fd,stroke:#2196F3
    style A2 fill:#e8f4fd,stroke:#2196F3
    style B2 fill:#e8f5e9,stroke:#4CAF50
    style B7 fill:#fff3e0,stroke:#FF9800
    style C1 fill:#fce4ec,stroke:#F44336
    style C3 fill:#fce4ec,stroke:#F44336
```

How the three loops interact:

- **Loop A → Loop B**: User Stories produced by the design loop flow into the implementation loop as execution units.
- **Loop B → Loop C**: Each deployment automatically brings new deliverables under the patrol loop's monitoring scope.
- **Loop C → Loop A**: Issues found during patrol that exceed the scope of a quick fix escalate back to the design loop for reassessment.

---

## 2. Global Configuration Management (Configuration Infrastructure)

### 2.1 The Problem

In environments where multiple AI clients coexist, each client has its own configuration entry point (Claude reads `CLAUDE.md`, Gemini reads `GEMINI.md`, Cursor reads `.cursor-rules`). Maintaining these files manually leads to:

- **Behavioral drift**: Different AI clients on the same project enforce different coding standards.
- **Fragmented configuration**: Engineering constraints scattered across multiple locations, with updates prone to gaps.
- **Cross-project inconsistency**: New projects cannot inherit the organization's engineering standards.

### 2.2 Technical Implementation

CNX uses the `cybernetix` CLI to centralize configuration management and distribute it atomically.

**2.2.1 Skill Mounting (`cybernetix setup`)**

On first run, the CLI performs three operations:

1. **Establish a Single Source of Truth**: Copies global conventions (`conventions/global/`) and skill definitions (`skills/`) from the repository into `~/.cybernetix/`, making it the sole authoritative configuration source on the machine.
2. **Symlink mounting**: Uses filesystem symlinks to mount `~/.cybernetix/skills/` into each AI client's configuration directory (`~/.claude/skills`, `~/.gemini/skills`, `~/.kimi/skills`, etc.). All clients share one canonical set of skill definitions — a change in one place propagates everywhere.
3. **Git Hook injection**: Installs a global `prepare-commit-msg` hook that automatically detects which AI client authored the current commit (via environment variables) and stamps it (e.g., `[claude code]`, `[gemini cli]`), enabling audit tracing in multi-agent workflows.

**2.2.2 Configuration Sync (`cybernetix sync`)**

One command performs a full distribution: convention files from `~/.cybernetix/conventions/global/` are delivered to each client's expected path in the appropriate format.

```
~/.cybernetix/conventions/global/
├── AGENTS.md        → ~/.kimi/AGENTS.md, ~/.codex/AGENTS.md
├── CLAUDE.md        → ~/.claude/CLAUDE.md
├── GEMINI.md        → ~/.gemini/GEMINI.md
└── .cursor-rules    → (project-level distribution)
```

**2.2.3 Project-Level Configuration (`cybernetix init`)**

When generating convention files for a specific project, CNX applies a **Global + Template merge strategy**:

```
Final AGENTS.md = Global AGENTS.md (organization-level constraints)
               + Template AGENTS.md (project-type constraints)
```

Four project templates (`fullstack`, `frontend-only`, `backend-service`, `cli`) each predefine their own architectural constraints, technology stack choices, and testing requirements. Global constraints apply to every project; template constraints apply only to the matching type.

### 2.3 Configuration Hierarchy

```
Organization (Global)    ← Coding standards, Git discipline, TCR workflow, test standards
  ↓ merge
Project Type (Template)  ← Architectural patterns (DDD/Clean Arch), tech stack, directory layout
  ↓ inject
Project Instance         ← AGENTS.md (constraints) + .claude/CLAUDE.md (client config)
```

---

## 3. Loop A: Product Definition and Requirements Design

### 3.1 Methodology Inheritance

| Classical Methodology | CNX Implementation |
|----------------------|--------------------|
| HCD (Human-Centered Design) | `$cnx-research`: Research before design; data-driven decision-making |
| BDD (Behavior-Driven Development) | `$cnx-design`: Requirements expressed as Acceptance Criteria |
| Scrum Backlog | `BACKLOG.md` + `docs/features/`: Two-tier index structure |
| INVEST Principles | Mandatory constraints on Story decomposition |

### 3.2 Research-Driven Design: `$cnx-research`

Structured research precedes requirements definition, preventing design decisions made on gut instinct alone. `$cnx-research` implements **HV Analysis (Horizontal-Vertical Analysis)**:

- **Vertical Axis**: Traces the full evolutionary arc of the subject — from its origins to the present — along a timeline. Produces a narrative analysis of 6,000–15,000 words, covering key inflection points, technology iterations, and market shifts.
- **Horizontal Axis**: Performs systematic benchmarking against comparable products and solutions at the current point in time. Produces a comparative analysis of 3,000–10,000 words, covering feature matrices, technology approaches, and positioning differences.
- **Cross-Axis Insights**: Cross-validates findings from both axes to surface trend predictions and strategic recommendations.

Research follows a strict source priority hierarchy: **primary sources > industry reports > secondary analysis**. Fabricating data is prohibited — information that cannot be verified is marked as unavailable, never invented.

The final output is a structured Markdown report that can be converted to a PDF with cover page and table of contents using the built-in `md_to_pdf.py` script (powered by WeasyPrint).

> **Scenario**: TaskFlow plans to add an "organization-level permission management" module. Before writing a single line, `$cnx-research` conducts an HV analysis on "B2B SaaS permission models" — the vertical axis traces the ACL → RBAC → ABAC → ReBAC evolution, while the horizontal axis compares how Linear, Notion, and GitHub each implement permissions.
>
> The cross-axis insight: after 2023, mainstream products universally layered resource-level fine-grained controls on top of RBAC — pure RBAC has become the minimum viable bar. This finding directly shaped how `$cnx-design` decomposed Stories downstream, averting a rework cycle that would have surfaced only after delivery.

### 3.3 Requirement Atomization: `$cnx-design`

Translates research findings and business requirements into instruction contracts that AI can execute. The core output is User Stories that conform to the **INVEST principles**:

| Principle | Requirement |
|-----------|-------------|
| **I**ndependent | Each Story can be delivered independently with no cross-dependencies |
| **N**egotiable | Defines acceptance criteria, not implementation details |
| **V**aluable | Each Story delivers perceptible user value |
| **E**stimable | Implementation scope is assessable; Action granularity is 2–5 minutes |
| **S**mall | A single Story can be completed within one session cycle |
| **T**estable | Each Story includes verifiable acceptance criteria |

> **Scenario**: A product manager's raw requirement is "admins should be able to see everyone's activity logs." `$cnx-design` decomposes this into three independent Stories: US-007 (write audit events), US-008 (audit list UI with filtering), and US-009 (export audit data as CSV).
>
> Each Story carries its own acceptance criteria — US-007's AC includes "create/delete/modify operations all generate audit events" and "events include actor ID, timestamp, and change diff." The export capability, which was buried implicitly in the original requirement, is surfaced as an explicit standalone Story rather than hidden in implementation details.

### 3.4 Management Artifacts: Two-Tier Index Structure

**`BACKLOG.md` (status index)** — the project's central state machine. Contains only Story ID, title, and status summary; implementation details are excluded:

```markdown
## Stories
| ID     | Title                | Status |
|--------|----------------------|--------|
| US-001 | User login           | ✅ Done |
| US-002 | Role-based access    | 🔨 In Progress |
| US-003 | Audit logging        | 📋 Ready |
```

**`docs/features/` (detailed design)** — each Story has two dedicated documents:

- `<feature>.md`: Full User Story including the Acceptance Criteria checklist.
- `<feature>-plan.md`: Technical design document with architectural decisions and implementation approach.

This separation keeps BACKLOG.md concise and readable as a progress dashboard, while detailed design lives in a dedicated location.

---

## 4. Loop B: Automated Implementation and Continuous Integration

### 4.1 Methodology Inheritance

| Classical Methodology | CNX Implementation |
|----------------------|--------------------|
| TDD (Test-Driven Development) | Tests written first; RED → GREEN → Refactor |
| TCR (Test && Commit ∥ Revert) | `$cnx-story-build`: commit on pass, revert on failure |
| DevOps / CI-CD | Objective arbitration layer: CI is the final authority on "deliverable"; minute-level feedback loops compress defect discovery cost |
| Defensive Programming | `$cnx-spar`: adversarial TDD for high-risk paths |

### 4.2 Project Scaffolding: `$cnx-init`

Standardizes project directory structure and CI configuration, eliminating the randomness of building from scratch.

`$cnx-init` applies the **Global + Template merge strategy** (see 2.2.3). Differences across project types primarily manifest in the **interaction layer**: frontend projects have a component tree and routing layer; CLI projects have command registration and interactive input; pure backend services have only an API interface layer. The complete structures for each template are as follows:

**`fullstack` template:**

```
my-project/
├── BACKLOG.md                       # Task index
├── AGENTS.md                        # Engineering constraints
├── docs/features/                   # Story details & design documents
│
├── src/
│   ├── domains/                     # DDD domain core (entities, value objects, domain services)
│   ├── app/                         # Application service layer (use-case orchestration)
│   └── lib/                         # Cross-layer shared utilities
│
├── components/                      # UI component layer (React + shadcn/ui)
│   ├── ui/                          # shadcn-generated — do not edit manually
│   └── [feature]/                   # Business components (grouped by feature)
│
├── app/  (or pages/)                # Routing and page layer (Next.js App Router)
│   ├── (routes)/                    # Page routes
│   └── api/                         # API routes / BFF layer
│
├── tests/
│   ├── unit/                        # Domain logic unit tests
│   ├── integration/                 # Service layer integration tests
│   └── e2e/                         # Critical-path end-to-end tests (Playwright)
│
├── .env.example                     # Environment variable template
└── .github/workflows/
    ├── ci.yml                       # Continuous integration
    └── sentinel.yml                 # Automated patrol
```

The remaining templates (`frontend-only`, `cli`, `backend-service`) differ only in their interaction layer — `BACKLOG.md`, `AGENTS.md`, `docs/features/`, `tests/`, and `.github/workflows/` remain consistent across all types.

The directory structure encodes four architectural constraints:

| Pattern | Where It Appears | Intent |
|---------|-----------------|--------|
| **Domain Driven** | `src/domains/` | Business logic decoupled from the framework; domain models have no dependency on the HTTP layer |
| **EDA (Event-Driven Architecture)** | `src/domains/events/` | Cross-domain communication via events rather than direct calls, reducing coupling |
| **API / CLI Separation** | `app/api/` + `bin/` | Interaction entry points are independent from business logic; the same domain can serve both Web and CLI simultaneously |
| **Stateless** | No server-side session assumptions | Designed for Edge/Serverless deployment; horizontal scaling requires no session synchronization |

### 4.3 TCR-Driven Development: `$cnx-story-build`

This is CNX's core execution unit. Its engineering significance lies in a fundamental shift: **correctness is not determined by the AI's own assertions, but exclusively by the pass/fail status of automated tests**.

**TCR (Test && Commit || Revert) execution flow:**

```
┌─────────────────────────────────────────────────────┐
│                  TCR Micro-Step                      │
├─────────────────────────────────────────────────────┤
│                                                      │
│  1. Write failing test (RED)                         │
│              │                                       │
│              ▼                                       │
│  2. Write minimal code to pass (GREEN)               │
│              │                                       │
│              ▼                                       │
│  3. Run tests ──── FAIL? ──── Revert changes         │
│              │                                       │
│            PASS                                      │
│              │                                       │
│              ▼                                       │
│  4. $cnx-.code-review (self-review gate)             │
│              │                                       │
│              ▼                                       │
│  5. git commit (micro-commit)                        │
│              │                                       │
│              └──── Back to Step 1, next Action       │
│                                                      │
└─────────────────────────────────────────────────────┘
```

Each Action is constrained to **2–5 minutes** of scope. The engineering rationale for this constraint:

- **Near-zero rollback cost**: Any failure discards at most a few minutes of work.
- **Errors do not compound**: Failing logic cannot be depended on by subsequent code, preventing hidden debt from accumulating in the codebase.
- **Observable progress**: The micro-commit sequence is itself a real-time record of delivery progress.

**The complete delivery pipeline** — `$cnx-story-build` does not stop at local tests passing. It requires completing the full end-to-end delivery chain:

```
TCR Micro-commits → git push → CI Pass → Deploy → Verification Gate
```

The **Verification Gate** is the final checkpoint: it requires **live evidence** (test output screenshots, curl responses, browser screenshots). The AI's own assertions ("I confirmed it works") are not accepted.

> **Scenario**: Executing US-007 (write audit events).
>
> Action 1: Write a RED test for `AuditService.record()` asserting that task creation triggers an audit write → implement minimal code → GREEN → code-review passes → `tcr: audit event on task create`.
>
> Action 2: Write a RED test for delete operations → discover `TaskService.delete()` is missing a hook injection point → add the implementation → GREEN → commit.
>
> 4 micro-commits total, zero manual intervention throughout. CI triggers all GREEN, auto-deploys to staging. Verification Gate collects evidence: `curl /api/audit` returns the correct event list, screenshot archived, US-007 closed.

### 4.4 Continuous Integration / Continuous Delivery: The Fast Feedback Infrastructure

CI/CD is not an "add-on" to CNX — it is the **objective arbitration layer** for all of Loop B. Passing tests locally is a necessary condition, not a sufficient one. Local environments carry implicit dependencies, uncommitted state, and machine-specific configuration. CI re-executes the same code in a clean, deterministic environment, making it the final authority on whether something is truly deliverable.

**4.4.1 CI as Objective Arbiter**

TCR promises "commit on passing tests," but that promise only holds once it is validated at the CI layer:

```
Local GREEN ≠ Deliverable
CI GREEN    = Deliverable
```

CI's scope extends beyond running the test suite — it is a complete quality gate sequence:

| Check | Purpose |
|-------|---------|
| **Lint / Type Check** | Coding standards and type safety; prevents low-grade errors from reaching the main branch |
| **Unit & Integration Tests** | Regression assurance for business logic; corroborates local TCR results |
| **Coverage Gate** | Enforces coverage thresholds; prevents test debt accumulation |
| **Build Artifact** | Confirms the build artifact can be generated; rules out dependency resolution issues |
| **E2E Smoke** | Smoke validation of critical paths in a real environment |

If any check fails, the deployment pipeline halts automatically. There is no "deploy first, fix tests later" path.

**4.4.2 The Engineering Value of Fast Feedback Loops**

The later a defect is discovered, the more expensive it is to fix — this is not folk wisdom, it is an empirically supported engineering finding. A bug caught within 5 minutes of commit costs roughly the same as initial development to fix. Caught in a test environment, the cost multiplies by 10. Caught in production, by 100.

CNX's TCR + CI combination compresses the feedback window to **minutes**:

```
micro-commit (2–5 min granularity)
    → git push (immediate)
        → CI triggered (seconds)
            → result returned (minutes)
                → problem localized (to this exact commit)
```

The micro-step granularity constraint (2–5 min/Action) delivers a second benefit here: when CI fails, the amount of code to triage is minimal, and the root cause is almost always immediately obvious.

**4.4.3 Two Independent Workflow Pipelines**

The CI configuration generated by `$cnx-init` contains two independent pipelines corresponding to different trigger scenarios:

```
.github/workflows/
├── ci.yml          # Triggered on every push / PR
│                   # Runs the complete quality gate sequence
│                   # GREEN → unlocks CD deployment permission
│
└── sentinel.yml    # Triggered by cron schedule (unattended)
                    # Runs $cnx-sentinel patrol tasks
                    # Provides the observability infrastructure for Loop C
```

`sentinel.yml` is a foundational dependency for Loop C — Loop C's continuous patrol capability runs on top of the CI platform, illustrating the infrastructure-level unity across all three loops.

**4.4.4 The CD and Verification Gate Dependency Chain**

The Verification Gate (live evidence acceptance) sits at the very end of Loop B, and its existence depends on a successful CD deployment:

```
CI PASS
  → CD: deploy to target environment
      → Verification Gate: collect evidence from the deployed version
          → screenshots / curl responses / test output
              → Story closed
```

Without CD there is no verifiable target, rendering the Verification Gate meaningless. This dependency chain ensures that **Story closure evidence must come from the live production environment, not a local simulation**.

---

### 4.5 Adversarial TDD: `$cnx-spar`

For high-risk paths — authorization, payments, data integrity — standard TDD coverage is insufficient. Tests and implementation are written by the same Agent, creating cognitive blind spots. `$cnx-spar` introduces an adversarial mechanism:

| Role | Responsibility | Constraint |
|------|---------------|------------|
| **Attacker** | Writes test cases designed to break the system | May not write any implementation code |
| **Defender** | Writes the minimal code to make tests pass | May not modify the Attacker's tests |

The adversarial cycle continues until the Attacker cannot produce a new RED test for two consecutive rounds, or all predefined scenarios are covered (maximum 5 rounds). Each round's results are committed independently, keeping the adversarial process fully traceable.

Automatic trigger signals: when a Story touches authentication/authorization, payment/billing, data integrity validation, complex state machines, or historically high-defect modules, `$cnx-story-build` automatically routes the Action to `$cnx-spar`.

> **Scenario**: US-010 (organization member permission changes) triggers the `$cnx-spar` auto-route.
>
> The Attacker's first round produces 3 RED tests: a regular member escalating privileges to modify another's role, whether an admin can continue operating after demoting themselves, and concurrent requests simultaneously modifying the same user's role. After the Defender implements passing code for all three, the Attacker's second round adds: if a role change succeeds at the DB level but the notification fails, does the permission atomically roll back?
>
> On round three, the Attacker cannot produce any new RED tests — the adversarial session ends. Test coverage on the permission module rises from the typical TDD baseline of 71% to 93%.

### 4.6 Delivery Traceability

After each successful deployment, two mechanisms ensure deliverables remain traceable:

- **`$cnx-.changelog`**: Automatically extracts completed Stories from BACKLOG.md, filters out internal technical details, and generates a user-facing changelog.
- **Git Hook (AI source tagging)**: The global `prepare-commit-msg` hook auto-detects the active AI client (via environment variables `CLAUDE_CODE`, `GEMINI_CLI`, `KIMI_CODE`, etc.) and injects a source tag into the commit message (e.g., `[claude code]`, `[gemini cli]`). In multi-Agent workflows, `git log` shows the actual executor of every commit at a glance.

---

## 5. Loop C: Observability and Resilience Maintenance

### 5.1 Methodology Inheritance

| Classical Methodology | CNX Implementation |
|----------------------|--------------------|
| SRE (Site Reliability Engineering) | `$cnx-sentinel`: Sampling-based automated patrol |
| Chaos Engineering | Randomized patrol strategy simulating unpredictable check patterns |
| Digital Forensics | `$cnx-bb-debug`: Automated on-scene evidence collection |
| Root Cause Analysis (RCA) | `$cnx-bb-analyzer`: Structured diagnostic reports |

### 5.2 Randomized Patrol: `$cnx-sentinel`

`$cnx-sentinel` provides continuous health monitoring for delivered features. Its core design philosophy is **probabilistic sampling over exhaustive regression**, striking a balance between cost and coverage.

**Patrol strategy matrix:**

| Strategy | Sampling Rate | When to Use |
|----------|--------------|-------------|
| Light | 5 times/day | Day-to-day monitoring during stable periods |
| Normal | 10 times/6 hours | Routine iteration cycles |
| Intensive | 20 times/hour | Post-major-release monitoring |
| Full | Full suite/week | Periodic comprehensive regression |

**Uncertainty handling** — avoiding false positives: a single failure does not trigger an alert; three consecutive failures are required to flag an anomaly.

**Hot-spot detection** — adaptive weighting: Stories that fail repeatedly automatically receive increased sampling weight. Issues discovered by patrol automatically create `FIX-XXX` Backlog entries for `$cnx-fix-build` to handle.

Patrol runs via GitHub Actions `cron` scheduling, providing unattended continuous monitoring.

> **Scenario**: Following the TaskFlow v1.3 release, `$cnx-sentinel` runs on the Intensive strategy. On the second sample, the patrol case for US-007 (audit write) fails — audit events exist but the `timestamp` field is empty. A single failure does not trigger an alert.
>
> On the fourth sample, the same case fails for the third consecutive time, crossing the threshold. `FIX-012: audit event timestamp is null` is automatically created and written to the Backlog, and US-007's sampling weight is automatically promoted to the next tier.

### 5.3 Automated Forensics: `$cnx-bb-debug`

A Playwright-based end-to-end debugger supporting two operating modes:

- **Native mode**: The target page has integrated the Black Box (BB) SDK; diagnostic data is collected directly via the SDK interface.
- **Universal mode**: No integration required on the target page; Playwright injects a collection script, enabling forensics on any web page.

Data dimensions collected automatically:

| Dimension | Collected Data |
|-----------|---------------|
| Console | Error logs, warnings, uncaught exceptions |
| Network | Request/response payloads, failed requests, slow requests |
| DOM | Page structure, render state, presence of critical elements |
| Performance | Load times, resource timing, interaction latency |
| Screenshot | Visual snapshot of the current page state |

### 5.4 Root Cause Diagnosis: `$cnx-bb-analyzer`

Consumes the diagnostic JSON produced by `$cnx-bb-debug` and performs structured multi-dimensional analysis (content state, network failures, DOM rendering anomalies, performance bottlenecks), outputting diagnostic conclusions and remediation recommendations.

> **Scenario (cont.)**: `$cnx-bb-debug` runs forensics on the audit list page. The Network dimension captures `GET /api/audit` returning 200 but with `timestamp` as `null`; the Console dimension simultaneously shows `[warn] AuditEvent serializer: missing timestamp`.
>
> `$cnx-bb-analyzer` consumes the diagnostic JSON and isolates the root cause: the v1.3 ORM upgrade introduced a field alias change that was not reflected in the serialization layer, breaking the `created_at` → `timestamp` mapping. The fix direction is clear; handed off to `$cnx-fix-build`.

### 5.5 Regression Repair: `$cnx-fix-build`

Executes a fix for a single issue — lighter-weight than `$cnx-story-build`, but held to the same quality standards:

- **Mandatory regression tests**: Every fix patch must include a regression test case targeting the specific issue, preventing recurrence.
- **Scope constraint**: One Fix handles one issue. If the fix reveals a scope wider than expected, it escalates to a User Story and re-enters Loop A.
- **Same quality gates**: Verification Gate, CI Pass, and production verification all apply equally.

> **Scenario (cont.)**: `$cnx-fix-build` executes FIX-012, with scope strictly limited to the serialization layer field mapping. A regression test is added (asserting `timestamp` is non-null and conforms to ISO 8601 format).
>
> 1 commit, CI GREEN, post-deployment Verification Gate confirms the audit list timestamps have recovered, FIX-012 closed. On the next `$cnx-sentinel` sample cycle, the check passes and US-007's sampling weight returns to baseline.

---

## 6. Engineering Baseline: Engineering Common Sense

CNX defines 8 non-negotiable engineering baselines that apply across all three loops. These are not "best practice suggestions" — they are mandatory checks in the Test Design Review phase of every Story:

| # | Baseline | Definition | Anti-Pattern |
|---|----------|-----------|--------------|
| 1 | **Idempotency** | Executing the same operation N times yields the same result as executing it once | "This won't be called twice anyway" |
| 2 | **Cross-Module Contracts** | Shared IDs, formats, and algorithms are consistent across all modules | "The other side will handle the format conversion" |
| 3 | **Data Flow Integrity** | Producer → storage → consumer validated end-to-end | "As long as it's in the database it's fine" |
| 4 | **Atomicity** | On partial failure, perform a complete rollback — leave no intermediate state | "The failure probability is very low" |
| 5 | **Input Validation** | All external inputs (API, user, file) are validated at the boundary | "Internal calls don't need validation" |
| 6 | **Graceful Degradation** | When a dependency fails, degrade service rather than crash | "That service won't go down" |
| 7 | **Observability** | Progress, state, and errors are visible to the user | "It can be looked up in the logs" |
| 8 | **Concurrency Safety** | Shared resource access is safe under multi-thread / multi-process conditions | "We only have a single instance right now" |

---

## 7. Passive Support Skills

Beyond the active Skills in the three loops, CNX includes a set of passively triggered support skills:

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `$cnx-.echo` | When user input is ambiguous or contradictory | Restates intent and resolves ambiguity before proceeding, avoiding wasted compute on a misunderstood instruction |
| `$cnx-.code-review` | After each TCR micro-step completes | Multi-dimensional self-review (security, maintainability, performance, scope); a Critical finding blocks the commit |
| `$cnx-.qa-cover` | During the Test Design Review phase | Defines the test pyramid (Unit > E2E > Visual > Smoke) and enforces coverage thresholds |
| `$cnx-.changelog` | After a successful deployment | Extracts completed items from BACKLOG and generates a user-readable changelog |

---

## 8. Relationship to Classical Methodologies

CNX is not a new methodology. It encodes proven engineering practices as standardized instructions that AI Agents can understand and execute.

```mermaid
graph LR
    subgraph "经典方法论"
        HCD["HCD<br/>以人为本设计"]
        BDD["BDD<br/>行为驱动开发"]
        S["Scrum<br/>Sprint / Backlog"]
        T["TDD<br/>RED-GREEN-Refactor"]
        TCR["TCR<br/>Test && Commit ∥ Revert"]
        SRE["SRE<br/>SLI / SLO / Error Budget"]
        CE["混沌工程<br/>随机故障注入"]
    end

    subgraph "CNX 实现"
        R["$cnx-research<br/>HV 分析"]
        D["$cnx-design<br/>INVEST Stories"]
        SB["$cnx-story-build<br/>TCR Micro-steps"]
        SP["$cnx-spar<br/>对抗式 TDD"]
        SE["$cnx-sentinel<br/>随机巡检"]
        BB["$cnx-bb-debug<br/>自动取证"]
    end

    HCD -->|"调研先行"| R
    BDD -->|"验收标准"| D
    S -->|"Backlog 管理"| D
    T -->|"测试先行"| SB
    TCR -->|"原子提交"| SB
    T -->|"攻防分离"| SP
    SRE -->|"采样监控"| SE
    CE -->|"随机策略"| SE
    SRE -->|"现场取证"| BB
```

The key distinction lies in the shift of execution subject: these methodologies originally depended on engineers' personal discipline (humans tire, humans cut corners). CNX hardens them into instruction constraints for AI Agents — an Agent will never "skip the tests just this once," because that branch does not exist in the Skill definition.

---

## 9. Limitations and Current State

**Validated:**

- Feedback-driven continuous delivery loop (Design → Build → Check → Fix)
- A standardized skill set of 14 Skills + 2 Tools
- Cross-AI-client configuration consistency management (`cybernetix` CLI)
- TCR micro-commits + Verification Gate quality assurance mechanism
- Multi-Agent audit tracing via Git Hooks

**Current Limitations:**

- **Multi-Agent coordination overhead**: `$cnx-story-build` evaluates Action dependencies to determine whether to launch parallel sub-Agents, but cross-Agent state synchronization and conflict resolution currently depend on conventions rather than enforced protocols, incurring coordination overhead in high-concurrency scenarios.
- **Framework coupling**: Skill definitions are written in Markdown and rely on AI clients' ability to interpret natural language instructions — execution precision varies across different models.
- **Patrol coverage**: `$cnx-sentinel`'s sampling strategy effectively controls cost, but it does not provide the same coverage guarantee as exhaustive regression testing.

---

## Appendix A: Skill Quick Reference

| Skill | Phase | Input | Output |
|-------|-------|-------|--------|
| `$cnx-research` | Research | Research topic | Markdown / PDF research report |
| `$cnx-design` | Design | Requirements description | BACKLOG.md + docs/features/ |
| `$cnx-init` | Initialization | Project name | Standardized directory structure + CI config |
| `$cnx-story-build` | Implementation | Story ID | Deployed code + verification evidence |
| `$cnx-roll-build` | Rapid implementation | One-sentence requirement | Auto-decompose → deliver |
| `$cnx-spar` | Defensive implementation | Feature description | Adversarial test suite + implementation code |
| `$cnx-fix-build` | Bug fix | Fix ID | Fix code + regression test |
| `$cnx-sentinel` | Patrol | Patrol strategy | Health report / FIX entries |
| `$cnx-bb-debug` | Debugging | URL | Diagnostic JSON + screenshots |
| `$cnx-bb-analyzer` | Diagnosis | Diagnostic JSON | Root cause analysis + remediation recommendations |
| `$cnx-fetch` | Intelligence | URL / keyword | Web fetch, search, crawl results |
| `$cnx-probe` | Monitoring | Target address | Node discovery, health check report |

## Appendix B: CLI Command Quick Reference

| Command | Purpose |
|---------|---------|
| `cybernetix setup` | First-time initialization of `~/.cybernetix/`, mount skills, inject Git Hooks |
| `cybernetix sync` | Full distribution of convention files to all AI client configuration paths |
| `cybernetix init [dir] [type] [tools]` | Generate project convention files (merges Global + Template) |
| `cybernetix refresh [dir]` | Detect project type and re-merge convention files from the latest templates |
| `cybernetix reset` | Reset `~/.cybernetix/` from the repository source, then sync |
| `cybernetix status` | Display current configuration state, sync status, and skill links |
