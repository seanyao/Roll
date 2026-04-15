---
name: wk
description: Unified entry for Wukong AI-Coding workflow. Routes to design/planning, story delivery, bug fixes, parallel dispatch, code review, and project initialization. Use for structured AI-assisted software development.
---

# WK (Wukong for OpenClaw)

**Unified AI-Coding entry point** - Complete workflow for structured software development.

## Quick Help

```bash
$wk <command> [options]
```

### Command Overview

| Command | Purpose | Example |
|------|------|------|
| `design` | Discuss + plan | `$wk design "user login feature"` |
| `build` | Execute Story | `$wk build US-001` |
| `spar` | Adversarial TDD | `$wk spar "transfer logic"` |
| `fix` | Fix Bug | `$wk fix "login button unresponsive"` |
| `roll` | One-sentence delivery | `$wk roll "add dark mode"` |
| `review` | Code review | `$wk review` |
| `fetch` | Single page scrape | `$wk fetch https://example.com` |
| `crawl` | Full site crawl | `$wk crawl https://docs.example.com` |
| `probe` | Node check | `$wk probe find orin` |
| `init` | Initialize project | `$wk init my-project` |
| `changelog` | Generate changelog | `$wk changelog` |

### Scenario Quick Reference

**Fetching web content**
```bash
# Single article -> use fetch (fast)
$wk fetch https://blog.example.com/article

# Entire doc site -> use crawl (bulk)
$wk crawl https://docs.example.com --depth 2
```

**Development workflow**
```bash
# 1. Design and plan
$wk design "user login feature"

# 2. Execute development
$wk build US-001

# 3. Code review
$wk review

# 4. Release
$wk changelog
```

---

## Detailed Documentation

### When to Use

| Scenario | Call |
|------|------|
| "Discuss approach" / "Plan new feature" | `$wk design "requirement description"` |
| "Execute US-001" / "Start development" | `$wk build US-001` |
| "Fix this Bug" | `$wk fix "Bug description"` |
| "Quickly implement a feature" | `$wk roll "one-sentence request"` |
| "Code review" | `$wk review` |
| "Initialize project" | `$wk init project-name` |
| "Generate changelog" | `$wk changelog` |
| "Scrape webpage" / "Crawl website" | `$wk fetch https://...` |
| "Check node" / "Discover machine" | `$wk probe find <machine>` |

### Workflow

```
User: "Help me build a login feature"
    |
    v
+-------------------------------------+
| $wk design "login feature"         |
|  -> wk-design                      |
|  -> Discuss approach -> Design      |
|     architecture -> Split Stories   |
|  -> Write to BACKLOG.md             |
+---------------+---------------------+
                |
                v
    "Created US-AUTH-001"
    |
    v
+-------------------------------------+
| $wk build US-AUTH-001              |
|  -> wk-story-build                 |
|  -> TCR workflow -> CI/CD -> Deploy |
|  -> Update BACKLOG.md               |
+---------------+---------------------+
                |
                v
    "✅ US-AUTH-001 completed"
```

### Commands

#### `design` - Discuss + Plan
```bash
$wk design "user system design"
$wk design "Use Postgres FTS or Meilisearch for search?"
$wk design --from-plan docs/features/auth-plan.md
$wk design --story "login feature"
$wk design --fix "fix API 404"
```

#### `build` - Execute Story
```bash
$wk build US-001          # Execute specified Story
$wk build --latest        # Execute latest Story
```

#### `fix` - Quick Fix
```bash
$wk fix "login button unresponsive"
$wk fix BUG-001           # Execute existing Bug
```

#### `roll` - One-Sentence Delivery
```bash
$wk roll "add dark mode"
# Auto: plan -> split -> execute -> deliver
```

#### `review` - Code Review
```bash
$wk review                 # Review staged changes
$wk review --staged       # Same as above
$wk review --unstaged     # Review all modifications
$wk review files src/     # Review specified files
```

#### `fetch` - Web Scraping / Intelligence Gathering
```bash
$wk fetch https://example.com           # Single page extraction
$wk crawl https://docs.example.com      # Full site crawl
$wk crawl https://site.com --depth 2    # Specify depth
```

**Three-layer strategy:**
1. **Tavily API** - AI extraction, best quality (requires `TAVILY_API_KEY`)
2. **LLM Native Fetch** - Uses built-in FetchURL capability
3. **Browser Automation** - Local browser-use preferred, cloud fallback (requires `BROWSER_USE_API_KEY`)

**Environment variable configuration (independent per machine):**
```bash
export TAVILY_API_KEY=tvly-...
export BROWSER_USE_API_KEY=bu-...  # Optional, local browser-use preferred
```

#### `probe` - Node Discovery and Health Check
```bash
$wk probe find orin              # Discover machine (Bonjour/mDNS)
$wk probe health seanclaw.local  # Health check
$wk probe diagnose apeclaw       # Full diagnosis
```

**Features:**
- LAN node discovery (supports .local hostnames)
- OpenClaw Gateway status check
- Port listening verification
- Log viewing

#### `init` - Project Initialization
```bash
$wk init my-project       # Create new project
$wk init .                # Initialize current directory
```

#### `changelog` - Generate Changelog
```bash
$wk changelog             # Generate from BACKLOG.md
$wk changelog --draft     # Preview, don't write to file
```

### Project Structure

Wukong projects require the following structure:

```
project/
├── BACKLOG.md          # Task index
├── CHANGELOG.md        # Release history
├── docs/
│   └── features/       # Story details & design docs
└── .github/
    └── workflows/      # CI/CD
```

### Integration

#### Integration with OpenClaw
```yaml
# ~/.openclaw/openclaw.yaml
skills:
  wukong:
    workspace: ~/workspace/wukong
    commands:
      - design
      - build
      - fix
      - roll
      - review
      - init
      - changelog
```

#### Environment Variables
```bash
export WK_WORKSPACE=~/workspace/wukong
```

### Requirements

- Node.js 18+
- Project directory must contain `BACKLOG.md` (can be created by init)
- Git repository (for TCR workflow)

### Related

- `wk-design` - Discuss + Design + Plan
- `wk-spar` - Adversarial TDD (high-risk logic)
- `wk-story-build` - Story delivery
- `wk-fix-build` - Bug fix
- `wk-roll-build` - Quick delivery
- `wk-.code-review` - Code review
- `wk-init` - Project initialization
- `wk-.changelog` - Changelog
