---
name: cnx
description: Unified entry for Cybernetix (CNX) AI-Coding workflow. Routes to design/planning, story delivery, bug fixes, parallel dispatch, code review, and project initialization. Use for structured AI-assisted software development.
---

# CNX (Cybernetix)

**Unified AI-Coding entry point** - Complete workflow for structured software development.

## Quick Help

```bash
$cnx <command> [options]
```

### Command Overview

| Command | Purpose | Example |
|------|------|------|
| `design` | Discuss + plan | `$cnx design "user login feature"` |
| `build` | Execute Story | `$cnx build US-001` |
| `spar` | Adversarial TDD | `$cnx spar "transfer logic"` |
| `fix` | Fix Bug | `$cnx fix "login button unresponsive"` |
| `roll` | One-sentence delivery | `$cnx roll "add dark mode"` |
| `review` | Code review | `$cnx review` |
| `fetch` | Single page scrape | `$cnx fetch https://example.com` |
| `crawl` | Full site crawl | `$cnx crawl https://docs.example.com` |
| `probe` | Node check | `$cnx probe find orin` |
| `init` | Initialize project | `$cnx init my-project` |
| `changelog` | Generate changelog | `$cnx changelog` |

### Scenario Quick Reference

**Fetching web content**
```bash
# Single article -> use fetch (fast)
$cnx fetch https://blog.example.com/article

# Entire doc site -> use crawl (bulk)
$cnx crawl https://docs.example.com --depth 2
```

**Development workflow**
```bash
# 1. Design and plan
$cnx design "user login feature"

# 2. Execute development
$cnx build US-001

# 3. Code review
$cnx review

# 4. Release
$cnx changelog
```

---

## Detailed Documentation

### When to Use

| Scenario | Call |
|------|------|
| "Discuss approach" / "Plan new feature" | `$cnx design "requirement description"` |
| "Execute US-001" / "Start development" | `$cnx build US-001` |
| "Fix this Bug" | `$cnx fix "Bug description"` |
| "Quickly implement a feature" | `$cnx roll "one-sentence request"` |
| "Code review" | `$cnx review` |
| "Initialize project" | `$cnx init project-name` |
| "Generate changelog" | `$cnx changelog` |
| "Scrape webpage" / "Crawl website" | `$cnx fetch https://...` |
| "Check node" / "Discover machine" | `$cnx probe find <machine>` |

### Workflow

```
User: "Help me build a login feature"
    |
    v
+-------------------------------------+
| $cnx design "login feature"         |
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
| $cnx build US-AUTH-001              |
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
$cnx design "user system design"
$cnx design "Use Postgres FTS or Meilisearch for search?"
$cnx design --from-plan docs/features/auth-plan.md
$cnx design --story "login feature"
$cnx design --fix "fix API 404"
```

#### `build` - Execute Story
```bash
$cnx build US-001          # Execute specified Story
$cnx build --latest        # Execute latest Story
```

#### `fix` - Quick Fix
```bash
$cnx fix "login button unresponsive"
$cnx fix BUG-001           # Execute existing Bug
```

#### `roll` - One-Sentence Delivery
```bash
$cnx roll "add dark mode"
# Auto: plan -> split -> execute -> deliver
```

#### `review` - Code Review
```bash
$cnx review                 # Review staged changes
$cnx review --staged       # Same as above
$cnx review --unstaged     # Review all modifications
$cnx review files src/     # Review specified files
```

#### `fetch` - Web Scraping / Intelligence Gathering
```bash
$cnx fetch https://example.com           # Single page extraction
$cnx crawl https://docs.example.com      # Full site crawl
$cnx crawl https://site.com --depth 2    # Specify depth
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
$cnx probe find orin              # Discover machine (Bonjour/mDNS)
$cnx probe health seanclaw.local  # Health check
$cnx probe diagnose apeclaw       # Full diagnosis
```

**Features:**
- LAN node discovery (supports .local hostnames)
- OpenClaw Gateway status check
- Port listening verification
- Log viewing

#### `init` - Project Initialization
```bash
$cnx init my-project       # Create new project
$cnx init .                # Initialize current directory
```

#### `changelog` - Generate Changelog
```bash
$cnx changelog             # Generate from BACKLOG.md
$cnx changelog --draft     # Preview, don't write to file
```

### Project Structure

Cybernetix projects require the following structure:

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
- `cnx-.code-review` - Code review
- `wk-init` - Project initialization
- `cnx-.changelog` - Changelog
