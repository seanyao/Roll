#!/bin/bash
# CNX unified entry - Displays workflow guidance

WK_DIR="${WK_WORKSPACE:-$HOME/workspace/wukong}"
SKILLS_DIR="$WK_DIR/skills"

COMMAND=$1
shift

show_skill() {
    local skill_name=$1
    local skill_path="$SKILLS_DIR/$skill_name/SKILL.md"
    if [ -f "$skill_path" ]; then
        echo "=== $skill_name Workflow ==="
        head -100 "$skill_path"
    else
        echo "❌ Skill not found: $skill_name"
        echo "Expected: $skill_path"
    fi
}

case $COMMAND in
  design|backlog)
    show_skill "cnx-design"
    ;;
  build)
    show_skill "cnx-story-build"
    ;;
  spar)
    show_skill "cnx-spar"
    ;;
  fix)
    show_skill "cnx-fix-build"
    ;;
  roll)
    show_skill "cnx-roll-build"
    ;;
  review)
    show_skill "cnx-.code-review"
    ;;
  init)
    show_skill "cnx-init"
    ;;
  changelog)
    show_skill "cnx-.changelog"
    ;;
  probe)
    echo "🔍 Running: cnx-probe"
    echo ""
    echo "Usage:"
    echo '  $cnx probe find <machine>     # discover machines'
    echo '  $cnx probe health <hostname>  # health check'
    echo '  $cnx probe diagnose <machine> # full diagnostics'
    echo ""
    echo "Examples:"
    echo '  $cnx probe find orin'
    echo '  $cnx probe health seanclaw.local'
    echo '  $cnx probe diagnose apeclaw'
    echo ""
    echo "Features:"
    echo "  • Node discovery (Bonjour/mDNS)"
    echo "  • OpenClaw Gateway status"
    echo "  • Port listener check"
    echo "  • Log viewer"
    ;;
  fetch)
    echo "🌐 Running: cnx-fetch"
    echo ""
    echo "Usage:"
    echo '  $cnx fetch <url> [method]  # single page extraction'
    echo '  $cnx crawl <url>           # full site crawl'
    echo ""
    echo "Examples:"
    echo '  $cnx fetch https://example.com'
    echo '  $cnx fetch https://example.com tavily'
    echo '  $cnx crawl https://docs.example.com --depth 2'
    echo ""
    echo "Smart Web Fetch v4.0 - Three-layer strategy:"
    echo "  1. Tavily API (AI extraction, requires TAVILY_API_KEY)"
    echo "  2. LLM Native Fetch (built-in FetchURL)"
    echo "  3. Browser Automation (local first, cloud fallback)"
    echo ""
    echo "Environment Variables:"
    echo "  TAVILY_API_KEY       - Required for Tavily"
    echo "  BROWSER_USE_API_KEY  - Optional (cloud fallback)"
    ;;
  *)
    cat <<'EOF'
🤖 CNX - AI-Coding Workflow

USAGE: $cnx <command> [options]

COMMANDS:
  design      Discuss + plan     $cnx design "user login feature"
  build       Execute Story      $cnx build US-001
  fix         Fix Bug            $cnx fix "login button unresponsive"
  roll        One-line delivery  $cnx roll "add dark mode toggle"
  review      Code review        $cnx review
  fetch       Single page scrape $cnx fetch https://example.com
  crawl       Full site crawl    $cnx crawl https://docs.example.com
  probe       Node check         $cnx probe find orin
  init        Init project       $cnx init my-project
  changelog   Generate log       $cnx changelog

SCENARIOS:
  Web content retrieval
    Single article → $cnx fetch <url>
    Full site backup → $cnx crawl <url> --depth 2

  Development workflow
    Design → $cnx design "requirement"
    Execute → $cnx build US-001
    Review → $cnx review
    Release → $cnx changelog

WORKFLOW:
  1. Design:   $cnx design "requirement description"
  2. Build:    $cnx build US-XXX
  3. Check:    $cnx review
  4. Fix:      $cnx fix / $cnx changelog

EOF
    ;;
esac
