# Wukong Skill Selection Guide

Quickly select the right skill or tool.

## Core Skills

| User Intent | Skill | Description |
|---------|-----------|------|
| **"Not sure how to do it"** / **"There are several options"** | `wk-design` | Explore solutions, compare options, human decision-making |
| **"Help me build a..."** (unclear requirements) | `wk-roll-build` | One-sentence request, AI auto-clarifies -> plans -> implements |
| **"Implement US-001"** (with a clear story) | `wk-story-build` | Execute per BACKLOG.md, full delivery |
| **"This logic is critical"** / **"Involves payment"** | `wk-spar` | Adversarial TDD, activate for high-risk scenarios |
| **"Fix a bug"** / **"Change some copy"** | `wk-fix-build` | Quick fix, no full workflow |
| **"Plan requirements"** / **"Split into stories"** | `wk-design` | Plan only, no implementation, outputs BACKLOG.md |
| **"Run several Actions in parallel"** | `wk-story-build` | Auto-determines parallelism after splitting Actions |
| **"Initialize project"** | `wk-init` | Create standard directory structure + BACKLOG.md |
| **"Check production status"** | `wk-sentinel` | Production patrol, regression testing |
| **"Debug this page"** | `wk-bb-debug` | Deep diagnosis, collect logs/network/DOM |

## Tools

| User Intent | Tool | Decision Logic |
|---------|----------|---------|
| **"Scrape a webpage"** / **"Crawl docs"** | `wk-fetch` | See fetch method selection below |
| **"Find the Orin machine"** / **"Check nodes"** | `wk-probe` | `find` -> discover machines / `health` -> health check / `diagnose` -> full diagnosis |

### wk-fetch Method Selection

| Priority | Method | Condition | Description |
|-------|------|------|------|
| 1 | **Tavily API** | Has `TAVILY_API_KEY` | Best quality, AI-optimized extraction |
| 2 | **LLM Native Fetch** | No Tavily | Use Kimi/Codex/Claude built-in fetch |
| 3 | **Browser Automation** | First two failed | See browser-use selection |

#### browser-use Selection

| Condition | Choice | Command |
|------|------|------|
| Has `BROWSER_USE_API_KEY` | **Cloud** | `Agent(task=...)` |
| `browser-use` installed | **Local** | `Browser(headless=True)` |
| Neither available | **Skip** | Prompt user to configure |

## Support Skills

| Scenario | Skill | Trigger Timing |
|------|-------|---------|
| Celebrate after Build | `wk-.yeah` 🎉 | Auto-executes after successful Build |
| Code self-review | `wk-.code-review` | Before Commit, or manually triggered |
| Generate Changelog | `wk-.changelog` | Auto-triggered after successful Deploy |
| QA test reference | `wk-.qa-cover` | Referenced when writing tests |

## Quick Decision Tree

```
User Input
    |
+----------------------+
| "Unsure about        |
|  the approach?"      |--> wk-design
+----------------------+
    | No
+----------------------+
| "One-sentence        |
|  request?"           |--> wk-roll-build
+----------------------+
    | No
+----------------------+
| "Has a US ID?"       |--> wk-story-build
+----------------------+
    | No
+----------------------+
| "Fix a bug?"         |--> wk-fix-build
+----------------------+
    | No
+----------------------+
| "Plan/split?"        |--> wk-design
+----------------------+
    | No
+----------------------+
| "Scrape a webpage?"  |--> wk-fetch
+----------------------+
    | No
+----------------------+
| "Find a machine?"    |--> wk-probe
+----------------------+
    | No
  Manual judgment
```

## Auto-Trigger Keywords

| Skill | Trigger Keywords |
|-------|-----------|
| `wk-design` | "discuss", "compare options", "how to choose", "trade-offs", "not sure what to use", "design", "plan" |
| `wk-roll-build` | "help me build", "add a feature", "change this", "refactor" |
| `wk-story-build` | "implement US-", "do this story", "complete Action" |
| `wk-fix-build` | "fix bug", "change copy", "adjust color", "error" |
| `wk-design` | "plan", "split", "write stories", "requirements analysis" |
| `wk-spar` | "adversarial", "attack-defense", "high-risk", "critical logic", "payment", "permissions", "security" |
| `wk-story-build` | "parallel", "develop simultaneously", "dispatch", "multi-path" |
| `wk-fetch` | "scrape", "crawl", "extract webpage", "get content" |
| `wk-probe` | "find machine", "check node", "check Orin", "health check" |
| `wk-sentinel` | "patrol", "check production", "regression test" |
| `wk-bb-debug` | "debug", "diagnose", "page has issues", "black-box analysis" |
