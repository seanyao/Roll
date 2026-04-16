# Roll Skill Selection Guide

Quickly select the right skill or tool.

## Core Skills

| User Intent | Skill | Description |
|---------|-----------|------|
| **"Not sure how to do it"** / **"There are several options"** | `roll-design` | Explore solutions, compare options, human decision-making |
| **"Help me build a..."** (unclear requirements) | `roll-build` | One-sentence request, AI auto-clarifies -> plans -> implements |
| **"Implement US-001"** (with a clear story) | `roll-build` | Execute per BACKLOG.md, full delivery |
| **"This logic is critical"** / **"Involves payment"** | `roll-spar` | Adversarial TDD, activate for high-risk scenarios |
| **"Fix a bug"** / **"Change some copy"** | `roll-fix` | Quick fix, no full workflow |
| **"Plan requirements"** / **"Split into stories"** | `roll-design` | Plan only, no implementation, outputs BACKLOG.md |
| **"Run several Actions in parallel"** | `roll-build` | Auto-determines parallelism after splitting Actions |
| **"Check production status"** | `roll-sentinel` | Production patrol, regression testing |
| **"Debug this page"** | `roll-debug` | Deep diagnosis, collect logs/network/DOM |
| **"Research this topic"** | `roll-research` | HV analysis deep research, outputs PDF report |

## Support Skills

| Scenario | Skill | Trigger Timing |
|------|-------|---------|
| Code self-review | `roll-.review` | Before Commit, or manually triggered |
| Generate Changelog | `roll-.changelog` | Auto-triggered after successful Deploy |
| QA test reference | `roll-.qa` | Referenced when writing tests |
| Intent clarification | `roll-.echo` | Auto-activates when user input is vague or unclear |

## Quick Decision Tree

```
User Input
    |
+----------------------+
| "Unsure about        |
|  the approach?"      |--> roll-design
+----------------------+
    | No
+----------------------+
| "One-sentence        |
|  request?"           |--> roll-build (fly mode)
+----------------------+
    | No
+----------------------+
| "Has a US-XXX ID?"   |--> roll-build (story mode)
+----------------------+
    | No
+----------------------+
| "Has a FIX-XXX ID?"  |--> roll-fix
+----------------------+
    | No
+----------------------+
| "Fix a bug?"         |--> roll-fix
+----------------------+
    | No
+----------------------+
| "Plan/split?"        |--> roll-design
+----------------------+
    | No
+----------------------+
| "High-risk logic?"   |--> roll-spar
+----------------------+
    | No
  Manual judgment
```

## Auto-Trigger Keywords

| Skill | Trigger Keywords |
|-------|-----------|
| `roll-design` | "discuss", "compare options", "how to choose", "trade-offs", "not sure what to use", "design", "plan", "split", "write stories", "requirements analysis" |
| `roll-build` | "help me build", "add a feature", "change this", "refactor", "implement US-", "do this story", "complete Action", "parallel", "develop simultaneously" |
| `roll-fix` | "fix bug", "change copy", "adjust color", "error", "FIX-", "BUG-" |
| `roll-spar` | "adversarial", "attack-defense", "high-risk", "critical logic", "payment", "permissions", "security" |
| `roll-sentinel` | "patrol", "check production", "regression test" |
| `roll-debug` | "debug", "diagnose", "page has issues", "black-box analysis" |
| `roll-research` | "deep research", "research this", "competitive analysis", "HV analysis", "deep dive" |
