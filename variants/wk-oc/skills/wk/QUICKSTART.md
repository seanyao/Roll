# WK-OC Command Quick Reference

**Unified AI-Coding workflow entry point** - Complete toolchain for structured software development

---

## Getting Started

```bash
$wk <command> [options]
```

---

## Command Overview

| Command | Purpose | Scenario |
|------|------|------|
| `backlog` | Requirement planning | New feature design, split into Stories |
| `build` | Execute Story | Develop specific features |
| `fix` | Fix Bug | Quick issue fixes |
| `roll` | One-sentence delivery | Simple requests, fast implementation |
| `review` | Code review | Check code quality |
| `fetch` | Single page scrape | Get single webpage content |
| `crawl` | Full site crawl | Bulk scrape websites |
| `probe` | Node check | Discover machines, health diagnosis |
| `init` | Initialize project | Create new project structure |
| `changelog` | Generate changelog | Pre-release update log |

---

## Usage Examples

### 📝 Plan - Planning Phase

```bash
# Plan a new feature, automatically split into Stories
$wk backlog "user login system"

# Plan from an existing design document
$wk backlog --from-plan docs/plans/auth.md

# Directly create a single Story
$wk backlog --story "add password reset feature"
```

### 🔨 Do - Execution Phase

```bash
# Execute a specified Story
$wk build US-001

# Quick bug fix
$wk fix "login button click unresponsive"

# One-sentence quick delivery (auto plan + execute)
$wk roll "add dark mode toggle"
```

### 👀 Check - Review Phase

```bash
# Code review
$wk review

# Scrape technical docs for reference
$wk fetch https://docs.example.com/api

# Crawl competitor website for analysis
$wk crawl https://competitor.com --depth 2
```

### 🚀 Act - Deployment Phase

```bash
# Generate changelog
$wk changelog

# Check production environment nodes
$wk probe health production.local
```

---

## Scenario Comparison

### fetch vs crawl

| Scenario | Command | Description |
|------|------|------|
| Read a single article | `$wk fetch <url>` | Single page extraction, fast retrieval |
| Back up an entire doc site | `$wk crawl <url>` | Full site recursive, bulk save |
| Get API docs | `$wk fetch` | Fetch current page at once |
| Competitor website analysis | `$wk crawl` | Deep crawl across multiple pages |

### build vs fix vs roll

| Scenario | Command | Description |
|------|------|------|
| Develop a planned feature | `$wk build US-001` | Execute existing Story |
| Fix a production Bug | `$wk fix "description"` | Quick fix workflow |
| Ad-hoc small request | `$wk roll "description"` | Auto-plan and execute |

---

## Full Workflow Example

```bash
# 1. Plan requirements -> generate US-001
$wk backlog "user login feature"

# 2. Execute development -> TCR workflow
$wk build US-001

# 3. Code review
$wk review

# 4. Release
$wk changelog
```

---

## Environment Requirements

- Node.js 18+
- Project directory must contain `BACKLOG.md`
- Git repository (for TCR workflow)

## Project Structure

```
project/
├── BACKLOG.md          # Story backlog
├── CHANGELOG.md        # Release history
├── docs/
│   └── plans/          # Design plans
└── .github/
    └── workflows/      # CI/CD
```
