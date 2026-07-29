# Changelog

## Unreleased

### 破坏性变更:定时任务全部退役,交付改由 agent 会话驱动

**你要做什么:** 以前用 `roll loop on` 让它按点自己跑的,现在改成打开一个 agent 会话、
在里面跑 `roll loop go`。想只跑一张卡就 `roll loop go --cards US-123`,想试一个 cycle 就
`--max-cycles 1`。

**能力边界(如实说):** **不开会话,就什么都不会发生。** Roll 不再安装任何定时器,也不在
后台留任何常驻进程。以前"晚上让它自己干"这件事,现在需要你开着一个会话让它连续跑 ——
你启动的运行会活过窗口(detached tmux),按自己的范围结束;但两次运行之间不会有任何推进。

**消失的命令(六个):** `roll loop on`、`roll loop off`、`roll loop now`、
`roll loop fallback`、`roll loop test`,以及 `roll loop off --all`。跑它们会说这个子命令不存在并指向 `roll loop --help`(不会替你猜该用哪条)。
`roll loop pause` / `resume` 保留 —— 它们管的是"停自主推进",跟定时器无关;熔断器也仍会
自动暂停。显式指定卡片的一次性运行在暂停状态下照样能跑,那是你当场的决定。

**失效的配置:** `roll config loop-schedule`(执行频率)和 `roll config loop-window`
(静默时段)现在还能设,但**没有任何东西会读它们** —— 频率和时段由你什么时候开会话决定。
这两个门面会在后续版本里去掉。

**旧机器上的残留:** 跑过旧版本的机器上可能还留着 `com.roll.*` 的 launchd 文件。它们已经
仍加载着的那种还会触发并调用 `roll loop run-once` —— 那条路径会如实说明这是残留 lane 在跑,但这属于你没要求过的活,该清掉。`roll doctor` 会列出每一个并
给出卸载命令;Roll 有意不替你删 —— 那是你机器上的任务。清理步骤见
[roll loop 指南](guide/en/loop.md#leftover-launchd-lanes)。

## v4.728.1 — 2026-07-28

### Delta Team(把一张卡分给设计/建造/评审三个角色跑)
- 新增 `roll delta` 一组命令:`prepare` 领一次委托并原子占位、`status` 看这次委托每个角色走到哪一步(能认出崩溃留下的孤儿并恢复)、`validate` 校验角色之间的交接产物、`conclude` 收口。角色用什么模型由本机预设文件 `~/.roll/delta-team/presets.yaml` 决定(不放进项目配置,免得跟着仓库到处跑):可以钉死某个模型、要求角色之间模型必须不同、设成本上限和排除项;凑不出符合条件的模型就明确拒绝,不会随便找一个顶上。主机引导模式下的花费本机看不到,如实显示 `?` 而不是编一个数字(US-DELTA-001/002/003)[delta]
- `roll delta validate` 现在对每个角色的交接产物做实质校验,而不只是检查文件存在:核对每个产物的 SHA-256 摘要与实际内容一致、产物路径不越出委托证据目录、角色的读写权限正确(只有 Builder 能写工作区)、host-native 角色带完整的 host attestation、Evaluator 的会话/角色实例令牌与 Builder 不相同、以及 Builder/Evaluator 证据文档的必要小节齐全。任一不符即 fail-closed 阻断并记录具体原因(digest 不符/路径越界/越权写/attestation 缺失/身份撞车)。历史 v1/占位 manifest 仍可解析但不能满足新的 Delta run(US-DELTA-004)[delta]
- 新增 `roll-delta-team` 技能:一份不绑定任何 agent 主机的"设计→建造→评审"操作手册,由 `roll delta` 命令驱动,换个主机也照着跑(US-DELTA-005)[delta]
- 完整 Delta 模式下的"设计者"现在是独立选派、只读运行的角色,不再是建造者的别名;角色路由解析不出来就直接停下,绝不静默退回让建造者兼职(US-DELTA-006)[delta]
- 完整 Delta 模式下的"评审者"必须亲手写出自己的验收结论(含看了哪些输入、判断理由)并附自己的产物签名;过去那种由分数字段拼装出来的报告不再算通过,评审者的会话与身份必须与建造者不同,撞车在派生之前就拦下(US-DELTA-007)[delta]
- Delta 的说法和开关收口:README、架构文档、中英指南与 `roll delta` 帮助统一讲清"Delta 团队(主机引导)"与"完整 Delta 团队"的区别、本机预设的边界、以及 host attestation 只是结构校验、不能当作"新会话/新模型真的跑过"的证据。自动循环里默认不启用完整模式,要显式打开,绝不静默转换(US-DELTA-008)[delta]

### 可观测性
- 每张卡现在有一份"轮次账本"(round-journal):每一轮谁(角色/模型)做了多久、结局如何、门禁花了多少时间,自动追加记录到卡夹(`.roll/features/<卡>/round-journal.jsonl` 机器读 + `.md` 人读),不需手工记。`roll cycle journal <卡号>` 一条命令看这张卡的中位数/均值/p90 时长与门禁占比,还能按"时代(era)"分窗对比,给后续提效提供基线与回滚判据(US-CYCLE-004)[cycle]

### 交付一轮更快、更少白跑
- 长跑的子进程不再被误杀:看门狗判断"有没有在干活"改为盯这次运行**自己的**工作目录(worktree)。过去它盯的是主检出,builder 一进独立工作区就永远看着像"卡住了",于是被系统性杀掉。现在有新提交或文件变动就续命,真的停住才终止,并给出明确的终止原因(US-CYCLE-001)[cycle]
- 每一个派出去的子 agent(设计、建造、评审、评分、结对)都套上这个看门狗,并按角色设时长上限(建造 120 分钟、评审/设计 20 分钟,可在 `agents.yaml` 里改);被终止会留下带原因的记录并计入轮次账本,不再有"没人看管跑一小时"的派生(US-CYCLE-002)[cycle]
- 过大的卡在**建卡时**就被拦住:`roll story new` / `validate` 会检查颗粒度——要有验收契约、预期证据不超过 3 条、AC 不超过 6 条、预估不超过 25 分钟、并声明风险档(low/high),不合格就不让进待办;建卡时可直接用 `--est-min` / `--risk-tier` 写入。存量老卡不追溯(US-CYCLE-005)[cycle]
- 一张卡返工超过 2 轮,说明当初拆得太大:现在会照着轮次账本里的事实自动写一份拆分建议放在卡夹旁(内容没变就不重复写),`roll loop cycle split-advice` 能列出所有待处理的建议,把"跑起来才发现拆错了"回流到设计环节(US-CYCLE-006)[cycle]
- 返工那一轮不再让新 agent 重读整个仓库:开工前先生成一份带校验和的简报(评审意见全文、改动统计、涉及文件与行号、设计契约引用);超出篇幅预算就先截断意见,并如实标出截断位置和全文路径。这份简报是**替代**原来的提示词,只会更短不会更长(US-CYCLE-007)[cycle]
- 评审成本按风险分级:卡上写 low 就一个评审者,写 high 才开并行评审小组(最多 3 人,每人独立新会话);新规则下的卡要是没有合法风险档,就在评审这一步直接报错停下,绝不默认按 low 放过。分级只能从经过检查的卡片契约里读,没有开关或环境变量能偷偷降级(US-CYCLE-008)[cycle]
- PR 不再占着关键路径:开完 PR、挂上钉住 sha 的自动合并就直接返回,合没合由 git 事实确认(分支已是主干祖先,或压缩合并的补丁已在主干),不看命令输出的字面话术;确认不了就明确推迟到下一拍重试,而不是错报完成,同一次合并被重复观察也不会把卡翻两次(US-CYCLE-009)[cycle]
- 开 PR 之前强制一次全量验证:`roll test --full` 跑整套并盖上"全量"印章,交付闸只认这种新鲜的全量证据(缺失、过期、只跑了改动部分、代码树不匹配都会被拦);日常微提交仍可只跑受影响的测试。门禁耗时按"全量/改动"分开记账(US-CYCLE-011)[cycle]
- 同一个"角色 × 模型"组合在同一张卡上连败 2 次,会产出一份换模型候选,交给异构 agent 共识裁决(一致同意才通过,有异议就上报);工具绝不自动改 `agents.yaml`,换不换仍是人决定(US-CYCLE-012)[cycle]

### 稳定性
- `roll idea` 取新卡号时会先看远端(origin/main)已有的号，而不再只看本地可能过时的待办清单，避免多台机器同时建卡撞到同一个号(过去 FIX-1272/1273/1473 都撞过)。远端连不上时会退回按本地取号并给出提示；万一选中的号刚被别处占用，会明确报错让你重来，而不是悄悄写入重复号(FIX-1481)[backlog]
- 受监督的单轮 loop 不再改动你本地的共享 `main` 分支：既不会为隔离本地领先提交而重置它，也不会把待办状态更新直接提交到本地 `main`（这两种情况过去都会弄坏主工作区、连累后续派工）。隔离只在各自的周期工作区内进行，待办状态更新则安全地同步到远端，你本地未推送的改动原样保留（FIX-1475）[loop]
- 只读角色的写隔离从"口头约定"变成"真强制,否则拒绝":沙箱型 agent(codex、reasonix)按操作系统级只读运行;非沙箱 agent 被派成只读角色时,在派生边界就明确报错停下,不再表面只读实际能写。reasonix 在没有任何可写目录的情况下也会写出完整只读沙箱配置(过去这种情况会放开写权限)(FIX-1482)[agent]
- 验收报告里的 CI 证据现在绑的是**这张卡自己的** PR —— PR 号、检查跑在哪个 sha 上、逐项结论、合并提交,全部落进报告的「交付时事实」小节;过去这一栏取的是仓库最近一次工作流运行,跟这张卡有没有关系纯属巧合。只有三种诚实状态:必需检查在合并前全绿=已核实、任一失败=红、其余一律未知并写明原因,拿不准绝不放过;事后补的报告会明确标注是事后重建 (US-EVID-033)[attest]
- 修复:名字以 `cycle-` 开头的史诗目录(比如 `cycle-efficiency`)被误当成周期运行目录整个跳过,导致该史诗下所有卡对 `roll attest` 不可见(报 story not found)、永远拿不到验收报告;现在只有卡夹内部的运行目录会被跳过(FIX-1483)[attest]

### 发布
- 发布改为两步，确保「能装到才算发布」：推 `v*` tag 时先建**草稿** GitHub Release(不再一上来就标成正式版);等你手动 `npm publish`(2FA)后,跑 `roll release verify <版本>`(或在 Actions 里手动触发)——它会核对 npm 上确实有这个版本且是 latest,通过了才把草稿提升为正式发布,不通过就明确报错、草稿原样留着,绝不谎报完成。已提升的正式发布不会再被同日合并/删除逻辑动到(FIX-1480)[release]

## v4.721.2 — 2026-07-21

### 稳定性
- loop 的构建子进程失联或被系统杀掉后，现在会在限定时间内察觉、收尾并写入终态（标记为 aborted），不再让整个受监督周期永久挂住；新增子进程存活/超时检测（FIX-1474）[loop]

## v4.721.1 — 2026-07-21

### 稳定性
- loop 看门狗的"进展"判定从 stdout 改为 git 状态（新 commit / 工作区文件变动）：输出缓冲型 agent 写文件时不再被 15 分钟无进展误杀；新增 `no-state-change` 杀因——默认 25 分钟无 commit 且无文件变动即终止（即使 stdout 仍在输出），原地打转的 cycle 不再烧满 45 分钟墙钟；阈值可用 `ROLL_CYCLE_NO_STATE_CHANGE_SEC` 覆盖（FIX-1477）[loop]
- attest 闸的"无 AC 块豁免"提前到渲染之前评估：无 AC 块的卡不再因渲染失败或空壳报告被硬拦，直接合法放行（FIX-1476）[loop]

## v4.720.1 — 2026-07-20

### 稳定性
- `roll worktree cleanup` 现在能认出压缩合并的交付，未交付分支仍会保留（FIX-1471）[loop]
- 暂停后可用 `roll loop go --cards` 只跑指定卡，其他启动方式继续保持暂停（FIX-1472）[loop]

## v4.719.3 — 2026-07-19

### 稳定性
- 修复致命回收漏洞:`.roll/loop/worktrees` 下"磁盘有、但 git 已不再注册"的孤儿目录(多因 `git worktree remove` 撞上 `.next` 之类未跟踪生成物"目录非空"失败,注册删了目录留下)会一直把运行时 canary 顶高、让 loop 永久暂停,而 cleanup 却看不见它、清不掉;现在审计会扫磁盘把孤儿显式计入并展示,能证明其所属 cycle 已交付的孤儿用"有界删除"(严格限定在 `.roll/loop/worktrees` 直接子目录内)自动回收、证不了的一律保留+提示 `--reclaim-orphan <path>` 人工回收;registered/外部/用户 worktree 绝不触碰;删注册 worktree 若残留目录也用同一有界删除补齐,不再产生新孤儿 (FIX-1460 / #1468)

## v4.719.2 — 2026-07-19

### 稳定性
- 修复致命回归:`roll worktree cleanup` 会把"历史 PR 被 squash 合并、但分支 tip 上还有未交付独立提交"的 `loop/cycle-*` 分支当成可删(仅凭已合并 PR 授权),导致丢失独立工作;现在删分支必须有 git 层面证据证明每个提交都已交付(是主干祖先,或 `git cherry` 显示每个提交都有等价补丁),只要有一个 `+` 未交付补丁就整条保留;已合并 PR 本身不再作为删除授权 (FIX-1458)

## v4.719.1 — 2026-07-19

### 稳定性
- 修复交付投影读错 PR 号:当 PR 标题内嵌了 `Closes #issue`,GitHub squash 后的提交主题会带两个 `(#N)`(issue 在前、真正的 PR 号在后),旧逻辑取第一个把 issue 当成 PR,导致发版 truth-live 一致性闸误报"Done 行 PR 号对不上";现按 GitHub 惯例取最后一个 `(#N)` (FIX-1457)
- 渲染态 v2 截图通道接入 CapturePlanner 派发:声明网页界面即经进程内 Playwright 渲染派发出一份带 sha256 摘要的 v2 收据(登录/跳转/非法目标只记 skipped、绝不伪造),归入同一 CaptureSet (US-PHYSICAL-013)
- 文档更新:截图 v2 网关的按来源就绪度、`roll capture refresh`/`status`/`migrate` 用法、渲染态进程内服务与"物理通道诚实标 v1"都写进中英验收证据文档(只写目标态) (US-PHYSICAL-015)
- 新增 `roll capture refresh`:探测本机真实能力后写出诚实的截图主机 capabilities.json(渲染器在→广播 rendered 通道 v2、渲染器缺→明确记 served:false 不谎报;物理通道诚实标 v1);`roll capture status` 因此按来源显示 v2 就绪度,不再笼统谎报 (US-PHYSICAL-012)
- 修复致命回归:自动交付循环在 worktree 里跑 `roll test` 因"改动已提交、--changed 匹配到 0 个测试"被误判成失败,导致每张卡都过不了验收、无法交付;现在 roll 自带的 --affected 闸把 0 改动测试当诚实绿(整套仍由 CI 全量兜底) (FIX-1454)
- 浏览器审计账本(`.roll/browser-operations/events.ndjson`,只追加、随正常授权取证增长)不再被 bootstrap 完整性闸误判为未知污染而卡住后续每张卡;该豁免精确绑定到这一个路径且校验 ndjson 结构,被替换/损坏的账本仍会被拦(不引入 trust-all/ignore-dirty) (FIX-1455)
- `roll worktree cleanup` 现在还能回收"已合并但没有 worktree 的孤立 loop 分支"(其提交已并入主干或有已合并的 GitHub PR),让分支泄漏 canary 真正能降下来;删除前逐个复核(引用未变、确已合并、未被 worktree 占用、非当前/受保护分支),任何不符即拒删,绝不 trust-all 或手动 `git branch -D` (FIX-1456)

- `roll capture` 全线输出现遵循 `ROLL_LANG` 与配置的语言(不再硬编码英文或双行中英混排):`ROLL_LANG=zh roll capture status` 打印中文、`en` 打印英文;约 40 条捕获文案已加入中英目录 (FIX-1453)
- 截图协议广播支持按来源(per-source)声明与协商:只有明确声明 roll.capture.v2 且真正 served 的来源才算 v2 可用,`roll capture status` 不再在物理通道仍是 v1 时谎报整体 v2 就绪;旧广播(无 sources)行为完全不变 (US-PHYSICAL-011)
- 新增渲染态 roll.capture.v2 截图证据的进程内服务:声明的网页界面用 Playwright 无头渲染→写出 PNG + 带 sha256 摘要的 v2 收据(登录/跳转/非法目标只记 skipped、绝不伪造),为 best-effort 多通道截图打底 (US-PHYSICAL-010)

## v4.718.2 — 2026-07-18

### 稳定性
- 浏览器交互填表(fill)现在真正驱动 React 受控表单:填进去的值不再在提交时丢失 (FIX-1449)
- 受管 MCP 进程清理在 Linux 更稳:进程刚退出、内核还没回收的瞬时竞态不再被误判成"杀不掉的泄漏";真正杀不掉的仍会大声报错、绝不放过 (FIX-1450)
- 本地隔离窗口截图与 prepare 点击走 Playwright,能正确触发 React 受控状态;并锁死"没到目标状态就不截图"的保护 (FIX-005, FIX-1451)
- 发布出去的 `roll test` 现在有回归测试盯住:装好的版本面对 Vitest 3 只用 --changed、绝不把不认识的 --affected 传给 Vitest (FIX-1452)

## v4.718.1 — 2026-07-18

### 新功能(截图证据:尽力多通道,坏机器绝不冒充"已核实")
- 物理截屏和渲染截图现在共用一份统一、带来源标注的证据收据;环境变量不再能悄悄关掉截图网关 (US-PHYSICAL-009) `[loop]`
- 声明了网页界面的卡,会尽力同时走多条截图通道(Roll 截屏窗口 + 渲染截图),每次尝试都完整记录在一份证据集里 (US-EVID-030) `[loop]`
- 交付是否通过与截图证据是否健康彻底分开:证据分四种状态(已核实/机器故障降级/目标不对/契约未声明);机器坏了绝不显示为已核实,目标不对直接拦下 (US-EVID-031) `[loop]`
- `roll capture migrate` 只在截图网关和渲染器都就绪时才开启尽力截图,否则保留原策略并讲清原因,绝不瞎猜或强行翻转;`roll capture repair` 能只重跑截图通道修复降级证据、不重开交付;截图能力是否就绪现在能在 `roll doctor`、`roll capture status`、`roll loop status --capture` 里看到 (US-EVID-032) `[loop]`

### 稳定性
- 浏览器跑完后清理 MCP 进程:macOS 拒绝重复结束进程或子进程已提前退出,不再被误判成协议错误;只有进程真的清不掉才报错 (FIX-1275) `[loop]`
- 新增 `roll worktree cleanup --dry-run|--apply`:只按 audit 裁定删可弃的 worktree,绝不因"旧"或被计数就一刀切;每次删前重新审一遍,有任何变化立即拒删 (FIX-1273) `[loop]`
- 每次提交的测试闸兼容普通 Vitest 项目,不再因附加了不认识的参数在跑测试前就退出、卡住绿色交付;跑了零个测试文件绝不算通过 (FIX-1274) `[loop]`
- loop 启动闸逐一核对 .roll 改动:只有内容哈希匹配证据清单才算已核实,其余一律保守拦下,不再有笼统路径就放行的漏洞 (FIX-1272) `[loop]`

## v4.717.2 — 2026-07-17

### 稳定性
- 已有合并记录的交付在旧 PR 查询缺席时不再被误判为未知

## v4.717.1 — 2026-07-17

### 新功能
- `roll agent disable/enable` 一键把不靠谱的 agent 撤出或放回派工池 (US-AGENT-050) `[loop]`
  <!-- evidence: .roll/features/agent-scope/US-AGENT-050/latest/US-AGENT-050-report.html -->
- loop 能进 git submodule 交付：建造、评审、发布全落在子模块自己的分支
- 子模块项目基本零配置：卡该落哪个子模块、走哪条分支都能自动推断
- 纯本地项目不开 PR 也能完成交付，诚实记为已交付

### 自动化流水线
- 只是在标题提了一嘴卡号的文档 PR，不再被误算成那张卡的交付 (FIX-1270) `[loop]`
  <!-- evidence: .roll/features/delivery-reconciler/FIX-1270/latest/FIX-1270-report.html -->
- 交付记账收紧：零提交、跳过验收、验收项没通过的一律拿不到"已交付"
- 中止的 cycle 不再被无关主干历史冒领成交付，对账只认真实开出的 PR
- 还有改动没提交时不许发布，已提交的部分不再掩护可能丢失的尾巴
- 已合并却被卡住的卡可经监督恢复救回一次，漏翻的完成状态也会自动补上

### 可见性
- Kimi builder 干活时你能实时看到它在做什么，不再长时间无声像卡死

### 稳定性
- macOS 锁屏不再白烧 cycle：需物理截图的卡挂起等解锁，等待不算失败 (FIX-1268) `[loop]`
- 浏览器操作结束后 MCP 进程真正清干净，清不掉会大声报错 (FIX-1271) `[loop]`
  <!-- evidence: .roll/features/browser-automation/FIX-1271/latest/FIX-1271-report.html -->
- 主 checkout 看门狗不再误杀 builder：只认开工后新造成的泄漏，死因如实标注
- cycle 善后收紧：被杀干净放手、交接残留不误报、恢复不立即再拦、重试不丢上下文
- 子模块项目的 cycle 不再卡在准备阶段，真实提交也不再被误判零产出

## v4.716.1 — 2026-07-16

### 外部行为验证(新能力:真实 smoke 不会被模拟冒充)
- 验收报告新增醒目的"外部行为验证"横幅与表格:像"真实 `npm i -g github:...`、发布后 CLI 启动、线上 OAuth 回调"这类本地证明不了的 AC,现在必须声明 `external-smoke`(隔离环境跑真实命令)或 `owner-attested`(人工签字带批准引用)。只有真实 smoke 通过或有效 owner 认证才是绿色;`verified-in-simulation`(仅 `npm pack` 之类模拟)和 `UNVERIFIED — external smoke not run` 一律非绿,只要有一个外部 AC 不达标横幅就转红——交付不能夸大自己的外部行为 (US-ATTEST-017) `[core+cli]`
  <!-- evidence: packages/core/test/fixtures/outward-verification/report.html -->
- 外部 smoke 在隔离的临时 `HOME`/`PREFIX`/工作目录里运行,只执行 spec 里显式声明的命令模板;产物记录 exit code、版本和脱敏摘要,凭据从不落盘。任何真实发布或账号操作永不自动执行,没有声明的授权就不会跑;用 `ROLL_SMOKE_ENV=release`(或 `ci`/`nightly`)指向对应环境,环境不匹配报 `unverified` 而非静默跳过 (US-ATTEST-015/016/017) `[docs]`

### 调度器故障自愈(新能力:launchd 挂了 loop 不再瘫痪)
- macOS launchd 调度器起不来时,loop 现在有一条 owner 确认的进程级后备通道:`roll loop on` 检测到 launchd bootstrap 失败会如实报告,并给出启动 fallback 的明确指引;fallback 用租约+心跳保证同一时刻只有一个 runner 在跑,启动/停止/异常退出五种路径都会干净收尾,不留孤儿进程 (US-LOOP-107) `[loop]`
- `roll loop status/on/off` 现在直接呈现 launchd 的失败状态并控制 fallback 调度器的开关——不需要 owner 自己去翻 launchctl (US-LOOP-108) `[cli]`
- launchd 故障→fallback 接管→launchd 恢复的完整恢复路径已实测验证并写入文档,含用 `launchctl list` 找到当前活跃 loop label 的排查姿势 (US-LOOP-109) `[docs]`
  <!-- evidence: .roll/features/loop-engine/US-LOOP-109/latest/US-LOOP-109-report.html -->

### 浏览器操作(新能力:托管 Chrome DevTools)
- Roll 现在能自己开一个隔离的 Chrome 去访问页面、做检查、收集诊断——用的是临时浏览器档案,碰不到你本人的登录态和 cookie,跑完即删。支持导航、DOM 断言、控制台/网络摘要和诊断截图,失败(超时/崩溃)会如实报告,绝不冒充测试通过 (US-BROW-001/002/004) `[cli]`
- `roll browser setup --dry-run` 先看会装什么、`--confirm` 才真写配置;`roll browser doctor` 分三条通道(托管/交互/截图)报告就绪度,缺什么、怎么补,一目了然 (US-BROW-003) `[cli]`
- 需要在你已登录的 Chrome 上做一次验证?`roll browser interactive` 走全新的"租约"流程:必须你本人在终端逐次批准(显示要访问哪个站、做什么、多久过期),一次 15 分钟、仅限本机连接,后台任务借不走;到期/取消/进程挂掉都只断开调试连接、绝不关你的浏览器,也读不走 cookie 和密码 (US-BROW-008) `[cli]`
- 浏览器操作全程记账:并发加锁、租约心跳、诊断信息自动脱敏,谁在什么时候对哪个站做了什么都有据可查 (US-BROW-005) `[loop]`
- 浏览器产出的证据分类明确:DevTools 截图只算诊断参考,正式视觉验收仍然只认 Roll Capture 的物理截图,两者不会混淆 (US-BROW-006) `[loop]`
- `roll supervisor next`、`roll doctor --tools` 和故事档案页现在显示浏览器三通道的就绪状态(含租约剩余时间和不可用原因);档案页新增浏览器操作时间线。查不到的事实诚实显示 unknown,绝不把"没记录"当"通过" (US-BROW-009/013) `[cli]`
- 性能诊断和设备仿真作为可选档位加入托管通道:`roll browser run --perf-profile` 收集页面性能摘要,`--profile "Pixel 7"` 等按设备档仿真,均为诊断用途 (US-BROW-012/014) `[cli]`
- 更新浏览器操作文档，正式发布交互式 owner-Chrome 通道：需预先开启本地 loopback 远程调试、前台 TTY 单次 owner 批准、15 分钟租约到期/取消、owner-run manual-attest；并明确说明不支持后台调度器、远程端点、cookie 导出和自动启动 Chrome (US-BROW-011) `[docs]`
- `roll browser update --check` 报告当前 DevTools 传输包版本与可用候选版本（只读，不下载、不安装、不改配置）；`roll browser update --apply --confirm` 经显式确认后执行原子更新，更新前运行冒烟检查，失败则保留原版本 (US-BROW-010) `[cli]`
- 托管与可选浏览器能力的使用文档齐备(setup/doctor/run/性能/设备仿真) (US-BROW-007/015) `[docs]`
- 托管通道现在为每次运行启动一个固定版本的 `chrome-devtools-mcp` stdio 会话:完成 MCP initialize/tools-list、校验最小工具清单后才允许执行浏览器动作,任何初始化失败/清单不匹配/进程崩溃都会 fail-loud;生产默认依赖已切到 MCP,原始 WebSocket/CDP 传输不再出现在 CLI/运行时 wiring 中 (US-BROW-016) `[core+infra]`
- 浏览器动作是一个封闭词表(导航/快照/控制台/网络/截图/点击/填表/按键),每个动作只能映射到清单里批准的那一个 MCP 工具——调用方没有任何办法自己点名工具或下发任意浏览器指令,词表之外一律拒绝并如实报因 (US-BROW-017) `[core]`
- `roll browser run` 的托管诊断现在真正走上面这条带政策闸的 MCP 通道跑(不再是绕开闸的直连):`--story`/`--url` 必填并记入 ledger 备审计,策略禁用则运行前即拒绝,`--fixture` 降级为明确标注仅测试的假目标接缝 (US-BROW-018) `[core+cli]`
- 新增 `roll browser doctor --probe`:起一个真实的 chrome-devtools-mcp 进程做活体探测(initialize + tools/list + 清单校验),用临时档案、跑完即清,只有探测通过才把受管通道标为 ready;`roll browser update --apply` 也加了同样的探测闸,探测失败中止更新保留原版本。这个真探针立刻抓出两个假测试掩盖的 bug——通信分帧用错了方言(真服务器是一行一条 JSON,不是 Content-Length 头),以及清单里要求了一个真服务器根本没有的工具;两处都已修正,探针现在对真服务器全绿 (US-BROW-019) `[cli+infra]`
  <!-- evidence: .roll/features/browser-automation/US-BROW-019/latest/US-BROW-019-report.html -->
- 新增真实浏览器回归闸:`pnpm test:browser-live`(设 `ROLL_BROWSER_LIVE=1` 启用)起一个本地 HTTP 目标 + 真 chrome-devtools-mcp + 真临时 Chrome,把导航/快照/控制台/网络/截图/重定向拒绝/超时清理等 12 个场景全跑一遍,只有真进程真验证才算 verified——fixture 报告永远不能通过这道闸,环境不具备时大声报 unavailable 而不是静默跳过;CI 配了专门的 Chrome-capable lane 每晚跑 (US-BROW-020) `[cli+infra]`
  <!-- evidence: .roll/features/browser-automation/US-BROW-020/latest/US-BROW-020-report.html -->
- 这道闸首跑就抓出四个假测试互相掩护的真 bug 并全部修复:policy 文件的 managed 通道配置从来没被真正读进去(缩进/snake_case/数组全解析错,写了 enabled: true 也永远 lane_disabled)、真服务器的截图字节被丢弃、真服务器的散文体回复(不是 JSON)不被理解、快照/点击的参数名不符 (US-BROW-020) `[cli+infra]`
- 浏览器操作文档与命令帮助全面对齐真实 MCP 通道:说清固定版本 sidecar 的生命周期、静态检查与 `doctor --probe` 活体探测的区别、policy 开闸姿势、live gate 前置条件与全部失败排查路径;删除一切把 fixture 当真实运行的表述,附真实运行与被拒两份逐字 transcript(2026-07-16 实录),并加锁测试防止文档再漂移 (US-BROW-021) `[docs]`
- 交互通道(owner Chrome)的租约与操作现在真的写进台账:谁批准的租约、到期/取消、执行了什么动作都有记录,`roll browser doctor` 和档案页里的 interactive 一栏不再永远显示 unknown (US-BROW-022) `[loop]`
- 截图证据的"物理 vs 诊断"裁决现在真正生效:Roll Capture 的物理截图经 CaptureBridge 落盘并进验收链路,DevTools 截图只算诊断参考——想拿 DevTools 截图冒充视觉验收会被分类器拦下 (US-BROW-023) `[loop]`
### 稳定性
- 无验收清单的卡不再被误拦导致无法 publish；缺少验收证据时循环会把工作明确挂起待人复评，不再静默丢弃 (FIX-1256) `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-1256/latest/FIX-1256-report.html -->
- cursor 不再被派去 builder 任务，避免工作泄漏到共享主 checkout 导致 cycle 被隔离 (FIX-1257) `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-1257/spec.md -->
- Supervisor 手动合并闸（`repair-evidence` / manual-merge diagnostics）现在与 reconcile 路径一样，同时识别 GitHub CheckRun 的 `conclusion` 和 StatusContext 的 `state`（如 Vercel）。以前只看 `conclusion`，带 StatusContext 的全绿 PR 会被判成 CI unknown，手动合并闸卡死；现在两类检查共用 `reduceStatusCheckRollup`，全绿可合并、含红可拒绝 (FIX-1252) `[loop]`
- `roll story new --help` 不再把用户导向已退役的裸 `roll index` 命令，也不再声称会刷新不存在的 dossier；帮助文案与真实命令面对齐（仅刷新 `.roll/index.json` 缓存，且 `--no-index` 只是延后该缓存），并新增回归断言锁住这个一致态 (FIX-1251) `[cli]`
  <!-- evidence: .roll/features/cli-simplification/FIX-1251/latest/FIX-1251-report.html -->
- 验收/评审报告不再把终端文本输出硬塞进 `<img>` 渲染成破图:真图片照旧显示图片,文本产物内联成可读文本块,按实际产物类型渲染 (FIX-1250) `[loop]`
- 连续跑多张卡的 `roll loop go` 不再"跑完一张就无故暂停":旧事件里秒/毫秒混用的时间戳会让历史暂停信号被误认成刚发生的,现已统一换算后再比较——这是 6 月下旬以来多卡连跑瘫痪的总根因 (FIX-1255) `[loop]`
- `roll loop go` 的启动横幅现在显示真正生效的范围(而不是本次命令行解析的范围);沿用上个 goal 的范围时会明确标注来源,新增 `--all` 一键回到全量 (FIX-1253) `[cli]`
- 上一个 goal 完成后再次 `roll loop go` 不再报"goal is already complete"死锁:完成的 goal 自动归档到 `goal-archive/`,新 goal 直接开跑,有事件可追溯 (FIX-1254) `[loop]`
- 合并对账不再被 force-push 淘汰的旧提交的失败 CI 记录误导:只看 PR 当前提交的检查结果,绿就是绿,修复后重推的 PR 能正常自动合并 (FIX-1258) `[loop]`
- `roll browser doctor` interactive 通道不再把 9222 端口任意进程当 Chrome ready，现在会经 /json/version 验真 (FIX-1264) `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-1264/latest/FIX-1264-report.html -->
- `roll north` 自主运行时长现在按 14 天窗口累计合格每日时长，不再把最近一段未中断时长误当成总值 (FIX-1265) `[loop]`
  <!-- evidence: .roll/features/loop-observability/FIX-1265/latest/FIX-1265-report.html -->
- 账本和 `roll loop cycles` 里 reasonix 跑的活不再显示错的 model:usage 数据缺 model 字段时回填本 cycle 实际派出的那个,不再被解析器硬编码的旧默认值覆盖;历史错账已一并修正 (FIX-1259) `[loop]`
- "CI 绿 + 独立 evaluator 认可"的挂起 PR 现在自动补验收件→转正→合并,不再等人手工跑三条命令;证据存疑的仍留在挂起通道并发告警,绝不静默转正 (FIX-1260) `[loop]`
- cycle 失败不再一律坍缩成看不懂的 `unknown_failure`:验收命令被白名单拒绝、约定界面没被截到、验收证据无法合并三类失败现在给出确定性归因和修复指引;熔断器也不再把已修好的卡的历史失败信号反复算进当前窗口——守夜期间一夜误停 5+ 次的总根因 (FIX-1261) `[loop]`
- 五处"配置该管的事源码写死"清扫:评审报告不再回填假 model、evaluator 名单不再伪造 reasonix 身份、dashboard 不再硬编码 owner 的机器路径、死配置旋钮移除、supervisor 身份改为配置驱动 (FIX-1262) `[loop]`
- 浏览器真相采集器现在吃统一注入的时钟(消除 collectedAt 竞态),physical_terminal 声明写错类型会大声报错而不是被静默当成"没有" (FIX-1263) `[loop]`
- 提交主题里光写一个卡号不再算交付证据:判定一张卡"已交付"必须有 PR、CI run 或账本记录的实锤关联,防止误把提法当交付 (FIX-1266) `[loop]`
- builder 硬轮换上线:任意连续两个 cycle 不会派同一个 builder(评估 harness 对不同 agent 的归一化能力);轮换把候选池排空时会大声报错而不是静默复用,可用 `loop_safety.builder_no_consecutive_repeat` 配置开关 (FIX-1267) `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-1267/latest/FIX-1267-report.html -->

## v4.714.2 — 2026-07-14

### 稳定性
- agent 用哪个 model 现在完全由配置决定(`.roll/agents.yaml` 的 `rigs:`/`routing:`),源码不再写死运行时默认。以前缺配置会**静默**落到源码里写死的值(reasonix 一直跑 flash),配置丢了都发现不了;现在缺配置会**明确报错并引导**(需要显式 model 的 agent),配好的 model 一路带到 spawn。改某个 agent 的 model = 编辑一行配置,不用动源码、不用重新发版 (FIX-1249) `[loop]`

## v4.714.1 — 2026-07-14

### 稳定性
- roll 给用户项目自动合并 PR 时,现在同时认 GitHub 的两种检查状态——Actions 运行**和** commit status / 外部 check-run(取二者并集)。以前只看 Actions,导致用别的 CI 上报状态的项目里"其实全绿"的 PR 被误判成"状态未知"而一直卡着不自动合并、账也对不上;现在全绿(不论来自哪种)照常自动合,状态未知/进行中的按"等待"处理而非误判失败 (FIX-1248) `[loop]`

## v4.713.2 — 2026-07-13

### 自动化流水线
- 交付对账收敛成一套判据:`roll loop cycles` 的读账和 `roll loop reconcile` 的合并现在共用同一个引擎,不再两套口径打架把同一个 cycle 一会儿算已交付、一会儿算没交付 (US-DELIV-008) `[loop]`
- 一条 `roll loop go` 就能从选卡一路走到开 PR、CI 绿后自动合并、标记交付——在周期边界自动做一次对账,不用再单独跑一条命令收尾,也没有后台守护进程 (US-DELIV-009) `[loop]`
- 对账可以放心反复跑、多来源(人工/定时/CI/周期边界)同时跑也不会重复合并或重复记账 (US-DELIV-011) `[loop]`
- `roll loop cycles` 和面板现在能看到 awaiting_merge / 外部合并这些新交付态,还带上 external-merge 率、等待合并的滞留时长等交付指标 (US-DELIV-012) `[loop]`
- 对账器认得"卡住的 PR":CI 长红(滞留超 24 小时)、合并冲突、draft、缺权限的 PR 会被明确标成"降级"并带上原因和滞留时长,被关未合的 PR 标成"终结",`roll loop reconcile --json` 里都能读出来——卡死的 PR 再也不会被错记成已交付,也不会对 draft/冲突/状态未知的 PR 盲目发起合并 (US-DELIV-010) `[loop]`
- 发布后的交付状态不再误报守护进程故障 (US-DELIV-013) `[loop]`

### 稳定性
- `roll loop on` 重跑时不再被 launchd 旧状态卡死 (FIX-1246) `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-1246/latest/FIX-1246-report.html -->
- 修好"builder 超时被杀后、已提交的真实工作被误判零产出"的系统性误杀:看门狗超时拆除现在会先数一遍 worktree 里真实的 tcr 提交再写终态账,且"没数过"不再等同于"零"——数不出来时保守保留成果、可恢复可救回,不再自动换 agent 把已完成的工作孤儿化 (FIX-1244) `[loop-engine]`
- 修掉两个偶发假红的测试(重载 CI 上看门狗用例超时、临时目录清理竞态),发版和自动合并不再被假红卡住 (FIX-1243) `[loop-engine]`
- `roll loop cycles` 不再对着分支已删的老 cycle 刷一屏 `fatal: Needed a single revision`——纯显示噪音,现已静默(判据不变) (FIX-1245) `[loop]`
- roll 给用户项目发版时,版本号按项目自己的版本世系走(首发从 0.1.0 起),不再错用 roll 自己的构建号;roll 自身发版方案不变 (FIX-1247) `[release]`

## v4.713.1 — 2026-07-13

### 自动化流水线
- 交付"最后一公里"重做成一个对账闭环:cycle 开完 PR 就进"等待合并"挂起态、立刻释放去做下一张卡,不再干等合并;合并与记账由交付对账器在任意 `roll` 调用时完成,**退役了那个在无人值守/headless 环境常起不来的独立 PR 守护进程**(US-DELIV-001、US-DELIV-006) `[loop]`
- 交付真相从 main 反查:用 PR 状态 + git patch-id 认出"已交付"——**不管是循环自己合的、还是人手动合的都算数**,`roll loop cycles` 账本不再和实际交付对不上;附只读命令 `roll loop reconcile`(US-DELIV-002) `[loop]`
- 缺验收证据的交付在 push 前就被拦下并告警,不再留下没有 PR 的裸分支 (US-DELIV-004) `[loop]`
- 对账时发现 PR 的 CI 已绿,自动执行 `gh pr merge --squash`,不用等仓库开 auto-merge 也不用依赖 launchd 守护进程 (US-DELIV-003) `[loop]`
- 同一张卡同时只允许一个交付在途(租约),避免多个 agent 重复做同一张卡、白白烧钱 (US-DELIV-005) `[loop]`
- 文档同步:架构说明更新为"最后一公里=一个对账闭环、无独立守护",三仓一致 (US-DELIV-007) `[loop]`

## v4.712.1 — 2026-07-12

### 交付方法
- 攻防结对引擎收尾:verified/designed 档的卡遇到任何攻防异常(凑不齐异构搭档、agent 不可用、某回合卡死)都会自动降级回单个 builder 把卡做完,并留下明确的降级记录——不再有卡死,也不会悄悄退化成一份空验收(US-LOOP-106) `[loop-engine]`
- roll-build 交付契约与文档更新到位:攻防结对从"契约里写着"变成"引擎真的在编排",roll-build 契约、架构文档、技能库三处同步一致(US-LOOP-105) `[loop-engine]`

### 可观测
- 新增只读命令 `roll loop adversarial`:把攻防卡的抓洞数、平均回合数、降级率、耗时按"攻防 vs 标准"两组汇总,用数据回答"攻防结对到底有没有多抓 bug、要不要扩大适用范围"(US-LOOP-104) `[loop-engine]`

## v4.710.3 — 2026-07-10

### 交付方法
- 攻防结对(写测试和写实现由不同 agent 分工、绿后再轮流互相攻破)现在真正接进了循环引擎:verified/designed 档的卡按"另一个 agent 写红测试 → 实现者写代码变绿 → 攻击者轮流补破坏性测试直到攻不动"的顺序编排,回合数、攻破出的漏洞、终止原因(攻不动/回合上限/超时)都留下事件记录。这套能力由几块地基拼成——确定性的终止算法(绝不挂死)、把测试作者/实现者/攻击者区分开的角色化启动、以及"任何攻防异常一律降级回单 builder、绝不死锁"的判定;standard 档完全不受影响(US-LOOP-100、US-LOOP-101、US-LOOP-102、US-LOOP-103) `[loop-engine]`

## v4.710.2 — 2026-07-10

### 稳定性
- 修好 roll-capture 在无界面环境(CI、无人值守 loop、非图形终端)下明明已安装却被误报"未安装"的问题——安装检测本是纯文件检查、不依赖图形界面,之前被连同权限探测一起跳过了(FIX-1241) `[loop-engine]`

## v4.710.1 — 2026-07-10

### 稳定性
- 验收契约在 cycle 开始就冻结下来:交付时按这份冻结的标准判定,谁在中途改动验收标准或私自加上"免截图",都会被检测出来并告警——不再能悄悄放宽自己的验收门槛(US-EVID-020、US-EVID-021) `[acceptance-evidence]`
- 有验收标准却没声明任何取证方式的卡,在建卡阶段就被挡进待办队列并提醒补上(软拦,绝不卡住整个循环),不用等它跑完才发现交不出证据(US-EVID-022) `[acceptance-evidence]`
- 截图/命令输出/物理截屏这类"抓取来的证据"改由框架自己绑定,builder 不再手填路径;抓取失败会明确报出来,不再悄悄变成一份空验收(US-EVID-023) `[acceptance-evidence]`
- 验收清单指向的证据文件在磁盘上找不到时,现在也会自动补跑一次去补齐,补住"清单在、证据文件不在"这类反复交不出的死角(US-EVID-024) `[acceptance-evidence]`
- 收紧免截图豁免:豁免是建卡时定死的,builder 中途加的不算数;而且"免截图 ≠ 免证据"——没写明替代证据(命令输出或指名测试)的豁免,建卡校验会直接挡下(US-EVID-025) `[acceptance-evidence]`
- 彻底修好循环把工作分支泄漏到共享目录的老问题:每个 cycle 用独立的分离工作区、失败时兜底打包保留、无主的残留分支自动回收(US-LOOP-094、US-LOOP-095、US-LOOP-096、US-LOOP-097) `[loop-engine]`
- 给分支治理加了一条端到端验证:跑完整一轮后主仓不会残留循环分支、远程分支合并后立即清除,不再只靠推理(US-LOOP-098) `[loop-engine]`

### 可观测
- 新增"免截图豁免率"味道信号,以及对存量豁免的只读审计,便于看清验收豁免有没有被滥用(US-EVID-026、US-EVID-027) `[acceptance-evidence]`

### 交付方法
- roll-build 交付契约固化三条"边造边验"的做法:写测试和写实现由不同 agent 分开做、还带一轮互相攻破;代码评审交给独立的另一个 agent 出结构化结论;每条验收标准一变绿就地采证(US-SKILL-031、US-SKILL-032、US-SKILL-033) `[skill-ecosystem]`

## v4.708.2 — 2026-07-08

### 新功能
- `roll worktree audit` — 先盘清哪些 worktree 可回收、哪些要保留(US-LOOP-093) `[loop-engine]`
  <!-- evidence: .roll/features/loop-engine/US-LOOP-093/latest/US-LOOP-093-report.html -->

## v4.708.1 — 2026-07-08

### 稳定性
- 用户项目自主发布不再卡在空验收报告或复检超时,会按真实证据继续推进(FIX-1233、FIX-1234) `[loop-engine]`
- codex 恢复参与派工,隔离不再剥掉登录凭据(FIX-1235) `[loop-engine]`
  <!-- evidence: .roll/features/loop-engine/FIX-1235/latest/FIX-1235-report.html -->
- loop 发现 agent 写回主仓会立即硬停并隔离现场,不再暂停后继续污染主仓(FIX-1236) `[loop-engine]`
  <!-- evidence: .roll/features/loop-engine/FIX-1236/latest/FIX-1236-report.html -->
- `loop now --cards` 不再启动旧版全局 runner,本地安全修复不会被绕过(FIX-1239) `[loop-engine]`
- 交付对账不再丢 PR 信息,已合并卡不会反复制造未提交变更(FIX-1240) `[loop-engine]`

## v4.707.1 — 2026-07-07

### 稳定性
- `roll design` 不再因为运行记录目录缺失而直接退出,会自动建好目录再继续(FIX-1221) `[loop-engine]`
- 带验收标准的卡不再卡在空报告熔断里,确认环节会留下可审计记录并诚实降档通过(FIX-1230) `[loop-engine]`
- codex 评审不再改写宿主仓 git 状态,外部 agent 的 git 副作用已被隔离(FIX-1231) `[loop-engine]`
- 发布差一步没落地就不动了不再堵着路,卡在施工中的建成卡现在自动回到待办池,下一轮重新派活不再死等人工救(FIX-1232) `[loop-engine]`
- Done 行上人工写的合并凭据不再被自动抹掉,发版检查也能正常通过(FIX-1221) `[loop-engine]`

## v4.706.1 — 2026-07-06

### 稳定性(48 小时长跑冲刺:9 个真实故障全部根治)
- 修掉一类让循环静默停摆数小时的身份错认:建造残留会让后续周期认错自己在哪,现在开工前自动检查并纠正,漂移时大声报警而不是带病硬跑(FIX-1209)`[loop-engine]`
- 一轮周期产生的坏配置收工时立刻清掉、写入当场被拦,不再留下"机器带病运转"的时间窗(FIX-1210)`[loop-engine]`
- owner 把卡标成"进行中"抢占后循环真的会让路,不再人机同做一张卡产出两份重复实现;死掉周期留下的卡仍会被正常回收(FIX-1211)`[loop-engine]`
- 一次发布失败留下的内部标记不再永久挡路,待办卡不会因此被晾几个小时没人领;实战复发的残余路径也已堵上(FIX-1212、FIX-1215)`[loop-engine]`
- agent 供应商抽风、一个字没输出就超时的情况不再算到卡头上把无辜卡打入冷宫,失败统计不再被污染(FIX-1213)`[loop-engine]`
- GitHub 偶尔抽风时建 PR 会自动重试,不再一击不中就把整轮成功建造全部作废(FIX-1214)`[loop-engine]`
- 长寿 PR 分支掉进 CI 事件黑洞（push/sync 事件 GitHub 不投递、零 check-run、合并永远被保护规则卡死）时，pr-loop 自动检测并通过 workflow_dispatch 定向拉起 CI，同时以 ALERT 记录静默场景（FIX-1217）`[loop-engine]`
- `roll release --yes` 不再在 bump/changelog 提交步被自己的 60 秒测试新鲜度闸拦下：提交前自动重写 `.roll/last-test-pass` 证明并校验树匹配，一键发版全程无需人工垫步；测试后改文件的恶意场景仍会被拒绝（FIX-1207）`[release-management]`

- 发版自动生成的记录性提交(changelog、建卡)不再被当成卡的正式交付,已完成卡的状态不会发版后莫名漂移,卡也不会没做就被标完成(FIX-1206、FIX-1208)`[release-management]`
- 主仓被弄脏拦下发布时会列出到底哪些文件脏(含暂存区的),不再"说脏又不说哪脏"(FIX-1218)`[loop-engine]`

### 验收与观测
- 发版前的验收检查能认出现行格式的验收标准清单,不再因"看不见清单"全部豁免放行——验收闸从装饰变回真闸,豁免会留痕(FIX-1216)`[loop-engine]`
- 协调交付时的判断、验证结论和救场动作会记成日志,终端里能回看,不再只活在聊天窗口(US-OBS-048)`[loop-observability]`

### 物理截图与隐私
- 截图证据默认只拍被测应用的窗口(测终端拍终端、测网页拍浏览器),不再默认全屏,屏幕上的聊天邮件等隐私不会夹带进证据;全屏须显式声明,找不到窗口的回落会留明确记录(US-PHYSICAL-006)`[capture-tool]`
- 物理截图拍完先过隐私闸：`roll attest` 在把 PNG 收进证据前校验像素尺寸与声明目标一致——窗口目标误拍成全屏、或未声明的全屏拍摄会被拒绝并记录原因，避免误把敏感桌面内容落库；通过校验的证据附带拍摄目标、请求来源、拍摄时间、是否声明全屏等元数据（US-PHYSICAL-007）`[capture-tool]`
- 截图证据不再误提交到公开仓库：入库前自动校验 remote 可见性，public/不可判定仓一律拒绝并告警，私有仓正常放行；owner 可显式豁免（US-PHYSICAL-008）`[capture-tool]`

### 护栏
- 赦免名单（`loop pardon-skip-list`）收编进 `roll doctor pardon` 诊断子命令，旧命令保留为过渡别名（REFACTOR-073）`[loop-engine]`

### 内部工程(护栏审计签字批次落地)
- 依据护栏大盘点的裁定,十一项整并一次落地:删净退役死代码、重复实现合一(git 环境处理、评审派发、验收清单自愈)、失败归因全系统统一词表与单一判定(外部故障分类、纠错归因、重复失败熔断、失败类别与根因键铺满全部终态记录、终态词表 17 收敛 15)、全局安装陈旧度进 roll doctor 读数、视觉证据校验前移为建卡软提醒(REFACTOR-062、REFACTOR-063、REFACTOR-065、REFACTOR-066、REFACTOR-067、REFACTOR-068、REFACTOR-069、REFACTOR-070、REFACTOR-071、REFACTOR-072、REFACTOR-076)`[loop-engine]`


## v4.704.2 — 2026-07-04

### 易用性
- 安装 roll 时顺手装好 Roll Capture:`npm i -g` 的 postinstall 会自动从 GitHub Release 下载 Roll Capture.app 装到 ~/Applications(macOS;CI/无网/sudo 场景优雅跳过,失败给手动指引绝不让安装失败);`roll setup` 可随时修复重装(US-PHYSICAL-005)`[capture-tool]`

## v4.704.1 — 2026-07-04

### 稳定性（今晚 roll-capture 实战暴露的三个自愈缺口）
- 构建过程中产生的文件不再留在工作区等人：验收证据随交付进 PR 分支、审计流水自动入库、agent 会话目录自动忽略，bootstrap 检查只拦真正来路不明的文件（FIX-1203）`[loop-engine]`
- PR 卡在"缺证据"时 pr-loop 会自己修：找到/生成本地证据、附进 PR 分支、重新校验后合并，修不了才发一条告警，不再每五分钟留字条等人（FIX-1204）`[loop-engine]`
- 选卡不再重做已经在等合并的卡：能从 PR 正文的证据锚点认出自家在途 PR，等合并的卡会显示"awaiting merge of PR #N"并跳过（FIX-1205）`[loop-engine]`

## v4.703.2 — 2026-07-03

### 稳定性（backlog 清仓批次 · 2026-07-03）
- 每个工作周期结束后会自动清理这一轮留下的构建缓存、临时文件和环境残留，下一轮从干净环境起跑，"本机绿 CI 红"这类脏环境问题少一大类（US-LOOP-088）`[loop-engine]`
- 新增八项故障注入演练：主仓被污染、验收报告损坏、证据悬空、认证挂掉、元仓脏、并发抢卡、冤枉卡平反、builder 挂死——每项都有可重复夹具证明系统按新契约自愈或明确暂停（US-QA-016 矩阵部分）`[qa-testing]`

### 智能
- 自动选卡前，默认 agent 会先对候选卡做一次语义排序（哪张更解堵、更紧急），排序只是建议——Hold/依赖/毒丸这些铁律照旧；评估结果带缓存，backlog 没变就不花钱（IDEA-069）`[loop-engine]`

### 物理截图（roll ↔ Roll Capture.app 全链路打通）
- `physical.screenshot` 正式成为 Roll 管理的工具：协议契约与 Roll Capture.app 的实现逐字段对齐（US-PHYSICAL-001, US-PHYSICAL-002）`[capture-tool]`
- `roll doctor --tools` 和 `roll setup` 能检测 Roll Capture.app 装没装、有没有录屏权限、收件箱可不可写，并诚实说明权限测的是当前终端宿主（US-PHYSICAL-003）`[capture-tool]`
- 需要物理截图证据的卡，`roll attest` 会自动请 Roll Capture.app 拍图、把 PNG 收进证据目录并在报告里展示完整拍摄状态链（US-PHYSICAL-004）`[capture-tool]`

### 内部工程
- 五千多行的循环执行器巨石文件拆成二十多个职责模块（行为零变化，有行数防回归测试守着），后续修 bug 不再牵一发动全身（REFACTOR-060）`[loop-engine]`

## v4.703.1 — 2026-07-03

### 稳定性（北极星冲刺 · 2026-07-03 第一性诊断产物）
- Builder 干活期间再也碰不了共享主仓：写入会被系统直接拒绝；万一主仓已经脏了，脏东西会被自动收进 `rescue/leaked-*` 隔离分支（附一条还原命令），loop 接着干活，不再连环熔断趴窝（US-LOOP-089）`[loop-engine]`
- 失败记账分清了"环境的锅"和"卡片的锅"：环境故障（认证挂了、主仓脏了、网断了）不再算到无辜卡头上把它们打入冷宫；新命令 `roll loop pardon-skip-list` 可以平反之前被冤枉的卡（US-LOOP-090）`[loop-engine]`
- 交付证据和代码从此绑在一起走：验收报告坏了就不发布，证据文件缺了就不合并，Done 只能由"真合并+证据齐全"翻牌；`roll attest audit` 一键体检所有已完成卡的证据链（US-EVID-019）`[acceptance-evidence]`

### 可见性
- 新命令 `roll north`：北极星面板一眼看到 loop 稳不稳——自主运行了多久、交付率多少、每张产品卡背了几张修复卡、有没有记错账，每项带 14 天趋势图和达标灯；`roll status` 顶部也加了一行速览（US-OBS-046, US-OBS-047）`[loop-observability]`
- loop 日报不再自相矛盾：修掉了"0 个周期却列出 10 条上月交付"的错报，数据对不上时日报会明确标注"数据降级"而不是装正常（FIX-1202）`[loop-observability]`
- `roll design` 的实时进展现在只显示这次运行的真实动作，不再把技能说明、其它示例项目的模板、重复的 diff 和底层命令刷屏；完整原始输出仍然保存在 transcript 里（FIX-1076）`[cli-visual]`

### 易用性
- `roll init` 在识别到产品需求文档且 backlog 为空时，会直接问你「现在就开始设计吗？」，答 y 就接着跑 `roll design`，不用再手动复制那条命令；加 `--yes` 或 `--then design` 可在自动化里一步到位（US-INIT-010）`[init-onboard]`

## v4.702.4 — 2026-07-02

### 可见性
- `roll design` 默认输出现在会实时显示有界进展、逐张建卡事件和静默心跳，同时继续把完整原始输出写入 transcript；`--verbose` 与 `--raw` 也改为运行中实时输出，不再等 agent 退出后回放（FIX-1071）`[legacy-onboard]`

## v4.702.3 — 2026-07-02

### 稳定性
- `roll init` 现在会负责提交并推送自己生成的项目约定文件，`roll loop go` 不再一开工就撞 dirty（FIX-1072）`[loop-engine]`
- Builder 提交会被钉在 cycle worktree，不再把提交漏到主 checkout（FIX-1073）`[loop-engine]`
- 状态面板给出的 AI client 修复命令现在可以直接执行，不再多带无效参数（FIX-1070）`[cli]`

### 可见性
- `roll loop watch` 不再把旧 cycle 的卡片和 agent 贴到新的空转或重试状态上（FIX-1074）`[loop-observability]`

## v4.702.2 — 2026-07-02

### Breaking changes
- Role taxonomy is now cut over to Supervisor / Designer / Builder / Evaluator. Designed cycles use `execution_profiles.designed`, `roles.designer`, and `role-artifacts/designer/design-contract.md`; retired keys now fail loudly instead of aliasing. See `docs/migration/role-taxonomy-v4.md` for the manual config update. (REFACTOR-ROLE-001..008)

### Automation pipeline
- Default project agent routing now uses open execute/evaluate pools with capability and health-aware ranking. Fresh sessions are the review isolation boundary; agent/model diversity is a preference or explicit strict mode, not a default hard exclusion. (REFACTOR-ROLE-008, US-AGENT-049)

### Acceptance evidence
- `roll design` now writes a Design Review Page so you can inspect the plan, flow, and prototype before build starts. (US-REVIEW-001, US-REVIEW-002)
  <!-- evidence: .roll/features/review-pages/US-REVIEW-001/latest/US-REVIEW-001-report.html -->
  <!-- evidence: .roll/features/review-pages/US-REVIEW-002/latest/US-REVIEW-002-report.html -->
- Acceptance gates now follow the work type: UI still needs real visual proof, while contract-heavy work can pass with tests, build, grep, and CI. (US-QA-015)
  <!-- evidence: .roll/features/qa-testing/US-QA-015/latest/US-QA-015-report.html -->

### Observability
- `roll supervisor live --watch` keeps the Supervisor Live role board open and redraws it in-place from the same event-backed view model. Snapshot and JSON modes remain unchanged; watch mode is interactive-only and supports `--interval <sec>`. (FIX-1035)

## v4.702.1 — 2026-07-02

### 可见性
- `roll cycles` 现在能看清 Builder 和模型身份，不再把内部模型名当成 agent（FIX-1066, FIX-1067）`[loop-observability]`
- 协同视图补齐协议图例，TCR 节奏能区分活跃大步和真实停滞（US-OBS-037, US-OBS-042）`[loop-observability]`
- CLI、HTML 和文档现在按单一语言显示，并说明如何切换和审计语言表面（US-LANG-001, US-LANG-003, US-LANG-004, US-LANG-005）`[i18n]`

### 自动化流水线
- Cursor 进入正式 agent roster，角色选角也会结合能力和健康状态排序（US-AGENT-048, US-AGENT-049）`[agents]`
- Builder 路由会避开 Prime 角色，并解释候选池、排除原因和最终选择（FIX-1047）`[loop-engine]`
- 公开命令面有了真相源，辅助命令收入口径和帮助文档保持一致（REFACTOR-056, REFACTOR-057, REFACTOR-058, REFACTOR-059）`[cli]`

### 稳定性
- Builder 不再能绕出 cycle worktree 留下泄漏提交，收尾前也会先过硬闸（FIX-1068, FIX-1069）`[loop-engine]`
- PR 合并对账和补证恢复更可靠，绿 PR 不再因为缺验收页或分数识别卡住（FIX-1057, FIX-1058, FIX-1061）`[loop-engine]`
- loop worktree 里的链接式卡片 spec 能被 attest 正常识别（FIX-1059）`[loop-engine]`
- Reasonix setup 不再把 docs/reports 等辅助目录挂成 agent skill（FIX-1042）`[skill-ecosystem]`
- Builder cycle 现在会把 `cd` 回主 checkout 后产生的本地 main 提交判为 sandbox boundary violation，记录泄漏提交数和 cwd 线索，并阻止它被当成 TCR 交付证据 `[loop-engine]`
- `roll supervisor repair-evidence` 现在能救回卡在证据门的绿 PR，不用手动合并或重跑整张卡 `[loop]`
- `roll supervisor repair-evidence` 已修复的 PR 重跑不再误报无法修复 `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-1062/latest/FIX-1062-report.html -->
- `roll cycles` 不再把旧失败轮误标为 delivered `[loop]`
- 等待 PR 合并的 cycle 证据不再被归档为失败诊断 `[loop]`
- **`aborted_no_delivery` 周期不再丢失 story/agent 归属**：外部信号终止的 cycle 会从已写入的 events.ndjson 回填已知的 `story_id` 与 `agent`；如果在路由完成前被终止，`agent` 字段会保留空值并附带 `agent_unknown_reason`，避免失败匿名化，`roll cycles` 也能正确显示对应卡片与 agent。(FIX-1060) `[loop-engine]`

### 文档与命名
- **持续刷新的 loop 摘要不再叫 "Morning Report"**：这个从 events/runs 持续重建、窗口为最近 12 小时的 digest 不管白天还是夜里都在刷新，叫 "Morning Report" 会误导白天查看的运营者。现在改叫 Loop Digest（循环摘要），主路径换成 `.roll/reports/loop/latest.html`，Truth Console 上直接露出链接。旧的 `reports/morning/latest.html` 作为兼容别名继续写一版，已有链接不会断开。(FIX-1048) `[loop-observability]`


- **两个核心概念改回更好记的名字**：项目级协调者从“Supervisor Agent”改名“Prime Agent”，交付一张 Story 的角色组合（规划/构建/评估）从“Story Execution Unit”改名“Delta Unit”。CLI 输出、文档、指南、宣传站、技能说明三端统一用新名。命令 `roll supervisor` 与内部代码标识符暂时保留原名作兼容，用户面一律读作 Prime Agent，下次大版本再评估是否连命令一起改。这是对 2026-06-27 一次改名的回退，回到 owner 更喜欢的原始命名。(REFACTOR-054)

### 自动化流水线

- **评分更能读懂 Reasonix/Kimi 的回复了**：有的评审会重绘终端、把同一段最终分数打印两遍，或先回显模板和分析再给真正答案；现在 Roll 会取最后一段可用的分数块，只要重复的分数和结论一致就采信，模板占位、真正冲突的两个不同分数、越界分数、不支持的结论仍会被拒。被拒时，`roll cycle <id> --roles` 会写出具体原因，并区分“给了类分数文本但没被采信”和“根本没返回分数内容”，不再是笼统的 unparseable。(FIX-1045) `[loop-engine]`
- **卡死在“无进展”的目标有了可审计的换人恢复路径**：当 loop 因连续无进展自动停下一张卡时，不再是个看不出原因、也走不出去的死角。`roll supervisor why` 会显示卡住的卡、连续无进展次数、上一个失败的 Builder、下一个可换的 Builder，以及如何查看上一次失败 cycle 留下的现场。新命令 `roll loop recover <卡号>` 先预览这些信息；加 `--apply` 后，在有“另一个”可用 Builder 时清掉这张卡的熔断计数、让它能被下一个 Builder 再试一次（不用手删 `goal.yaml` 或改内部状态）；没有可换的 Builder 时会明确拒绝并说明原因。每次恢复都会记一条事件，写明是谁恢复的、跳过/选了哪个 Builder、为什么允许重试——熔断器不会被悄悄绕过；没人来手动恢复时，无进展熔断照常拦住盲目重试。(FIX-1049) `[loop-engine]`
- **Reasonix / agy cycle 用量也能被 ledger 记录了**：Reasonix 跑完后会在 stdout 留下 `tok · in X · out Y · ¥Z` 用量页脚，Roll 现在会解析这个页脚并把 token、cost 写进 cycle ledger；agy / gemini 的 `-p` 输出本身不含用量，runner 会显式记录 `agy_stdout_no_usage` 原因，不再笼统地标成 `usage_unknown`。`roll cycles --json` 会带出具体原因，方便区分"解析失败"和"agent 确实没输出用量"。(FIX-1050) `[loop-engine]`
- **agy 内部工具失败不再被当成普通 gave-up**：当 agy 退出码为 0 但 stdout 只剩控制字符、且 native antigravity CLI 日志里出现 `GREP_SEARCH` 超时或 `trajectory converted to zero chat messages` 等内部错误时，Roll 会把 cycle 终态记为 `agent_internal_failure`，在 ledger、`roll cycles --detail` 和 ALERT 里带上原生错误类别、摘要和日志路径，而不是隐藏成无输出的 gave-up。(FIX-1051) `[loop-engine]`
- **agy 登录一次后就能参与无人值守的评审/打分了**：以前即便你已经在终端里登录过 agy，loop 在后台拉起它做评审或打分时还是会反复报"登录失败"，因为后台进程看不到你登录留下的凭据。现在 agy 会带着和你手动使用时相同的登录环境启动，登录过一次就能安静地参与循环，不再打断你去重新确认。新命令 `roll agent readiness agy` 可以先检查 agy 在后台能不能正常登录：能就直接说 ok，不能就明确告诉你缺什么、怎么恢复（只报路径和变量名，绝不打印任何密钥）。万一登录真的失效了，agy 会被临时挂起并留下一条可见记录，等你重新登录后自动恢复；纯网络波动不会被误判成登录问题。(FIX-1056) `[loop-engine]`
- **已交付的故事不再在 cycle 账本里显示"未发布"**：当一个 story 已经合并到 main 并出现在交付记录里，但较早的 cycle 行因为当时 publish 没完成、`runs.jsonl` 里还是 `unpublished`，`roll cycles` 现在会检查交付真相、把该行标记为 `delivered`，不再让已上线的成果看起来像"没发出去"。同时，`roll truth query` 能在交付记录缺少 PR 编号时，从合并提交的正文里找回 PR 编号，不再报 `pr_number_no_publish_attempted`。(FIX-1046) `[loop-engine]`
  <!-- evidence: .roll/features/loop-engine/FIX-1046/latest/FIX-1046-report.html -->

### 新功能

- **`roll design` 现在会给出一个可读的运行摘要和产物交付块**：运行前显示目标、模式、agent 和原始记录路径；运行中默认只渲染关键进度行，原始 agent 输出保存到 `.roll/runs/design/<timestamp>-<target>/transcript.log`；结束后交付块列出设计产物（`spec.md#detailed-design`）、生成的 HTML、新建卡片数、当前状态和下一步动作。`--verbose` 可查看 assistant 详细文本，`--raw` 可输出完整记录。(FIX-1055) `[legacy-onboard]`

## v4.630.2 — 2026-06-30

### 自动化流水线

- **评分能读懂真实 agent 的输出了**：评审给分时夹带的终端控制字符、启动横幅、JSONL 包装或项目符号前缀都会被自动清理，只要回复里有一段完整的分数/结论/理由就能采信；同时，只要装了别的 agent，干活的 agent 就绝不会给自己的交付打分——要么由独立评审打分，要么诚实地不打分并保留卡片不上线。(FIX-1044) `[loop-engine]`

### 可见性

- **v4 角色日志入口补齐**：文档说明 Builder、Peer Reviewer、Evaluator、采信分数和解析失败原始产物分别该去哪里看，方便 supervisor 诊断多 agent 协作链路。(US-OBS-036) `[loop-observability]`
- **协同视图数据底座就位**：新增 `collab-view.v1` 投影，从事件流和 CycleRoleSummary 派生换手、升级与 supervisor 姿态，为 `roll cycle --collab` 和 `roll supervisor live --collab` 提供类型稳定的数据契约。(US-OBS-038) `[loop-observability]`

## v4.630.1 — 2026-06-30

### 自动化流水线

- **Reasonix builder 可以在 linked worktree 里正常提交了**：loop 现在会给每个 Reasonix cycle 生成临时本地 sandbox 配置，把已计算出的 git common dir 写入允许写目录；不需要永久放宽 `~/.reasonix/config.toml`，也不会把 API key 写进 argv 或配置文件。(FIX-1036) `[loop-engine]`
- **Loop 交付不会再误报完成**：PR、CI 或验收链路缺证时，Roll 会停在可恢复状态，不再把没真正上线的卡记成已交付。(FIX-1032a, FIX-1032c, FIX-1039) `[loop-engine]`
- **Scoped `roll loop go` 更守边界**：单卡运行不会被旧计数或定时 tick 带到下一张卡，适合人工盯一张关键修复。(FIX-1034, FIX-1040) `[goal-mode]`
- **Agent auth 诊断更准**：日志里的 `403` 卡号不再被误判成登录失效，真正的鉴权失败仍会明确阻塞。(FIX-1033) `[loop-engine]`
- **发版前检查更可信**：`roll release --json` 和一致性闸现在会真实读取待发布内容，旧交付缓存不会再误拦或误放。(FIX-1030, FIX-1041) `[release-management]`

### 新功能

- `roll design` 不再在已有 backlog 的项目里意外启动完整设计 session，而是先给出可选的几种目标方式（`--from-file`、直接需求文本等）(FIX-1031) `[loop]`

### 可见性

- 验收报告和故事档案开始显示执行阵容（Execution Cast），每位 Builder、Peer Reviewer、Evaluator 和验收门禁在交付页面上一眼可见（US-OBS-034）`[loop]`
- **Cycle 角色链可直接查看**：`roll cycle --roles` 会展示 Builder、Peer Reviewer、Evaluator 和采信结果，不用再翻事件流。(US-OBS-033) `[loop]`
- **评审解析失败不再消失**：有返回但格式不对的 reviewer/scorer 会显示原因和原始产物位置。(US-OBS-035) `[loop]`

## v4.629.2 — 2026-06-29

### Agent 管理

- **Agent 配置收敛成 Scope → Role → Binding → Agent → Model**：机器级和项目级 Agent 域现在只写 `~/.roll/agents.yaml` / `.roll/agents.yaml`，`roll agent` 展示 Machine Scope、Project Scope、继承来源、resolved role、Agent pool health 和 legacy compatibility；`roll agent migrate` 可以把旧的 primary/local/pairing/route 配置迁到新模型，迁移默认不删除旧文件。(US-V4-015, US-V4-016, US-V4-017, US-V4-019, US-V4-020, #1073) `[autonomous-evolution]`
- **评审/打分回到公平候选池**：peer review 和 score 现在优先通过 evaluation Role binding 解析候选，历史上的 headless auth、VPN、账号状态不再变成静态排除；临时不可用只作为本次 runtime health skip 记录，异构评审和自评防线保持不变。(US-V4-018, #1073) `[autonomous-evolution]`

### 自动化流水线

- **Supervisor 成为 V4 操作入口**：`roll supervisor status/next/why/live` 会说明 guided/autonomous 模式、下一步 owner action、Planner/Builder/Evaluator 角色状态和不可用原因；旧 Dossier Web / daemon 产品面退场，story-scoped attest report 和 CLI-first observability 继续作为验收与观察入口。(US-V4-011, US-V4-013, US-V4-014, #1072, #1073) `[autonomous-evolution]`

## v4.629.1 — 2026-06-29

### 自动化流水线

- **V4 Supervisor 执行架构上线**：Story 现在按 standard、verified、planned 剖面交付，Supervisor 负责项目级观察与建议，验收证据按 Story 收口，不再依赖全局档案刷新。(US-V4-001, US-V4-002, US-V4-003, US-V4-004, US-V4-005, US-V4-006, US-V4-007, US-V4-008, US-V4-009, US-V4-010, US-V4-012) `[autonomous-evolution]`
  <!-- evidence: .roll/features/autonomous-evolution/US-V4-008/latest/US-V4-008-report.html -->
  <!-- evidence: .roll/features/autonomous-evolution/US-V4-012/latest/US-V4-012-report.html -->

## v3.628.1 — 2026-06-28

### 上手引导

- **`roll init` 给出的 PRD 下一步现在能直接运行**：`roll design --from-file <path>` 会校验输入文件并把 PRD/brief 绑定到 `$roll-design`，不再落到 usage。(#1065) `[legacy-onboard]`

## v3.627.1 — 2026-06-27

### 上手引导

- **新拆的卡会带验收契约**：`roll design` 现在把预期证据和评分重点写进 story，交付和评审看同一份标准。(US-SKILL-030) `[skill-ecosystem]`
  <!-- evidence: .roll/features/skill-ecosystem/US-SKILL-030/2026-06-27T02-11-16/US-SKILL-030-report.html -->
- **`roll init` 会先分清项目类型**：PRD、空项目、已有代码库、partial Roll、旧布局和已就绪项目都会走不同下一步。(US-INIT-004, US-INIT-005, US-INIT-006a, US-INIT-009) `[legacy-onboard]`
  <!-- evidence: .roll/features/init-onboard/US-INIT-004/latest/US-INIT-004-report.html -->
  <!-- evidence: .roll/features/init-onboard/US-INIT-005/latest/US-INIT-005-report.html -->
  <!-- evidence: .roll/features/init-onboard/US-INIT-006a/latest/US-INIT-006a-report.html -->
- **已有代码库先诊断再应用**：`roll init` 先产诊断和计划，确认后再 `roll init --apply`，不会一上来改你的仓库。(US-INIT-006b, US-INIT-006c, US-INIT-006d) `[legacy-onboard]`
  <!-- evidence: .roll/features/init-onboard/US-INIT-006b/latest/US-INIT-006b-report.html -->
  <!-- evidence: .roll/features/init-onboard/US-INIT-006c/latest/US-INIT-006c-report.html -->
  <!-- evidence: .roll/features/init-onboard/US-INIT-006d/latest/US-INIT-006d-report.html -->
- **`roll init --apply` 可以放心重跑和退出**：重复执行会复用变更账本，`roll offboard` 只移除 Roll 管理的内容。(US-INIT-006e, US-INIT-006f) `[legacy-onboard]`
  <!-- evidence: .roll/features/init-onboard/US-INIT-006e/latest/US-INIT-006e-report.html -->
  <!-- evidence: .roll/features/init-onboard/US-INIT-006f/latest/US-INIT-006f-report.html -->
- **`roll next` 成了上手流程的继续按钮**：init、onboard、repair、migrate、design 和下一张 Todo 都会收束到一个显然下一步。(US-INIT-007) `[legacy-onboard]`
  <!-- evidence: .roll/features/init-onboard/US-INIT-007/latest/US-INIT-007-report.html -->
- **文档、CLI help 和站点图现在讲同一条路**：README、指南、skill contract 和 `$roll-onboard` 图都改成“已有代码库”视角。(US-INIT-008) `[legacy-onboard]`
  <!-- evidence: .roll/features/init-onboard/US-INIT-008/latest/US-INIT-008-report.html -->

### 稳定性

- **验收截图不再能伪造现场**：CLI 用 Terminal.app，站点图用真实浏览器窗口；无 GUI 或无权限时诚实跳过。(US-INIT-003d, US-INIT-008) `[acceptance-evidence]`
  <!-- evidence: .roll/features/init-onboard/US-INIT-003d/latest/US-INIT-003d-report.html -->
  <!-- evidence: .roll/features/init-onboard/US-INIT-008/latest/US-INIT-008-report.html -->

## v3.626.2 — 2026-06-26

### 自动化流水线

- **调高 spec 里的 `est_min` 现在真能把卡送进更硬的档位了**：文档一直说「在故事 spec 里 bump `est_min` 就能升档（easy ≤8 / default 8–20 / hard >20）」，但路由器只读了 backlog 行上的 `est_min`，spec frontmatter 里的从没被喂进分档器——于是 `est_min: 24` 的卡始终落在 default 档。现在分档以 spec frontmatter 的 `est_min` 为准（spec 没写才回退到 backlog 行），文档承诺的升档手段终于生效。
  Bumping `est_min` in a story spec now actually escalates it to a harder tier. The router only read the backlog row's `est_min` and ignored the spec frontmatter, so an `est_min: 24` card kept running on `default`. Tier selection now reads the spec frontmatter `est_min` first (falling back to the backlog row), so the documented escalation lever works. (FIX-1026) `[loop-engine]`
- **loop 不再因为没开 VPN 就停摆**：纯国产工作流（kimi/pi/reasonix via DeepSeek、Bailian/DashScope embeddings）所有服务本就直连可达，但 loop/release 的连通性预检探的是固定海外主机（github.com），VPN 一关就误判「断网」并 halt——实测掉线后停摆过约 11 小时、零周期。现在可用 `loop_safety.probe_url` 把探测指向你真正需要的主机，或 `loop_safety.skip_network_check: true` 直接跳过预检；原来的 `proxy_enable_cmd` 恢复路径保留。
  The loop no longer stalls just because the VPN is off. The loop/release connectivity precheck probed a fixed foreign host (github.com), so a dropped VPN was misread as "no network" and halted the loop (~11h of dead cycles observed) even though every configured domestic provider was directly reachable. Point the probe at a host you actually need via `loop_safety.probe_url`, or opt out with `loop_safety.skip_network_check: true`. (FIX-1025) `[loop-engine]`

## v3.626.1 — 2026-06-26

### 自动化流水线

- **loop 再也不会弹 macOS 录屏授权了**：以前无人值守跑 loop 时会反复弹「请求录屏」授权框（甚至堆成一摞挡住屏幕），根因是判断「是否无人值守」用的 isTTY 被 loop 的 PTY（script+tmux）包装骗过了。现在 loop 在每个子进程显式关掉截屏探测，探测和真截屏两条路都认这个开关——你自己在终端跑 `roll attest --capture-web` 截图不受影响。(FIX-1022) `[loop-engine]`
- **评分/配对只用你配置里允许的国产代理**：以前会自动启用机器上探测到的 codex/claude 来评分配对，既违反纯国产约束又白白失败。现在只认 `.roll/agents.yaml` 里声明的代理。(FIX-935) `[loop-engine]`
- **loop 跳过有未发布本地改动的卡**：一张卡若本地还有没提交/没发布的工作，loop 先跳过它，不再覆盖或重复劳动。(FIX-1018) `[loop-engine]`
- **推送前先体检仓库可推性**：加了仓库可推送性预检 + 暂停闸，推不动时不再硬来、空转。(FIX-1019) `[loop-engine]`
- **`roll loop --help` 讲清三态**：help 里写明 ACTIVE / DORMANT / PAUSED 三态、休眠含义、三种唤醒方式。(US-LOOP-079m) `[loop-engine]`

### 上手引导

- **`roll init` 之后知道下一步该干嘛了**：当你手头有需求文档（PRD 之类）但 backlog 还是空的时候，`roll init` 收尾、`roll status`、`roll doctor` 三处都会提醒你去把需求变成可执行的 backlog——先做设计、再开 loop。(US-ONBOARD-NUDGE-002, US-ONBOARD-NUDGE-003) `[legacy-onboard]`
- **一条命令就能开始设计**：敲 `roll design` 直接在你的 AI agent 里拉起交互式设计会话，把需求聊成 INVEST 故事写进 backlog。不用再自己记着「先去 agent 里加载哪个 skill」。(US-ONBOARD-NUDGE-004) `[legacy-onboard]`
- **装完就能选默认 agent**：`roll setup` 不再静默替你选第一个 agent——如果你的机器装了多个 AI agent，setup 会问你用哪个当默认（非交互环境则按注册表顺序选第一个，确定性不出错）。选完存进 `primary_agent`，以后 `roll design`、`roll agent use` 这些交互入口默认就用它，不用每次都再选。重跑 setup 不再打扰——已有默认就静默跳过；想换默认用 `roll setup --reselect` 或 `roll agent use`。(US-ONBOARD-NUDGE-006) `[legacy-onboard]`
- **文档收尾**：init→design 引导流程、`roll design` 命令入口、默认 agent 选择都已写进中英文档，不用再靠「本来就知道」。(US-ONBOARD-NUDGE-005) `[legacy-onboard]`
- **新项目上手更清晰**：新项目流程改成「先建仓库、再 `roll init`」，并给出 epic 提示，少走弯路。(FIX-1020) `[legacy-onboard]`
- **`roll init` 收尾有总结/确认，支持 `--auto`**：init 完成时给出「做了什么」的总结 + 确认；加 `--auto` 可非交互一把梭完成。(FIX-1021) `[legacy-onboard]`

## v3.625.2 — 2026-06-25

### 自动化流水线
- **Loop 卡住时会自己换人、拆卡，不再整夜空转**：某个 AI 干不动一张卡时（憋很久不出一个字，或跑完一点东西都没产出），loop 自动换下一个 AI 试；几个 AI 都试过还不行，就把这张卡拆成更小的卡再做；实在做不了才停下来喊你。每张卡换人有上限、拆卡有深度上限，绝不会无限打转。想关掉这套自动补救、回到「一失败就停」的老行为，设 `ROLL_LOOP_NO_AUTO_RECOVER=1` 即可。(FIX-928, FIX-929, FIX-930, FIX-931, FIX-932) `[loop-engine]`
- **档案页一眼看出 loop 在跑、在睡、还是被你暂停**：`#loop` 区块顶部加了三态状态头——运行中（几条 lane 就绪）、休眠（告诉你从什么时候睡的、为什么睡、哪几条 lane 卸了、怎么唤醒）、已暂停。(US-LOOP-079l) `[loop-engine]`
- **看 loop 实时流能看清在跟谁配对、裁决、分数**：`roll loop watch` / status 里跨代理配对事件以前只印事件名，现在展开成一行人话——选了谁配对谁（working → peer）、复核裁决（agree/refine/object）+ 问题数、打分与结论、耗时。(FIX-934) `[loop-engine]`

## v3.625.1 — 2026-06-25

### 自动化流水线
- **Loop 会自己睡、自己醒了**：backlog 没活时，loop 自动进入休眠——卸掉定时任务、不再每半小时空转、账本也不再记一堆“无事可做”。等你加了新卡、敲了任意 `roll` 命令、或夜间 Dream 扫出活，它自己就醒过来接着干。省电、省噪音、账本干净。(US-LOOP-079a, US-LOOP-079b, US-LOOP-079d2, US-LOOP-079e, US-LOOP-079f1, US-LOOP-079f2, US-LOOP-079h1, US-LOOP-079h2, US-LOOP-079j, US-LOOP-079k, US-LOOP-079n) `[loop-engine]`

### 上手引导
- **`roll init` 之后会告诉你下一步**：当你手里有需求文档、但 backlog 还是空的时候，`roll status` / `roll doctor` 会提醒你去跑 `$roll-design` 把它变成可执行的 backlog——不用再靠“自己本来就知道”。(US-ONBOARD-NUDGE-003) `[legacy-onboard]`

### 修复
- **无人值守时不再被 macOS 录屏授权弹窗打断**：headless 运行（launchd 定时任务 / CI）时跳过屏幕录制权限探测，不再反复弹授权框、也不会卡住整轮循环。(FIX-927) `[tools-layer]`

## v3.624.3 — 2026-06-24

- **验收报告内容判定与视觉证据闸分离**：`attest:gate` 不再把“报告有 AC/ac-map/E2E 证据但声明的截图面未真实捕获”误报成 empty-shell；这类情况现在按视觉证据缺口给出可操作 reason，避免 correction loop 反复走错修复方向。(FIX-400 follow-up) `[acceptance-evidence]`

## v3.624.2 — 2026-06-24

### 稳定性

- **内置工具补齐 JSON Schema 契约并在调用前校验输入**：所有 builtin tools 现在声明真实 `inputSchema` / `outputSchema`，普通调用和既有委派调用都会在执行前拒绝结构非法的输入并返回 `invalid_input`；`roll tool status` 和机器级 Tools 页同步显示参数契约，便于 agent 内省与排障。(US-TOOL-022) `[tools-layer]`

- **工具依赖现在有真实 readiness gate**：内置工具会按声明的 requirement 检测 Git/GitHub/系统命令等依赖，缺少非可选依赖时不再假装可用，而是拦截或给出可操作提示；`roll doctor` 同步展示这些依赖状态。(US-TOOL-020) `[tools-layer]`

- **Tools 页显示依赖链和可用性**：机器级 Tools 页面为每个 tool 展示 input/output 契约、requirement 链、live readiness 和修复提示，工具边界与环境问题更容易排查。(US-TOOL-021) `[tools-layer]`

- **实时控制台项目切换更可信**：live 模式下项目切换器会按 registry/slug 分发对应项目快照，非当前项目不会误用当前帧；删除或不可达项目不再表现为可切换的真项目。(US-OBS-023) `[delivery-dossier]`

- **可观测 daemon 有正式生命周期命令**：新增 `roll daemon start|stop|status` 管理本机只读观测进程，进程 PID、启动/停止和状态输出都有测试覆盖。(US-OBS-024) `[delivery-dossier]`

- **实时控制台文档补齐**：架构文档和新增 live-console 指南记录了 `roll cycle watch`、三流权威边界、静态导出与未来 live serve 的关系，以及证据按构造产生的方向。(US-OBS-025) `[documentation]`

- **单 cycle 实时窗口可回放 activity 流**：`roll cycle watch` 能围绕一个 cycle 展示标准 activity 事件，把生命周期、TCR、gate、stdout 和工具调用投影到同一条实时观察线。(US-OBS-027) `[delivery-dossier]`

- **pi/kimi 工具调用信号被规范化并持久化**：normalizer 补齐工具调用粒度，cycle 信号写入 `signals.jsonl`，后续 dossier、watch 和证据草稿都能消费同一份活动流。(US-OBS-028) `[delivery-dossier]`

- **TruthSnapshot 覆盖所有控制台面板**：casting、charter、skills、git hooks、live feed 等原本 off-schema 的面板进入结构化 snapshot，页面不再绕开同一真相选择器。(US-OBS-029) `[delivery-dossier]`

- **档案页新增 snapshot 适应度闸**：控制台渲染如果读取 snapshot 之外的数据会被测试拦住，防止未来再出现页面局部真相口径漂移。(US-OBS-030) `[delivery-dossier]`

- **ac-map 证据草稿从 activity 流生成**：loop 会结合 activity signals 与 diff 起草 AC→证据映射、报告和截图引用，默认保守不自动通过，但让缺证据问题更早、更具体地暴露。(US-OBS-031) `[acceptance-evidence]`

- **验收报告软链缺失时不再误判空壳**：无人值守 loop 现在能从真实 run 目录找到验收报告和 ac-map，`attest:gate` 的失败原因也会指向真实路径，不再显示 `<epic>` 占位。(FIX-400) `[acceptance-evidence]`

- **成功交付的 builder 收尾不再误触发登录暂停**：builder exit 0 的交付总结即使提到 login、credential 或鉴权，也不会被误判成 auth block；真正的登录失败和网络失败仍照常归因。(FIX-401) `[loop-engine]`

- **失败 cycle 救援不再冲掉 backlog Done**：`rescue_leaked` 清理泄漏 main 提交时会保留已写入但尚未提交的 `.roll/backlog.md` 状态，避免已合并卡回到 Todo 后被重做。(FIX-402) `[loop-engine]`

- **peer reviewer/scorer 不再漏掉 agent 文件凭据**：reasonix 等 agent 的 profile env 现在由真实 spawn 层统一注入，peer review、Review Score 和 ac-map 补救路径都会拿到 `~/.reasonix/.env` 里的密钥；tmux cycle 窗口也追加透传 agent secret env 名，避免 env-only 配置在无人值守 loop 里丢失。(FIX-403) `[loop-engine]`

- **agent 缺密钥会在 spawn 前明确阻塞**：builder、reviewer、Review Score scorer 和 ac-map 补救在真正启动 agent 前会检查必需 credential env；env 与 agent 文件凭据都缺失时写出点名 agent 和变量名的 `agent:blocked` / ALERT，不再等到 mid-cycle 才掉成模糊 auth block。可用的其它 scorer/reviewer 仍会继续接手。(FIX-404) `[loop-engine]`

- **agent 名册收敛到 6 个一等成员**：`claude`、`kimi`、`codex`、`pi`、`antigravity (agy)`、`reasonix` 成为唯一可列出/探测/派发的 agent roster；`openai`、`deepseek` 继续作为 provider/model alias 保留，不再作为独立 agent 冒出。(US-AGENT-043) `[agents]`

- **agent 名册改为单一真相源派生**：`AGENTS` 现在承载一等 agent 身份、显示名、PATH 探测 bin、默认模型和能力标记；registry、`roll agent list`、doctor/setup 探测和 spawn profile 覆盖都从同一组 6 个身份派生，减少后续名册漂移。(US-AGENT-044) `[agents]`

- **交付真相重建不再丢无 PR 号的 story-only merge**：多个只含 story id、没有 `(#PR)` 的合并提交现在按 commit SHA 保留，不会因 `prNumber=0` 互相覆盖；release gate 可稳定识别这类已合主干的卡。(FIX-924) `[feedback-truth-alignment]`

- **旧 agent 配置开始显式迁移/拒绝**：`openai`、`deepseek` 作为 provider alias 会静默迁移到 `codex`、`pi`；`cursor`、`trae`、`qwen`、`opencode`、`openclaw` 等已删除 agent 在 `roll agent use/set` 和 doctor/setup 面上不再静默回退，而是明确过滤或报错。(US-AGENT-045) `[agents]`

- **文档/站点/技能收口到 6 agent**：docs、guide（中英）、skills 中作为 agent 提及的 `cursor`、`trae`、`opencode`、`openclaw` 及 `openai`/`deepseek`/`qwen` 独立 agent 条目已移除；model/provider 提及不动（`deepseek-v4-pro` 等 model id、`openai` 等 provider alias 保留）。(US-AGENT-046) `[agents]`

- **agent roster 适应度闸与 Rig 类型**：新增结构化 roster gate，CI 测试会校验 core/CLI/spawn/runner-label 等 roster 面都保持六 agent，并用合成 `qwen` 回流证明会红；`Rig` 明确建模 `agent × model`，阻止 `deepseek` 这类 model/provider 被当作 agent 指派。(US-AGENT-047) `[agents]`

- **项目切换器不再显示已删除项目**：档案页项目列表的 reachable 过滤移动到 `collectDossierState` 读侧，`truth.json`、静态首页和机器页都消费同一份已过滤项目行；删除目录后的 stale registry 行不会再渲染成 phantom switcher 项。(US-OBS-019) `[delivery-dossier]`

- **交付真相重建补齐无 PR 号 story-only merge 的跨阶段去重**：`ensureDeliveriesFresh` 两阶段 git log 合并现在按 `pr:<n>` / `sha:<commit>` 去重，避免某个 `prNumber=0` 事实挡掉后续已合主干的 story-only squash commit。(FIX-925) `[feedback-truth-alignment]`

- **release gate 接受无 PR 号交付的 merge SHA 证据**：Done 行现在可用 `merged <sha>` 作为可验证 merge ref；truth-live 在 PR 号缺失时校验 merge commit，避免 story-only squash merge 被迫伪造 PR ref。(FIX-926) `[feedback-truth-alignment]`

- **loop 已合并卡不再回流**：合进 main 的卡会被稳定识别为已交付，不再反复被选回待办。(FIX-399 / FIX-923) `[feedback-truth-alignment]`

- **评审评分池不再太早放弃**：异构 reviewer 都不可用时，会继续尝试同厂可用候选，减少无谓失败。(FIX-911) `[loop-engine]`

- **发版闸不再放过假 Done**：待发布卡会核对真实交付记录，backlog 写错会直接拦住。(FIX-391) `[feedback-truth-alignment]`

- **缺验收件的已完成工作不再沉底**：loop 会开待复评 draft PR，并把卡标成待复评等待补件。(FIX-909) `[loop-engine]`

- **ac-map 补救草稿不再只有引用没有证据文件**：loop 自动生成验收映射草稿时，会同步写出提交、改动文件和测试信号文本，方便复评者逐条确认；草稿状态仍需被确认后才可过 attest 闸。(FIX-912) `[acceptance-evidence]`

- **切换 agent 槽位后档案页自动刷新**：`roll agent use` / `roll agent set` 写入槽位后会 best-effort 重建静态档案聚合，Casting/Agents 视图不用等下一次手动 `roll index` 才更新；刷新失败只 WARN，不回滚已写槽位。(FIX-378) `[delivery-dossier]`

## v3.624.1 — 2026-06-24

### 新功能

- **实时控制台底座上线**：档案页可以从静态快照走向实时刷新。(US-OBS-020 / US-OBS-021) `[delivery-dossier]`

### 修复

- **取分阶段失败归因细分 + unparseable 一次再问救回**：之前取分链路的 `runScorePairing` 把所有 reviewer 失败一律当 null 吞掉——auth 超时、网络不通、进程崩溃、回复了但格式跑偏——四种原因全被静默丢弃，池子耗尽后闸判「缺分数」→ cycle 失败。现在每种失败都发出 `pair:score-failure` 可观测事件（unparseable/timeout/auth-block/exit-error），不再沉默。最冤的「reviewer 答了但格式跑偏」加了一次严格格式重申再问（`你上次回复缺/错了 SCORE/VERDICT/RATIONALE 行，请严格只回这三行`），答了白答的 pi 之类的 reviewer 现在有机会被救回。parse 绝不放松——只接受严格三行协议；闸逻辑逐行不动，救援分须自然满足全部独立性过滤。(FIX-910) `[loop-engine]`

- **loop 交付真相不再漏认已合并卡**：手动合并和外部合并也会被识别，已合卡不再被反复重选。(FIX-389a / FIX-390 / FIX-903 / FIX-904 / FIX-905 / FIX-906) `[feedback-truth-alignment]`

- **loop 挂死或缺验收件时不再丢工作**：周期空挂会硬超时，CI 已绿但缺报告的工作会进入待复评，不再触发假熔断。(FIX-907 / FIX-908 / FIX-913) `[loop-engine]`

- **loop 评审和在飞对账更稳**：评审会带仓库上下文和反馈重试，GitHub 探测失败时也不再误重选在飞卡。(FIX-386 / FIX-387 / FIX-397) `[loop-engine]`

- **`roll loop watch` 状态行不再掉成 unknown**：长时间窗口也能显示真实故事和 agent。(FIX-382) `[loop-engine]`

- **builder 进程 cwd/PWD 钉到 cycle worktree,不再漏写共享 checkout**：pi/kimi 等经 PTY 包装的 agent 现在同时用真实 `cwd` 和 `PWD` 指向 cycle worktree,并清理继承的 `GIT_*` 状态,避免 CLI 依据父进程 `PWD` 写进主 checkout；不再注入 `GIT_DIR`/`GIT_WORK_TREE`,避免污染共享 `.git/config` 的 `core.worktree`。(FIX-914) `[loop-engine]`

- **chromium/playwright 依赖加固——钉版本、init 预装、离线优雅提示**：之前三处用 `playwright@latest`（未钉版本），`latest` 可能拉到新版导致浏览器版本漂移、偶发截图失败；chromium 在第一次需要截图的 cycle 当场下载（~100-200MB），网抖则该 cycle 截图失败。现在 `screenshot.ts` 和 `browser.ts` 统一使用钉定版本 `playwright@1.52.0`，缓存命中一致不重装；`roll init` 和 loop 首启时静默预装 chromium（已缓存秒返、失败不阻塞）；离线/网络错误时 skip 消息区分「headless Chromium unavailable (offline or network error)」；Tools 页 browser tool 可用性联动 chromium 安装状态。(FIX-394) `[acceptance-evidence]`

- **终端交付命令在 headless loop 不再假死、命令 stdout 升格为可过闸证据**：之前带 `deliverable_cmd`（终端命令）的卡在无人值守 launchd loop 中因无 GUI session 无法截图，attest 门判败堵死整条 loop。现在终端 lane 镜像 web lane 的 headless 回退——命令执行成功但无 GUI 时自动把 stdout 文本升格为 `taken:true` 终端证据，attest 门可正常通过，不再依赖 epic 级 `screenshot_exempt` 豁免。修复也拓宽了回退条件：原先只匹配 "no GUI session"，现覆盖所有 headless 跳过（含 "not macOS" 等），条件是命令已成功运行。(FIX-392) `[acceptance-evidence]`

### 稳定性

- **无人值守 loop 上一轮没跑完时不再并发起新轮，不会堆积拖慢机器**：调度脚本生成器加了「在飞守卫」——上一个 cycle 还在跑时，新的 launchd tick 自动让路而不是硬起一轮，根治了「cycle 超过调度间隔→并发堆积→CPU thrash→更慢→更多并发」的死亡螺旋。生成器同时默认设好 headless 截图环境，无人值守 loop 不再弹 macOS 屏幕录制授权框。(FIX-393) `[loop-engine]`

## v3.621.1 — 2026-06-21

### 修复

- **watch 事件行时间戳与状态行统一显示设备本地时区**：之前事件行硬编码 UTC 渲染（`getUTCHours`），状态行却走本地时区，同屏出现时差；`cycle:terminal`、`report:morning` 等事件类型也落到了 "unsupported event" 无意义渲染。现在时间戳统一走设备本地时区，新增 `cycle:terminal` 和 `report:morning` 的显式渲染，未知事件干净降级不再显示 "unsupported event"。(FIX-385) `[loop-engine]`

- **loop 不再盲目重选「在飞」的卡**：发 PR 后卡↔PR 连接不再断裂（`pr=None` 根治），reconcile 对 gh 探测失败也稳健守住 🔨，CI 红不再只是报警——走 fix-forward 恢复原分支修而非从头重选。(FIX-384) `[loop-engine]`

- `roll loop watch` 状态行现在正确显示故事和 agent `[loop]`

- **无人值守 loop 现在能为可视卡真正截图，不再空转挂起**：之前 loop 在 cycle 工作树里跑网页截图时，因为工作树没装 playwright 依赖（`require('playwright')` 找不到模块）就直接跳过，带页面证据的卡验收报告成了空壳、纠正熔断把整条 loop 停掉。现在截图失败会自动回退到能在工作树里跑、且会自愈安装浏览器的 headless 命令行路径，可视卡得以在无人值守下真正截图并交付。(FIX-379) `[acceptance-evidence]`

- **建卡校验和交付期校验现在同一把尺子，杜绝「能建出来、一进 loop 必失败」的毒卡**：一张卡声明的「交付演示命令」，`roll story validate` 在建卡时就用和交付截图时完全相同的白名单来判（必须是 roll 的只读命令、不含 shell 特殊字符、不是会改状态的命令），并对 `watch` 这类一直刷屏不退出的流式命令明确提示——不能直接当交付命令，请加 `--once`/快照模式或声明无需截图。之前两处各判各的，能建出「建卡时绿、交付时必被拒」的卡，一进 loop 必失败、攒够三次还会熔断整条 loop。(FIX-383) `[loop-engine]`

### 变更

- **交付状态改用结构化账本追踪，卡的状态更准、不再靠「读文字猜」**：loop 判断一张卡有没有真正交付（发了 PR 没、合进 main 没、CI 红还是绿），现在统一从一份结构化的交付记录账本读取，不再去解析 backlog 的中文文字和正则猜测。好处是状态显示更可靠、少了「明明合并了却还显示待办」这类漂移和误判，backlog 的状态栏变成这份账本的派生展示；账本只追加不改写、跨多个工作树共享、原子落盘，避免并发写坏。配套落地：交付记录的数据类型与生命周期状态（和「评审裁定」彻底分开）、唯一的查询入口函数、消费侧改读结构化记录、运行账本改只追加消除并发部分写、架构文档同步说明这套机制。(US-TRUTH-013 / US-TRUTH-014 / US-TRUTH-016 / US-TRUTH-017 / US-TRUTH-019 / US-TRUTH-020) `[feedback-truth-alignment]`

## v3.620.1 — 2026-06-20

### 修复

- **发版页和档案页都改成只看「下一版」的真相**：档案页的发版栏现在自动显示真实的最新版本号、每次发版同步刷新，不再卡在旧版本；发布页的「待发布」也只列上一个发布版本之后新合入的卡（就是下次要带的内容），而不是几百张全量未完成卡；配套的一致性检查面板改成自解释，一行告诉你能不能发版、每项查什么、怎么修。(FIX-368 / FIX-372) `[release-management]`

- **文件夹形式的卡片跑验收报告不再被「别的卡号」抢走清单**：就算卡里的小标题里提到了其他卡号，验收报告也只认这张卡自己的全部验收项，正常完整显示。(FIX-374) `[acceptance-evidence]`

- **发版前自动拦住「漏写发版说明 / 文档对不上」**：`roll release` 的一致性闸新增三道确定性检查——① 自上一个发布以来合入的每张卡，必须有 ✅ Done 行并带合并号（这一维原来形同虚设，绿了也没在验）；② 每张卡要么在 CHANGELOG 里有条目、要么在卡里显式写明「不入发版说明」的理由，否则拦住发版（防止用户可见的改动无声上线）；③ 站点不能再链向不存在的指南页。判断更重的「文档是否还和实现一致」审计，同步沉淀进 `$roll-doc-audit` 技能（先审一致性、再补文档），闸守底线、技能查细节。(FIX-375) `[release-management]`

### 新功能

- **loop 观察窗看长周期更省心**：默认的 `roll loop watch` 窗口现在直接显示当前阶段、静默时长、TCR 次数和最近一次有意义的进展，长周期一眼就能看懂；新增 `--events` 和 `--raw-events` 两档，可直接跟踪事件流，不用再自己 tail 原始日志；`roll loop go` 和定时 loop 的 tmux 监视窗也和手动观察走同一个统一入口；TCR 提交按当前周期的观测时间排序，不再把开工前的旧提交错当成本周期的新进展；帮助文字与中英文档都说明了默认、紧凑事件、原始事件三档查看层级以及只读与 Ctrl-C 退出。(US-LOOP-043 / US-LOOP-045 / US-LOOP-046 / US-LOOP-047 / US-LOOP-048) `[loop-engine]`

- **主动询问外部工具权限，并在档案页标清可用性**：roll 现在会在 `roll init` 或启动时主动问你要不要授予截图权限、安装 Chromium 这类外部工具依赖，拒绝会说明具体影响，并在 Agents 档案页上逐项显示每个工具能不能用。(US-EVID-018) `[acceptance-evidence]`

### 变更

- **下架未成熟的"生产巡检"和"每日简报"两块能力面**：`$roll-sentinel`（随机抽样巡检）和 `$roll-brief` / `roll brief`（owner 每日简报）不再作为 Roll 的核心能力宣传——它们成熟度不够，且和外部控制台 / Delivery Dossier / `roll status` / 真相信号这条已经成熟的可观测链路重复。现在第三个闭环（Loop C）讲的是"可观测与维护"：用 `roll status`、`roll dossier`、`$roll-debug`/`$roll-doc-audit`/`$roll-doctor`、`$roll-.dream` 代码健康扫描和真相信号来发现问题、把修正写回 backlog。代码、技能目录、命令面、站点与中英文档已同步；新增一道回归闸，防止这两块能力面悄悄回流到活跃文档/站点/帮助/技能目录里（历史归档、迁移文档、旧版幻灯片不受影响）。(FIX-356 / 356a-d) `[skill-ecosystem]`

- **`$roll-doc` 更名为 `$roll-doc-audit` 并同步用户表面**：站点 Skills、技能图谱、`roll-doc-skill.html` 公共旧链接、guide/README 风格说明和 CLI skills panel 都改成"文档/产品一致性审计"心智；旧 diagram URL 保留跳转到 `roll-doc-audit-skill.html`，避免已分享链接断掉。`[skill-ecosystem]`

- **loop 能在卡做大时自己再拆**：交付前的自检判定"太大"、或独立评审判定"范围过大"时，loop 会调 `roll loop self-downgrade` 把原卡挂起（🚫 Hold）、按缺口拆出子卡并接着干，子卡只继承原卡的入边依赖、不指向被挂起的伞卡（避免死锁）；同一条拆分链最多自动拆两次，第三次拒绝并告警等人处理。评审触发的再拆还要先过"异构共识"——拉 2+ 不同厂商的 agent 复核拆分方案，全同意才落，有异议就暂停告警（人在环上，不在环里）。(US-AGENT-042 / US-AGENT-041) `[autonomous-evolution]`

- **暖会话复用收窄到同一卡重试**：默认仍关闭；即使开启，也只会在同一张卡重试时恢复先前会话，跨卡继续冷启动，避免把上一张卡的旧上下文带偏当前交付。(FIX-369 / FIX-370 / FIX-371) `[loop-engine]`

- **Dream 代码结构扫描改走确定性 TS/AST pre-scan**：`roll dream run-once` 现在会在 agent 前生成 `.roll/dream/structure-scan.json`，用 TypeScript 引用图、AST fingerprint 和 AST env 解析给死代码、不可达分支、重复结构、单实现抽象和 env 文档缺口提供机器证据；agent 消费该 artifact，不再靠 grep 式临场判断兜底，文档类扫描保持原流程。(US-LOOP-080) `[loop-engine]`

- **web 控制台新增机器级 Tools 页**：一处看全所有内置工具（bash / browser / git / github / network / fs / mcp）、各自的能力与默认护栏（超时 / 沙箱 / 重试 / 每周期上限），和 Agents、Skills 同级，挂在 `MACHINE › …` 面包屑上。中英文 Overview 指南与 Tools & policy 指南都已指向这个新页面。(US-TOOL-016 / US-TOOL-017 / US-TOOL-018) `[tools-layer]`

- **web 控制台改版：新的 Now 默认页 + 实时 loop 观察窗**：控制台打开后默认进「Now」运营视图（取代旧的 Overview），项目标签重排成 Now·Backlog·Loop·Release·Casting·Charter；Now 仪表盘重做后能正确反映当前是否有周期在跑（没有就明说「当前没有周期在跑」，不再把已完成的旧卡误标为进行中），并实时显示 loop 正在跑哪张卡、流到哪一步，On-Deck 与 Needs-you 列表的卡可直接点进各自卡页、Needs-you 显示真实总数并按失败/挂起分色，Live Stream 与 Loop Heartbeat 区域更大更易读；#loop 观察窗能实时看到每个周期的七段进度带、段内活动与闸门事件，报告与账本都按同一份活动流展示，处处口径一致。(US-DOSSIER-043 / US-DOSSIER-044 / FIX-373 / US-LOOP-078) `[delivery-dossier]`

## v3.619.1 — 2026-06-19

### 修复

- **`roll release` 可反复执行并自愈中断**：release 分支或 PR 已存在时不再失败，而是复用已有分支/PR 并跳过已完成步骤；auto-merge 已开启或 PR 已合并时幂等跳过；配合已有的 GraphQL EOF 重试 + REST 回退，一次网络抖动不再毁掉发版。(FIX-330) `[release]`

- **多智能体评审更扛抖动**：`roll peer` 和 `roll loop go --review auto` 现在会按排序依次尝试多个异构 reviewer，单个 agent 超时或崩溃时自动换下一个，不再因为一次失败就误判为无可用 reviewer 或终止终审。(FIX-336) `[pairing]`

- **审计并清理 v2→v3 "假 Done" 死 bash 引用**:系统扫描技能合约与文档中已退役的 `source "$(command -v roll)"` 和 `_loop_*` bash 调用,确认 US-AGENT-008/009 的 self-downgrade 能力在 v3 缺失并退回状态;技能审计新增 `dead-bash-ref` 回归闸,`roll skills audit --strict` 不再允许新的死 bash 引用进入 skill 合约。(FIX-364) `[feedback-truth-alignment]`

### 新功能

- **工具层类型契约落进 spec**:新增 ToolId/ToolDeclaration/ToolInvocation/ToolResult/ToolPolicy/ToolCost 等共享类型,并让 CycleCost 可挂载 toolCosts,为后续 registry、policy 和 adapter 层提供同一套类型词汇。(US-TOOL-001) `[tools-layer]`

- **工具注册表核心落地**:新增 core/tools ToolRegistry 与 Tool 接口,统一 register/invoke/shutdown/snapshotCosts 路径,把 policy、预算、事件、retry 和成本累计都收进可测试的核心层。(US-TOOL-002) `[tools-layer]`

- **工具策略从 policy.yaml 解析**:新增 ToolPolicyEngine,从 `.roll/policy.yaml` 的 `tools:` section 解析 enabled、timeout、retry、预算和 sandbox 字段,未知字段只告警不拒绝。(US-TOOL-003) `[tools-layer]`

- **Bash 工具适配器落地**:新增 infra BashTool,通过 argv-only exec seam 执行命令,支持 cwd allowlist、timeout、输出截断、advisory blockedCommands、secret redaction 和 `.roll/tool-dumps/` dump。(US-TOOL-004) `[tools-layer]`

- **Browser 工具适配器落地**:新增 infra BrowserTool,同一 adapter family 提供 `browser.screenshot`、`browser.console`、`browser.dom-query`,支持 allowedOrigins/headlessOnly sandbox、headless/GUI lane、honest skip 和共享队列。(US-TOOL-005) `[tools-layer]`

- **Git 工具适配器落地**:新增 infra GitTool,同一 adapter family 提供 `git.commit`、`git.status`、`git.push`、`git.merge`,复用现有 git wrapper 保持命令语义不变,并让 `git.status` 支持成功静默事件。(US-TOOL-006) `[tools-layer]`

- **GitHub 工具适配器落地**:新增 infra GitHubTool,同一 adapter family 提供 `github.pr`、`github.ci`,复用现有 gh CLI wrapper 处理 PR 创建/状态/合并与 CI 状态/重跑,保持 GitHub 调用语义不变。(US-TOOL-007) `[tools-layer]`

- **Filesystem 工具适配器落地**:新增 infra FsTool,同一 adapter family 提供 `filesystem.stat`、`filesystem.read`、`filesystem.write`,按 allowedPaths 管控路径,支持相对路径按项目根解析、读截断和写入前 redaction。(US-TOOL-008) `[tools-layer]`

- **Network 工具适配器落地**:新增 infra NetworkTool,提供 `network.fetch`,支持 timeout、policy retry、allowedOrigins、network blocked、redirect follow 和 HTTP proxy 环境变量,让 HTTP 探测走统一工具治理路径。(US-TOOL-009) `[tools-layer]`

- **MCP 工具适配器落地**:新增 infra McpTool,提供 `mcp.call`,支持 `.roll/mcp-servers.json` 与 `policy.yaml tools.mcp.servers` 配置、lazy connection reuse、dispose 断开、policy disabled 拒绝和 server unavailable 诚实错误分类。(US-TOOL-010) `[tools-layer]`

- **工具调用事件与成本观测收紧**:ToolRegistry 的 `tool:result` 事件改为只发布脱敏结果事实,失败结果即使 `emitsEvents:false` 也会留痕;CLI 无 cycleId 的工具调用不计入 per-cycle ToolCost,cycle:end 可携带工具成本快照。(US-TOOL-011) `[tools-layer]`

- **CLI 展示工具调用时间线与成本摘要**:`roll loop status`、`roll cycle` 和 attest report 现在会从事件流/CycleCost 展示工具调用摘要、失败 errorCode 与工具成本 breakdown,并保留原生币种显示,避免把人民币成本误标成美元。(US-TOOL-012) `[tools-layer]`

- **网页 Loop 账本展示工具调用轨迹**:Truth Console 的 Loop cycle 行现在在成本列旁露出工具摘要,展开后展示每次工具调用、失败 errorCode 和按原生币种标注的工具成本,截图证据可直接证明 USD 与 CNY/RMB 不会混标。(US-TOOL-013) `[tools-layer]`

- **既有 infra 调用迁移到工具治理路径**:process exec、git/gh wrapper 和默认 web screenshot 现在会经 infra tool delegation seam 执行,保留原命令语义的同时向 events.ndjson 追加脱敏 tool invoke/result 事件。(US-TOOL-014) `[tools-layer]`

- **工具层文档和状态命令落地**:新增英文/中文 Tools guide 与 `roll tool status`,用户可以查看注册工具、有效 policy 状态、CLI/Dashboard 工具用量入口和原生币种成本边界。(US-TOOL-015) `[tools-layer]`

## v3.618.3 — 2026-06-18

### 修复

- **showcase 在全局安装下 agent probe 崩溃**:`rollBin()` 定位到全局包的 `conventions/` 而找不到本地 `roll.js`，子进程直接崩掉判所有 agent 不可用；现加回退：本地不存在时走 PATH 的 `roll`。`[showcase]`

- **退役未成熟的生产巡检与 owner 简报**:从活跃 skill 目录、skill 面板、站点 skill 地图和核心 patrol 代码中移除 `roll-sentinel` 和 `roll-brief`，停止将其作为当前核心能力呈现；通用 sentinel 概念(截屏/PAUSE/默认值)原样保留。(FIX-356b) `[skills]`

## v3.618.2 — 2026-06-18

### 改进

- **showcase 默认选角全部国产化**:builder/reviewer/scorer 默认改为 kimi/reasonix/pi，不再混用国外 agent；reasonix 补入 agent vendor 注册表。`[showcase]`

## v3.618.1 — 2026-06-18

### 新功能

- **Reasonix agent 支持**:新增 DeepSeek 原生编程 agent 接入,`roll loop` 可选用 reasonix 跑 worker,与 pi/kimi 同等待遇;agent 注册表、展示名、smoke 检查和 loop spawn 全部贯通。(US-AGENT-002, FIX-359) `[agents]`

- **跨卡暖上下文(默认关闭,lever-4)**:codex 会话在相邻 cycle 之间复用,省去每轮冷启动重读近千万 token 的仪式开销——实测 execute 阶段大头就在冷上下文。默认 OFF,需手动开启;关闭时零影响。(lever-4) `[loop-engine]`

### 修复

- **评审闸不再误杀合理的大改动**:之前评审闸在异构评审真正跑完、写出证据之前就检查,导致任何跨多个模块或超过 3 个文件的合理改动(哪怕真做了不同厂的异构评审)都被判"没评审"而让整轮失败——loop 因此交付不了任何实质性大改。现在改成"评审先跑、闸后查":异构评审写出证据后闸才检查,真评审过的大改正常通过;没有异构评审者的单 agent 场景仍走原有的自评兜底。(FIX-362) `[loop-engine]`

- **国内模型的成本不再被当美元记账**:deepseek/pi/kimi 等按人民币(¥)结算的模型,`roll cycles`、`#loop` 看板、`roll status` 等所有成本展示面现在显示正确币种符号(¥),不再硬编码 `$`;`runs.jsonl` 新增 `cost_currency` 字段记录币种;混币种视图(¥+$)按币种分别汇总,不盲目相加。(FIX-361) `[cost]`

- **不再误拉 IDE 配置目标当评审者**:agy 在 headless 环境反复弹 Google OAuth 登录框——已禁用它当评审者(`canReviewHeadless=false`),止住弹窗拖垮 cycle;agy 仍留注册表可手动使用。(FIX-360) `[pairing]`

- **结对评审池只收能 headless 运行的 reviewer**:`roll pair init`、pairing selector、Review Score 和 peer-gate retry 现在共用 agent profile 的 `canReviewHeadless` 能力;Cursor/Trae 这类 IDE 配置目标不再进入评审/评分候选池,避免选中后 spawn 不出 verdict 拖垮 cycle。(FIX-328) `[pairing]`

- **"接着上一张卡的思路开干"加了防越积越多的保险**:这个提速功能(默认关闭)原本每个循环都会把工作记忆传给下一张卡,一张接一张连环传下去,会让后面的卡背着越来越多前面卡的旧思路、越跑越偏。现在只有"从零开始"的循环才会留记忆,最多隔一张卡传一次,不会再连环累积——把这个开关做成了"开了也不会越用越糟"。(FIX-355) `[loop-engine]`

- **暖会话捕获不再因发布失败而丢失**:以前 cycle 没干净交付保留工作树时暖会话捕获被跳过;现在挪到 agent 退出后立即执行,无论 publish/preserve 结果都记录。(FIX-354) `[loop-engine]`

- **循环现在能看出"花多久才动第一笔"**:以前一个循环从开工到产出第一处改动之间是一段黑箱(只有固定心跳),看不出 agent 摸索仓库用了多久,也就没法判断"预构建/项目地图"这类提速开关到底有没有用。现在加了一个"首次落笔"标记,把开工→第一处改动的耗时单独标出来,让提速效果可量、可证伪。(FIX-357) `[loop-engine]`

- **发版与发布扛 GitHub API 瞬时抖动**:`roll release` 和 runner publish 遇 gh GraphQL EOF 不再直接崩溃——先重试再回落 REST,网络抖动可自愈,不需人工收尾。(FIX-353) `[release]`

- **事件流时间戳统一为毫秒**:阶段事件用毫秒而结对闸与周期终态用秒的静默不一致已修复——所有时长计算现在归一,不再暗中打坏。(FIX-352) `[loop-engine]`

- **`roll brief` 已退役**:这个 owner 简报能力面尚未成熟,直接移除避免误导。查看项目状态请用 `roll backlog` 或 `roll status`。(FIX-356a) `[loop]`

### 改进

- **技能可视化图谱页面**:站点新增技能关系图浏览页,展示技能之间的依赖与调用关系。(#795) `[site]`

## v3.617.2 — 2026-06-17

### 修复

- **各类 agent 的展示、用量和 smoke 行为改走统一注册表**:模型名、实时观察窗、usage recovery、dashboard 回填、pairing 成本和 loop smoke 不再散落写 claude/pi/kimi/codex 特判;新增 agent 只需补 AgentSpec,非 claude 不再显示成 `?` 或被 mock smoke 降级。(FIX-313) `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-313/latest/FIX-313-report.html -->

- **Loop 页的"已合并显示"这次真生效了**:上一版加的"PR 合了 → 显示绿色"其实是哑的——一个缓冲区上限太小的 bug 让它读不到 git 记录、静默失效;现在已合并的交付会正确显示为已交付(绿),且只按这个循环自己开的 PR 判定,不会被别的 PR 误判成绿。(FIX-349, FIX-348, FIX-350) `[loop-observability]`

- **重复的故事编号当场拦住**:同一个编号被两个地方使用时,不再静默读到错的卡;新增一个 CI 检查,扫到重复编号就报错。(FIX-340) `[loop-engine]`

- **发布没成功的循环不再误标"失败"**:循环把活干完、过了质量闸,但因为临时的 GitHub 故障没能开 PR 时,现在显示"未发布"(中性灰),不再误显示成"失败"(红);`roll loop run-once --help` 也改为显示帮助,不再误跑一个循环。(FIX-351) `[loop-engine]`

### 性能(可选,默认关闭)

- **两个 execute 提速开关(默认关,需手动开启)**:`prebuild_dist`(循环工作区一建好就预构建,省 agent 找入口的往返)和 `project_map`(spawn 时给 agent 注入精简的仓库结构 + 本卡相关文件,省它摸索)。对所有 agent 通用、不破循环隔离;不开就完全没影响。(FIX-338) `[loop-engine]`

## v3.617.1 — 2026-06-17

### 质量与可信

- **代码质量评分改由独立评审给出,做事的 agent 不再给自己打分**:每次交付的质量分,现在由另起一个**全新独立会话**的评审 agent 来打——哪怕是同一种 agent,也必须是独立的新会话(不是当前会话、也不是它派生的子代理)。做事的 agent 不再自评,评分更可信、防自我美化;评分阶段也不再偶发漏分而把成功交付误判为失败。(FIX-343, FIX-342) `[acceptance-evidence]`

### 可见性

- **Loop 页能看见本仓所有活循环了**:backlog、PR、Dream 和 go 会话都在同一区里。(US-DOSSIER-042) `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-042/latest/US-DOSSIER-042-report.html -->

- **四个机器信息页字体统一**:agents、skills、conventions、about 四个页面的字体字号向控制台看齐,整套界面视觉一致。(FIX-287) `[delivery-dossier]`

- **Loop 页:已合并的交付显示为已完成(绿色)**:PR 被合并后,Loop 页的循环状态会按真实合并结果显示为已交付,不再停在"待合并"的黄色。(FIX-347) `[loop-observability]`

### 修复

- **截图豁免必须写清理由**:只写 true 不再跳过截图要求。(FIX-309) `[loop]`
  <!-- evidence: .roll/features/acceptance-evidence/FIX-309/latest/FIX-309-report.html -->

- **项目档案不再把已合并故事显示成未交付**:本地 main 落后远端时,`roll index` 现在按远端主线判断交付状态。(FIX-308) `[dossier]`
  <!-- evidence: .roll/features/acceptance-evidence/FIX-308/latest/FIX-308-report.html -->

- **项目档案不再把所有项目都叫成 roll**:项目页头和项目切换器会按当前项目派生真实名称;未设置品牌名时优先取 git remote 仓名,再取项目目录名,APE-PR 等项目会显示自己的名字而不是统一显示为 roll。(FIX-307) `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/FIX-307/latest/FIX-307-report.html -->

- **纯后端/校验类的卡不再被误判为"空交付"**:没有可视界面、按规则豁免截图的卡,只要有文本证据(如测试输出)就正常通过验收,不再因"缺截图"被误杀。(FIX-345) `[acceptance-evidence]`

## v3.615.1 — 2026-06-15

### 修复

- **故事档案页的文本证据又能直接看了**:AC 下的 Vitest/test 输出等文本证据改回内联折叠展示,不用点开新页面;截图证据仍是缩略图点开看大图,文件缺失时显示明确空态。(FIX-285) `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/FIX-285/latest/FIX-285-report.html -->

- **项目页的选角和钩子信息按正确稿显示了**:Casting 区恢复 3+1 阶梯卡、ramp 竖条和场景角色三列布局;Loop 的 Hooks 区改为列本仓真实 git 钩子,不再把调度 lane 当成 hooks。(FIX-284) `[loop]`
  <!-- evidence: .roll/features/delivery-dossier/FIX-284/latest/FIX-284-report.html -->

## v3.614.4 — 2026-06-14

### 改进

- **循环实时流对所有 AI 都看得见了**:以前只有 claude 跑的循环能在实时窗里看到在干什么,换成 codex 等别的 AI 就是一片空白。现在用一套统一的"活动信号"把不同 AI 的输出都翻成同一种可读的实时流,还带进度心跳——哪个 AI、跑到哪一步都看得清,长时间没动静也不会让你误以为卡死了。(US-LOOP-077)

### 修复

- **"完成"必须是真合并了**:以前一轮循环可能把没合并进主线、甚至没通过测试的活,用"环境问题"当借口标成已完成。现在没真合并就不算完成,失败的一轮也不再被放过——测试红了就是红了,不拿环境当挡箭牌。(FIX-295)
- **复杂的活强制独立评审,不许自己评自己**:改动一多就必须有独立评审才放行——优先换一个不同的 AI 来评;如果你本机只装了一个 AI,就用它的另一个独立实例来评,只要不是同一个会话里自己给自己打分。拿不到独立评审就拦下重试,而不是偷偷降级成自评。(FIX-293)
- **几个 AI 能正常启动了**:agy、gemini 等 AI 之前因为启动参数顺序写反而起不来(连带它们参与评审也起不来),现在修好了。(FIX-296)
- **showcase 演示按你真实的环境识别 AI**:`roll showcase` 以前在一个空白沙箱里探测你装了哪些 AI,老是误报"没装";现在按你真实环境探测,装了哪些认哪些。(FIX-292)
- **循环页面只显示真正干过活的循环**:以前调度器每隔半小时"醒来发现没活、又睡下"的空转,也被当成一条循环显示在页面上,几百条把页面刷得没法看;现在只显示真正接了活的循环,循环编号也不再因为截取方式出错显示成负数(像 "-32144")。(FIX-297)

## v3.614.3 — 2026-06-14

### 改进

- **设计技能更严**:`roll-design` 现在把"详细设计"做成一道硬步骤——拆任务之前,必须先拿出能照着写的方案(数据结构、**至少一个完整样例**、接口、映射规则、边界情况)并经确认。规矩一句话:拿不出一个完整样例,就还没设计完。(US-SKILL-029)

### 修复

- 失败/空转的一轮循环现在也记下用了哪个模型:之前那条记录里模型是空的(只补过另一处、这条漏了),导致实时窗和循环账本看不到是哪个 AI 在跑;现在哪个都记上。(FIX-294)

## v3.614.2 — 2026-06-14

### 修复

- `roll loop go` 启动时会给清楚的反馈了:告诉你起的是哪个会话、在做哪些卡、第一轮起没起、怎么只读地看——之前只甩一句模糊的 "started" 就退出,你根本不知道开没开。会话复用时也会补上观察窗,attach 进去能直接看到实时流、而不是落在干活的窗口里。还能 `--attach` 直接在前台跟住实时流(此时 Ctrl-C 只停看、不停循环)。(FIX-289)
- 失败/空转的一轮循环现在也记下用了哪个模型、烧了多少 token、花了多少钱:之前账本那行只剩时间、其余全是 —;读不到用量时如实标"未知",不再假装成 0。而且每一轮结束(不管成没成)都会刷新项目网页,失败的循环不再在循环页里隐身。(FIX-290)
- 网页截图取证不再因为"本地没装 Chromium"就悄悄降级成纯文本:有图形界面时直接用系统截屏(打开浏览器截真窗口、真像素),没界面才用无头浏览器,都不行才如实记"没截成"——绝不拿文本冒充截图。(FIX-291)

## v3.614.1 — 2026-06-14

### 新功能

- **项目进展网页**:roll 现在把项目的真实进展做成一个网页,一眼看清正在做什么、合了没、验收了没。分六个标签——总览、项目章程、待办、循环、发版、谁演什么角色;另有几个本机通用的页(装了哪些 AI、有哪些技能、有哪些约定、roll 是什么)。每张卡片从"说要做"到"已合并"再到"已验收",一步步点亮。左上角能在本机所有用 roll 的项目之间切换。(US-DOSSIER-019~041)

- **命令行和网页看到的是同一份真相**:直接敲 `roll` 就有身份、当前状态和一张命令地图;`roll status` 先给结论;`roll cycles`、`roll cycle` 看每一轮各干了什么;`roll cast` 看哪个 AI 演哪个角色;`roll doc` 翻项目文档。命令行和网页用同一份数据、同一个数字。(US-CLI-010~018)

- **一条命令跑通整条交付线 `roll showcase`**:在一个用完即弃的沙箱里,让几个不同的真实 AI 各司其职——一个写、一个评审、一个打分——完整走一遍"接活→写→评审→拍验收图→合并→翻牌",每一步都留下看得见的证据。发版时可以顺手跑一遍(就算 AI 抽风也不卡发版)。(US-SHOW-001)

### 修复

- `roll loop go` 的预算和轮数上限,改成每次启动单独说了算,不再悄悄沿用上回的旧设置;空转的一轮不再被算成"花了不明的钱"而把整轮叫停。(FIX-280)
- 跑测试时不再把临时数据写进你真实的项目清单。(FIX-281)
- 修好了项目页里大量打不开的证据图片。(FIX-282)
- 项目切换器只列还在的项目;从机器页能一键回到项目主页;`roll init` 会自动登记项目。(FIX-283)

## v3.613.2 — 2026-06-13

### 稳定性

- `roll loop go` 的预算与运行上限改为每次启动显式设定：只取本次调用的 `--budget`/`--max-cycles`/`--for`，省略即本轮不设限，不再沿用上一次会话持久化的旧值（此前 flagless 连跑会继承几天前设的预算与单周期上限，一个 idle 周期即 budget_limited 收摊、整轮零产出）；scope/review 仍按需沿用（FIX-279） `[loop]`
  <!-- evidence: .roll/features/goal-mode/FIX-279/latest/FIX-279-report.html -->

- `roll index --rebuild` 不再把已合并故事页降级：delivered 判定补离线 git 合并真相（提交标题点名故事 id，或 `(#N)` PR 合并提交引用它），rebuild 无实时 PR 快照时也保住已合并卡的"已合主干·已验收"横幅与交付脊柱；选择器可提升但不再抹掉 git 证明已合的卡，Done 闸防止 Todo 卡被误提升（FIX-278） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/FIX-278/latest/FIX-278-report.html -->

## v3.613.1 — 2026-06-13

### 稳定性

- `roll release` 事务健壮性：任一步骤依赖抛错（提交闸拦截、网络故障…）都归为该步的有序中止而非裸栈；带测试证明提交闸的仓库（roll 自身）先刷新证明重试一次再提交（FIX-277，发版实战首跑揪出） `[release]`
  <!-- evidence: .roll/features/release-management/FIX-277/latest/FIX-277-report.html -->

- `roll setup skills` 在全局安装环境不再向安装树写 guide 文档撞 ENOENT 崩栈：安装树无目录清单可维护，单行提示后跳过；源码仓行为不变（FIX-276） `[cli]`
  <!-- evidence: .roll/features/documentation/FIX-276/latest/FIX-276-report.html -->

- cycle worktree 依赖安装失败会直接以失败终态和 `[FAIL] worktree deps bootstrap failed` ALERT 暴露，并清理空 worktree，不再继续烧 agent 后误落 `idle_no_work`（FIX-268） `[loop]`

### 新功能

- `roll release` 收口为唯一发版命令：一条事务（版本号→折叠 changelog→包闸→发版 PR→等合并→快进 main→一致性闸→推 tag），每个不可逆步骤前都有闸，失败 fail-loud 零半成品；ship/waiver/changelog/consistency 旧子命令物理删除（豁免路径不复存在——修掉漂移才能发）；CI 闸入口改 `roll release --gate-check`（US-REL-007） `[release]`
  <!-- evidence: .roll/features/release-management/US-REL-007/latest/US-REL-007-report.html -->

- 全站可复制命令芯片与数据新鲜度：周期账本行 → roll cycle、待交付行 → roll loop go/backlog promote、故事档案头 → 拾取命令（全部真实存在，点击 ✓ copied）；总览 generated 超 6h 亮"数据过期"警示，心跳 next 做客户端倒计时（US-DOSSIER-018） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-018/latest/US-DOSSIER-018-report.html -->

- `roll cycle <id>` 单周期轨迹带：摘要行+story 行+垂直七段（色点+事实摘要，中途死掉的段显示"未达"不省略）+ PR/diff/story 证据指针；与 web 轨迹带同形同词表（US-CLI-013） `[cli]`
  <!-- evidence: .roll/features/cli-simplification/US-CLI-013/latest/US-CLI-013-report.html -->

- `roll cycles [--since 1d|3d|7d|all]` 升一等命令：周期账本每行周期号·结局·story·模型·tokens·花费·耗时，汇总行失败=failed+reverted+blocked 不吞，尾部 → roll cycle 提示；与 web 账本同聚合同词表（US-CLI-012） `[cli]`
  <!-- evidence: .roll/features/cli-simplification/US-CLI-012/latest/US-CLI-012-report.html -->

- 技能页签：审计条（N skills·violations·hub 总行数，与 audit-skills --strict 同口径）、四组契约清单带调用频次（自评分 note 口径），行展开看真实文件树（行数）、审计要件勾选、可复制目录路径与 SKILL.md 原文滚动区；清单从仓库目录实读防漂移（US-DOSSIER-017） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-017/latest/US-DOSSIER-017-report.html -->
- 发版页签待交付与变更日志：待交付按史诗分组（行点进档案），变更日志从 merged PR 真相生成（pr:merge 事件优先、Done 行 PR# 注记兜底，行带 #N merged 证据链）；页底历史版本可折叠展开（含曾豁免标记）；闸门头 merged/pending 与两段同算术（US-DOSSIER-016） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-016/latest/US-DOSSIER-016-report.html -->
- 发版页签六维一致性面板：闸门头（tag·判定·f/w/?·切版·上一版·merged/pending 进度条）+ 六维对账行（漂移卡可点跳待办搜索），合计与状态行严格同数，任一维 fail 明示挡发版；⑦data 维以提案虚线行呈现并链 FIX-248/249；附可复制 roll release consistency check 芯片（US-DOSSIER-015） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-015/latest/US-DOSSIER-015-report.html -->
- 循环页签本机 agents 面板：每行运行器·版本·近72h周期与花费·可用状态（未检测置灰），展开看接入文件同步真相（✓/⟳/−），约定过期带琥珀标与可复制 roll setup 修复命令（US-DOSSIER-014） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-014/latest/US-DOSSIER-014-report.html -->
- 循环页签周期账本：Today/3d/7d/All 范围切换实时重算（失败=failed+reverted+blocked 不吞），每行结局点·周期号·story·模型·tokens·花费·耗时，展开成 cycle→story→build→peer→ci→pr→end 七段轨迹带带证据（US-DOSSIER-013） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-013/latest/US-DOSSIER-013-report.html -->
- 待办页签重设计：愿望页头、搜索+六态筛选 chips（总览光谱点击预置）、史诗手风琴（交付中/已落定分组），故事行带类型徽标·ID·迷你脊柱·claim↔truth 对照；epic/story 面包屑根改 Backlog 页签（US-DOSSIER-012） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-012/latest/US-DOSSIER-012-report.html -->
- 看板升级五页签真相控制台：总览页三十秒读完判定条、循环心跳、三聚合卡与六态光谱，页签 hash 路由下钻返回不丢；品牌与 slogan 注入式；旧 ledger 暂驻待办页签（US-DOSSIER-011） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-011/latest/US-DOSSIER-011-report.html -->
- 真相口径同源：`roll index` 一次聚合产出 TruthSnapshot，同一序列化同时内嵌 index.html 并写出 `truth.json`（机器可读）；reverted cycle 纳入失败计数不再被吞（US-DOSSIER-010） `[dossier]`
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-010/latest/US-DOSSIER-010-report.html -->

### 性能

- 建卡与 `roll index` 提速 5.4 倍（实测 41s → 7.6s，产物字节级不变）：索引一次树遍历、每卡 3 次 git 扫描合并为一次快照、全局趋势与反向依赖一次计算（FIX-275） `[cli]`
  <!-- evidence: .roll/features/loop/FIX-275/latest/FIX-275-report.html -->
- 技能自评分改走 TS 原生命令 `roll self-score`，幂等可重试；不再让 agent 把 TS bundle 当 bash 库 source（FIX-274） `[skills]`
  <!-- evidence: .roll/features/skill-ecosystem/FIX-274/latest/FIX-274-report.html -->

### 新功能

- 评分成为 pairing 场景：score 阶段由异构配对 agent 给交付打分（note 带 scored-by 溯源），无候选/超时回落自评，永不阻塞 cycle；`roll pair init` 默认开 code+score 两阶段（US-PAIR-009） `[pairing]`
  <!-- evidence: .roll/features/cross-agent-pairing/US-PAIR-009/latest/US-PAIR-009-report.html -->
- `roll pair score <story>` 手动让配对 agent 打分；`roll self-score` 新增 `--fallback-reason` 记录回落原因；三技能契约改"配对优先、自评回落"，结对指南中英双轨更新（US-PAIR-010） `[pairing]`
  <!-- evidence: .roll/features/cross-agent-pairing/US-PAIR-010/latest/US-PAIR-010-report.html -->

## v3.612.2 — 2026-06-12

### 稳定性

- `roll loop go` 撞上运行中的 cycle 不再秒停，等锁释放后接着跑（FIX-269） `[loop]`
  <!-- evidence: .roll/features/goal-mode/FIX-269/spec.md -->
- cycle worktree 在 agent 进场前先装好依赖，离线沙箱里测试也能跑（FIX-268 根因预防） `[loop]`
- `roll attest --capture-command` 截图后不再弹 macOS 终止进程确认
  <!-- evidence: .roll/features/acceptance-evidence/FIX-266/latest/FIX-266-report.html -->

## v3.612.1 — 2026-06-12

### 新功能

- `roll loop go` — 连续跑 backlog 到完成或暂停（US-GOAL-002） `[loop]`
  <!-- evidence: .roll/features/goal-mode/US-GOAL-002/latest/US-GOAL-002-report.html -->
- `roll loop goal` — 查看目标、安全闸和最后裁定（US-GOAL-001） `[loop]`
  <!-- evidence: .roll/features/goal-mode/US-GOAL-001/latest/US-GOAL-001-report.html -->
- `roll peer` — 一次性外部评审有结构化记录（FIX-255） `[loop]`
  <!-- evidence: .roll/features/goal-mode/FIX-255/latest/FIX-255-report.html -->

### 可见性

- 交付档案新增真相板，一眼看 Story/Cycle/Release（US-TRUTH-011） `[truth]`
  <!-- evidence: .roll/features/feedback-truth-alignment/US-TRUTH-011/latest/US-TRUTH-011-report.html -->
- epic 页能直接打开总览设计文档（US-DOSSIER-009）
  <!-- evidence: .roll/features/delivery-dossier/US-DOSSIER-009/latest/US-DOSSIER-009-report.html -->
- 主帮助只显示常用命令，机器入口收进对应分组（REFACTOR-052） `[loop]`
- 帮助与文档已跟 goal/peer 新命令对齐（US-GOAL-007）
  <!-- evidence: .roll/features/goal-mode/US-GOAL-007/latest/US-GOAL-007-report.html -->

### 自动化流水线

- goal 完成前按主干证据裁定，不再提前报 Done（US-GOAL-003） `[loop]`
  <!-- evidence: .roll/features/goal-mode/US-GOAL-003/latest/US-GOAL-003-report.html -->
- goal 无进展会跳卡报警，不再空转烧熔断（US-GOAL-004） `[loop]`
  <!-- evidence: .roll/features/goal-mode/US-GOAL-004/latest/US-GOAL-004-report.html -->
- goal 连跑有预算、用量和时间盒安全闸（US-GOAL-005） `[loop]`
  <!-- evidence: .roll/features/goal-mode/US-GOAL-005/latest/US-GOAL-005-report.html -->
- goal 完结前有异构终审，降级也会留痕（US-GOAL-006） `[loop]`
  <!-- evidence: .roll/features/goal-mode/US-GOAL-006/latest/US-GOAL-006-report.html -->
- `roll loop resume` 清失败计数，不再恢复即熔断（FIX-251） `[loop]`
  <!-- evidence: .roll/features/loop-engine/FIX-251/latest/FIX-251-report.html -->
- loop 出网预检不再依赖 macOS 默认缺失的 GNU `timeout`，避免直连正常时误报 `egress blocked`（FIX-257） `[loop]`
- 调度环境残留会被体检指出，不再静默污染 loop（FIX-232） `[loop]`

### 稳定性

- `roll loop go --cards` 不再沿用上次暂停的全量范围（FIX-259）
- goal 失败原因现在直达状态页，不再只剩 `no_cycle_terminal`（FIX-260）
- 验收证据不再只靠文字声明，缺截图会被指出（FIX-258）
- `roll attest --capture-command` 不再把失败命令当验收通过（FIX-263）
- `roll attest --capture-command` 相对路径按项目目录执行（FIX-262）

### 工程和测试

- `roll attest` 现在识别新卡的验收清单（FIX-261）
  <!-- evidence: .roll/features/acceptance-evidence/FIX-261/latest/FIX-261-report.html -->
- 新 worktree 跑 `roll test` 会自动补齐 skills（FIX-264）
- goal/off/pause 的文档讲清了和定时 loop 的关系（FIX-256）


## v3.611.2 — 2026-06-11

### 事实对齐(US-TRUTH 史诗全量交付)

- 字段级事实权威矩阵:十类持久事实各自声明唯一权威源/唯一写者/冲突仲裁/unknown 判据,跨仓仲裁 github_pr_merge > product_main > roll_meta(US-TRUTH-000) `[truth]`
- 周期终态事件 schema v1:每个事实字段要么有完整值要么带枚举化缺失原因,静默 0/"—" 在结构上不可能;被杀周期也能推导终态(US-TRUTH-001) `[truth]`
- 影子一致性审计 `roll consistency audit`:七条漂移规则只读扫描,fail/warn/unknown/grandfathered 分级,报告落盘不报警不拦截(US-TRUTH-002) `[truth]`
- 真相选择器:story/cycle/evidence 三类结论由纯函数统一推导,闭合 reason code,真实漂移案例冻结(US-TRUTH-003) `[truth]`
- 读侧三件套(dashboard/dossier/status)统一走真相适配器,unknown 一律显示 ?,绝不静默装成功(US-TRUTH-004) `[truth]`
- 发版闸接入审计:fail 级漂移拦截发版;owner 豁免必须记录原因/范围/期限/操作者并进事实流,过期失效(US-TRUTH-005) `[truth]`
- 变更点护栏:落盘字段必须登记权威语义,未登记字段 CI 红灯并指路登记(US-TRUTH-006) `[truth]`

### 稳定性

- 死循环必须尖叫:连续异常 tick 触发 ALERT(带首末时间),恢复自动注记;gh_error 落底层错误首行(FIX-233) `[loop]`
- 观察窗锚定本次 cycle:live.log 周期起始重置,不再回放上个周期的旧转录(FIX-237) `[loop]`
- agent 自开 PR 被运行时收编登记并记违纪日志,绝不重复开 PR;skill 硬闸同步(FIX-245) `[loop]`
- `loop off` 清扫全部 com.roll.* 僵尸 lane;`roll doctor` 列出全部 lane 及指向/加载态,陈旧标红(FIX-234) `[loop]`
- 门禁判死 ≠ 产物丢弃:带提交的失败周期把分支推上远端可审计可营救;明确裁定不自动复用(FIX-247) `[loop]`

### CLI 契约

- 统一求助契约:--help 一律只读(update --help 曾真执行升级!)、stdout 用法、exit 0;未知子命令 stderr+非零;报错带上标志名(FIX-238/239) `[cli]`
- loop 用法行只列现役子命令,monitor/attach 退役项移除(FIX-240) `[cli]`
- `roll story new` 成为真正的单一建卡入口:卡夹+backlog 行+索引刷新一步完成,--no-index 支持批量(FIX-250) `[cli]`

### 文档

- 两份 README 命令表与现役注册表逐项对齐(中英一致),新增 README-vs-registry CI 防漂测试(FIX-241) `[docs]`
- methodology/loop 指南子命令清单更新为现役全集,退役 branches 指到 git ls-remote(FIX-242) `[docs]`

### 其他

- 裁定删除 FIX-235(premature Done 已由审计+闸覆盖)与 FIX-236(TCR 闸一次性事件未复现);backlog 全量清零

## v3.611.1 — 2026-06-11

### 稳定性

- 漏写验收意图映射不再整批枪毙交付:补救通道让同一 agent 当场补写 ac-map 再过闸,诚实红线不动(FIX-246) `[loop]`
- 新终态"已发布待合并"终结幻影失败与发布即 Done:连败计数只数真正无产出的失败,loop 不再因成功而停摆(FIX-244) `[loop]`
- 合并证据回填接进每个 cycle 收尾:失败/待合并的历史记录在 PR 真合并后自动翻账为已交付(FIX-243) `[loop]`

### 可见性

- 周期记录补上 tokens/成本/模型字段,claude 流式、页脚刮取、pi 会话恢复三条适配通道全部接通;预算护栏改由真实成本驱动,烧钱有上限感知(FIX-249) `[loop]`
- 状态面板按 v3 词表如实分类:十四个失败不再显示成零,ROLLUP/RECENT/agents 三区段同窗口同口径(FIX-248) `[loop]`

## v3.610.2 — 2026-06-10

### 可见性

- 改变交付真相的节点不刷新看板聚合页，新卡新状态要等手动重建索引才出现，看板静默滞后（FIX-231） `[loop]`

### 自动化流水线

- loop 复用陈旧会话致 cycle 跑在冻结环境里，代理一关 agent 全部静默超时失败，连败到自动暂停（FIX-230） `[loop]`

### 其他

- 幻灯片功能整体下线——交付控制器不内置做 PPT；slides 命令、模板与文档全部移除（US-CLI-008）
- 退役一次性迁移命令 archive migrate 与 migrate-features（能力分别归 gc 与 story new）；roll migrate 保留为 pre-2.0 项目升级路径（REFACTOR-048）
- bump skills submodule → 32d9f5c (roll-deck removed)（PR#574）
- docs(guide): port quality-rubric examples bats/bash → TS/Vitest（PR#570）
- docs(guide): de-migrate the guides — current Vitest/TS reality (round 2)（PR#569）
- reframe to current TS-native architecture (drop v2→v3 migration narrative)（PR#568）
- coverage tooling (@vitest/coverage-v8 + pnpm test:cov)（PR#567）


## v3.610.1 — 2026-06-10

### 稳定性

- 故事档案改"按节点增量挂载"为主路：各生命周期节点把当场已知的产出挂上页面，全量重渲降级为显式 rebuild 修复工具，根治"合了但页面没动"（US-DOSSIER-007）

### 可见性

- 历史交付卡 legacy 状态语义：pre-v3 已 Done 卡(无 latest/无 ac-map)派生 legacy 标记，状态仍=完成+历史 chip，脊柱不再读证据假装半成品（US-DOSSIER-008）
- backlog 状态机归一到单一强类型真相，渲染与调度与对账全部消费它，不再各自拿字符串猜状态（REFACTOR-047） `[loop]`

### 工程和测试

- 把 7 个曾比对旧引擎 oracle、现退化为确定性自校验的差异测试升级为真冻结期望快照（US-PORT-021b）

### 其他

- 把幻灯片渲染命令改写为 TS，脱离 bash 回落引擎（US-PORT-016）
- 把待办管理写端命令改写为 TS，脱离 bash 回落引擎（US-PORT-019）
- 所有命令脱回落后退役 bash 引擎并清残件（高爆破坏性收尾，人工放行）（US-PORT-021）
- release ship 的确认提示在新版 Node 上仍会卡住，敲回车没反应，目前只能用免确认参数绕过，需彻底修交互读取（FIX-229） `[loop]`
- dossier: redesign features index as a delivery board (status overview + foldable epics + lifecycle spine)（PR#560）
- dossier: align features index status/type with backlog + 3-state grouping (delivery board)（PR#559）

## v3.609.2 — 2026-06-09

### 可见性

- 交付档案首页改表格视图：epic 列表以 Epic / Progress / Stories 表格呈现，扫读对齐更顺（US-DOSSIER-005）
- 交付档案按证据标完成：迁移来的 V2 历史卡按其标题 ✅ 标记显示为已交付，不再因缺 v3 验收报告而全标未交付（US-DOSSIER-006）

### 其他

- changelog generate 剔除已在某版本段发布的故事，不再在 Unreleased 过度累积；纯 PR / 手工条目保留（FIX-227）
- roll release ship 的交互确认改为按行读 stdin，不再因等 EOF 在交互终端永久挂起（FIX-228）
- 把 loop 日志与事件的只读子命令改写为 TS，脱离 bash 回落引擎（US-PORT-022 part 1）

## v3.609.1 — 2026-06-09

### 自动化流水线

- 把 dream 调度剩余子命令改写为 TS，脱离 bash 回落引擎（US-PORT-020）
- 交付段补可重建证据轻量版，含合并请求与集成结论与改动与交付方与成本与时间线（US-EVID-008）
- 二阶闭环把成功率趋势回灌做自整定：roll tune 只读聚合 self-score/agent pass 率/误判/rubric 相关性，产阈值-路由-rubric 三类建议（仅建议、样本门+冷却防失真）（US-EVID-015）

### 工程和测试

- 确定性证据自动落盘，测试输出与覆盖率与产物都写进证据框（US-EVID-002）
- attest 从迁移后的多故事 epic 文件抽取验收条目返回空，致已有 ac-map 的 Done 故事渲染成零条 AC（US-PORT-001 实证），改 resolveStoryAcItems 越过空壳 owner 取真 AC 文件（FIX-226）

### 其他

- 把项目初始化命令改写为 TS，脱离 bash 回落引擎（US-PORT-013）
- 把技能挂载与约定分发命令改写为 TS，脱离 bash 回落引擎（US-PORT-014）
- 把在线刷新模型价目的命令改写为 TS，脱离 bash 回落引擎（US-PORT-017）
- 把切换与设置 agent 的写入命令改写为 TS，脱离 bash 回落引擎（US-PORT-018）
- 修退役命令引用并立一页新手上手指南（US-DOC-GS-001）
- 证据框在每个周期开头就立好，运行目录与证据归处先备好交给执行用（US-EVID-001）
- 瞬态证据当场采，改前改后与验证时各截一张成对入框（US-EVID-003）
- 收尾时由运行器确定性组装验收报告并刷新档案，不依赖代理记得（US-EVID-004）
- 验收硬闸默认开启，标完成却无报告从提醒升级为发版闸拦截（US-EVID-005）
- 证据生命周期相关文档中英双轨刷新收尾（US-EVID-006）
- 档案脊柱口径对齐，老的已完成卡一次性补跑回填证据（US-EVID-007）
- 自评分作为评分门禁参与通过与否，回归或低分能真的拦下完成（US-EVID-013）
- 无人值守执行器，出错先归因再自动纠正，默认保守且不自动合主干且振荡移交刹车 — report: `.roll/features/acceptance-evidence/US-EVID-014/2026-06-08T23-03-10/US-EVID-014-report.html`
- 无人值守安全刹车，同卡反复退回自动熔断暂停并加一页夜间运行晨报 — report: `.roll/features/acceptance-evidence/US-EVID-016/2026-06-08T23-54-55/US-EVID-016-report.html`
- 跨代理结对的中英双轨文档刷新收尾（US-PAIR-007）
- roll init 顺带生成 pairing 配置并在界面告知，新用户少一步且仍显式（US-PAIR-008）
- site: roll-build explainer page (site-aligned, bilingual) + homepage CTA（PR#546）
- site: track site/diagrams/ + roll-build skill infographic（PR#545）
- site: roll-build 技能卡可点击跳转讲解页（PR#547）

## v3.608.2 — 2026-06-08

### 跨 Agent 结对（异构第二双眼睛）

- 结对成为一等能力：交付后由一个**不同厂商**的 agent 单向复检改动，换视角多样性——理性挑选（只挑已装+可用+胜任+异构）、可复现轮换、无搭档如实留痕不静默（US-PAIR-001/003）`[pair]`
- `roll pair init` 物化显式 `.roll/pairing.yaml`：文件在=开、删=关，默认值写进文件而非隐藏；`roll init` 也顺带生成，新项目零额外步骤，现有项目一条命令补上（US-PAIR-001/008）`[pair]`
- `roll pair status` 看结对池：谁能结对、厂商、能力、谁因何被排除，外加**结对花了多少钱**（次数/搭档/成本），可观测不靠猜（US-PAIR-002/006）`[pair]`
- 多阶段结对：设计/测试/代码/周期四个检查点可独立开关，默认仅代码（US-PAIR-004）`[pair]`
- 配对越用越准：成本真实记账 + ε-greedy 偏好高命中异构对但保底探索不锁死多样性（US-PAIR-006）`[pair]`
- 安全底线：30 秒硬超时、超时/出错不阻塞 cycle、绝不自行动主干（US-PAIR-003）`[pair]`

### 可见性

- 故事档案 = 一个故事的全部上下文入口：页顶 As a / I want / So that 原语 + CONTEXT + AC 内联 + 显眼可点的设计文档链接（US-DOSSIER-003）
- 设计文档链接打开 markdown 渲染页而非裸文件（US-DOSSIER-004）
- 验收证据可重跑：每条 AC 配一条任何人能照着重跑的验证命令 + 测试清单，证据从"看截图"升级到"自己能验"（US-EVID-010）

### 工程和测试

- `roll ci --wait` 移植到 TS：CI 等待门脱离 bash，逐轮裁定镜像 v2 顺序（US-PORT-015）
- `roll release ship` 一条受闸命令完成 tag-push（发版第 4 步），一致性闸把关，npm publish 仍人工（US-REL-SHIP）
- cleanup：`.codex/`、`.worktrees/` 进 .gitignore（per-machine 状态不入库）

## v3.608.1 — 2026-06-08

### 自动化流水线

- 非 claude agent 的 loop 观察窗不再黑屏：套伪终端逐行直播，进程组清杀不留孤儿（FIX-224） `[loop]`
- 断网不再误伤：网络不可达时周期降级为本地交付，输出提示而非报错，连败不累计、不误触自动暂停（IDEA-001） `[loop]`

### 可见性

- 三层交付档案：roll index 重建首页总账（愿望→事实进度）、史诗页、故事五站档案，全部来自真实模型可逐层下钻（US-DOSSIER-001a~d）

### 工程和测试

- 验收命令认出卡片文件夹布局：别处一句提及不再劫走归档位置，报告与 AC 解析归位（FIX-225）
- 旧档案树退役收尾：卡片文件夹成为运行产物唯一的家，读取兼容移除（US-META-002c）
- 卡片契约进发版闸：活卡必须有卡片文件夹、证据链接不许悬空，史前卡只计数不拦截（US-CONSIST-006）
- 铸卡单一通道：roll story new 一条命令建卡，拒绝覆盖；每次验收收尾自动刷新档案索引（US-META-009）
- 自评笔记归卡：故事自评住进卡片文件夹，看板趋势与档案复盘双源合并读（US-META-008）
- 发版就绪判定认两种形态：Unreleased 段或预写好的下一版本段都算 changelog 就绪（FIX-226）
- 文档与官网一致性清扫两轮：档案单一家、四槽路由、降级模式、六维闸全部对齐实现（指南中英 + skills + README）

## v3.607.2 — 2026-06-07

### 自动化流水线

- 无技能子模块的项目跑 loop 找不到技能、选 agent 无视项目配置；补全局技能兜底、读项目配置选人、新增 pi 接管（FIX-221） `[loop]`
- loop 选 agent 被项目级单一默认一票否决：所有难度档坍缩成一个 agent，难题不再给 claude；装机探测永真空转；按 v2 链路修复（FIX-223） `[loop]`
- 非 claude agent 的 loop 接管命令全量 port（kimi/codex/deepseek/qwen/agy/gemini/antigravity）（US-PORT-010）
- roll loop now 手动触发降噪：交互终端只看关键节点，不再被逐行 JSON 淹没（FIX-220） `[loop]`

### 工程和测试

- difftest 卸 oracle 收尾：全仓断言测试期不再起任何旧引擎，桥接表与文档记 oracle 卸任（US-PORT-009e）
- 看板冻结测试时钟钉死：快照不再随墙钟与时区漂移，任意日期任意时区可复现，提交闸不再被误堵（FIX-222）

### 其他

- 验收卡史诗归属适配新档案布局：两级目录解析收敛为单一解析点（PR#513）

## v3.607.1 — 2026-06-07

### 可见性

- detectLiveCycle 僵尸周期污染：无 cycle:end 的僵尸周期被误判为"当前正在运行"，叠加 state.current_item 过期，dashboard 头行显示已交付数小时的旧故事；已加 >2h 僵尸跳过+最近活跃优先（FIX-217） `[loop]`

### 其他

- 验收闸查旧档案位：迁移后真报告被判缺失，硬闸假阴性逼出双账，闸址改与写端同源（FIX-216） `[loop]`
- roll peer mktemp 竞态 + 解析器无法解析自然语言决议；已加 PID 防竞态 + prompt 要求 Resolution: 行 + 解析器优先读该行（FIX-219） `[loop]`
- 层层嵌套索引站：从总览到史诗到卡片到报告全程可点击浏览（US-META-003）
- 建卡时自动生成 story 定义文件和全景报告骨架，后续阶段逐步填充（US-META-005）
- 交付与终评产物写入 story 文件夹，与验收报告同处一层（US-META-006）
- 存量 story 数据迁移命令：补定义文件、建文件夹、跳过多故事文件并保留反向引用（US-META-007）

## v3.606.3 — 2026-06-06

### 新功能

- 档案制写入端：待办与交付物同夹的布局支持，含编号到史诗的索引与垃圾回收命令（US-META-001）

### 稳定性

- 版本探针读冻结引擎的化石串：version 显示旧号、update 自检误报、升级 nag 永不消失，三症同根（FIX-202） `[loop]`

### 可见性

- 完成状态抢跑：PR 还没合并卡片就翻了完成，违反完成即已合主干的纪律（FIX-211） `[loop]`
- 面板对历史全瞎：周期记录缺时间戳，八次真实交付显示零，统计无从分桶（FIX-213） `[loop]`
- 面板对运行中的周期全盲：活性探测还读旧信号，真在干活却显示空闲零周期（FIX-203） `[loop]`
- (最小核) — roll loop now 改前台直跑:重入本 CLI run-once,agent 转录经 ROLL_LOOP_STREAM 实时打到当前终端(零 tmux 零弹窗零 tail);launchd 排程仍走静默 runner;buffered 用量采集不变 (#470)（US-PORT-011）

### 自动化流水线

- 终态失真：真实交付已合并完成，周期记录却写失败，失败语义被稀释（FIX-214） `[loop]`
- 无人值守周期自产实拍：给截屏调度器加终端通道，无图形环境时诚实跳过留痕（US-ATTEST-011）
- roll release v3 原生重写：版本号引导、changelog、PR 与 tag 流程提示；发版闸已在 CI（US-PORT-004）
- loop 读面子命令 TS 薄读取（eval、runs、story、signals）；tmux 流的 monitor 与 attach 退役（US-PORT-007）
- dream 服务出 v3 runner（复用调度模板模式）或裁定退役；现状是断链僵尸（US-PORT-008）
- loop cycle cycle-20260606-050516-6852 (#477)（PR#477）

### 工程和测试

- 迁移命令嵌套仓盲区：对私仓的搬迁打到主仓上，吞错自报成功，修执行面并补嵌套形态测试（FIX-215） `[loop]`
- 档案迁移命令：读索引按清单搬树改名重建链，演练模式先行，可重入有测试（US-META-002a）
- difftest 卸 oracle：领域服务层一批对拍全部转冻结期望，测试期不再起 bash 或 python 引擎（US-PORT-009b）

### 其他

- v3 心脏首跑即瘫：skill 路径化石致 agent 盲开、改动漏回主仓、被杀不留痕、cycle 不可观测；修解析+钉题+连 .roll+信号善后+tmux 观测窗（FIX-204） `[loop]`
- 交付可以悄悄跳过验收报告：文本约束没牙，缺报告要在运行时留痕可审计，政策可升硬闸（FIX-207） `[loop]`
- 排程静默死亡：启用命令吞掉挂载失败照报成功，三小时无 tick 全靠人肉掩盖（FIX-212） `[loop]`
- 验收证据惯例升级：文本证据属 agent 自述可伪造，CLI 卡默认改为真实终端截屏走独立捕获通道，文本降级为补充（US-ATTEST-010）
- 验收口径补全：失败与阻塞有名分、敏感信息进档前遮蔽、报告生成后冒烟自检（US-ATTEST-012）
- 验收报告分层且自含待办全貌：卡情上下文与业务结论在前技术折叠，空章节裁剪，设计审查不改证据（US-ATTEST-013）
- 过程内联进报告：时间线与关键转折加折叠全转录，无人过程也可回溯（US-ATTEST-014）
- 执行存量迁移：演练过目后真跑，重写唯一活引用，全仓对账校验存档（US-META-002b）
- skills 验收文案同步新档案布局，跨仓改 roll-skills 后 bump submodule manual-only（US-META-004）
- changelog 生成同输入两次运行结果漂移：探针偶发失败静默切换过滤分支，17 条目消失（FIX-199） `[loop]`
- 观测窗可读性：裸流换三层关键节点转录，信号口径与验收报告时间线同源（US-PORT-012）
- roll brief TS 化：汇报口吻保留，默认一屏精简、细节折叠，跟随 locale 单语；agent 经结构化流只取终稿，绝不漏思考过程（US-PORT-002）
- roll idea TS 化：分类、自动编号、过 lint 规则落卡，与 backlog 存取同源（US-PORT-003）
- changelog 确定性输出转正：AI 润色降级为可选路径或退役，默认不再回落 bash（US-PORT-005）
- config 写面 TS 化，整个 config 命令收口（US-PORT-006）
- difftest 卸 oracle 第一步：立可复用的冻结期望转换范式，先转规格层与基础设施层两批验证可行（US-PORT-009a）
- difftest 卸 oracle：命令行只读命令一批对拍转冻结期望（US-PORT-009c）

## v3.606.2

### 稳定性

- **修复 loop 在姊妹 worktree 布局下整体空转** — 项目身份此前会被解析到 git 主 worktree（对 roll 自身即 v2 冻结 checkout），所有周期在错误目录 idle；现在身份 = 当前 worktree 顶层，状态、日志、取卡全部回到正确项目

## v3.606.1

### 新功能

- **`roll attest` 验收证据链上线** — 每个交付的 story 可生成单文件验收报告：逐条 AC 判定（五档徽章）、证据卡片（截图 / 可搜索的 CLI 文本 / commit·CI·部署链接）、零证据强制降级红线 + 缺口附录；离线可开、可打印 PDF。web/iOS/Android 三端截屏各带前置自动跳过；同 story 自评条目折叠展示
- **发版一致性闸** — 每个 v* tag 在创建 Release 前先过 `roll consistency check`：任一维度对不上即中止发版，差异清单见 job 日志
- **loop 调度面 TS 化** — `loop on/off/pause/resume/now` 原生实现；`loop on` 生成自包含 v3 runner（周期心脏 = `loop run-once`）；`loop now` 检测旧版模板自动再生成后再跑（根治 command not found）

### 稳定性

- **backlog 状态端到端确定性** — 取卡即标 🔨 进行中、交付完成确定性翻 ✅ Done、崩溃残留的认领自动回收；普通项目（.roll 被 gitignore）布局下状态不再悬空
- **changelog 不再漏卡** — 裸 ID（非链接形）的 Done 行正确入草稿；空草稿时 `--write` 不写占位句
- **peer 硬触发留痕** — 高复杂度交付未经评审会在事件流与 ALERT 留下可审计记录

### 精简

- **tart 隔离 lane 移除** — `test_isolation.type` 只留 `none`；残留 tart 配置显式报错退出，绝不静默回落宿主
- **bats 测试套件退役** — 51k 行 bash 测试由 TS diff-test 体系接管（对使用者无感；v2 分支保留全量历史）

### 文档

- **架构与理念文档归仓** — `docs/architecture.md`（分层 / 领域 / 12 条不变量）、`docs/verification.md`、`docs/manifesto.md`
- **双语新章** — 验收证据指南、一致性与发版闸指南、README 仓库结构章节与环境要求修正


## v3.0.0

### TypeScript 重写

- **引擎从 bash 换成 TypeScript** — roll 的核心重写为 pnpm monorepo（`packages/`：spec/core/infra/cli/web 分层）。这是一次引擎替换，不是功能改版
- **命令一个不变** — `roll init` / `loop` / `status` / `backlog` / `prices` / `slides` 等全部子命令的入参、输出、副作用、退出码保持原样；升级后照旧用
- **逐层对拍迁移** — 地基、CLI、领域服务、infra、loop 各层逐条移植，每条命令写 diff-test 断言「TS 输出 == 原 bash 输出」，逐字节对齐冻结的 v2 oracle
- **1031 项 TS 测试全绿** — 单测覆盖每个公共入口 + 跨层 diff-test；`npm i -g @seanyao/roll` 装的就是这套 TS-first CLI

### 兼容与回滚

- **bash 实现留作回落 + oracle** — `bin/roll` 随包一起发布：TS 层尚未接管的命令自动透传 bash，行为零差异；同一份 bash 也是测试套件的标准答案
- **v2 归档在 `v2` 分支** — 锚点 tag `v2-freeze-2026-06-04`，需要时一键回滚

## v2.604.2

### 精简

- **自动简报功能下线(FIX-195)** — 不再后台定时生成每日简报;需要时手动运行 `roll brief` 即可,过往简报都保留

### 稳定性

- **一条坏记录不再拖垮整个自动循环(FIX-193)** — 以前运行历史里出现一条损坏记录,会让 `roll loop` 整个起不来;现在自动跳过坏记录、照常运行

## v2.604.1

### PR Loop 重构

- **统一 PR Loop 分类（CI 唯一门禁）** — 移除分支名特殊处理和 review 门禁，所有 PR 一视同仁：落后→rebase，CI 红→heal，CI 绿→合
- **删除 CI / Alert / Brief Loop** — 6 条服务精简为 3 条（loop、dream、pr），PR Loop 接管 CI 监控和 heal
- **rebase 后立刻合并** — rebase 完成后同轮重取 PR 状态，可合则合，不再等下一轮 tick
- **rebase 先于 heal** — 落后且有 CI 故障的 PR 先 rebase 再判断是否需要 heal
- **修复 rebase 丢失远程 commit** — fetch 后 `checkout -B origin/ref` 再 rebase，不再静默销毁他人推送的 commit
- **修复 BASHPID bash 3.2 兼容** — `${BASHPID:-$$}` 回退，heal 不再崩溃

### 价格系统

- **移除硬编码 parser alias + 精简模型 19→10** — 删除 deepseek-chat/reasoner 别名、kimi-k2 保底，移除已退役的 claude 旧模型
- **`roll prices refresh` 支持多厂商** — 可按 `anthropic|deepseek|kimi` 分别刷新

### 修复

- **修复 `cmd_review_pr` — `gh pr view --json diff` 在任何已发布版本中不存在，改用 `gh pr diff`
- **修复 orphan 结果覆盖** — 允许 `runs.jsonl` 纠正 `cycle_end(orphan)`，成功交付不再显示 `·`
- **修复 changelog generate pyargs bash 3.2 兼容** — 空参数不再 panic

### 文档

- **loop 架构图更新** — 6→3 loop + PR Loop 统一行为
- **价格文档更新** — 多厂商、多币种（USD + CNY）

### backlog 维护

- **自制 `→ v3` 标记统一改为正式 `🚫 Deferred` 状态**
- **推迟 ideation loop 系列（US-AUTO-047..050）至 v3**

## v2.603.1

### 可见性

- **loop tmux 时间戳显示改为本地时区(FIX-169)** — 之前输出 UTC，北京时间显示晚 8 小时，看 loop 现场时间全程对不上；显示改本地时区，事件日志仍存 UTC `[loop]`
- **dashboard ci-timing 完成时回填空 conclusion(FIX-168)** — run 跑完时更新 `ci-timing.jsonl` 里空的 conclusion，时长统计不再缺口 `[loop]`

### 稳定性

- **技能自评笔记不再写错位置(FIX-176)** — 从 `.roll/` 目录内调用时会写成 `.roll/.roll/notes`、趋势统计读不到；现在始终落到正确的 `.roll/notes`

### 自动化流水线

- **changelog generate 只列自上次发布以来的待发布项(FIX-177)** — 之前会把全部 500+ 历史 ✅ Done 都列出来；现在按「上次 release tag 以来的提交」判定，只显示这一版真正要发的内容
- **changelog generate 出完整 + 按项目风格 AI 润色的待发布说明(FIX-178)** — 一条命令产出自上次发布以来的完整内容，用配置的 agent 按 CHANGELOG 风格润色，失败自动回退确定性草稿
- **changelog generate 补录无卡 merged 改动(US-CL-007)** — 发版前已 merge 但没建卡的改动（如直接开 PR 的修正）不再在 Unreleased 里被漏掉
- **PR loop 单轮内关闭已绿的 agent PR(PR #413)** — green 且可合的 agent PR 在同一个 tick 内处理掉，不再留到下一轮 `[loop]`
- **Alert Loop runner 显式传入 `_LOOP_RT_DIR`(FIX-171)** — 之前未显式传入，导致 `_alert_dispatch` 消费端回退到旧共享路径，项目本地 ALERT 永久积压无人处理 `[loop]`
- **loop 按文件路径判断产出落仓(FIX-172)** — 不再读标签，改为看 story 改的文件路径（`.roll/`→roll-meta）；摘标签前的安全前置 `[loop]`
- **loop 仅在 Roll 维护者机器上领卡(US-LOOP-067)** — 别的项目仍跳过，让维护者侧卡以后也能 loop 自己跑 `[loop]`
- **loop 领到 roll-meta 卡后在 `.roll/` 干活(US-LOOP-068)** — 在 `.roll/` 做活、提交到 roll-meta 仓、用 roll-meta 自己的测试做 gate `[loop]`

### 其他

- **roll-meta 卡改到产品仓文件立即 abort(US-LOOP-069)** — 绝不重演把维护者工具塞进产品仓的事故 `[loop]`
- **prices_fetcher 抽象为 vendor 驱动(US-VIEW-023)** — 从 Claude-only 抽象成按 vendor 驱动，加一家厂商只注册一个 vendor、不动抓取主干，Claude 行为不变
- **roll prices refresh deepseek 自动抓价(US-VIEW-024)** — 从官方页抓实价、diff、变了才落盘，deepseek 价格不再只能手工维护
- **roll prices refresh kimi 聚合多子页抓价(US-VIEW-025)** — 聚合 K2.5/K2.6 多子页抓实价，kimi 错价不再像 #406 那样靠人肉发现

## v2.602.5

### 稳定性

- **升级后彻底不再反向提示"升级"回旧版本(FIX-170)** — 续 FIX-166:上次清缓存只在「新版本自己跑升级」时生效,可升级其实是旧版本执行的,所以换版本后偶尔还会被叫去装回旧号(这回升到 2.602.4 又冒出来提示装回 2.602.2)。现在版本检查缓存绑定了写它的版本号,版本一变缓存立即失效,不管 roll update / npm / brew / 手动哪种升级方式都不会再反向提示

## v2.602.4

### 可见性

- **kimi 成本按官方实价显示(价格快照校正)** — 之前 kimi 所有模型都按一个旧低价(¥1/¥4)算,成本被低报约 5-7x;现在按官方实价(K2.6 ¥6.5 in / ¥27 out)显示,kimi-code 的用量成本终于对得上账。deepseek 价格本就正确,顺手清掉过期的折扣注释

## v2.602.3

### 可见性

- **deepseek 的 cycle 也能看到 token 和成本(FIX-164)** — 之前 deepseek 跑的 cycle 明明提了 PR、有耗时,token/成本却是空的(压根没采到用量);现在每轮都按当轮实际 agent 落账,deepseek 和 kimi 一样看得见用量和成本 `[loop]`

### 稳定性

- **roll update 后不再被反向提示"升级"回旧版本(FIX-166)** — 升级后旧的版本检查缓存没清,偶尔还会冒出叫你装回旧号的提示;现在升级会顺手清掉缓存,这点残留也没了 `[loop]`

## v2.602.2

### 自动化流水线

- **自家 PR 跑红了会自动后台修(US-LOOP-062a)** — loop 开的 PR 一旦 CI 变红,会在后台 checkout 交给 agent 修(有次数上限、不重复触发),修不好或关了自愈才告警,不再烂成没人管的僵尸 PR
- **你批准过的绿 PR 会被自动合并(US-LOOP-062b)** — 你 review 通过、CI 又绿的 PR,loop 直接帮你合并删分支,不用再等仓库级 auto-merge、也不用手点

### 可见性

- **kimi / deepseek 成本按人民币 ¥ 显示(FIX-162)** — 之前 kimi 的成本被误标成美元 $,现在和 deepseek 一样按 ¥ 显示,成本总账不再混币种

### 稳定性

- **升级提示不再反向叫你装回旧版本(FIX-163)** — 换上更短的新版本号后,`roll loop on` 等命令一度提示"升级"回旧的年份版本号;现在按 GitHub 最新发布判断,装的是最新就不再误报,发版遇到新号比线上"看起来小"也不再卡住

### 工程和测试

- **roll-design 中等复杂度也过一道 peer(US-SKILL-018)** — 以前只有大改或跨边界的设计才自动触发 peer 评审,现在中等复杂度也会过一道,方向隐患能在拆故事前被独立挑一次;10 秒内可跳过

## v2.602.1

### 新功能

- **curl 一键安装,不用 npm 也能装和升级(US-INSTALL-002~005)** — `curl ... | bash` 从远端按版本拉取、钉版安装到本地并 symlink 进 PATH,支持原地升级、卸载,并能认出当初是 curl 还是 npm 装的 `[loop]`
- **`roll changelog generate` 自动生成更新日志(US-CL-006)** — 从 backlog 已完成故事里提取用户可见的改动,按感知分组生成 CHANGELOG,不用手写 `[loop]`
- **版本号改成更短的 MAJOR.MMDD 格式(US-REL-005)** — 去掉年份前缀,大版本号可手动改(做大改版时改一次即可) `[loop]`

### 可见性

- **loop dashboard 又能看到当天 cycle 了(FIX-157)** — 之前事件文件一旦不存在 loop 不会自动重建,`roll loop status` 整天显示 0 cycle;现在每轮都确保事件落盘,当天 cycle、token、成本都看得见 `[loop]`

### 稳定性

- **loop 不再卡在已完成的故事上空转(FIX-161)** — 描述里恰好出现"待办"字样的已完成故事会被反复领取然后空转;现在选路只认状态列,真待办才会被领 `[loop]`
- **loop 自己开的 PR 跑红了不再被默默吞掉(FIX-158)** — 之前红的 loop PR 既不自动合也没人管、默默烂成僵尸;现在会浮出告警让你看见 `[loop]`
- **落后于 main 的 PR 不再卡着合不进(FIX-159)** — 之前自动 rebase 推不上去、还会把工作区留在别的分支上;现在能正常 rebase 合并并复位 `[loop]`
- **loop 每轮都用最新待办,不再拿过期列表空跑(FIX-160)** — loop 自己写的过程文件会让"拉取最新 backlog"被一直跳过、用陈旧列表反复领已完成的活;现在区分自身产物,backlog 保持新鲜 `[loop]`

## v2026.601.4

### 稳定性

- **从 `.roll/` 子目录跑 `roll` 不再误报"老结构"(FIX-156)** — `.roll/` 是嵌套 roll-meta git repo,从那里跑 `roll loop status` 等命令时 `git rev-parse` 会返回 `.roll/` 自己当 root,然后旧的"新结构存在?"检查找 `.roll/.roll` 找不到,又看到 `.roll/` 里满地 Roll 内容,就误报"老结构、要 migrate";现在检查会向上找直到 `.roll/` 的父目录,认出"这就是该 Roll 项目的私有过程仓",不再误报 `[loop]`
- **peer review 死等终结(FIX-150c)** — 此前 peer 调用挂了就是无限挂,等不到 verdict cycle 就跟着挂;现在 wall-clock 超 `peer_call_timeout`(默认 3min)直接 SIGTERM/SIGKILL 干掉跑挂的 agent,tmux 内的也送 Ctrl-C 中断,设全局标志 `_PEER_LAST_TIMED_OUT` 让上层落 ledger 用,绝不无限等 `[loop]`

## v2026.601.3

### 可见性

- **kimi cycle 现在也能看到 token 和成本(FIX-154)** — 以前 dashboard 对 kimi 那一行全是 `—/—`,看不到主力 agent 花了多少钱;现在 cycle 跑完读 kimi-code 的 `wire.jsonl`,把 token 数和成本写进事件流,RECENT 视图和成本总闸都看得见 `[loop]`

### 稳定性

- **loop 把活派给 AI 后现在真会动手,不再空转零产出(FIX-152)** — kimi 等对话式 agent 拿到 SKILL.md 会把它当成"贴过来的文档"反问"What would you like me to do?",8 秒空返没交付;技能正文前置一条 agent 无关的自主执行指令,kimi/claude/pi/codex/agy 现在都会直接动手 `[loop]`
- **agy 在 loop / cron 自动化里不再卡 tty 等待(FIX-153)** — antigravity(agy)默认要 tty 批准操作,自动化场景拿不到 tty 就一直挂着等;现在 headless 模式自动加 `-p` 和跳过权限标记,跑得到结果 `[loop]`
- **测试不再在桌面弹空报错终端(FIX-155)** — bats 测试跑完临时沙箱删了,但 peer auto-attach 弹的 Terminal 窗口指向那个已不存在的路径,桌面堆一堆空报错的死窗口;给 peer 弹窗补上和 loop 弹窗一样的测试守卫,测试上下文不再弹 `[loop]`

## v2026.601.2

### 新功能

- **curl 安装器骨架:不靠 npm 也能装 roll(US-INSTALL-001)** — 自包含安装脚本探测 OS(仅放行 macOS / Linux)、preflight 检查 `bash≥3.2`/`python3`/`curl`/`tar` 缺啥报啥、把运行时装到 `~/.local/share/roll/` 并 symlink 进 PATH,重复运行即原地升级。本版先从本地源目录复制(真正的 `curl ... | bash` 远端取数留后续故事)`[loop]`

### 可见性

- **peer 评审可靠落盘、能查了(FIX-150a)** — 此前 peer 痕迹碎成三处且大多丢失;统一落盘到项目本地规范路径,新增查询命令翻看历次 peer 记录(发起方 / 对象 / 轮次 / 各方结论 / 耗时),不再依赖 agent 自觉写盘 `[loop]`
- **三个专用 loop(CI / PR / Alert)空闲时也留心跳(FIX-151)** — 健康空闲时不再零日志让人以为没在跑;每轮补一条轻量存活心跳,status 显示各 loop 上次运行距今多久 `[loop]`

## v2026.601.1

### 新功能

- **从 GitHub Issues 直接拉进 backlog (US-SYNC-001..007)** — `roll backlog sync` 把 GitHub issue 按 label 映射成 US/FIX/IDEA 拉进 backlog,`--dry-run` 先预览、`--label` 过滤,重复同步自动跳过已存在的 `[loop]`
- **loop 按任务难度自动挑 AI agent(四槽路由)(US-AGENT-020..031)** — 复杂度分类器把活分到 easy / default / hard 各自的 agent(取代旧的三维历史命中率路由),`roll agent use/set` 锁定或单槽切换,选中的扛不住会自动降级换备用并留痕 `[loop]`
- **每个 cycle 跑完自动打分、能看质量趋势 (US-EVAL-001..005)** — loop 每轮按统一 rubric 自评打分写进记录,`roll loop eval` 看窗口趋势,连续低分自动浮出"该改进了"的信号 `[loop]`
- **onboard 会分析业务 / 技术 / 测试现状 (US-ONBOARD-016/017)** — 接手老项目时多产出领域建模、技术现状、测试覆盖三类分析(区分扫描到的事实和 AI 推断、禁止泛泛而谈),并据此给 backlog 播种候选 story,落盘前 [Y/n] 让你确认 `[loop]`
- **roll-doc 能跨目录深读项目 (US-DOC-015..019)** — 新增 Phase 3b:顺着调用链理出外部集成、部署管线,缺 `AGENTS.md` 自动补、高引用目录自动加 README,报告标注 `file:line` `[loop]`
- **deck 支持按 slide 选版式 (US-DECK-017..019)** — 每页 slide 可声明 layout,渲染器按布局路由到不同版式组件,skill 带选版式 playbook(老 deck 仍兼容)`[loop]`
- **新增 / 删 skill 后自动重建能力清单 (US-SKILL-016)** — `roll skills generate` 扫描 `skills/` 重写清单,CI 有漂移门防手改失忆,不用再手维护目录 `[loop]`

### 自动化流水线

- **专职 PR Loop:开完 PR 不用再守着合并 (US-AUTO-044)** — 主 loop 开完 PR 就退,新增每 5 分钟独立跑的服务专门 rebase / 合并 / 关 PR,合并即自动删分支,同一故事不会重复开 PR `[loop]`
- **专职 CI Loop:CI 抖动自动重跑、flaky 自动浮出 (US-AUTO-045)** — 新增每 5 分钟独立跑的服务,瞬时网络抖动导致的失败自动 rerun,检测 flaky 和耗时劣化,真失败写 ALERT `[loop]`
- **专职 Alert Loop:告警不再刷屏、急事立刻弹通知 (US-AUTO-046)** — 新增每 1 分钟独立跑的服务消费告警,同类 1 小时内聚合防刷屏,error 立即弹 macOS 通知 `[loop]`
- **loop / dream / brief 调度一行命令就能改 (US-LOOP-033..036, fixes FIX-105)** — `roll config loop-window 9-18` / `loop-schedule 30/7` / `dream-time 03:20` / `brief-time 09:15`,改完立刻生效,不用再手工改配置;dream / brief 重新支持精确到分钟 `[loop]`

### 可见性

- **每轮 loop 结束直接看到这一轮干了啥 (US-LOOP-040/042)** — cycle 结束在 `.command` 窗口渲染本轮总结(开了什么 PR、跑没跑测试、有没有告警)`[loop]`
- **远程也能看 loop 在干嘛 (US-OBS-014/015)** — 每轮结束自动推送状态快照,人不在机器前也能远程看 loop 状态 `[loop]`
- **loop 连续改同一文件不再刷屏像卡死 (US-VIEW-020..022)** — `roll loop attach` 里 agent 反复改同一文件折叠成一行 `✏ <文件> ×N`,不再复读长路径 `[loop]` `[doc]`
- **非 Claude agent 也能看到 token/成本 (US-LOOP-027..031)** — dashboard 不再对 pi、codex、Gemini、Kimi、Qwen 的 cycle 黑屏,显示真实 token 和成本;暂无插件的 agent 仍显示 `—/—` `[loop]` `[doc]`
- **loop 跑了哪几轮可跨项目查 (US-LOOP-020)** — 运行记录改存项目本地,`roll loop runs --all` 跨项目聚合查看 `[loop]`

### 稳定性

- **loop 同步不再冲掉你未提交的 .roll 改动 (FIX-145)** — meta-sync 遇到未提交的 `.roll` 编辑时跳过 `reset --hard`,不再清掉本地改动 `[loop]`
- **路由到的故事中途没法做时自动改挑别的 (FIX-146)** — agent 交接时若选中的 story 变不可用,自动重新挑一个,不再空转 `[loop]`
- **修好几个会让 loop runner 崩的小问题 (FIX-147/148)** — runner 因反引号转义报 `press: command not found`、dream/brief 调度默认值错乱,均已修复 `[loop]`
- **`roll agent list` 正确识别 antigravity** — 能正常显示 `antigravity (agy)` 并探测 agy 命令 `[loop]`

### 工程和测试

- **发布说明就是 changelog,不再是两个东西 (US-REL-004)** — Roll 里只有 changelog、没有单独的 "release notes"(也没有 `RELEASE_NOTES.md` / `roll release-notes`):发版时直接把该版 changelog 段落作为 GitHub Release 正文,changelog 本身改用按感知分组 + 第二人称的写法,读起来就是给你看的发布说明 `[release]`

## v2026.529.5

### Added

- **`roll feedback` — 一条命令直接给 Roll 提反馈** — `roll feedback "..."` 直接开一个 GitHub issue,自动附上环境信息(系统 / 版本 / 当前 agent),`--type` 自动映射到对应 label;反馈仓库按 env > 项目 > 全局 > origin 优先级解析,不用手填 `[cli]`
- **loop 按故事自动挑最合适的 AI agent** — 不再所有活都丢给同一个工具:每个故事按硬规则 + 历史命中率软偏好路由到更合适的 agent,`roll loop status` / brief 能看到每个 agent 的命中率 `[agent]`
- **agent 扛不动的活自动拆小,而不是硬憋半成品** — cycle 起步先跑 pre-flight 自检;扛不住就自降级(重新拆小 + 标 🚫 Hold + 干净退出),自动重拆设 chain_depth≥2 上限并告警 `[agent]`
- **每次交付自动打分,能回看质量趋势** — roll-build / roll-fix / roll-design 完成后各写一条统一格式自评分,dashboard 显示趋势(均值 / 最低 / 重做率)`[skill]`
- **合并前自动查测试质量,烂测试进不了主干** — 新增两条测试质量红线(内联外部工具、文件落在仓库外),设计阶段自检 + 合并门扫描;命中写 ALERT,确需绕过用 `[skip-test-quality]` `[test]`
- **loop 活跃时段能按项目单独设** — 不用再让所有项目迁就一个全局时间,活跃窗口从项目本地 `.roll/local.yaml` 读 `[loop]`
- **`roll-doc` 能追踪数据流和调用链** — 不只列模块,还顺着 import 链路把数据怎么流、谁调谁理出来 `[doc]`

### Fixed

- **loop 的 agent 路由以前是摆设,说一套做一套** — 嘴上说"交给 X",实跑的却是安装时写死的另一条命令,手动换工具也不生效;改成每轮运行时按当下挑中的 agent 重建命令,换 agent 立刻生效 `[loop]`
- **干完活却卡在提交、整轮白做** — 提交前被测试门拦下,接着去跑全量 `npm test` 把自己拖死、成果作废;改成只测改动的 `roll test` 快速过关,能正常提交、开 PR `[loop]`
- **非 Claude agent 跑 loop 不再黑屏假死** — deepseek / pi 等执行阶段几十分钟没输出像卡死、心跳也没发;放弃强求实时输出,改成稳定打存活心跳(运行时待下一轮 cycle 实证)`[loop]`
- **dashboard 看不到当天跑完的 cycle** — 事件写入端搬进了项目本地,读取端还在读旧的 shared 文件,卡跑完合了 PR 却显示 Today=0;改成统一从项目本地读并把历史并过去 `[loop]`
- **loop 用 kimi 跑必崩** — kimi 升级新版后调用参数对不上,一跑就挂;已修好 `[agent]`
- **`roll loop on` 调度时间显示全是 00:00** — 渲染时 printf 展开顺序错了,现在正常 `[loop]`
- **没装的工具被误判成"可用"** — 只看到 `~/.claude` 目录就当 Claude 装了、还设成默认 agent;现在必须命令真在 PATH 上才算装 `[agent]`
- **`roll test` 在隔离 VM 里更稳** — 修了 tart 拿到过期 IP 的问题,默认只跑受影响用例让 VM 更快 `[test]`

### Improved

- **loop 日志全改项目本地、按 cycle 全留** — 以前全局 + 项目本地重复存两份、全局那份还无限 append,per-cycle 又 cap 50 偶尔丢轮;改成全落项目本地、不限量、零全局重复,机器层事件单列项目 ops 日志,cycle 结束终端只显示当前这轮 `[loop]`
- **loop 的"完成"现在等于"真合进主干"** — 以前开 PR 那刻就标 ✅ Done,但 PR-protected main 要 review + 绿 CI、自治 cycle 常合不进 → 假 Done;改成真正 merge 才算完成,没合自动退回 📋 待办 `[loop]`
- **同一故事不再每轮重复开 PR** — 选卡前先查它是不是已有开着的 PR,有就跳过,合不进的 PR 不再越堆越多 `[loop]`

## v2026.528.2

### Added

- **loop 换机器跑不会再拿过期 backlog** — 以前在 A 机器跑的 loop，搬到 B 机器继续时会用本地的旧 backlog，不知道有什么新待办；现在每轮开始前自动拉一次最新状态，多台机器始终看同一份 `[loop]`

- **CI 红了 loop 不再干等** — 主干测试挂掉时，loop 以前会停下等人去修；现在先自己分析失败原因、发一个修复，试满 3 次还没修好才发告警找人；自己开的 PR 被 CI 标红后也会自动续上去修，不会因为"本轮 loop 已经结束"就悄悄放弃 `[loop]`

- **`roll test` — 测试跑在独立环境里，不会再误伤本机** — 以前跑完整测试套件会触碰本机的 loop 调度服务，测试一过就把正在运行的 loop 打掉；现在测试在独立的 macOS VM 里跑，本机的 loop 完全不受影响 `[test]`

### Fixed

- **Kimi CLI 改名后全链路都能识别了** — Kimi 把工具从 kimi-cli 改名为 kimi-code、安装目录也换了；Roll 现在新旧名字都能认出来，kimi-code 的安装路径也加进了自动查找范围，调度环境里也能找到，已设好的旧配置不需要动 `[agent]`

- **`roll loop log` 现在真的能看了** — 每轮 cycle 的日志存档修好了；以前文件根本没生成，现在用 `roll loop log` 能查到每一轮跑了什么 `[loop]`

- **loop 跑完的终端窗口不再瞬间消失** — 以前 cycle 结束 Terminal 窗口立刻关掉，来不及看本轮干了什么；现在窗口留着直到你自己关 `[loop]`

### Improved

- **提交安全检查不会再被静默绕过** — Roll 的 TCR 要求每次提交前先过测试；以前在新终端或新机器上开工，这道检查会因为 git 配置没自动生效而悄悄失效，自动化环境尤其容易中招；现在每次打开 Claude Code 新会话、或跑 `roll setup` 都会自动配好，这个漏洞从源头堵死 `[infra]`

- **macOS 自带 bash 下中文命名的测试用例不再被静默跳过** — macOS 系统自带的旧版 bash 在处理中文或特殊字符测试名时会截断，导致这些测试根本没执行却也不报错，本地看起来全绿但实际上漏了一批用例；已修复，本地和 CI 结果现在一致 `[test]`

## v2026.527.1

### Added

- **pi / deepseek 跑的 loop 现在能看到真实 token 和花费** — 仪表盘不再显示 —/—，按人民币原币种计价，连之前没数据的历史轮次也补齐了 `[loop]`
- **`roll loop gc` 清理 loop 残留** — 一条命令清掉废弃项目的残骸文件和过期备份，不再越堆越多 `[loop]`
- **loop 可以用 gemini / openai / qwen 来跑了** — 在 pi / deepseek / kimi 之外多了几个选择 `[loop]`
- **loop 触发频率能设成任意分钟数** — 不再只有几个固定档，1 到 1440 分钟随便填 `[loop]`

### Fixed

- **每日汇总的花费按币种分开显示** — 人民币和美金不再被混加成一个数 `[dashboard]`

## v2026.526.1

### Changed

- **`roll loop --help` 不再显示内部 hook 命令** — notify / enforce-tcr / precheck-ci 移到单独的内部命令区，不给用户看了 `[cli]`

### Added

- **一个故事跑过的所有轮次能合并看了** — `roll loop story <ID>` 一眼看清总耗时、花了多少钱、走过哪几个 PR `[loop]`
- **仪表盘不再丢历史轮次** — 老数据自动归档，往前翻多远都看得到 `[loop]`
- **写 slides 不用再抄模板 HTML** — 9 个常用组件块（卡片、对比、时间线…）直接拿来用 `[deck]`
- **服务状态在窄终端也对齐了** — 中英文混排不再因为汉字占两格错位 `[i18n]`

### Fixed

- **`roll slides new` 失败时给得出手的提示** — 模板找不到列可选项、内容有错指出位置、生成崩了告诉你看哪份日志 `[deck]`
- **跑完整测试不再卡 60 分钟** — loop 启动时的多语言初始化优化后回到正常时长 `[loop]`
- **收拾了 9 个不稳定的测试** `[testing]`

### Docs

- **新增"多台机器同时跑 loop"章节** — 怎么协调、状态符号是啥意思都说清楚 `[loop]`
- **README 更新** — 不再要求 bash 4，macOS 自带的 3.2 就能跑；命令表补上 `roll loop story` `[docs]`

## v2026.525.1

### Added

- **loop 触发频率可以按项目单独设** — 不再全局一刀切，有的项目可以慢点跑 `[loop]`

### Fixed

- **主页不再误报** — 已经开了 loop 的项目不会再被标成"缺失" `[loop]`
- **loop 弹窗关了也能翻回之前的输出** — 不再一关就全没 `[loop]`

## v2026.524.2

### Added

- **`roll slides new` 不再像卡住** — 分阶段显示进度、当前步骤和耗时 `[deck]`
- **`roll slides new` 可以用项目自己的模板** — 不只用内置的了 `[deck]`
- **`roll slides list` 一眼看出 slide 状态** — 哪些能看、哪些生成失败、失败原因也能查 `[deck]`
- **`roll slides templates` 列出可用模板** — 内置和项目自定义的一眼可见 `[deck]`
- **`roll slides delete` 删除幻灯片** — 不再需要手动 rm `[deck]`
- **用 pi / deepseek / kimi 跑的 loop 也能在终端里实时看到进度** — 不再黑屏 `[loop]`
- **网站语言随浏览器自动切换** — 中文用户看到中文 `[i18n]`

### Fixed

- **loop 不再一次吞太多故事** — 每次只做一个，时间可预期 `[loop]`
- **loop 挂了会换备用** — 不再直接放弃 `[loop]`
- **loop 本地工作区不再堆积** — 合并后自动清理 `[loop]`
- **标进行中的故事不再永久卡住** — 超时恢复待办 `[loop]`
- **成本不再虚高** — 支持多模型真实价格 `[dashboard]`
- **dashboard 不再对非 Claude 模型显示空白** — 能看出每轮谁跑的 `[loop]`
- **主页 agent 标签不再骗人** — 显示真名 `[dashboard]`

### Docs

- **新增 `guide/{en,zh}/pricing.md`** — `roll prices` 命令用法、价格快照机制、历史成本固化语义；README 索引同步 `[pricing]`
- **FAQ 新增 A11** — 价格更新后历史 cycle 成本数字不会变 `[pricing]`

## v2026.523.2

### Added

- **每轮 cycle 实时打出 7 阶段进入退出与耗时** — `startup` / `preflight` / `worktree_setup` / `claude_invoke` / `publish_push` / `publish_wait_merge` / `cleanup`，长静默阶段 30–60s 一次心跳，再也不用盯着空屏猜 loop 卡在哪 `[loop]`
- **cycle 结束打一份按耗时降序的阶段面板** — 同时把每阶段秒数固化到 `runs.jsonl` 的 `phases` 字段，跨轮对比"今天哪一步最慢"有完整数据 `[loop]`
- **`roll loop runs` 每行末尾追加 `slowest=<阶段> <占比>%`，新子命令 `roll loop runs --detail <cycle_id>` 打开完整阶段面板** — 不必翻 ndjson 就能定位单轮瓶颈 `[dashboard]`
- **`tests/run.sh --affected [base-ref]`** — TCR micro-step 只跑被本次改动覆盖的测试文件，反馈秒级；改动 `tests/helpers/*` 等保守降级到全套 `[testing]`
- **`tests/run.sh --tier=fast|slow|all`** — 本地 TCR 默认 `fast`，CI 跑 `--tier=all`；`ROLL_TEST_TIME_CAP=1` 时 `fast` 全跑 60s 硬上限，性能漂移立刻打红 `[testing]`
- **测试质量评分卷（6 类反模式 rubric）** — `roll-.dream` Scan 7 按 rubric 输出 `REFACTOR-XXX [test-quality:❶|❷|...]`，单轮上限 5 条，存量 ❶ 类反模式可结构化治理 `[dream]`
- **`roll lang [zh|en|--list]`** — i18n 地基命令：查看 / 切换 / 列出可用语言，按本机 locale 自动选默认；`ROLL_LANG` 环境变量临时覆盖 `[i18n]`
- **`roll prices show / refresh`** — 价格表挪进带版本号的 snapshot，能一键拉官方文档对比；调价不再要改源码、提 PR，每个 version 的价格都查得到 `[pricing]`
- **cycle 结束时按当时价格固化成本** — 以后调价或升级都不会回头改写历史轮次的数字；老事件继续可读，渲染时打 `[legacy]` 标记 `[loop]`

### Fixed

- **dashboard 把已合并 PR 错显示成"开放"** — `roll loop status` 兜底走 git log 找 squash merge subject，原正则只认 `loop/cycle-LABEL` 旧分支名，对新的 `loop cycle LABEL (#N)` 默认 subject 匹配不上；现在两种都认 `[dashboard]`
- **`model_prices.bats` 改用 fixture 价格表注入** — 之前对生产 PRICES 算术断言把调价误伤成测试红，重写后只断结构不变量（cache_read < input、out ≥ in 等）`[testing]`
- **已合入临时分支堆在 origin 不被清理** — `_loop_cleanup_stale_cycle_branches` 漏过 agent / abort 两条路径，现在 cycle 入口先扫一遍再走主流程 `[loop]`
- **临时目录复现 bug 时留下幽灵 launchd 服务** — 自动检测临时路径并把所有 `launchctl` 调用走 sandbox 注册表，主用户 launchd domain 不再被污染 `[launchd]`
- **dashboard 把 story 列错显示成上一轮的 ID** — `_STORY_ID_PAT` 老正则每段只认纯字母，`US-I18N-001` 这种字母+数字混合 segment 匹配不上 → 新 `pick_todo` 被静默丢掉，仍展示前一轮的旧 story 名；正则更新为 `[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+` 后 I18N / K8S / D2 / S3 等命名都能识别 `[dashboard]`

### Docs

- **新增 `guide/{en,zh}/loop.md` "Cycle phases" 小节** — 七阶段表 + 触发时机 + 典型耗时 + 收尾面板样例；FAQ 增 C6 "某阶段慢怎么定位"
- **新增 `guide/{en,zh}/testing.md` "TCR Test Strategy" 小节** — `--affected` 与 `--tier` 两个杠杆的语义、匹配规则、CI/本地默认组合；新增 "测试质量评分卷" 小节列六类反模式与修复方向

## v2026.523.1

### Added

- **`roll loop branches`** — 一眼看见本机残留的 loop 分支；每轮入口先 GC 一次，半途中止的 cycle 也会被收掉 `[loop]`

### Changed

- **dashboard token 列拆成 input / output / cache 写 / cache 读** — cache 是真花钱的，账单终于解释得清 `[loop]`

### Fixed

- **每日 dream / brief 在 macOS 26.4 上从来没真跑过** — 换成 interval 触发，从今天起稳定每天产出 `[loop]`
- **dashboard 上 tcr 次数、built 列表、ALERT 文案不再显示假零或别故事的旧标签** `[loop]`
- **选一个故事不再把别的依赖它的故事也标成"在做"** — dashboard 不再骗你说有人在干活 `[loop]`
- **`roll setup` / `roll update` 不再在隐藏的覆盖提示上无声卡死**
- **`$roll-notes` 现在写到 `.roll/notes/`** — 和 dream / brief 一致，不再扔到项目根目录 `[loop]`
- **loop CI 网关不再把"排队中 / 进行中"误判成失败** `[loop]`

## v2026.522.2

### Changed

- **Roll 改用 Antigravity (`agy`)** — Google 已退役独立 Gemini CLI，agy 是接班产品；老用户重跑 `roll setup` 即可

### Improved

- **dashboard token 列现在只算 input/output，cache 不再混进来虚抬总量** `[loop]`
- **`roll loop status` 现在分清「没装 / 装了关了 / 正常」三种状态** — 之前看不出 loop 到底有没有起来 `[loop]`

### Fixed

- **loop 异常中断时未推送的 commit 不再丢** — 自动开成 PR `[loop]`
- **loop 每小时弹窗不再抢前台焦点** — 后台开 Terminal，不打断你在干的事
- **`roll loop` 在非 git 目录下不再静默崩溃** `[loop]`

## v2026.522.1

### Fixed

- **loop 不再被 Roll 自身测试遗留的后台调度静默杀掉** `[loop]`

## v2026.521.3

### Added

- **`roll slides`** — 给个主题，agent 自动写 18 张双语 slide 并渲染成 HTML 在浏览器里直接打开；`roll slides list` / `preview` 管理已有 deck

## v2026.521.2

### Fixed

- **`roll setup` 不再在 macOS 后台活动列表里留下 ghost「bash」条目** — 改由 `roll init` 和 `roll loop on` 按需安装 `[loop]`
- **`roll setup` 现在能正确显示哪些步骤真的装了** — 之前装好的 skills 和 peer 状态目录会被误标成"跳过" `[loop]`
- **`roll loop status --days 7` 不再吞掉天数参数** — 之前永远只显示默认 3 天，dashboard 底部那条 "more" 提示也改成能直接复制跑通 `[loop]`
- **loop 每轮起手不再刷一堆"找不到文件"报错** — 修了内部脚本里的旧路径，并让 agent 在 zsh 下不再被未匹配的通配符卡住 `[loop]`

## v2026.521.1

### Added

- **dashboard cycle 行现在标出模型和按公开单价算的成本** — 跨账号 / 跨项目可以横向对比和加总，不再被订阅折扣藏掉真实开销 `[loop]`

### Improved

- **`roll setup` 重跑能看出"已是最新"还是"刷新了 X 项"** — 每步上报 changed / unchanged / failed，强制覆盖用 `~` 标出 `[loop]`
- **`roll-peer` 评审第一轮要先独立判断** — 不再被评审方预设结论带跑，跨 agent 才真的是二次判断 `[loop]`

### Fixed

- **`roll init` 默认不再打"Project ready"假提示** — 老项目进引导分支时不再骗你说已就绪 `[legacy-onboard]`

## v2026.520.1

### Added

- **`roll offboard`** — 一键清掉项目里的 Roll 痕迹，先 dry-run 预览、二次确认才动手；命名空间对不上直接拒绝，绝不跨项目误删 `[legacy-onboard]`
- **`roll init` 现在认得出非典型布局的老项目** — 微信小程序、Python 平铺、Terraform 仓不再被当成空项目静默跳过引导 `[legacy-onboard]`
- **onboard / offboard 用户指南** — 完整接入与退出流程文档上线，遗留项目页"怎么退出"段从手动 rm 改为指向新命令 `[docs]`

### Improved

- **公开 README 重写为给使用者看的** — 中英文 README 去掉自我推销语言，围绕安装 + 使用展开，新增贡献指南与漏洞报告说明 `[docs]`
- **markdown 改动不再绕过 CI** — 文档量减下来之后，关键文档改动现在和代码一样要过 CI `[ci]`
- **onboard 留下回退清单** — onboard 完事会记下动过哪些文件、在 AGENTS.md 哪段合并、加了哪些 launchd 调度，作为 offboard 的精准回退依据 `[legacy-onboard]`

### Fixed

- **loop 跑过 45 分钟预算时不再卡死** — watchdog 现在能稳定收掉超时的 claude，下一轮按时启动 `[loop]`
- **loop worktree 里能看到主仓最新 backlog** — 每轮启动会先把主仓 `.roll/` 同步进 worktree，不再因为 meta 滞后让 loop 拿到旧待办 `[loop]`

## v2026.519.3

### Major

- **`.roll/` 拆为独立私有仓库** — 过程文件（backlog / brief / features / dream / domain / briefs）整体迁入嵌套私有 repo `roll-meta`，主仓只留产品文档。AGENTS.md 新增 §9 说明双 repo 协作约定 `[meta]`

### Improved

- **`.roll/features/` 按 Epic 分组** — features 目录由扁平改为 Epic 子目录，附带 loop 架构经验文档 `[docs]`
- **站点登陆页对齐 v2.0 架构** — `docs/site/` 文案与 2.0 实际产物对齐，去掉过期描述 `[docs]`

### Fixed

- **loop 异常退出** — dashboard 不再卡在"运行中"，崩溃 / 被 kill / 超时退出都会写下结束标记 `[loop]`
- **`FIX-065` loop 共享状态隔离** — 测试运行的 loop 不再污染生产 backlog/brief，sandbox 化共享路径 `[loop]`

## v2026.519.2

### Improved

- **`roll init`** — 初始化流程现在显示 6 步编号进度，新建文件用绿色 `+`、合并已有用琥珀 `~`，结尾给三步上手指南 `[loop]`

### Fixed

- **`roll --help` 中 `init` 描述** — 文案从 `+ docs/` 改为 `+ .roll/features/`，对齐 2.0 实际产物和 README；v2 (`lib/roll-help.py`) 与 legacy (`bin/roll`) 两份 help 同步修正 `[FIX-064]`

## v2026.519.1

### Major（大版本重构）

- **项目结构重组 — 过程文件迁入 `.roll/`** — Phase 1 of Legacy Onboard Epic。`BACKLOG.md`、`PROPOSALS.md`、`docs/{features,briefs,dream,design,domain}/` 全部搬入 `.roll/`；`docs/guide/`、`docs/site/`、`docs/intro/` 上移到根级。一次性 breaking change，迁移指南见 `guide/{en,zh}/migration-2.0.md` `[legacy-onboard]`
- **新命令 `roll migrate`** — 老项目一键迁到新结构：dry-run 预览 + `git mv` 保留历史 + 单原子 commit + 三态幂等（仅老 / 仅新 / 并存） `[legacy-onboard]`
- **新版 `roll init` 识别 Legacy 项目** — 检测到现有源码无 `AGENTS.md` 时引导用户进入 onboard 流程：列出本机 AI agent、显式告知 token 消耗、引导运行 `$roll-onboard` `[legacy-onboard]`
- **新技能 `$roll-onboard`** — 三组九问 ≤ 3 分钟，AI 读懂项目后生成 `.roll/onboard-plan.yaml`，bash 侧 `roll init --apply` 执行 `[legacy-onboard]`
- **新命令 `roll init --apply`** — 消费 onboard plan 创建 `.roll/` 结构，按用户选择写 `.gitignore`、同步 AI 工具约定 `[legacy-onboard]`
- **结构强制检测** — 新版 Roll 在老结构项目上拒绝运行 + 引导 `roll migrate`（`setup` / `update` / `version` / `help` / `init` 豁免；`ROLL_SKIP_STRUCTURE_CHECK=1` 旁路） `[legacy-onboard]`

### Improved

- `AGENTS.md` §8 Documentation Conventions 重写匹配新目录结构，明确"过程默认对内、产品默认对外"原则 `[docs]`
- `guide/{en,zh}/practices/` 收入工程规范文档（原 `docs/practices/engineering-common-sense.md`） `[docs]`
- 新增 Python 校验器 `lib/roll-plan-validate.py`，验证 onboard plan 完整性、`generated_at` 24h 时效、版本兼容 `[legacy-onboard]`

### Fixed

- **`roll setup` 后从未开启 loop 的项目** — 不再被 macOS 自动激活、每小时弹出终端窗口 `[loop]`
- **`_write_backlog` 缺 `mkdir -p` 导致 `cmd_init` 在 `.roll/` 不存在时崩** `[legacy-onboard]`
- **`release.sh` 多 feature 时 awk `newline in string` 错误** — macOS BSD awk 不容忍 `-v var=多行`；改用 `ENVIRON` 读取 `[release]`
- **GitHub 仓库改名 Roll → roll** — 内部代码、测试 fixture、文档引用全部同步小写命名 `[chore]`
- **`.roll/backlog.md` 和 `guide/*` 中残留 `docs/features` 等老路径引用** — Story 5 sed 漏覆盖 `.roll/` 和 `guide/` 文件，dream 巡检发现后补齐 `[legacy-onboard]`

## v2026.518.4

### Improved

- **`roll` 主页焕新** — 一屏看清 loop / dream / peer 状态、四道防线、Pipeline 进度和待你处理的事 `[loop]`
- **`roll --help` 焕新** — 命令按日常 / 项目 / 全局三组分类，常用命令 ★ 高亮，不再被大字 ASCII banner 占屏 `[loop]`
- **`roll status` 焕新** — 一行看健康总览，AI 客户端同步状态、约定文件清单、项目模板逐段展示，drift 行直接给修复命令 `[loop]`
- **`roll backlog`** — 待办任务按缺陷 / 故事 / 重构 / 创意四类分组显示，进行中的条目紫色高亮，Blocked / Deferred 分区附带原因 `[loop]`
- **`roll brief`** — 简报现在用终端三段式渲染：摘要数字、已完成亮点、待决策清单按 D1/D2 编号 `[loop]`
- **`roll setup`** — 首次安装流程现在显示 6 步编号进度，每步完成打勾，结尾显示"Setup complete" `[loop]`

### Fixed

- **loop 弹窗现在固定走 Terminal.app** — 不再按终端偏好挑来挑去，省得在新版 Ghostty 上弹窗假成功、备选方案也失效 `[loop]`
- **与 roll agent 对话** — 不再因工具不同而忽冷忽热 `[loop]`
- **大小写不同路径进同一项目** — 不再被 loop 当成两个独立项目、LOCK 和状态不再分裂 `[loop]`
- **loop 跑完一轮** — 不再挡死后续调度、卡到手动 kill `[loop]`
- **binary 升级后 loop dashboard 回落 IDLE 问题** — 旧 binary 用不同路径大小写算出不同 slug，新 binary 启动时自动把旧 slug 的状态文件、日志、历史记录全部迁到新 slug，upgrade 无感无损 `[loop]`
- **loop status 费用显示严重偏低** — `$9.25` 的 cycle 显示为 `$0.04`：读取了最后一次 API 调用的 token 数重新算价，改为直接用 `cost_reported_usd`（loop-fmt 写入的权威累计值） `[loop]`

## v2026.518.3

### Fixed

- **autonomous loop 跑测试时狂开 Ghostty 窗口** — `_write_loop_runner_script` 生成的 outer runner 在 popup 分支只检查 `ROLL_LOOP_NO_POPUP` / mute 文件 / Darwin；当 loop 的执行 agent 跑 bats 跑到 `_loop_test` 这类需要执行生成脚本的测试时，每个 test case 都会真的弹一个 Ghostty 窗口，一轮 cycle 累出 80+ 个孤儿窗口。popup 守卫追加 `BATS_TEST_NUMBER` 判定，任何 bats 上下文里自动跳过 popup `[loop]`

## v2026.518.2

### Fixed

- **`roll loop status` dashboard 崩溃 / 列对齐** — `_dash_release_ready` 用 `grep -c` 在零匹配时返回 "0" + 非零退出码再被 `|| echo 0` 追加一个 "0"，拼成 "0\n0" 让 `[[ -gt ]]` 报语法错；改用 `grep | wc -l | tr -d ' '` 单值返回。Today 表头去掉 "(in progress)" 后缀（曾溢出到 Yesterday 列），数值列宽 6→8 让指标行对齐表头 `[loop]`
- **v2026.518.1 在刚发版的仓库里 dashboard 不可用** — 上面那个崩溃在 HEAD == latest tag、或 tag 之后只有 docs/chore commit 的仓库中必触发；本版作为追加修复，升到 v2026.518.2 即恢复 `[release]`

## v2026.518.1

### Improved

- **`roll loop status` 焕新** — 重设计的 dashboard 替换原本的扁平列表：按天 Today / Yesterday / −2d 分列总账（轮次、PR、耗时、tokens、成本、失败计数），下面每天分段列出 cycle 详情；idle / done / fail 用 `·` / `✓` / `✗` 区分，不再统统挂"运行中"；时间统一显示 UTC+8；同一 cycle 的 pr 事件与 cycle_start 不再被错切成两条；多 story cycle 用 `|` 连起来一行展示；走 `ROLL_UI=v2` 默认开，`ROLL_UI=v1` 一键回退到旧实现 `[loop]`
- **loop 每轮成本和 token 真实可见** — 每个 cycle 结束时把模型用量（input / output / cache_creation / cache_read tokens、claude 上报的折后价、耗时）写进永久事件流，dashboard 按模型公开单价（list price）算出真实成本、按 k / m / b 显示 token，多机器 / 多项目可横向对比；历史 cycle 没写过这条事件的，自动从 claude 自己的会话日志里回灌一份 `[loop]`
- **`roll update` 不再每次刷 PR 评审两档安装提示** — 两段安装命令挪到 `roll doctor`，在 git repo 内探测分支保护和事件 workflow 的当前状态，只对未启用项显示安装指令 `[pr]`

### Fixed

- **发版管道空版本雪球** — release.sh AI changelog 调用失败时硬退出（不再静默发空 tag）；release.yml 同日合并检测到 fallback notes 时跳过合并，避免把前一个 release body 累积到新版本里 `[release]`

## v2026.517.9

### Improved

- **`roll-loop` 环境变量文档化** — `ROLL_LOOP_FORCE` / `ROLL_LOOP_NO_HEAL` / `ROLL_LOOP_HEAL_MAX` / `ROLL_LOOP_PR_MERGE_TIMEOUT` 四个配置项补入中英双语 configuration 指南，并加 bats 测试守护 `[loop]`
- **BACKLOG 四种条目渲染折叠** — Story / FIX / REFACTOR / IDEA 四组解析循环结构完全一样，合并为单一渲染函数，格式变更不再需要同步四处 `[refactor]`

## v2026.517.8

> 空版本：发版脚本 AI 调用失败 fallback 未拦截，导致无实际内容的 tag 被推出。缺陷已在后续 commit `005601a` 修复（release.sh 和 release.yml 双重校验），见 Unreleased 段。

## v2026.517.7

> 空版本：原因同 v2026.517.8。

## v2026.517.6

### Fixed

- **`features.md` 规划中标记不再依赖 AI 自觉** — 发版脚本 AI 重写后跑机械校验自动补齐 `*(规划中)*`，规则落到 shell 里不再可能被 prompt 漂移悄悄抹掉

## v2026.517.5

合并 v2026.517.1 – v2026.517.5 全部更新。

### New

- **`loop` CI 自愈** — story 引入的 CI 红自动修，修不好才写 ALERT，不再每次都停下等人 `[loop]`
- **`roll loop events`** — 查看每轮详细事件流：任务选择、评审、CI、合并全都有迹可查 `[loop]`
- **`features.md` 区分已上线和规划中** — 一眼看出哪些能用
- **七个功能区补上中英双语用户指南** `[dream]`
- **dream 检测功能目录过期** — 文档落后时不再悄悄无人知晓 `[dream]`
- **Roll 官网上线** — 装、用、原理一站讲清楚

### Improved

- **`roll-build` 收尾三角度并行深审**（重用 / 质量 / 效率），自检清单新增参数膨胀、N+1 等反模式
- **loop 实时输出突出重点** — TCR、评审、CI gate 高亮，工具日志不再喧宾夺主 `[loop]`
- **loop attach 三个等待点动态反馈** — story 执行、CI、PR 合入不再像卡住 `[loop]`
- **官网首屏动画** — 6 秒内演示装好到自动交付的完整流程

### Fixed

- **多 cycle 并行不再双取同一 Todo** — 新 cycle 启动前扫 OPEN 的 loop PR 跳过已认领故事 `[loop]`
- **loop 等 PR 合入 main 才算交付** — 不再 CI 绿就以为代码进了主干 `[loop]`
- **孤儿 worktree 恢复的 PR 不再被 BEHIND 状态卡住** `[loop]`
- **无 PR 时 `roll ci --wait` 不再死等超时** `[loop]`
- **`roll loop runs` 看得到刚跑完的记录**，且跨子目录可见 `[loop]`
- **`roll dream` / `roll brief` / `roll loop` 定时任务不再被 Claude 升级弹窗拦住悄悄失效**
- **mac 休眠不再打断 loop cycle** — 全程保持唤醒 `[loop]`
- **agent 假死时 loop 自动接管**，不再无限挂起 `[loop]`
- **PR 合并失败时 loop 仍把代码备份到独立分支不丢失** `[loop]`
- **loop 启动时自动恢复上一轮中断工作**，意外中断的代码不再失踪 `[loop]`
- **`roll loop now` 卡住状态会先自愈再启动** `[loop]`
- **自治 loop 不再被权限弹窗卡住** `[loop]`
- **`roll peer` 多轮 review 不再中途断线** `[peer]`
- **loop 空跑也清理 worktree**，不再随时间堆积 `[loop]`

## v2026.515.1

- **New**: `roll brief` / `roll dream` 生成文档后自动提交推送 — 每次晨报和夜检不再需要手动 commit `[loop]`
- **New**: 双语 FAQ 指南 — 10 个自治交付常见场景（loop 卡住、PR 冲突、agent 切换、权限问题等），每条含原因和原理，EN + ZH 对照 `[docs]`
- **Fixed**: loop 孤儿状态自愈 — cycle 启动时检测 state.yaml 残留 running，若无活跃进程则自动重置为 idle，防止 loop 因中断永久卡死 `[loop]`
- **New**: 可选的事件驱动 PR 评审模板 — `cp templates/workflows/pr-review-event.yml .github/workflows/`，PR 开即触发 AI 评审，不装也行（loop 每轮兜底） `[pr]`
- **New**: loop PR inbox 从"分类但空转"升级到"分类+执行" — eligible PR 自动调 AI 评审，stale PR 自动 rebase，fork 和冲突写 ALERT；bot 已评审的 PR 自动让步 `[loop]`
- **New**: `roll review-pr <number>` — agent-agnostic AI 代码评审，任意 agent（Claude/Kimi/DeepSeek 等）均可评审任意 git 平台的 PR；PR body 加 `[skip-ai-review]` 可跳过 `[pr]`
- **Fixed**: `roll peer` 终态后 tmux session 不再残留 — AGREE/ESCALATE/UNKNOWN/round≥3 自动 kill，round<3 保留复用 `[peer]`
- **New**: `loop/cycle-*` 远程僵尸分支兜底 GC — 每轮 cycle 结尾扫描已合入 main 的 `loop/cycle-*` 分支并删除，弥补 PR auto-merge 失败时的清理盲区 `[loop]`

## v2026.514.5

- **Fixed**: 上版 `claude/*` 临时分支清理意外失效 — 现已恢复 `[loop]`
- **Fixed**: loop session 结束后本地 worktree 不再积累，`git worktree list` 保持干净 `[loop]`
- **Fixed**: 发版脚本不再维护独立的 agent 检测逻辑，配置变更时两处不再悄悄漂移

## v2026.514.3

### 约定与导航

- `$roll-design` 澄清需求前先自己定位产品端和业务域，问你的问题少了
- `$roll-doc` 为已有项目生成 AGENTS.md 导航骨架 — 新接入 Roll 不再从空白出发

### 自动化流水线

- loop 每轮先消化开放 PR 再领新 backlog — 把队列里的 PR 当成首类工作，不是绕开的障碍 `[loop]`
- 自己开的 `loop/*` 分支不会被自己评审，避免同源 bias `[loop]`
- 24 小时内 rebase 同一个 PR 超过 3 次自动熔断，workflow 文件出错时不再无限循环 `[loop]`
- 每次 session 收尾自动删掉自己推上去的 `claude/*` 临时分支，远端不再积压"看起来要发 PR 实际不会发"的孤儿分支 `[loop]`

## v2026.514.2

### 自动化流水线

- 故事跑完自动开 PR，CI 过了就合入主分支 — 你不需要盯着，审计记录也完整保留 `[loop]`
- AI 评审现在有实权：可以批准或打回 PR，配合 CI 形成双重把关；真的很急可以在 PR 描述里加 `[skip-ai-review]` 临时绕过 `[loop]`
- 散落的 session 分支自动清理，远端仓库不再越来越乱 `[loop]`

### Changelog 开始管自己

- 生成时自动过滤技术黑话，并对照历史风格保持表达一致 `[loop]`
- 写入前有一道自审：行文不达标就退回重写，不进 changelog `[loop]`
- 历史版本全部重新整理：按主题分组、合并同类项、附 `[loop]` / `[dream]` 归因标记
- Release Notes 生成规范写入 Skill：分组规则、条目合并、归因标签、措辞原则

### 可见性

- Peer review 协商现在对所有 agent 实时可见，不再只是 claude 专属
- "Release ready" 只有真的有东西可发时才会亮，纯文档改动不再误报 `[loop]`
- PROPOSAL 的提示指向了实际有内容的地方 `[loop]`

### 其他

- 纯文档改动直接合 main，不等 CI，合并更快
- README 新增 Evolution 章节，梳理 Roll 从工具到自主交付系统的演进脉络

## v2026.513.1

### Loop 更可靠了

- 每轮 story 在独立工作区里跑，完了自动合回来清理；跑挂时现场保留，不会碰主分支上你正在改的东西 `[loop]`
- `depends-on:` 和 `manual-only:` 标签现在真的有用 — Loop 自己会跳过条件没满足的任务，不用再盯着 `[loop]`
- 同时只有一个 Loop 在跑，并发写入的问题修掉了 `[loop]`
- `roll update` 之后 loop 状态不再误报 off `[loop]`

### 测试和 CI

- Unit 和集成测试并行执行，机器有多少核就用多少，等待时间降下来了 `[dream]`
- 纯文档改动不触发 CI 全套测试，合并更快 `[dream]`

### Dashboard

- 重新设计：三层自治状态 + 四道防线 + Pipeline 全景 + 当前焦点 + 介入区，一屏看完 AI 正在做什么 `[loop]`

### 修复

- `roll peer` 协商退出时偶发的崩溃修掉了 `[loop]`

## v2026.512.8

### 掌控感更强了

Loop 已经能跑、能看了——这一批让你对它有更多控制权：

- `roll loop pause` / `roll loop resume` — 想自己上手时一键暂停，做完再让 AI 接着跑 `[loop]`
- `roll alert` — 集中查看、确认、清除 loop 产生的告警，不用翻 loop status `[loop]`
- macOS 系统通知 — story 完成或有新告警时自动弹通知，静音模式下不打扰 `[loop]`
- `roll ci [--wait]` — 查看当前 CI 状态，或等 CI 跑完再继续手头的事

### Loop 更聪明了

- Loop 现在等 CI 通过后才标 story 完成，CI 红了会保持进行中并发出提醒 `[loop]`
- API 出错时自动重试，不再直接中断 `[loop]`
- 弹窗认识 Ghostty 和 iTerm2 了，不再强制弹 Terminal.app `[loop]`
- BACKLOG 支持 `block` / `defer` — 卡住的任务标一下就不占队列了

### 文档体系上线

- loop / dream / peer 中英文用户指南全部上线，覆盖所有子命令和使用场景 `[dream]`
- `$roll-doc` — 扫描任意项目的文档现状，找出缺口并生成草稿 `[dream]`
- Dream 每晚检测文档是否跟代码脱节，发现问题写进重构待办 `[dream]`
- `roll status` 新增跨项目 loop 状态一览

## v2026.511.8

### 终于能看到 Loop 在做什么了

Loop 上线后最大的感受是「不知道它在干啥」——这一批更新专门解决这个问题：

- Loop 开跑时自动弹出终端窗口，AI 干活的过程实时可见 `[loop]`
- `roll loop attach` — 随时接入正在跑的 loop 现场 `[loop]`
- `roll loop runs` — 查看 loop 最近几次跑了什么、完成了哪些 `[loop]`
- BACKLOG 任务执行中实时显示进度标记，不用等做完才知道 `[loop]`
- 不想被打扰时，`roll loop mute` 关掉弹窗，`roll loop unmute` 恢复

### Loop 更稳了

- macOS 上调度从 crontab 换成 launchd，重启后不丢 `[loop]`
- 升级 roll 后 loop 服务自动生效，不用手动重启 `[loop]`
- 多个项目同时跑 loop，互不干扰 `[loop]`
- 崩溃或异常退出后，下次启动自动清理残留状态 `[loop]`
- 并发触发时自动跳过，不重复执行 `[loop]`

### 其他改进

- `roll loop monitor` — 一屏查看 loop / dream / brief 三个服务状态
- `roll loop status` 三态显示：没装 / 装了没启 / 正在跑，一眼看清
- `roll init` 升级后自动迁移 loop 配置，少一步手动操作

## v2026.510.10

### Loop、Dream、Brief 首次亮相

Roll 从「技能编排工具」变成了「自主执行系统」——三个新组件同步上线：

- `roll loop` — 让 AI 自动调度 BACKLOG，Story 一个接一个跑，不用你盯着
- `roll brief` — 每天早上自动整理昨天做了什么，帮你快速恢复上下文
- `roll-.dream` — 每晚自动巡检代码和架构，把发现的问题写成可执行的待办

### 自动化能力

- 每个 Story 交付时自动沉淀一个 E2E 测试，项目逐步积累可回放的验收套件 `[loop]`
- CI 失败会自动分诊，按严重程度路由成 backlog 里可执行的修复项 `[loop]`
- `roll debug` 诊断出根因在源码内时，自动进入修复流程并回验 `[loop]`
- Changelog 每次部署后自动更新，不再需要手动整理 `[loop]`

### 可见性

- `roll status` / `roll update` 运行后展示最近几个版本的更新内容
- `roll release` 命令 — 在 CLI 里直接触发发布，不用记路径

## 2026.05.09
- **Added**: roll-peer 跨 Agent 代码评审 — 支持 Claude Code、Kimi CLI、DeepSeek TUI、Codex CLI 多工具协同评审 (by @seanyao)
- **Added**: DeepSeek TUI 和 Codex CLI 支持 — roll-peer 新增两个 AI 工具后端 (PR #6 by @leoliu198998-ui)
- **Added**: Claude GitHub Actions — PR Assistant 和 Code Review 自动化工作流 (PR #8)
- **Fixed**: roll-peer DeepSeek serve 探测 — 修复 pipefail 和 grep 范围问题，避免误判 (PR #9, #10)

## 2026.05.08
- **Improved**: 技能清单瘦身 — 移除所有技能 YAML 中的 model 字段，简化配置

## 2026.05.07
- **Added**: Pi (pi-coding-agent) 支持 — 新增 AI 工具检测和集成
- **Added**: DeepSeek TUI 支持 — 新增 ai_deepseek 检测和配置同步 (PR #5 by @leoliu198998-ui)
- **Improved**: roll-design DDD 建模 — 增加战略设计（Context Map）和战术建模（Aggregate/Entity/VO）能力
- **Fixed**: roll update 版本校验 — npm install 后验证实际安装版本，CDN 不一致时自动重试
- **Fixed**: AI 工具检测加固 — 修复 pi 工具检测逻辑，补充 _is_ai_installed 测试用例

## 2026.05.06
- **Added**: OpenCode 集成 — 检测 opencode 环境，自动同步全局 AGENTS.md 规则文件
- **Improved**: Git 提交归属 — 用 Co-Authored-By trailer 替代 [client] 前缀，更标准的多 AI 工具归属方式
- **Improved**: AGENTS.md 加入 Scope Gate — 防止技能执行时越界修改不相关文件

## 2026.05.05
- **Added**: 技能权限声明 — 每个技能声明 allowed-tools，约束 AI 工具可用范围
- **Added**: 技能模型绑定 — 每个技能绑定最适合的 AI 模型，平衡性能和质量
- **Added**: Identity 约定 — 从 git config 读取身份信息，禁止在约定文件中硬编码个人数据
- **Improved**: CLI 命令精简 — 收敛为 setup / init / hook / status 四个核心命令
- **Improved**: 约定文件重构 — 公共规则提取到 conventions/global/AGENTS.md，工具专属文件瘦身
- **Fixed**: 同步时清理已删除文件，防止用户机器残留幽灵文件
- **Fixed**: 修正 AGENTS.md 中过时的文件路径引用
- **Fixed**: 修正 GEMINI.md 中技术栈描述错误
- **Fixed**: 修正遗留的 Wukong 品牌引用为 Roll
- **Fixed**: package.json 作者邮箱修正

## 2026.05.04
- **Added**: BB 注入模式 — 对未集成 Black Box 的页面自动注入诊断探针，统一数据采集接口
- **Added**: roll-doctor 技能 — 一键诊断开发工具链健康状态（Node、npm、git、AI 工具等）
- **Improved**: roll-notes 写作风格 — 强制叙事体写作，保持风格一致性
- **Improved**: 约定文件更新 — 整合 insights 建议到全局约定中

## 2026.05.03
- **Fixed**: npm publish 代理冲突 — 发布前清除代理环境变量，避免网络错误
- **Fixed**: 模板中 $roll-story 过时引用 — 统一替换为 $roll-build (PR #4)

## 2026.04.29
- **Improved**: roll-notes 叙事风格 — 强化写作规范，确保笔记保持统一的叙事语调 (by @Sean via Kimi CLI)

## 2026.04.24
- **Added**: Trae IDE 支持 — 生成 project_rules.md 规则文件，`roll` 命令自动检测 Trae 并同步配置
- **Fixed**: 同步函数容错 — 源文件不存在时正常返回，避免 set -e 崩溃
- **Fixed**: Trae 检测和配置迁移 — 修复 ai_* 配置项缺失时的检测逻辑

## 2026.04.22
- **Improved**: 技能审计 P0 — 名称对齐、清理过时引用、补充 When Not to Use 段、统一 license 声明 (PR #3 by @sealfe)

## 2026.04.21
- **Added**: roll-notes 技能 — 开发过程中随手记录想法和笔记，叙事体写作
- **Improved**: 品牌清理 — 清除遗留的旧品牌引用，移除废弃的 roll-probe 技能和 clean 命令
- **Fixed**: git 安装检测 — 直接检查 .git 目录，避免在 nvm 环境下误判
- **Fixed**: roll-release YAML 描述引号修复

## 2026.04.20
- **Added**: roll-release — 一条命令完成版本号、changelog、tag、npm publish 全流程
- **Fixed**: uninstall.sh 同时清理真实目录和符号链接
- **Fixed**: npm 发布 token 切换为 classic automation token，修复 CI 发布失败

## 2026.04.19
- **Added**: npm 分发 — 开发/运行时路径分离、`roll update` 自动更新、后台版本检查提醒、npm 发布基础设施

## 2026.04.17
- **Added**: roll-jot — 一句话快速记录 bug 或想法到 backlog，不打断当前工作
- **Added**: roll-.clarify — 遇到模糊需求时自动追问，确保开工前意图清晰
- **Added**: roll-.clarify 集成到 roll-design 工作流 — 模糊输入时自动触发澄清
- **Improved**: CLI 精简 — 三步极简 init，约定文件转为技能参考，技能自动读取项目上下文
- **Fixed**: roll init 工作流文件缺失 — 补全初始化所需的模板文件 (PR #1 by @leoliu198998-ui)
- **Fixed**: roll-build 技能 YAML 描述引号修复 (by @Sean via Kimi CLI)
- **Fixed**: 通信规则同步和优化 — 对齐全局约定源，抑制实现细节噪音 (by @Sean via Kimi CLI)
