# Roll — 快速上手

这条路径把一个 git 项目从安装带到验收报告，目标是 5 分钟内跑通第一条
Roll 管理的故事。

## 1. 安装

```bash
npm install -g @seanyao/roll
npm install -g @seanyao/roll
```

Roll 需要 Node.js 22 或更新版本，并且本机至少装好一个支持的 AI agent。

## 2. 初始化项目

```bash
cd your-project
roll setup
roll init
```

`roll init` 会先诊断当前目录，再决定是否写文件。空项目走新项目骨架；已有
代码库走 `$roll-onboard`；只有 PRD/文档的目录会被当成新项目并指向设计；
部分 Roll 或旧 Roll 布局只打印修复/迁移建议，不直接改文件。

## 3. 从需求到 Backlog

如果你手头有需求文档（PRD、草图、笔记）但还没有源码，`roll init` 会把它识别
为 PRD-only 新项目并指向设计。已有 Roll 骨架但 backlog 为空时，`roll status`
和 `roll doctor` 仍会提示进入设计阶段。

想立刻开始设计对话：

```bash
roll design --from-file docs/PRD.md
```

如果 `roll init` 检测到 PRD，就使用它打印出来的那条
`roll design --from-file ...` 命令；没有文件时，`roll design` 仍会在你的 AI
agent 里拉起同一个 `roll-design` 技能。你描述领域模型，agent 把 INVEST 故事写入
`.roll/backlog.md`，详细设计会生成自包含的 `design-review.html` Design Review Page，
然后你跑 `roll loop go` 把这些故事建出来。

你也可以直接在 agent 里跑 `$roll-design`，效果一样。

如果你心里已经有故事，只想快速加一条，跳到第 4 步。

## 4. 写第一条 Backlog

用一句话建一张小故事卡：

```bash
roll idea "Add a health check endpoint"
```

`roll idea` 自动分类、取号、推断史诗、建卡片文件夹 — 一步完成待办行和故事文件夹。

然后编辑 `.roll/features/<史诗>/<ID>/spec.md`，把 AC 写清楚。

第一条故事要小：一个可见行为，一条明确测试路径。

## 5. 跑 Loop

交付之所以前进是因为你启动了它 —— 没有任何东西会替你开始。在项目里打开一个 agent 会话，然后执行：

```bash
roll loop go
```

这个 agent 会话就是 Supervisor：它挑下一张 `📋 Todo` 卡、跑 build/fix 周期，
也可以把活派给 Delta Team。你启动的运行会活过窗口(detached tmux),直到范围做完或到达上限;但 Roll 不会自己开始跑 —— 你不打开
agent 会话跑 `roll loop go`，就什么都不会发生。

想先只跑一轮：

```bash
roll loop go --max-cycles 1
```

需要限定范围时：`--epic <名称>` 只跑一个史诗，`--cards <id,...>` 只跑指定卡，
`--for <时长>` 限制墙钟时间。

任何时候看状态：

```bash
roll loop status
```

`roll loop status` 是常用快照视图。若当前有 cycle 在跑，并且你想看实时视图，
用只读 watch 命令：

```bash
roll loop watch
```

排查事件用 `roll loop watch --events`，只有需要原始审计 JSON 时才用
`roll loop watch --raw-events`。所有 watch 模式都是只读；Ctrl-C 只停止视图。

想暂时不让项目再跑周期，以及重新放开：

```bash
roll loop pause
roll loop resume
```

暂停期间，指定单卡的引导式执行 —— `roll loop go --cards US-DEMO-001` —— 仍然可以跑。

## 6. 生成验收报告

故事落地、backlog 行变成 `✅ Done` 后，生成离线验收报告：

```bash
roll attest US-DEMO-001
```

报告会写进该故事的 `.roll/features/` 文件夹。发布前，每条 AC 都应有 verdict
和证据链接。
