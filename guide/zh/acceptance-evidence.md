# 验收 Review Page — `roll attest`

每个交付完成的 story 都可以带一份**单文件验收 Review Page**：逐条 AC 的判定与支撑证据，
离线可开、可打印 PDF、非工程角色也能读。

## Review Page 位置

每个 story 只有一个家——史诗下的卡片文件夹：

```
.roll/features/<epic>/<id>/<run-id>/<id>-review.html  ← 验收 Review Page（自包含）
.roll/features/<epic>/<id>/<run-id>/<id>-report.html  ← 旧报告兼容别名（一个发版周期）
.roll/features/<epic>/<id>/<run-id>/evidence.json     ← 采集的硬事实
.roll/features/<epic>/<id>/<run-id>/evidence/         ← 原始命令/测试产物
.roll/features/<epic>/<id>/<run-id>/screenshots/      ← 需要视觉验收时的截图
.roll/features/<epic>/<id>/ac-map.json                ← AC → 证据的意图映射
.roll/features/<epic>/<id>/latest                     ← 指向最新一次的软链
```

每次运行按时间戳落盘、永不覆盖。backlog 的 `✅ Done` 行链接到
`latest/<id>-review.html`；CHANGELOG 条目旁可带不可见的
`<!-- evidence: ... -->` 注释 marker 供追溯。

**故事自己的 `latest/<id>-review.html` 就是人类验收入口。** 验收一张故事看的是
它自己的验收 Review Page，不是全局 archive/index 页面。`roll attest` 只对当前故事负责：
它只写本故事的 Review Page、旧报告兼容别名和 `latest` 指针，不刷新任何全局 archive / 史诗 / 首页
HTML。那些归档页想看时用 归档重建 按需渲染，它们是便捷/归档视图，不是交付真相面。

## 三段式生命周期

1. 立框。loop 周期一开始，runner 先创建带时间戳的 run 目录，并把它通过
   `ROLL_RUN_DIR` 交给内层 agent。派生目录 `ROLL_EVIDENCE_DIR` 与
   `ROLL_SCREENSHOTS_DIR` 分别指向 `<run-id>/evidence/` 和
   `<run-id>/screenshots/`。
2. 过程采集。`roll test` 把命令输出和摘要写入 `ROLL_EVIDENCE_DIR`；需要视觉
   验收的端面把截图写入 `ROLL_SCREENSHOTS_DIR`。agent 在故事卡根目录维护
   `ac-map.json`，把每条 AC 映射到支撑证据，并标注状态：`pass` ·
   `pass-with-evidence` · `readonly` · `partial` · `claimed` · `missing`。
3. 收尾硬闸。交付结束时 runner 调用
   `roll attest <story-id> --run-dir "$ROLL_RUN_DIR"`。`roll attest` 清扫硬事实
   （TCR commits、最新 CI、可选部署探针、test-pass 凭证），渲染验收 Review Page，把
   `latest` 指向本次 run。仅此而已——它只对当前故事负责：不挂载故事页交付段、
   不重建 `.roll/index.json`、不刷新任何全局 archive/史诗/首页（那些归档页用
   归档重建 按需渲染）。

`roll attest` 也可独立运行——没有意图映射时，每条 AC 诚实渲染为 🟧 仅声明。

抓到的产物按**实际媒体类型**渲染，不按产生它的采集通道决定。图片文件（`png`、`jpg`、
`jpeg`、`webp` 或 `gif`，包括无扩展名但能识别出图片签名的产物）显示为图片；`.txt`、
`.log` 等文本输出会先转义，再以内联、可读的 `<pre>` 块显示。因此，终端采集可能以任一
形式出现。

## 闸口策略

验收闸**默认是 hard**。带 AC 的 story 若交付完成却没有新鲜且内容充足的报告，
不会被标成 `✅ Done`，而是直接拦住。显式迁移窗口可在 `.roll/policy.yaml`
里改成 soft：

```yaml
loop_safety:
  attest_gate: soft
```

soft 模式会记录缺口并发出同一类审计信号，但不阻塞本轮交付。它是临时兼容口，
不是默认行为。

合并闸读取结构化证据，不读口头说明。出现以下事实时，交付可能被拒合：

- `attest render` 退出码非零；
- `ac-map.json` 引用的路径无法在本次 story run 或卡片归档下解析，除非是本仓允许的
  GitHub PR/commit/check URL；
- AC 仍是 `claimed`，表示 Builder 只有完成声明，没有 pass/fail 证据；
- AC 仍是 `needs-confirmation`，表示 harness 草稿还没被 Builder 处理；
- positive AC（`pass`、`pass-with-evidence`、`readonly` 或 `partial`）没有真实证据引用；
- 无豁免的可视卡没有截图，也没有记录化的机器采集 skip；
- 声明了 `deliverable_url`、`deliverable_cmd` 或 `physical_terminal`，但对应
  surface 没有真实采集；
- AC 是 `fail`，表示检查执行过并变红。

PR body 会带 `Roll-Evidence` trailer，指向这张 Story 的证据入口。人工评审从这里开始：
打开验收 Review Page，再沿 AC map 和引用文件检查。

发版前或发现 Done 行可疑时，运行审计命令：

```bash
roll attest audit
roll attest audit --json
```

它会扫描 Done stories，查缺失报告、缺失或空的 `ac-map.json`、悬空证据引用和
`evidence_debt` 行。无问题退出 0；发现问题退出 1，并列出 story ID 与缺失引用。

## 红线

**零证据**的 AC 永远不能是 `pass` 或 `pass-with-evidence`：渲染层强制降级为
🟧 仅声明，并列入 **Discrepancies（证据缺口）**附录。`pass-with-evidence`
表示 harness 基于硬盘上强证据做出的确认，明确不同于 agent 亲自确认的 `pass`。
"我确认它能跑"这类口头完成，正是被这条红线挡住的东西。

## 外部行为验证

有些 AC 描述的是 Roll 在本地无法证明的行为——真实的
`npm i -g github:owner/repo`、发布后 CLI 的首次启动、线上 OAuth 回调。构建成功
或 `npm pack` 通过并**不能**证明这些；模拟不是外部承诺本身。把这类 AC 标为
manual-only 再呈绿色，等同于用"未执行"替代"通过"。

当一张故事或修复记录了外部安装 / 发布 / 登录渠道时，相关 AC 必须在 Evaluation
契约里显式声明**一种**验证路径——Roll 从不从散文里猜"什么算外部"：

```yaml
expected_evidence:
  - kind: external-smoke                     # 隔离环境里的真实命令
    target: npm i -g github:owner/repo#<commit> && repo --version
    proves: 文档里的 git 安装渠道能在全新目录真实安装并启动
    outward:
      mode: external-smoke
      command: npm i -g github:owner/repo#<commit> && repo --version
      environment: release                   # ci | nightly | release
      timeout_sec: 180
  - kind: owner-attested                     # smoke 无法覆盖时的人工签字
    proves: 生产环境 OAuth 回调可往返
    outward:
      mode: owner-attested
      reason: 需要真实第三方账号，没有安全的自动路径
      approvalRef: https://github.com/owner/repo/issues/1343
```

attest 报告会在靠上位置渲染一个**外部行为验证**横幅与表格。只有真实 smoke 通过
（或有效、未过期的 owner 认证）才是绿色：

| 解析状态 | 报告文案 | 绿色？ |
|----------|----------|--------|
| `verified` | `VERIFIED (external smoke)` / `VERIFIED (owner-attested)` | 是 |
| `verified-in-simulation` | `verified-in-simulation — simulation only, NOT accepted` | **否** |
| `unverified-external` | `UNVERIFIED — external smoke not run`（或 `owner attestation pending`） | **否** |
| `failed-external` | `FAILED — external smoke` | **否** |

只要有一个外部 AC 不是 `verified`，横幅即转红——交付不能夸大自己的外部行为。
`npm pack` 之类的模拟证据会保留并标注 `verified-in-simulation`，但绝不替代真实 smoke。

### 发版 / nightly smoke 环境搭建

外部 smoke 在**隔离**环境里运行——全新的临时 `HOME`/`PREFIX`/工作目录，只执行
spec 中显式声明的命令模板与受控变量。产物记录 exit code、版本、脱敏后的
stdout/stderr 摘要；凭据从不落盘。

用 `ROLL_SMOKE_ENV=release`（或 `ci` / `nightly`）把运行器指向对应环境；声明的
`environment` 与当前环境不匹配时会被报为 `unverified`，绝不静默跳过。**任何真实
发布或账号操作永不自动执行**：凡是推送包、改动远端账号或产生费用的动作，没有声明
的授权（你写进 spec 的 `external-smoke` 命令，或一条 `owner-attested` 批准引用）
就不会跑。若没有匹配的 smoke 环境，AC 保持 `unverified`、报告保持非绿——绝不会被
自动升级成手工通过。

## 设计期声明可视证据

`roll story validate` 在设计期就检查一张卡是否**生而诚实**——带可视证据 AC，
且 web 面要声明可截的产品页。若卡有可视证据 AC，但没有声明任何交付面
（`deliverable_url`、`deliverable_cmd`、`physical_terminal` 或
`screenshot_exempt`），validate 只打印 must-declare 软警告，仍以 0 退出。
运行时 gate 也只把同一信号作为诊断携带，不会仅因此阻断或把交付标成 skipped。
校验器靠两条规则识别：

- **`[visual-evidence]` 标记即定论。** 以字面 `[visual-evidence]` 标记开头的 AC
  条目**本身**就是可视证据 AC，无论后面写什么词——不必再额外写"截图 / screenshot"：
  标记就是你的显式声明。（没标记时，校验器仍认 `screenshot` / `截图` / `录屏`
  这类无歧义名词。）

  ```markdown
  - [ ] [visual-evidence] headless 截 Now 落地页及各 tab 真实渲染
  ```

- **声明的交付面优先于 AC 文本。** 一旦卡有了可视证据 AC，其 surface 先看 frontmatter：
  - 声明了 `deliverable_url:`（别名 `screenshot_url:`）⇒ **web**——卡已承诺一个真实
    产品页,就该截 web 图；
  - 声明了 `physical_terminal:` ⇒ **terminal**，但合同更严格——报告必须包含从 macOS
    `Terminal.app` 真实屏幕像素截下来的图。headless stdout、transcript 渲染图、
    HTML replay 图都不能满足这个合同。`roll attest` 会在可用时请求
    `physical.screenshot` provider，把返回的 PNG 复制进本 story 的 run 目录，
    并在报告里展示 `requested -> taken/skipped/failed/timeout -> attached/not-attached`
    状态链；
  - 否则声明了 `deliverable_cmd:` ⇒ **terminal**——走终端截屏通道的 CLI 交付；
  - 否则由 AC 文本判定（web / terminal / 含糊）。

  所以声明了 `deliverable_url: .roll/features/agents.html` 的卡判为 **web** 面，
  即便其 AC 文案里提到 `roll` 命令。

## 证据模式

Story 可以在 frontmatter 声明 `evidence_mode:`，也可以在 Evaluation contract
里声明 `- evidence_mode: ...`。Roll 也会为 Evaluator prompt 推导模式，但只有显式
声明的非视觉模式会改变截图门。
这个显式模式不是空白覆盖：已经声明 URL、终端命令、physical terminal 或
visual-evidence AC 时，仍会升级到对应截图/采集门。

| 模式 | 必需证明 | 截图策略 |
|------|----------|----------|
| `visual_ui` | 真实渲染截图、功能/冒烟检查、CI | 必需 |
| `cli_output` | stdout/stderr 快照、退出码、命令 fixture 或聚焦测试、CI | 条件必需；终端/TUI 视觉变化仍要截图 |
| `refactor_contract` | 聚焦测试、typecheck/build、grep/no-old-symbol 检查、CI | 默认不需要；有视觉风险时升级 |
| `data_state` | fixture replay、事件断言、幂等/并发覆盖、CI | 默认不需要；有视觉风险时升级 |
| `docs_content` | rendered text 检查、链接检查、diff review、CI | 条件必需；布局变化要截图 |

`screenshot_exempt:` 应命名或明确指向替代矩阵，最好配套
`evidence_mode: refactor_contract`、`data_state` 或 `docs_content`。QA/Evaluator
可以在三种情况下把非视觉模式升级回截图门：改了视觉表面、AC 明确要求 visual
evidence、已有证据暴露 rendering/layout 风险；升级原因必须记录。

## 外部工具就绪度

可视证据依赖机器级工具；这些工具会被显式声明，并在启动时探测：

- `macOS screencapture` —— 物理 Terminal.app / 浏览器窗口截图工具。它是 macOS
  内置工具，但作为稳定截图宿主的 Terminal.app 需要 Screen Recording 权限。
  缺权限时 attest 记录明确的截图 skip；headless、transcript 渲染图和 HTML
  复现图都不算截图证据。交互式 `Terminal.app` 授权探针一旦成功，会缓存在
  `ROLL_HOME` 下，后续 `roll doctor` / setup 检查不会反复触发 macOS 权限弹窗；
  如果刚刚授权，先重启 Terminal.app 再信任缓存。
- `Roll Capture.app` / `physical.screenshot` —— 物理截图请求的 provider 通道。
  就绪度不可用时，`roll attest` 记录带设置原因的 honest skip，不阻断报告生成；
  provider 超时时，报告把 timeout 作为独立失败原因展示。
  macOS npm 安装会尝试从 `seanyao/roll-capture` 最新 Release 安装 app 到
  `~/Applications`；`roll setup` 可重试这条修复路径，除非传入
  `--no-capture-install`。

  **截图默认策略 (US-PHYSICAL-006)：** 物理截图请求默认使用**窗口级**截取——
  只截被测应用的窗口（终端/CLI 证据截 Terminal.app，网页证据截 Google Chrome），
  不再默认全屏。全屏截图必须在卡片 spec 中显式声明 `capture_fullscreen: true`。
  这个隐私优先的设计防止证据链夹带屏幕上无关的隐私内容（聊天记录、邮件、其他项目）。
  如果目标窗口找不到，Roll Capture.app 会返回带有原因的降级记录——不允许静默扩大截取范围。

### 截图 v2 网关 —— 按来源就绪度 (US-PHYSICAL-010..013)

Roll 的截图主机支持两种协议。`roll capture status` 现在**按来源**分别报告就绪度,
不再在某条通道还是 v1 时笼统谎报"v2 就绪":

- **渲染态 (`playwright-rendered`)** —— 由 Roll **进程内**用无头 Playwright 提供:
  声明的网页界面渲染成 PNG,转成带 `sha256` 摘要的 `roll.capture.v2` 收据。**仅在装了
  Chromium 时**才广播 v2;否则状态显示 `unavailable` 并给出可执行原因(绝不伪造能力)。
- **物理态 (`roll-capture-window`)** —— 原生 `Roll Capture.app`,今天诚实标为 **v1**
  (文件投递协议)。物理 v2 是单独的后续卡(US-PHYSICAL-014);状态标 `v1` 而非谎称 v2。

接线方式:

- `roll capture refresh` 探测本机真实能力,写出诚实的 `capabilities.json`(渲染器在→
  渲染通道 v2;物理→v1)。
- `roll capture status` 随后按来源显示 `v2 playwright-rendered — ready` 与
  `v2 roll-capture-window — unavailable`(legacy),不再是一条笼统结论。
- `roll capture migrate` 仅当渲染态 v2 通道真正 served 时才开启 `best_effort`,否则保留
  当前策略并说明原因。开启后,声明界面经进程内渲染通道派发,产出归入 CaptureSet 的
  taken v2 收据;登录 / 跳转 / 非法目标记为 `skipped`,绝不伪造 taken。
- `Playwright Chromium` —— 可选的 headless web 截图工具，用于 `roll attest`
  和归档截图。安装命令是 `npx playwright install chromium`。

`roll doctor` 总是打印这些工具的可用性、权限状态、影响和修复命令。只想看工具与
Terminal.app Screen Recording 就绪度时，用 `roll doctor --tools`。`roll init`
与 `roll loop go` 在启动时跑同一套探测；交互式终端会询问是否安装/打开缺失的
设置步骤，自动化环境默认静默，除非设置 `ROLL_EXTERNAL_TOOLS=yes` 或
`ROLL_EXTERNAL_TOOLS=no`。选择 `no` 时会说明证据影响，然后继续，不改机器状态。

机器级 Agents 页面（`.roll/features/agents.html`）也显示同一块工具状态，方便
审阅者区分证据采集问题来自机器配置，而不是 story 代码。

## Best-effort 截图、证据健康与修复

视觉证据是一种 **best-effort（尽力而为）** 的交付能力：每个声明的视觉面都会经由
每条合格截图通道尝试采集，截图服务的故障绝不会被误判为产品回归。交付正确性与
视觉证据健康是**两件独立的事实**。

### 来源标签

每张被接受的图像都带有产出它的通道：

- **Roll Capture · physical（物理）**——由 Roll Capture.app 对你真实终端或应用
  窗口拍摄的物理截图。它证明屏幕上呈现了什么；它绝不声称自己无法观测到的 URL。
- **Playwright · rendered（渲染）**——`finalUrl` 经批准的重定向归一化后等于声明
  目标面的渲染回执。绑定目标的渲染回执是合格的视觉证据——不同于诊断截图。

绑定目标的渲染回执可以独立满足视觉 AC。物理 Roll Capture 图像是满足视觉 AC 的一种
合格来源；绑定目标的渲染回执是另一种同样合格的来源。

### 四种视觉状态

| 状态 | 含义 | 闸动作 |
|------|------|--------|
| `verified` | 至少一张有效且绑定目标的图像（物理或渲染） | 正常发布 |
| `degraded-infrastructure` | 每条配置通道都已尝试；只发生宿主/供应方/工具类故障 | 发布并显式标记降级；**不重建**——可由仅证据重跑修复 |
| `invalid-target` | 某条通道到达登录页、未批准重定向、错误目标、损坏图像或伪造回执 | 作为证据失败拦截；修复目标/配置 |
| `absent-contract` | 无声明面、无计划尝试，或规划器被绕过 | 作为设计/执行失败拦截 |

`degraded-infrastructure` 有意不等于绿色截图结论。它把代码交付与损坏的证据机器
分开，使同一个已完成的故事不会被反复重建。

### 隐私边界

- 回执绝不包含凭据、cookie、DOM 转储或网络响应体。
- 窗口捕获默认限定窗口范围；目标缺失产生带类型的失败，绝不静默扩大为全屏。
- `ROLL_NO_SCREENCAP=1` 只禁用 Runner 直接的原生 `screencapture` / AppleScript
  路径，不会关闭 Roll Capture 网关请求或 Playwright 渲染尝试。

### 受控本地窗口截图

物理网页证据需要浏览器窗口、但当前没有安全目标窗口时，使用受限的本地通道：

```bash
roll capture local-window --story FIX-005 --url http://127.0.0.1:4173/team
```

合成本地 UI 需要在截图前产生可见状态变化时，可加受限的 `--prepare` JSON 列表：

```bash
roll capture local-window --story FIX-1435 --url http://127.0.0.1:4173/ \
  --prepare '[{"kind":"click","selector":"#synthetic-checkbox"},{"kind":"wait","ms":300},{"kind":"scroll","selector":"#synthetic-result"}]'
```

`--prepare` 只允许有上限的 `click`、`fill`、`wait` 与 `scroll`。未知字段或动作种类、
任意 JavaScript、导航、超量动作或等待都会在 Chrome 启动前被拒绝。临时 Playwright 连接只会
附着到一次性 loopback Chrome，精确定位已发现页面及其唯一的原始目标 frame，并在每一步后
校验该 frame 仍处于同一精确 URL。连接随后只断开，不会关闭待截图窗口。`click` 通过浏览器
UI 路径定位可见元素，使受控 React 输入走正常事件路径。准备动作失败时不会发送截图请求。
`fill` 只接受非 password 的 `input` 与 `textarea`，contenteditable 目标会被拒绝。

这不是通用浏览器自动化：它不能使用 owner profile，也不能打开远程 URL。prepare API 不
暴露 cookie 或 storage 的读写、导入或导出操作，也不会注入凭据；目标本地应用本身的正常
UI 交互仍按原样运行。`fill` 会拒绝 password 控件，且只能填写不敏感的本地合成值；绝不能
在命令行传入凭据或个人信息。

它只接受 loopback HTTP(S) 页面。Roll 会启动一次性 Chrome profile 和带 nonce 标题
的本地 wrapper 窗口，要求 Roll Capture.app 只截该精确标题窗口，随后关闭 wrapper、
Chrome 与 profile。它不会打开远程 URL、连接 owner Chrome profile，也不会回退为全屏
截图。JSON 结果会给出物理回执与精确 selector。

真实本地受控输入回归为显式选启，因为它会打开可见的一次性 Chrome 窗口；它只提供临时合成
React 页面，桌面 Chrome 宿主不可用时会失败并明确说明：

```bash
ROLL_BROWSER_LIVE=1 pnpm test:controlled-capture-live
```

### 仅证据修复

`degraded-infrastructure` 交付可以在不重开构建的情况下修复：

```bash
roll capture repair <story-id>
```

它**只**重跑截图通道并重新解析证据健康，绝不触碰 TCR / 构建周期，绝不重开已完成
的交付。对失败交付或任何非降级状态，它会拒绝（同样不重建）。结果为 `verified`
时发布新采集的图像；仍为降级时保持可发布并标记降级。

### 启用 best-effort 截图

新视觉故事的默认值是 `best_effort`。既有项目保留其已记录的策略，直到一次显式、
能力感知、可回退的迁移显式启用它：

```bash
roll capture migrate            # 仅在 v2 网关与渲染器都就绪时启用 best_effort
roll capture migrate --dry-run  # 只预览不写入
roll capture migrate --revert   # 恢复此前记录的策略
```

迁移是幂等的。只有在 v2 Roll Capture 网关**和**浏览器渲染器**都**就绪时才启用
`best_effort`；否则保留既有策略并给出显式原因（`provider_v2_unavailable` /
`renderer_unavailable`）——绝不猜测回落，绝不强制翻转既有项目。

### 就绪度

`roll doctor`（以及 `roll capture status` 与 `roll loop status --capture`）会报告
v2 网关就绪度、渲染器就绪度与有效截图策略——每项都带可执行原因：

```bash
roll doctor              # 含 “Capture policy readiness / 截图策略就绪度” 一节
roll capture status      # 同样的就绪度，独立呈现（机器读取加 --json）
roll loop status --capture
```

## Review Score 折叠区

`.roll/notes/` 里存在该 story 的评审分条目时，报告底部出现折叠的
*Review Score · 评审分* 区；没有则整块不出现。评审分由全新独立会话的
同行 Reviewer 产出，绝不由工作 agent 自评。

## 卡片从哪来 —— `roll idea`

用一句自然语言加卡：

```bash
roll idea "退款流程在部分支付时会崩溃"
```

`roll idea` 自动分类（bug→FIX / 功能→IDEA）、取下一号、lint 校验、推断归属史诗，
并创建完整卡片文件夹（spec.md + 故事页 + 刷新索引）。一个命令全搞定。

如需显式指定 ID 与史诗，内部命令 `roll story new` 仍在：

```bash
roll story new US-PAY-001 --title "退款流程" --epic payments
```

两条通道都写出带 frontmatter 的 `spec.md`、故事页骨架，并刷新 `.roll/index.json`。
已存在的卡拒绝覆盖——卡只出生一次，之后由人补充。技能从不手写卡片文件；
任何没有卡的活卡行会被一致性 `cards` 维度在发版闸拦下。

## 静态归档 —— 归档重建

归档重建 是按需的修复/归档渲染器。它把归档重建为可浏览的三层静态
HTML（每页自包含、按当前语言单语显示、明暗主题、可打印）：

```
.roll/features/index.html              ← 归档首页（Story / Cycle / Release）、
                                         真相条、可搜索的史诗卡片
.roll/features/<epic>/index.html       ← 史诗页：史诗账本 + 故事三分组
                                         （已合主干 / 周期中 / 待办）
.roll/features/<epic>/<id>/index.html  ← 故事归档：五站——立项、设计、执行、
                                         交付（验收横幅 + 逐 AC 证据块）、复盘
```

页面上每个数字都来自真相模型——anchors -> selectors -> adapter ->
projections——绝不手填。Story 聚合对比 backlog 声明与 merge/证据真相；
Cycle 聚合只读 TerminalOutcome 终态记录；Release 聚合读取最新发版闸 verdict
和有效 waiver。一句话：**待办是愿望，主干是事实，done ≡ merged。**

归档首页会显式保留未知。`?` 表示事实缺失或不在已知 schema 内；`0` 表示
已知为零。过早写下的 backlog `✅ Done` 只是和真相冲突的声明，会显示为漂移，
不会被当成已交付。

故事归档页里，截图证据仍是缩略图并可点开看大图。Vitest 输出等文本证据会从
引用的 evidence 文件读取，并以内联、折叠、可滚动的正文块显示在 AC 下；
文件缺失或不可读时，页面显示明确的不可用空态。

当前交付真相仍以按 Story 收口的 attest 加 CLI-first 可观测为准：
`roll status`、`roll loop watch`、`roll loop runs`、`roll loop cycle <id>`。手动
运行 归档重建 只用于对账、归档导出、CI artifact 或迁移修复；rebuild mode
会在手工合并或历史迁移后从源重渲每张故事页。
