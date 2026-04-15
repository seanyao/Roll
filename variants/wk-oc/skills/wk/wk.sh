#!/bin/bash
# WK unified entry - Displays workflow guidance

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
    show_skill "wk-design"
    ;;
  build)
    show_skill "wk-story-build"
    ;;
  spar)
    show_skill "wk-spar"
    ;;
  fix)
    show_skill "wk-fix-build"
    ;;
  roll)
    show_skill "wk-roll-build"
    ;;
  review)
    show_skill "wk-.code-review"
    ;;
  init)
    show_skill "wk-init"
    ;;
  changelog)
    show_skill "wk-.changelog"
    ;;
  probe)
    echo "🔍 Running: wk-probe"
    echo ""
    echo "Usage:"
    echo '  $wk probe find <machine>     # discover machines'
    echo '  $wk probe health <hostname>  # health check'
    echo '  $wk probe diagnose <machine> # full diagnostics'
    echo ""
    echo "Examples:"
    echo '  $wk probe find orin'
    echo '  $wk probe health seanclaw.local'
    echo '  $wk probe diagnose apeclaw'
    echo ""
    echo "Features:"
    echo "  • Node discovery (Bonjour/mDNS)"
    echo "  • OpenClaw Gateway status"
    echo "  • Port listener check"
    echo "  • Log viewer"
    ;;
  fetch)
    echo "🌐 Running: wk-fetch"
    echo ""
    echo "Usage:"
    echo '  $wk fetch <url> [method]  # single page extraction'
    echo '  $wk crawl <url>           # full site crawl'
    echo ""
    echo "Examples:"
    echo '  $wk fetch https://example.com'
    echo '  $wk fetch https://example.com tavily'
    echo '  $wk crawl https://docs.example.com --depth 2'
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
🤖 WK - AI-Coding Workflow

USAGE: $wk <command> [options]

COMMANDS:
  design      Discuss + plan     $wk design "user login feature"
  build       Execute Story      $wk build US-001
  fix         Fix Bug            $wk fix "login button unresponsive"
  roll        One-line delivery  $wk roll "add dark mode toggle"
  review      Code review        $wk review
  fetch       Single page scrape $wk fetch https://example.com
  crawl       Full site crawl    $wk crawl https://docs.example.com
  probe       Node check         $wk probe find orin
  init        Init project       $wk init my-project
  changelog   Generate log       $wk changelog

SCENARIOS:
  Web content retrieval
    Single article → $wk fetch <url>
    Full site backup → $wk crawl <url> --depth 2

  Development workflow
    Design → $wk design "requirement"
    Execute → $wk build US-001
    Review → $wk review
    Release → $wk changelog

WORKFLOW:
  1. Design:   $wk design "requirement description"
  2. Build:    $wk build US-XXX
  3. Check:    $wk review
  4. Fix:      $wk fix / $wk changelog

EOF
    ;;
esac
