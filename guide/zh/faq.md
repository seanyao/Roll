# Roll 常见问题

按你和 Roll 接触的阶段组织，给真实问题真实回答：

- **[A. 上手 / 信任 / 安全](#a-上手--信任--安全)** —— 第一次接触前后会想的
- **[B. 定位与对比](#b-定位与对比)** —— Roll 和同类项目的区别
- **[C. 运行中常见问题](#c-运行中常见问题)** —— 跑起来后卡住怎么办

---

## A. 上手 / 信任 / 安全

> **Roll 有两套界面。** 读这份 FAQ 时请分清：
>
> - **CLI 命令** —— 在终端里跑：`roll init`、`roll loop go`、`roll status`、
>   `roll loop cycle` 等。负责状态管理、执行、观测。**它们本身不写代码**。
> - **Skill** —— 在你的 AI agent 里调用（Claude Code、Cursor、Codex、Pi
>   等）：`$roll-build`、`$roll-design`、`$roll-fix`、`$roll-onboard` 等。
>   在 Claude Code 里输入形式是 `/roll-build`；`$` 前缀是文档里跨工具的
>   通用写法。**真正写代码的是 skill**。
>
> 看到 `roll loop go` —— 是 shell 命令。看到 `$roll-build US-001` —— 是
> 你在 agent prompt 里调用的 skill。
>
> **Roll 里没有任何东西会自己开始跑。** 交付推进是因为你跑了 `roll loop go`;
> 这次运行会活过你的窗口(detached tmux),按自己的范围结束;两次运行之间不会有推进。

### A1. Roll 会不会改我代码、搞坏我的 main 分支？

**短答：** Roll 有真的护栏，但**两种模式的安全模型不一样**，要看清你在
跑哪种。

**通用保证 —— TCR**：每次提交都跑你的测试。测试不过，提交自动回滚。
**两种模式下，坏代码都不可能保留**。这是其他护栏的地基。

**手动模式（`$roll-build`、`$roll-fix` 等，trunk-based）：**

- agent 一边干一边做 TCR 微提交
- **Phase 6** 在 push 之前在本地跑完整 CI
- **Phase 7** 在 push 之前由 agent 做代码 review
- **Phase 8** 直推 `main` —— 你坐在 agent 面前看着这一切发生，随时能叫停
- 远程 CI 是最后一道网：push 后变红你立刻就能看到，修一下或 revert

**Loop 模式（在你打开的 agent 会话里跑 `roll loop go`）：**

- 在 worktree 的分支上构建（`loop/cycle-${CYCLE_ID}`）
- `gh pr create --base main` 开 PR
- 调用 `gh pr merge --auto --squash --delete-branch` —— PR **只有在你的
  required CI checks 全绿时**才自动合并。**默认是 CI 把关，不是人**
- 要在合并前加上人审，去 GitHub 的 branch protection 把 `main` 加上
  required reviewers，`--auto` 就会等你审完

**两种模式都一样：** 所有过程都在 git history 里。要回滚就 `git revert`
或 `git reset`，没有黑盒。

**先手动试一遍：** 打开你的 AI agent（Claude Code、Cursor、Pi 等），
在项目里调用 build skill 跑一条 story：

```text
$roll-build US-001         # 在 Claude Code 里输入：/roll-build US-001
```

你会在眼前看完整的 design → TCR → 本地 CI → review → push 过程，在用
`roll loop go` 把整个史诗交给它之前，先看清 Roll 到底碰了什么。

---

### A2. 我有一个已有项目能用吗？会污染我现有代码吗？

**短答：** 可以。Roll 对已有代码库有专门的 onboarding 流程，且只写自己的目录。

**细节：** 在已有代码的仓库里跑 `roll init`，会自动检测并引你走
`$roll-onboard`。这个 skill 会读你的项目，问 9 个关于认知 / 范围 / 隐私
的问题，先写出 `.roll/onboard-plan.yaml` 作为契约，审阅后再由
`roll init --apply` 实际动手。`roll init --apply` 会先打印计划操作检查点并在写入前等待确认；
非交互自动化必须使用 `roll init --apply --auto`。

Roll 写到你仓库里的东西：

- `.roll/` —— backlog、feature 规格、配置（要 commit）
- `.claude/skills/` 或其他 agent 等价目录 —— Roll skill 的软链（要 commit）
- `.gitignore` 加几行

Roll **不会**碰你的源代码 —— 除非 agent 正在执行你写的某条 story。

---

### A3. 我不想让它连着跑一长串，能手动一条条来吗？

**短答：** 能。这本来就是默认行为 —— loop 只在你叫它的时候才跑。

**细节：** 只要你不跑 `roll loop go`，Roll 就是一套 CLI + skill 库。你在
`.roll/backlog.md` 写一条 story，然后在 AI agent 里调用 skill：

```text
$roll-build US-001         # 端到端跑一条 user story
$roll-fix   FIX-002        # 端到端跑一条 bugfix
```

（在 Claude Code 里输入形式是 `/roll-build US-001` 和 `/roll-fix FIX-002`。）

每次调用都在你眼前跑完 design → TCR → 本地 CI 闸 → agent 自审 → 推到
`main`，每一步你都看得见，随时能叫停。
等你信任这套流程了，再在 agent 会话里跑 `roll loop go --max-cycles 1` 让它
自己选一条 story，之后再逐步放宽这次运行的范围。

---

### A4. 装上之后改了我哪些系统配置？怎么干净卸载？

**短答：** 两个地方，`./uninstall.sh` 全部还原。

**细节：**

- **全局**：`~/.roll/`（你的 config）、`~/.shared/roll/`（共享 loop 状态、
  `runs.jsonl`）。每个项目的 agent 路由放在 `.roll/agents.yaml`。
  npm 二进制放在 npm 全局目录里。
- **每个项目**：`.roll/`，以及 `.claude/skills/`（或其他 agent 等价路径）
  下指向 Roll skill 的软链。

Roll 做的每件事都发生在你亲手启动的命令里。`roll loop go` 会把 worker 放进 detached
tmux 窗口,所以关掉终端它还在跑,按自己的范围结束 —— 想留前台就加 `--no-tmux`。
Roll 绝不做的是:装下任何会启动你没要求过的工作的东西。

要完全卸载：

```bash
npm uninstall -g @bipo-ape/roll
~/.roll/uninstall.sh --dry-run    # 预览会删什么
~/.roll/uninstall.sh              # 实际执行
```

---

### A4b. 没装 npm / Node.js 能装 Roll 吗？

**短答：** 能。curl 安装自带一切，只需要 bash、curl、tar —— macOS 和 Linux 都预装。

**细节：**

```bash
npm install -g @bipo-ape/roll
```

不需要 Node.js、不需要 npm、不需要任何包管理器。脚本下载 tarball、解压到
`~/.local/share/roll/`、把 `~/.local/bin/roll` 软链进你的 PATH。升级和卸载也一样
——`roll update` 重新下载最新 tarball；`rm -rf ~/.local/share/roll ~/.local/bin/roll`
全部清除。

钉版本（生产环境推荐）：

```bash
npm install -g @bipo-ape/roll
```

---

### A5. 跑一次大概多少 token？成本能看到吗？

**短答：** 能。Dashboard 按公开单价显示每个周期的模型 + 成本。

**细节：** 从 `v2026.521.1` 起，`roll loop status` 会显示用的模型和按公开
per-token 单价算出来的成本。这是一个**横向可比**
的数字，不是你的实际账单 —— 你的实际花费取决于你的订阅折扣（Claude Pro 等）。

Claude Opus 4.x 上典型单条 story 成本：**$0.5 – $3**，看故事复杂度和
TCR 来回次数。切到 Kimi / DeepSeek 能便宜 5–10 倍，代价是收敛慢一点。

**非 Claude agent：** token/cost 抓取是按 agent 分别支持的。截至当前版本，跑在
**Claude、pi（DeepSeek）、OpenAI（codex）、Gemini、Kimi** 上的 cycle
都能看到真实 token 数和成本。还没有 usage 插件的 agent —— 主要是 **OpenCode** ——
token/cost 列仍显示 `—/—`。新 agent 的支持不会自动出现，需要落一个小的按 agent
插件（见 `lib/agent_usage/README.md`）。

**试一下：**

```bash
roll loop status                 # loop 快照，带成本列
roll loop status --days 7        # 看过去 7 天每个周期的成本
```

---

### A6. 我需要懂 DDD / TCR / Prompt 工程吗？

**短答：** 不需要。但**会写 user story** 帮助很大。

**细节：** Roll 的方法论藏在 skill 里，不需要你脑子里装。`$roll-design`
带你做 DDD 拆解；`$roll-build` 替你跑 TCR；prompt 工程封装在 skill 文件里
（你好奇可以读或改）。

唯一需要你**脑子里有**的：**把你想要的东西讲清楚**。INVEST 形态的 story
（独立、可协商、有价值、可估算、足够小、可测）比"帮我做个功能"效果好得多。
`$roll-design` 帮你从模糊想法走到 INVEST。

---

### A7. User Story 应该写多细？写得不好它能跑通吗？

**短答：** 细到**你自己**能照着写代码。太模糊的会被识别出来、refine 后再
`$roll-build` 才动代码。

**细节：** 一条可执行的 story 包含价值陈述（`As X, I want Y, so that Z`）、
2–5 条验收标准（AC）、以及非显然的约束。**别**指定实现方式 —— Roll 自己来。

- **太模糊** → `$roll-build` 里的 `$roll-.clarify` 阶段会停下来问你
- **太复杂** → design 阶段会建议拆成更小的 story
- **模糊但能跑** → agent 自己做选择，原型阶段可以接受，生产代码风险较大

**试一下：** 运行 `$roll-design "加一个登出按钮"`，看它怎么把一句话扩成
一条带 AC 的 INVEST story。

---

### A8. Roll 适合什么项目？什么不适合？

**适合：**

- 有真实的测试套件（TCR 依赖它）
- 用 git + PR 工作流
- 有 CI（GitHub Actions 或同类）
- 能用 1–3 句话描述的需求
- TypeScript / Python / Go / Bash 项目（当前支持最好）

**不适合：**

- 一次性脚本、扔掉的原型 —— 开销大于价值
- 高度专门化领域（底层 OS、嵌入式、形式化验证）—— AI agent 在这些领域表现差

**边界情形 —— 没测试的老代码库：** 这是个 bootstrap 问题，不是禁区。
TCR 总得有**点东西**可守，所以零测试的仓库 day-one 跑不了 loop —— 但把
这类代码库救回来正是 Roll 擅长的事。流程：先用 `$roll-onboard` 把现有
代码逆向工程成 backlog，**先写 characterization-test story**（用测试把
当前行为钉死，再动代码），有了这层网之后再在 TCR 下重构。前几条 story
是 bootstrap，之后就和正常的 Roll 项目一样跑。

---

### A9. 没有 CI / 没有 GitHub Actions 也能用吗？

**短答：** 能用，但失去 CI 闸门。TCR 和 PR 流程还在。

**细节：** `roll status ci --wait` 找当前 commit 上的 GitHub Actions。如果没配
CI，Roll 优雅降级：TCR 仍是内层闸门（测试不过提交不留），PR 仍然创建，
但 loop 不会等远程 CI 绿就标记 story 为 Done。

纯本地用（不挂 GitHub），Roll 也能当方法论 + skill 层用 —— 只是失去
"等绿了再下一条"的自动行为。

---

### A10. 单人用还是团队用？多人怎么协作？

**短答：** 优先支持单人 / 结对；团队用法可行但需要按场景设计。

**细节：**

- **单人**：默认。`.roll/backlog.md` 是你的私人队列。
- **结对**：把 `.roll/` 提交进 git，搭档的 Roll 读同一份 backlog。锁是
  per-machine 的，两人都开 loop 不会撞状态，但可能抢同一条 story。
- **团队**：`.roll/backlog.md` 当源代码对待，通过 PR 协作。`-peer` skill
  支持跨 agent 评审（一个 agent 评另一个 agent 的 PR）。多人 loop 的
  "谁挑下一条"协调还是个粗糙边缘。

务实建议：团队里在自己的分支 / fork 上跑 loop，PR 像普通贡献者一样合上去。

---

### A11. 价格更新后，历史 cycle 的成本数字会变吗？

**短答：** 不会。每轮 cycle 的成本在完成时就固化了。

**细节：** loop cycle 结束时，Roll 会把 `cost_list_usd`（按当时价格算出的成本）和
`prices_version`（用了哪个快照版本）写入 usage 事件。dashboard 优先读固化值。厂商
调价、`roll config prices refresh`、Roll 升级都不会回头改写历史数字。

此功能上线之前的旧 cycle（没有 `cost_list_usd` 字段）会回退到用*当前*快照现算，
行末显示浅灰色 `[legacy]` 标记 — 提醒你这个数字在调价时可能会漂移。

**试试看：**

```bash
roll config prices show            # 查看当前价格快照
roll config prices refresh         # 拉取最新定价、对比、有变化落新快照
roll loop status --days 7   # 历史 cycle 用的是固化成本
```

---

### A12. 一次运行正在跑，怎么在手机上看它的状态？

**短答：** 配置 `roll_meta_dir`，然后把 `.roll/prompts/remote-watch.md` 粘贴进手机或
浏览器里的 Claude Code。

**细节：** 在 `~/.roll/config.yaml` 配好 `roll_meta_dir` 后，本机会在每轮 cycle 结束
后把 `status/loop.md` 快照 push 到 roll-meta 仓库。remote-watch prompt 读这份快照 +
GitHub API，汇报 loop 健康、backlog 进度和 CI 状态——只读，不需要本地 `roll`。快照的
新鲜度取决于你启动的那次运行的最后一轮 cycle；那次运行结束后就不再有新快照。配置与
排障见 [远程监控](loop.md#远程监控remote-monitoring)。

### A13. 怎么看某一轮 cycle 的时间花在哪了？

**短答：** `roll loop runs --detail <cycle_id>` 打印这一轮各阶段的耗时拆解。

**细节：** 每轮 cycle 都记录了各个命名阶段的耗时。detail 视图渲染一段
`─── Cycle <id> Phase Breakdown ───` 块，按耗时降序，秒数 + 占比 + 条形图都有，
一眼能看出时间是花在 agent、worktree 准备还是推送上。设 `NO_COLOR=1` 关闭颜色。
怎么读这个结果见下面 C6。

---

## B. 定位与对比

### B1. 和 Claude Code 自带的 `/loop`、skills、tasks 是什么关系？

**Claude Code 已经有什么：** Skills（自定义命令）、tasks（session 内 todo）、
plan mode（执行前 review）、`/loop`（按时间间隔触发 prompt 的定时器）。

**Roll 的差异：**

- **Backlog 持久化在 git 里**。Roll 的 `.roll/backlog.md` 跨 session、
  跨重启、跨模型都在。Claude Code 的 tasks 一个 session 就没了。
- **是交付管线，不是定时器**。`/loop` 每 N 分钟重发一个 prompt。`roll loop go`
  选下一条 ready 的 story，走完 DDD → TCR → PR → CI，等绿了再下一条 ——
  会话开着就一轮接一轮。
- **TCR 是硬闸**。Claude Code 的 skill 是建议性的，Roll 在 commit 时刻
  强制 `test && commit || revert`。
- **跨 agent**。同一份 backlog 和 skill，可以在 Codex / Kimi / DeepSeek /
  Pi / OpenCode 上跑。`/loop` 只认 Claude。

**怎么选：**

- 交互式 session，临时任务 → Claude Code 单独用就够
- 长期项目，一次坐下要推很多条 story、要硬 CI 闸 → 在 Claude Code 上加一层 Roll

Roll 的 `roll-*` skill **本身就是** Claude Code skill。Roll 不替代
Claude Code，它在上面叠一层。

---

### B2. 和 [superpowers](https://github.com/obra/superpowers)（obra）比？

**superpowers 强在哪：** 成熟的 7 阶段方法论（brainstorm → worktree →
plan → execute → test → review → finish），支持的 agent 很广（Claude
Code / Cursor / Codex / Antigravity / Copilot / Factory / OpenCode），强制
RED-GREEN-REFACTOR，subagent 驱动开发。Roll README 已致谢 ——
Roll 几个工作流模式从它借鉴而来。

**Roll 的差异：**

- **持久 backlog + 多故事连跑**。superpowers 是 session 驱动 —— 每个周期
  你自己启动。Roll 也是 session 驱动，但一条 `roll loop go` 会一轮接一轮
  自动挑下一条 ready 的 story，直到这次运行结束。
- **CI 作为终态闸门**。Roll 等 GitHub Actions 绿了才标 Done；
  superpowers 把 CI 集成留给你。
- **PR-centric**。每条 Roll story 最后是一个挂上你 CI 的 PR；
  superpowers 对产出形态更灵活。

**怎么选：**

- 你想自己驱动每个周期，要一套强方法论压阵 → **superpowers**
- 你要启动一次运行就让它啃完一片 backlog，还要硬 CI 闸 → **Roll**

也可以一起用 —— 两者有重叠但不冲突。

---

### B3. 和 [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)（Yeachan Heo）比？

**oh-my-codex 强在哪：** 给 Codex CLI 的精致 harness —— tmux HUD、hooks、
agent 团队（`$ralplan`、`$ralph`、`$ultragoal`）、`.omx/` 持久状态、
基于 ledger checkpoint 的多目标续命。29k star，非常活跃（107 个 release）。

**Roll 的差异：**

- **不只 Codex**。Roll 支持 Claude / Codex / Kimi / DeepSeek / Pi /
  OpenCode。oh-my-codex 有意聚焦 Codex CLI。
- **TCR 是硬闸**。oh-my-codex 推荐 clarification → planning → execution
  的流程，但**不**在 commit 层强制 TDD/TCR。
- **PR + CI 是终态**。Roll 的 loop 每条 story 结束在"PR 合并 + CI 绿"。
  oh-my-codex 结束在"agent 说目标完成"。
- **方法论形态**。oh-my-codex 强调耐久的多目标执行和并行团队。Roll 强调
  单 story 原子化（一条 INVEST story → 一个 PR → CI 绿 → 下一条）。

**怎么选：**

- 重度 Codex CLI 用户，想要 hooks / tmux HUD / 多 agent 团队 →
  **oh-my-codex**
- 想要跨 agent 可移植，把 PR/CI 当成成功契约 → **Roll**

---

## C. 运行中常见问题

### C1. Loop 卡住了 —— 故事停在 "In Progress" / Done 没写上

**现象：** `roll loop status` 显示 `running`，或者 BACKLOG 里某条 story
停在 `🔨 In Progress` 超过一个周期，或者 agent 跑过了（能看到 TCR commit）
但 story 没标 `✅ Done`。

**原因：** Loop 在调用构建 skill **之前**就把 story 标为
`🔨 In Progress`，只有两个硬门都过了才写 `✅ Done`：(1) TCR commit 数 > 0，
(2) `roll status ci --wait` 通过。任何一个挂了，story 就保持原状 —— 这是设计如此，
避免假阳性的完成标记。

**原理：** 每个周期获取一个项目级 LOCK
（`~/.shared/roll/loop/.LOCK-<slug>`）。PID 已死的 LOCK 下个周期自动清理；
进程还活着但挂起的（例如 tmux 卡死）会让 LOCK 一直在，阻止新周期启动。

**解决：**

```bash
roll loop status              # 看 LOCK + 持有它的 PID
roll loop watch               # 只读实时视图；Ctrl-C 只停止视图
roll loop runs                # 上一个周期的结果和告警
roll loop alert               # 有没有 CI 或 TCR 告警
roll loop reset               # 实在卡死了清状态 + LOCK
roll loop go --max-cycles 1   # 干净地跑一轮新周期
# 如果代码确实做完了、测试也过，但 Phase 11 没走完：
$roll-build US-XXX            # 手动重跑这条 story
```

---

### C2. PR 有合并冲突 / Rebase 失败

**现象：** `gh pr checks` 显示 "This branch has conflicts"，或
`roll loop runs` 报告 rebase 失败告警。

**原因：** Loop 在 worktree 里构建期间，另一个 commit 合到了 `main`，
动了和 PR 同一行。

**原理：** `roll loop reconcile` 把 awaiting-merge 的 cycle 对着 `main` 探测，
遇到冲突就把 PR 报成 stuck 并给出 `conflict` 原因，而不是盲目重试。结构性冲突
归你解决 —— loop 不会替你改写分支去猜合并结果。

**解决：**

```bash
gh pr view <number>               # 看哪些文件冲突
git fetch origin main
git checkout <pr-branch>
git rebase origin/main            # 手动解决
git push --force-with-lease
# CI 重跑；如果开了自动合并，绿了自动 merge
```

---

### C3. 怎么看 Loop 做了什么 + 花了多少钱？

**现象：** 一次运行刚跑完，你想快速看清楚发生了什么、花了多少。

**为什么重要：** Roll 每个周期都写结构化记录，但根据需求有多个查看入口。

**原理：** 每个周期向 `<project>/.roll/loop/runs.jsonl` 追加一条 JSONL，
包含 story ID、模型、TCR commit 数、耗时、结果、成本（按公开单价）。
`roll status`、`roll loop cycle` 与按 Story 收口的 attest 报告把这些——连同真相账本的其余部分——
聚合成人类可读界面。实时 watch 是只读视图，会把 live 活动和结构化事件事实合并展示；
tmux 观测 pane 使用同一个 watch 入口。

**观测入口：**

| 你想看什么 | 命令 |
|---|---|
| 最近 N 个周期摘要 + 成本 | `roll loop status --days 7` |
| 一个故事跨所有 cycle 的总花费 | `roll loop story <ID>` |
| 每周期 JSONL 记录 | `roll loop runs` |
| 单个 cycle 各阶段耗时 | `roll loop runs --detail <cycle_id>` |
| 带成本列的快照 dashboard | `roll loop status --days 7` |
| 实时看 agent 在做什么 | `roll loop watch` |
| 调试 compact 事件事实 | `roll loop watch --events` |
| 原始审计 JSON 事件 | `roll loop watch --raw-events` |
| 一眼看清已发布 / 进行中 / 队列 / 发布就绪 | `roll status` |
| 需要关注的告警 | `roll loop alert` |
| 完整 cycle agent 输出（纯文本） | `roll loop log` |
| 完整 agent 对话记录 | `roll loop watch --verbose` 或 `roll loop log` |

`status` 是滚动窗口（默认 3 天）。当一个 story 拖了一周、跑过好几轮，你想看它**总共**花了多少
——总耗时、总 token、总成本、所有 PR——用 `roll loop story <ID>`：它会读完整事件流（含轮转归档
`.1` … `.4`），一次性给你一张面板。

---

### C6. cycle 显示某个阶段特别慢——怎么定位？

**现象：** `roll loop runs` 某条 built 行尾出现 `slowest=claude 96%`，
或某轮看着没干啥却显示 `slowest=worktree_setup 40%`。想知道时间花在哪
一步再决定要不要动。

**原因：** 每轮 cycle 在内部被切成 6 个命名阶段
（`startup` / `preflight` / `worktree_setup` / `agent_invoke` /
`publish_push` / `cleanup`）。主 loop 不等合并：它记录
`awaiting_merge`，随后由 Delivery Reconciler 在 cycle 边界、读路径或显式
`roll loop reconcile` 时推进。因此几乎每轮都是 `agent_invoke` 占大头。

**怎么办：**

1. 从 `roll loop runs` 那行（或 `runs.jsonl`）抄出 cycle_id。
2. `roll loop runs --detail <cycle_id>` 打完整面板：按耗时降序，秒数 +
   占比 + 条形图都有。
3. 常见模式：
   - `agent_invoke` 占绝大头 → 多文件故事的正常表现；除非能拆故事
     否则没什么可调的。
   - PR 一直开着没合 → 运行 `roll loop reconcile --json`，再查 CI、draft/
     评审、冲突或权限原因。这不属于主 loop 的阶段。
   - `worktree_setup` > 30 秒 → `git fetch origin` 慢；通常是临时网络
     抖动。
   - `preflight` > 30 秒 → 受管工作区审计发现 stale、unknown 或未注册成员。检查
     `roll worktree audit` 与 `roll supervisor live`；Roll 会保留现场并打印 owner
     recovery action，不会自动删除或重建。

阶段耗时也写进 `runs.jsonl` 的 `phases` 字段（每个阶段一个秒数键），
可以跨多轮做后处理分析。

---

### C4. 多个项目同时跑 Loop 会互相干扰吗？

**现象：** 你同时给两个项目开着 `roll loop go`，怀疑它们互相影响。

**原因：** 不会。每个项目有自己的 LOCK
（`~/.shared/roll/loop/.LOCK-<project-slug>`）和自己的 `state.yaml`。
Slug 由 `basename + md5(绝对路径)` 生成，即便两个项目
目录名一样，路径不同也得不同 slug 和不同锁。

**解决：**

```bash
# 在每个项目目录跑一下，看各自的运行状态 + LOCK
roll loop status

# 看所有活着的锁
ls ~/.shared/roll/loop/.LOCK-*

# 如果另一个项目留下的僵死锁挡住了你
roll loop reset
```

---

### C5. 什么时候自动恢复，什么时候要我介入？

**Loop 的原则：清楚的工作往前推；模糊的工作或坏掉的环境停下来告诉你 ——
不会猜。**

下面说的"自动恢复"都是指*在你启动的这次运行之内* —— 由同一条 `roll loop go`
的下一轮 cycle 收拾干净。运行一结束，就什么都不会再自动恢复了。

**自动恢复（不需要你插手）：**

- 网络超时 → 指数退避重试（2s、4s、8s、16s）
- 角色候选 agent 离线（不在 PATH / 断 auth / 断网 / 账号不可用）或 token 耗尽 →
  在本次 resolution 中跳过，并记录 runtime health
- 崩溃进程留下的僵死 LOCK → 下个周期自动清理
- 崩溃周期留下的孤儿 `🔨 In Progress` → 下个周期回退为 `📋 Todo`

**需要你：**

- 所需角色没有剩余可用候选 → 写 ALERT 停下；修环境或调整 role binding 后
  `roll loop resume`
- CI 持续红 → 修测试 / build，然后重新起一次 `roll loop go`
- PR 合并冲突 → 手动解决，push
- `gh` 认证过期 → `gh auth login`
- Story 反复回滚（每次 TCR commit 数 = 0）→ story 规格不清晰；重写 AC
  或 `$roll-build US-XXX` 手动跑一遍看在哪卡住

更细的操作话题（pause/resume、切换 agent、gh scope 等）见
[loop.md](loop.md) 和 [configuration.md](configuration.md)。

### C9. dashboard 显示 "sync: offline" 是什么意思？

**症状：** dashboard 底部显示 `sync: offline`，或者你好奇为什么没配置跨机器同步
却显示 `sync: not configured`。

**为什么重要：** dashboard 同步状态指示器告诉你其他机器的 cycle 记录是否已合并到
当前视图。

**底层：** 在 `~/.roll/config.yaml` 中配置了 `roll_records_remote` 后，每轮 cycle
会把自己的记录 push 到共享 git 仓库，dashboard 渲染前会 pull 合并。指示器有三种
状态：

- `sync: ok (2m ago)` — 远端可达，所有机器的记录已合并
- `sync: offline` — 远端不可达（网络问题、认证过期）；仅显示本地数据，其他机器的
  cycle 在恢复连接前不可见
- `sync: not configured` — 未设置 `roll_records_remote`；同步已关闭，这是单机使用
  时的正常状态

**`sync: offline` 的解决：**

```bash
# 检查到 records 仓库的连通性
ssh -T git@github.com           # 或你的 git host

# 验证远端是否仍可访问
git ls-remote $(roll config get roll_records_remote)

# 认证过期则重新登录
github.com → gh auth login
gitlab.com / 自建 → 检查 SSH key

# dashboard 在离线期间自动降级为仅本地数据——不会丢数据，
# 只是暂时看不到其他机器的 cycle，等连接恢复即自动同步。
```

### C10. 我跑了 roll-doc-audit——怎么知道它做了 Phase 3a 还是 Phase 3b？

**症状:** 你跑了 `$roll-doc-audit`,想知道它是停在目录级填充(Phase 3a),还是继续做了
深度的跨目录读取(Phase 3b)。

**为什么会这样:** Phase 3a(即"Fill"填充阶段)孤立地读取每个缺口目录——每个目录
至多 20 个源文件——产出模块 README。Phase 3b("Deep Read")仅在项目具备值得记录的
跨目录结构时触发:跨 ≥ 3 个目录的 import 链、被共享的 `*State` / `*Status` 枚举、
外部端点调用,或 CI 配置文件。纯文档项目若无源码缺口且无此类特征,则完全跳过
Phase 3b。

**看 Phase 4 报告。** 运行结束的摘要始终打印两段:

```
Phase 3 — Fill
  2 drafts generated: [src/commands/README.md, docs/CONVENTIONS.md]
Phase 3b — Deep Read
  Symbol table: exports(42) imports(156) enums(7) external_urls(4) configs(3)
  2 topic documents generated:
    - docs/data-flows.md     (data-flow)   source entries: 6
    - docs/integrations.md   (external-integration) source entries: 4
```

若 Phase 3b 无命中,则只打印一行——`Phase 3b: no subject-level drafts generated`
——所以没有任何 `docs/data-flows.md` / `docs/state-machines.md` /
`docs/integrations.md` / `docs/deployment.md` 输出,就是只跑了 Phase 3a 的标志。
在 `--dry-run` 下,同样的 Phase 3b 行会标 `(plan)` 且不写文件。完整拆解见
[roll-doc-audit.md](roll-doc-audit.md)。


---

## loop 跑完一轮但 dashboard 显示 backlog 为空

loop 从 `.roll/backlog.md` 选故事。如果 backlog 看起来空了或没有 `📋 Todo` 条目，常见原因：

**1. `.roll/` 没同步（换机器或重装系统）**

`.roll/` 是独立的私有 git 仓库（roll-meta）。
新机器上需要手动克隆并配置远端：

```bash
# 替换成你实际的 roll-meta 仓库地址
git clone git@github.com:your-org/roll-meta.git .roll
```

**2. SSH Key 未授权**

```bash
ssh -T git@github.com   # 应该返回 "Hi <username>!"
```

失败则需要把 SSH Key 重新添加到 GitHub。

**3. 检查同步状态**

```bash
git -C .roll remote get-url origin  # 空值 = 同步未启用
git -C .roll log --oneline -3        # 查看最近同步的提交
```

**4. 手动强制同步**

```bash
git -C .roll fetch && git -C .roll reset --hard origin/main
```

### C5. 为什么这个 cycle 用了别的 agent 而不是我以为的那个？

**症状**：你以为会用某个 agent，但 loop 选了另一个。

**原因**：Roll 解析的是 scoped role binding，不是隐藏默认值。Builder 来自
`story.execute`；评审和打分来自 `story.evaluate`。绑定可能继承 Machine Scope
（`~/.roll/agents.yaml`），也可能在 Project Scope（`.roll/agents.yaml`）里声明。

**自检**：

```bash
roll agent          # Machine Scope、Project Scope、已解析角色、pool health
roll agent list     # 本机装了哪些 agent
roll loop runs 20   # 看最近 20 个 cycle 的 agent
```

如果候选因为 auth、网络、VPN、账号或 binary 缺失不可用，Roll 只会在本次
resolution 中跳过它并记录运行时事实，不会静默改写静态 pool。

### C6. 故事为什么翻成 🚫 搁置了，cycle 不是跑了吗？

**症状**：BACKLOG 行显示 `🚫 Hold → split to US-FOO-XXXa,US-FOO-XXXb`,
日志里有 `self-downgrade` 或 `StorySplitCapHit` 类的 ALERT。

**原因**：agent 在 `roll-build` / `roll-fix` SKILL 的 Pre-flight 阶段
自评判定 `verdict: too_big` —— 故事的 `est_min` 超出当前 agent 上限,
或 `risk_zone` 不匹配,或近期历史命中率低于 `prefer_threshold` 且
链深度还有降级预算。cycle 调 `roll-design --from-story <id>` 拆出
`chain_depth + 1` 的子故事,原故事翻 🚫 Hold,干净退出。

链深 ≥ 2 时 cap 拦截 `StorySplitCapHit`,第 3 次拆解被拒绝,写 ALERT
等人工介入,防止无限套娃。

**处理**：看 agent 拆出来的子故事是否合理;不满意可手动编辑,或把
原故事翻回 📋 Todo + 重写更紧的 `est_min` / `risk_zone` profile。

### C7. 怎么不离开终端发反馈（bug / idea / UX）？

反馈走最小入口:本地 Roll backlog 用 `roll idea`,公开 GitHub issue 用
`gh issue create`。

```bash
roll idea "Safari redirect 后登录失败"
gh issue create --title "Safari 上登录失败" --body "复现步骤: ..."
```

`roll idea` 写入 Roll backlog;`gh issue create` 写入 GitHub。需要环境信息时
可在 issue body 里附上 roll 版本 / OS / agent / 语言 / 项目等内容。详细分流见
[feedback.md](feedback.md)。

### C8. 升级后我的 loop 状态 / ALERT 跑哪去了？（Phase 2.0）

**短答：进了你的项目。** Phase 2.0 起，项目的 loop 运行时数据放在
`<project>/.roll/loop/`，不再在 `~/.shared/roll/loop/`。ALERT 现在是
`<project>/.roll/loop/ALERT-<slug>.md`，状态是 `state-<slug>.yaml`，运行
历史是 `runs.jsonl`。

**需要手动迁移吗？** 只有从这次搬迁之前的版本升级才需要。Roll 只读项目本地路径，
cycle 不会在启动时改写路径。要把老项目搬过来，手工把 `state-<slug>.yaml`、
`ALERT-<slug>.md`、`PAUSE-<slug>`、`mute-<slug>` 以及该项目在 `runs.jsonl` 里的行
复制进 `<project>/.roll/loop/`。

**清残骸：** `roll loop gc` 退役孤儿 slug（项目已删）、清扫过期 `.migrated-*`、
`runs.jsonl.tmp.*` 与旧备份；`roll loop gc --dry-run` 预览。完整说明见
[Loop 数据布局](loop-data-layout.md)。

### C11. Roll 如何选择 CLI、文档和 agent 的语言？

`ROLL_LANG=en|zh` 固定当前进程语言。`roll config lang en|zh` 保存偏好，
`roll config lang --reset` 回到系统语言探测。`roll help --lang en|zh <topic>`
可临时切换帮助和指南语言。

这些控制只影响用户可见表面。Agent 契约、代码、git 元数据和 schema 保持英文；
与 owner 的对话跟随当前任务里 owner 使用的语言。发版前可运行
`roll doctor language` 审计文档、约定、skills 与生成表面的语言漂移。

### C12. `roll browser interactive` 有什么限制？

**短答：** 它是一个面向本地 Chrome 调试端点的前台、owner 运行、单次操作工具——
不是后台自动化，也不是远程浏览器。

**细节：** `roll browser interactive` 要求：

- 已连接的 TTY 和每次操作的显式 owner 批准。
- 你自己用 loopback 调试端口启动的 Chrome，例如 `127.0.0.1` 上的
  `--remote-debugging-port=9222`。

它**永远不会**：

- 从后台调度器或 CI 作业中运行。
- 连接远程或非 loopback 端点。
- 导出 cookie、storage 或 network bodies。
- 自动启动 Chrome。
- 独自让 CI 通过——结果仅用于 **owner-run manual-attest**。

租约最多 15 分钟，操作结束后立即释放。无人值守诊断请用受管通道
（`roll browser run`）。

### C13. 某个故事被标记为证据降级——需要重建吗？

**简答：** 不需要。`degraded-infrastructure` 表示代码交付已通过，只是截图机器
出了故障（宿主 / 供应方 / 工具）。重建故事解决不了任何问题。只修复证据即可：

```bash
roll capture repair <story-id>
```

**细节：** `roll capture repair` **只**重跑截图通道并重新解析证据健康，绝不重开
构建或 TCR 周期，交付结论原样带过。对失败交付或任何非降级状态，它会拒绝（同样
不重建）。

先查清截图为何不可用：

```bash
roll doctor                 # “Capture policy readiness / 截图策略就绪度” 一节
roll capture status         # 网关 + 渲染器就绪度与有效策略
roll loop status --capture
```

若 v2 网关显示 `provider_v2_unavailable`，请安装/更新 Roll Capture.app 使其
advertise `roll.capture.v2`；若渲染器不可用，运行 `npx playwright install
chromium`。视觉 AC 由 **Roll Capture · physical** 图像或绑定目标的
**Playwright · rendered** 回执任一满足——当渲染回执已绑定该目标面时，并不要求
必须有物理图像。

### C14. `roll capture migrate` 显示 “retained”——为什么没启用 best_effort？

迁移是能力感知的，绝不猜测。只有在 v2 网关**和**渲染器**都**就绪时才启用
`best_effort`；否则保留既有策略并给出显式原因：`provider_v2_unavailable`（截图
宿主未 advertise v2）或 `renderer_unavailable`（未安装 Playwright Chromium）。
修好所报能力后重跑即可——迁移是幂等的，`roll capture migrate --revert` 可回退。
