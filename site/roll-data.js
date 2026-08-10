// Concise product content for the Roll site.
// Core mechanism + quick start + commands + documentation.

window.RollData = (function () {

  const CYCLE_NDJSON = [
    '{"ts":"2026-05-17T11:05:02Z","stage":"cycle_start","label":"047","detail":"","outcome":""}',
    '{"ts":"2026-05-17T11:05:03Z","stage":"story","label":"US-AUTH-003","detail":"user login with OAuth","outcome":""}',
    '{"ts":"2026-05-17T11:06:10Z","stage":"build","label":"2 commits","detail":"tcr micro-steps","outcome":"ok"}',
    '{"ts":"2026-05-17T11:07:45Z","stage":"peer","label":"1/3","detail":"AGREE","outcome":"agree"}',
    '{"ts":"2026-05-17T11:08:01Z","stage":"ci","label":"green","detail":"43s · 26 tests","outcome":"ok"}',
    '{"ts":"2026-05-17T11:08:30Z","stage":"pr","label":"#312","detail":"merged to main","outcome":"ok"}',
    '{"ts":"2026-05-17T11:09:18Z","stage":"cycle_end","label":"047","detail":"2 tcr · 6m 12s","outcome":"delivered"}',
  ].join('\n');

  const PUBLIC_COMMAND_SURFACE = [
    "roll agent",
    "roll backlog",
    "roll config",
    "roll design",
    "roll doctor",
    "roll help",
    "roll idea",
    "roll init",
    "roll loop",
    "roll next",
    "roll north",
    "roll release",
    "roll setup",
    "roll status",
    "roll test",
    "roll update",
  ];

  const EN = {
    UI: {
      nav: [
        { id: "how", label: "How it works" },
        { id: "quickstart", label: "Quick start" },
        { id: "commands", label: "Commands" },
        { id: "guides", label: "Docs" },
      ],
      githubLabel: "GitHub",
      installCopy: { idle: "copy", done: "copied" },
      heroCaption: "one session, real delivery",
      cycleStatus: "session-driven · ready",
      terminalLive: "live",
      featureGroupsLabel: "Feature groups",
      skillGroupsLabel: "Skill groups",
      footerTag: "Agents, roll out.",
    },
    HERO: {
      version: "Supervisor-led delivery",
      tagline: "Roll",
      sub2: "Backlog to accepted evidence, one Story at a time.",
      sub: "Roll routes planning, implementation, review, CI, and acceptance evidence through the agents available on your machine. You own the backlog, the PRs, and the release decision.",
      install: "npm install -g @seanyao/roll",
      ctas: [
        { label: "Quick start", href: "#quickstart", primary: true },
        { label: "View on GitHub", href: "https://github.com/seanyao/roll", primary: false, external: true },
      ],
      meta: ["MIT licensed", "Node 22+", "Works with Claude · Antigravity · Codex · Cursor · Kimi · Pi · Reasonix when available"],
    },
    TERMINAL: [
      { kind: "prompt", text: "roll loop go" },
      { kind: "ok", text: "session driving", detail: "cycle 1 · US-1 picked" },
      { kind: "step", arrow: "story", label: "US-128", text: "Designer, Builder, Evaluator" },
      { kind: "step", arrow: "build", label: "2 TCR commits", text: "tests green" },
      { kind: "step", arrow: "ci", label: "green", text: "acceptance checks passed", ok: true },
      { kind: "step", arrow: "pr", label: "#312", text: "merged to main", ok: true },
      { kind: "cursor" },
    ],
    FRAME_A: [
      { kind: "prompt", text: "roll loop go" },
      { kind: "ok", text: "session driving", detail: "cycle 1 · US-1 picked" },
      { kind: "cursor" },
    ],
    WHY: {
      label: "Why Roll",
      title: "The work is not the prompt.",
      sub: "AI can write, test, and ship features. Roll gives that capability a repeatable process: Story-scoped planning, quality gates, CI, and evidence.",
      cards: [
        { title: "Consistent process", body: "Every Story gets the same roles, gates, and evidence path, no matter which agent is available." },
        { title: "Human control", body: "Humans define the backlog, review the PRs, and approve the release. Roll does not ship on its own." },
      ],
      quote: "Same work standards for every AI tool, so output quality does not depend on whoever is driving.",
    },
    HOW: {
      label: "Core mechanism",
      title: "Human sets goals.\nSupervisor coordinates.\nDelta Unit delivers.",
      sub: "Roll separates project coordination from Story delivery.",
      layers: [
        {
          glyph: "human",
          name: "Human",
          sub: "On the loop",
          body: "Owns the backlog, reviews PRs, and approves releases.",
          owns: ["Backlog", "Release approval", "Architectural calls"],
        },
        {
          glyph: "loop",
          name: "Supervisor",
          sub: "Project-level coordination",
          body: "Reads backlog, CI, PRs, evidence, and repeated failures; advises the next action.",
          owns: ["Next action", "Route advice", "Escalation"],
        },
        {
          glyph: "dream",
          name: "Delta Unit",
          sub: "standard · verified · designed",
          body: "Delivers one Story through Designer, Builder, and Evaluator roles.",
          owns: ["Story delivery", "TCR + CI", "Evidence"],
        },
      ],
      analogy: {
        label: "The analogy",
        body: "Like a well-run workshop. You set the job; the tools, checks, and process are already in place. Work moves forward without you doing every step, and you stay in control of the decisions that matter.",
      },
    },
    QUICKSTART: {
      label: "Quick start",
      title: "Start in one session.",
      sub: "Install Roll, initialize a project, then run the loop.",
      steps: [
        { cmd: "npm install -g @seanyao/roll", desc: "Install the CLI." },
        { cmd: "roll init", desc: "Diagnose the project and write Roll metadata." },
        { cmd: "roll next", desc: "Get one best next command." },
        { cmd: "roll loop go", desc: "Start delivering cards from the backlog." },
      ],
      notes: [
        "Existing codebase onboarding plan: run roll init, review the plan, then roll init --apply.",
        "Existing Codebase Onboarding is plan-first; roll next continues after apply.",
        "roll loop pause stops automatic card pickup; roll loop resume reopens it. roll loop status shows ACTIVE / PAUSED.",
        "New projects need a Git remote before the loop can push branches and open PRs.",
      ],
    },
    COMMANDS: {
      label: "Commands",
      title: "The commands you need.",
      sub: "The full public command list is in the README. These are the core workflow commands.",
      rows: [
        { cmd: "roll init", desc: "Diagnose this directory and route setup." },
        { cmd: "roll next", desc: "Print one best next command." },
        { cmd: "roll idea", desc: "Capture a backlog card." },
        { cmd: "roll loop go", desc: "Start a session-driven run." },
        { cmd: "roll status", desc: "Read project health and CI state." },
        { cmd: "roll north", desc: "Open the delivery metrics panel." },
        { cmd: "roll supervisor delivery", desc: "Read one feature/card delivery conclusion." },
        { cmd: "roll doctor", desc: "Diagnose install, skills, and tools." },
        { cmd: "roll update", desc: "Upgrade Roll and re-sync conventions." },
      ],
    },
    GUIDES: {
      label: "Documentation",
      title: "Read the core guides.",
      sub: "Start with Getting started, then go deeper only when you need to.",
      tiles: [
        { name: "Getting started", path: "guide/en/getting-started.md", desc: "Install, init, and first loop run." },
        { name: "Overview", path: "guide/en/overview.md", desc: "Core model and onboarding paths." },
        { name: "AI agents", path: "guide/en/ai-agents.md", desc: "Roles, scopes, and agent routing." },
        { name: "Loop", path: "guide/en/loop.md", desc: "Session-driven execution and observability." },
        { name: "Acceptance evidence", path: "guide/en/acceptance-evidence.md", desc: "Evidence lifecycle and attest gates." },
        { name: "Architecture", path: "docs/architecture.md", desc: "Layers, domains, and invariants." },
      ],
    },
  };

  const ZH = {
    UI: {
      nav: [
        { id: "how", label: "工作原理" },
        { id: "quickstart", label: "快速开始" },
        { id: "commands", label: "命令" },
        { id: "guides", label: "文档" },
      ],
      githubLabel: "GitHub",
      installCopy: { idle: "复制", done: "已复制" },
      heroCaption: "一个会话 · 真实交付",
      cycleStatus: "会话驱动 · 就绪",
      terminalLive: "实时",
      featureGroupsLabel: "功能分组",
      skillGroupsLabel: "Skill 分组",
      footerTag: "Agents, roll out.",
    },
    HERO: {
      version: "Supervisor-led 交付",
      tagline: "Roll",
      sub2: "从 backlog 到验收证据，一张 Story 一次交付。",
      sub: "Roll 在本机可用 agent 之间路由规划、实现、评审、CI 与验收证据。你负责 backlog、PR 和发布决定。",
      install: "npm install -g @seanyao/roll",
      ctas: [
        { label: "快速开始", href: "#quickstart", primary: true },
        { label: "GitHub", href: "https://github.com/seanyao/roll", primary: false, external: true },
      ],
      meta: ["MIT 协议", "Node 22+", "支持 Claude · Antigravity · Codex · Cursor · Kimi · Pi · Reasonix（可用时）"],
    },
    TERMINAL: [
      { kind: "prompt", text: "roll loop go" },
      { kind: "ok", text: "会话驱动中", detail: "cycle 1 · 领取 US-1" },
      { kind: "step", arrow: "story", label: "US-128", text: "Designer、Builder、Evaluator" },
      { kind: "step", arrow: "build", label: "2 次 TCR 提交", text: "测试通过" },
      { kind: "step", arrow: "ci", label: "绿灯", text: "验收检查通过", ok: true },
      { kind: "step", arrow: "pr", label: "#312", text: "已合入 main", ok: true },
      { kind: "cursor" },
    ],
    FRAME_A: [
      { kind: "prompt", text: "roll loop go" },
      { kind: "ok", text: "会话驱动中", detail: "cycle 1 · 领取 US-1" },
      { kind: "cursor" },
    ],
    WHY: {
      label: "为什么用 Roll",
      title: "难点不是提示词，而是交付过程。",
      sub: "AI 能写、测、发功能。Roll 给这种能力加上可重复的过程：按 Story 规划、质量闸、CI 和证据。",
      cards: [
        { title: "一致的过程", body: "无论可用 agent 是谁，每张 Story 都走同样的角色、闸门和证据路径。" },
        { title: "人保留控制", body: "人定义 backlog、审阅 PR、批准发布。Roll 不会自己发布。" },
      ],
      quote: "给每个 AI 工具同一套工作标准，产出质量不依赖谁在驾驶。",
    },
    HOW: {
      label: "核心机制",
      title: "人定目标。\nSupervisor 协调。\nDelta Unit 交付。",
      sub: "Roll 把项目协调与 Story 交付分开。",
      layers: [
        {
          glyph: "human",
          name: "Human",
          sub: "掌舵",
          body: "负责 backlog、审阅 PR、批准发布。",
          owns: ["Backlog", "发布批准", "架构决策"],
        },
        {
          glyph: "loop",
          name: "Supervisor",
          sub: "项目级协调",
          body: "读取 backlog、CI、PR、证据与重复失败，给出下一步建议。",
          owns: ["下一步", "路由建议", "升级"],
        },
        {
          glyph: "dream",
          name: "Delta Unit",
          sub: "standard · verified · designed",
          body: "通过 Designer、Builder、Evaluator 交付一张 Story。",
          owns: ["Story 交付", "TCR + CI", "证据"],
        },
      ],
      analogy: {
        label: "类比",
        body: "像一间打理好的工坊。你定下工作，工具、检查和流程都已就位；工作会推进，但你始终掌握关键决定。",
      },
    },
    QUICKSTART: {
      label: "快速开始",
      title: "在一个会话里开始。",
      sub: "安装 Roll，初始化项目，然后运行 loop。",
      steps: [
        { cmd: "npm install -g @seanyao/roll", desc: "安装 CLI。" },
        { cmd: "roll init", desc: "诊断项目并写入 Roll metadata。" },
        { cmd: "roll next", desc: "只给出一个最合适的下一步。" },
        { cmd: "roll loop go", desc: "开始从 backlog 逐张交付。" },
      ],
      notes: [
        "已有代码库接入计划：先 roll init，审阅计划，再 roll init --apply。",
        "已有代码库接入以计划为先；roll next continues after apply。",
        "roll loop pause 暂停自动领卡，roll loop resume 恢复；roll loop status 显示 ACTIVE / PAUSED。",
        "新项目需要 Git remote，loop 才能推送分支和创建 PR。",
      ],
    },
    COMMANDS: {
      label: "命令",
      title: "你需要的核心命令。",
      sub: "完整公开命令列表见 README，这里是核心工作流命令。",
      rows: [
        { cmd: "roll init", desc: "诊断当前目录并路由 setup。" },
        { cmd: "roll next", desc: "打印一个最合适的下一步。" },
        { cmd: "roll idea", desc: "捕获一张 backlog 卡。" },
        { cmd: "roll loop go", desc: "启动会话驱动运行。" },
        { cmd: "roll status", desc: "查看项目健康与 CI 状态。" },
        { cmd: "roll north", desc: "打开交付指标面板。" },
        { cmd: "roll supervisor delivery", desc: "查看 feature/卡片交付结论。" },
        { cmd: "roll doctor", desc: "诊断安装、skills 和工具。" },
        { cmd: "roll update", desc: "升级 Roll 并重新同步约定。" },
      ],
    },
    GUIDES: {
      label: "文档",
      title: "先读核心指南。",
      sub: "从快速上手开始，需要时再深入。",
      tiles: [
        { name: "快速上手", path: "guide/zh/getting-started.md", desc: "安装、init 与第一次 loop。" },
        { name: "概述", path: "guide/zh/overview.md", desc: "核心模型与接入路径。" },
        { name: "AI agents", path: "guide/zh/ai-agents.md", desc: "角色、scope 与 agent 路由。" },
        { name: "Loop", path: "guide/zh/loop.md", desc: "会话驱动执行与可观测性。" },
        { name: "验收证据", path: "guide/zh/acceptance-evidence.md", desc: "证据生命周期与 attest 闸。" },
        { name: "架构", path: "docs/architecture.md", desc: "分层、领域与不变量。" },
      ],
    },
  };

  return { CYCLE_NDJSON, PUBLIC_COMMAND_SURFACE, EN, ZH };
})();
