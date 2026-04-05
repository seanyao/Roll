#!/bin/bash
# CNX unified entry - Displays workflow guidance

CYBERNETIX_DIR="${CYBERNETIX_WORKSPACE:-$HOME/workspace/cybernetix}"
SKILLS_DIR="$CYBERNETIX_DIR/skills"

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
  backlog)
    show_skill "cnx-backlog"
    ;;
  build)
    show_skill "cnx-story-build"
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
    echo '  $cnx probe find <machine>     # 发现机器'
    echo '  $cnx probe health <hostname>  # 健康检查'
    echo '  $cnx probe diagnose <machine> # 完整诊断'
    echo ""
    echo "Examples:"
    echo '  $cnx probe find orin'
    echo '  $cnx probe health seanclaw.local'
    echo '  $cnx probe diagnose apeclaw'
    echo ""
    echo "功能:"
    echo "  • 节点发现 (Bonjour/mDNS)"
    echo "  • OpenClaw Gateway 状态"
    echo "  • 端口监听检查"
    echo "  • 日志查看"
    ;;
  fetch)
    echo "🌐 Running: cnx-fetch"
    echo ""
    echo "Usage:"
    echo '  $cnx fetch <url> [method]  # 单页提取'
    echo '  $cnx crawl <url>           # 全站爬取'
    echo ""
    echo "Examples:"
    echo '  $cnx fetch https://example.com'
    echo '  $cnx fetch https://example.com tavily'
    echo '  $cnx crawl https://docs.example.com --depth 2'
    echo ""
    echo "Smart Web Fetch v4.0 - 三层策略:"
    echo "  1. Tavily API (AI 提取，需 TAVILY_API_KEY)"
    echo "  2. LLM Native Fetch (内置 FetchURL)"
    echo "  3. Browser Automation (本地优先，云端兜底)"
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
  backlog     需求规划        $cnx backlog "用户登录功能"
  build       执行 Story      $cnx build US-001
  fix         修复 Bug        $cnx fix "登录按钮无响应"
  roll        一句话交付      $cnx roll "添加深色模式"
  review      代码审查        $cnx review
  fetch       单页抓取        $cnx fetch https://example.com
  crawl       全站爬取        $cnx crawl https://docs.example.com
  probe       节点检查        $cnx probe find orin
  init        初始化项目      $cnx init my-project
  changelog   生成日志        $cnx changelog

SCENARIOS:
  获取网页内容
    单篇文章 → $cnx fetch <url>
    整站备份 → $cnx crawl <url> --depth 2

  开发工作流
    规划 → $cnx backlog "需求"
    执行 → $cnx build US-001
    审查 → $cnx review
    发布 → $cnx changelog

WORKFLOW:
  1. Plan:   $cnx backlog "需求描述"
  2. Do:     $cnx build US-XXX
  3. Check:  $cnx review
  4. Act:    $cnx changelog

EOF
    ;;
esac
