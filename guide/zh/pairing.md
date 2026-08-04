# 跨 Agent 结对 —— 在 loop 里自动获得异构的第二双眼睛

结对让一个**不同**的 agent（不同厂商）自动复检你的工作。它的 primitive 是
**结对（pair）**而非评审：一个 agent 干完活，一个异构搭档复检，换来视角多样性。
一个模型盲区里藏着的 bug，另一个模型往往一眼看到。

Roll 把评审指派看成 scoped Agent 模型里的 `evaluate` 角色：
`Scope -> Role -> Binding -> Agent -> optional Model`。agent 是有限的七个身份
（`claude`、`kimi`、`codex`、`pi`、`agy`、`reasonix`、`cursor`）；model 是挂在该 agent 上的可选数据。

结对与 [`$roll-peer`](peer.md) 不同：peer 是你（或 loop 风险闸）按需发起的多轮协商；
结对是常驻的单向第二遍，接在 cycle 里，由 Project Scope 的 `evaluate` binding 管控。

## 开启 —— 显式，绝不静默

```bash
roll agent                         # 查看 story.evaluate
roll agent migrate --dry-run       # 预览旧 agent 配置的一次性迁移
```

新项目应在 `.roll/agents.yaml` 里声明 evaluator pool：

```yaml
# .roll/agents.yaml
schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [claude, codex, kimi, pi, agy, reasonix]
        require: [evaluate]
        strategy: health-aware
```

`.roll/pairing.yaml` 不再是运行时输入；scoped `evaluate` role 是结对候选的唯一来源。
静态配置列公平候选，auth/network/VPN/account 等运行时失败只在本次 resolution 中跳过候选。

一次性迁移时，只有启用的旧 `code` stage 会把其中具备代码复查能力的候选迁入
`defaults.story.roles.evaluate`。旧的 `score`、`design`、`test`、`cycle` 配置语义已废弃：
仅有 score 的条目绝不会开启代码复查，Review Score 仍独立于这个废弃文件而必跑。

## 看它做了什么 —— 可观测性

Loop cycle evidence 和角色视图会显示结对池（谁能结对、其厂商、被声明的能力，
以及某个 agent**因何被排除**），外加**结对花了多少钱**：

```
  Cross-Agent Pairing — pool status / 结对池状态

  enabled: true · stages: [code]

    ✓ claude  model=claude-opus-5 vendor=anthropic · [code]
    ✓ codex   model=gpt-5.3-codex vendor=openai · [code]
    · pi      model=deepseek-v4-pro vendor=deepseek · [code]

  pairings to date: 7 (codex×4, kimi×3) · total cost $0.94 · 11 findings
```

成本从第一天起每次结对都记账——即使还没做预算自适应，你也始终知道这第二双眼睛
花了多少。

## 选择逻辑

某阶段触发时，选择器**只**保留：已安装、可用、被声明能做该阶段、能作为 headless
reviewer 运行，且与干活 agent **不同厂商**的——然后在其中轮换（以 cycle id 为种子，
可复现）。有战绩的搭档会被温和偏好（ε-greedy，ε≈0.2），但始终保留探索，任何一对都
不会垄断。若没有合格的异构搭档，这个"没有"本身也会被记录（`pair:none-available`）——
绝不静默跳过。

## 什么才算"换了一个 agent" —— 看模型,不看名字

隔离距离算在**解析出的模型**上,厂商从模型反查,绝不从 agent 条目名猜 ——
因为按名字判断在两个方向上都错:

- **两个条目,一个模型。** 如果 `agents.yaml` 把两个 rig 钉在同一个模型上,
  它们**不是**异构对。本仓的 `pi` 与 `reasonix` 都解析到 `deepseek-v4-pro`,
  把它们配成一对,就是同一个模型评审自己家写的代码,却报告"已独立评审"。
- **一个条目,多个厂商。** `cursor` 能跑 `claude-opus-5-thinking-high`(anthropic)
  也能跑 `gpt-5.3-codex`(openai),默认还是 `auto`。把它算作"一个厂商"是虚构。

四档距离,从强到弱:

| 距离 | 含义 |
|---|---|
| `vendor` | 评审者的模型来自**另一个已知厂商** |
| `model` | 至少是另一个模型(可能同厂) |
| `session` | 同一个模型,但必须是新起的会话 |
| `off` | 不要求(必须显式写出来) |

**认不出厂商的绝不能满足 `vendor` 档。** 它会降到能证明的最强一档并记下原因。
"我们分辨不出来"永远不会被报成"它们不一样"。新增 agent 或模型时必须在同一次改动里
补上模型前缀,否则涉及它的每次比较都会静默降一档。

**选型读配置,不读观测。** 评审者会跑哪个模型在 spawn 之前就已知(它的 rig,
否则它注册的默认模型)。有几个 agent 的用量解析器是刻意留空的,
如果选型依赖观测到的模型,这些 agent 就永远达不到 model/vendor 档。
评审者自己的输出声称跑了什么,在事后**对账**并在不符时告警 —— 绝不回头改判定。

## Effort —— 一张表管两个轴

评审强度与隔离强度都是关于 rig 的事实,所以一张表同时表达:
表里出现哪些关卡就是评审强度,每个关卡的值就是要求的距离。

```yaml
# .roll/agents.yaml
effort:
  code:  vendor      # 代码评审:要求换厂商
  score: vendor      # 评分:要求换厂商
```

预设展开成同一张表:`standard`(两关都 `vendor`,**缺省**)、
`light`(`code: vendor`、`score: off`)、`off`(两关都关)。
逐关声明会覆盖它所基于的预设。

两条刻意的拒绝:

- **缺省绝不是 `off`。** 缺失 section、未知预设、非法值,全都回落 `standard`
  **并报错** —— 要关掉评审必须亲手写出来。
- **只有 `code` 与 `score` 可配。** `design`、`test`、`cycle` 在 stage 枚举里存在
  但**没有生产路径**;配置它们是一个明确的报错,而不是一个"开了却永远不跑"的设置。

## 看这个取舍 —— `roll effort`

```bash
roll effort           # 按 (关卡 × 实际达成的距离):样本、命中、成本
roll effort --json
```

只读。两件它刻意拒绝做的事:

- **样本少于 10 的格子不给命中率**,并在输出里点名。三五个样本算出的比率看着像趋势
  但不是;而 0 样本渲染成 "0%" 就是"没人反馈问题所以没有问题"那个谬误。
- **可观测与不可观测的成本绝不混入同一个平均。** 成本 `0` 曾同时表示"免费"和
  "解析不出用量" —— 现在是两列,因为用量读不出来的评审者并不是白干的。

在"实际达成距离"这个字段存在之前记录的裁定,会被单独计入 `untieredSamples`,
而不是被塞进一个从未测量过的距离里。

## 安全 —— 结对绝不阻塞 cycle

- 对复检设 **30 秒硬超时**（executor 里双保险），慢搭档绝不拖死 cycle。
- **不阻塞**：超时、出错或无搭档都只记录，cycle 照常推进。结对是增强，不是闸。
- **绝不自行动主干**：结对只产证据和事件，不做合并。

## 事件与证据

每次结对先发 `pair:selected`，再发 `pair:verdict`（含裁定、发现数、成本、阶段）
或 `pair:none-available`。裁定同时作为证据写入本轮的 `peer/cycle-<id>.pair.json`。
评分结对发 `pair:score`（分数、裁定、成本），证据写入
`peer/cycle-<id>.score.pair.json`。

## 阶段

运行中的代码复查阶段只有 `code`：配置了 `story.evaluate` 时，由异构搭档复检
交付的改动。Review Score 是完成 cycle 后必跑的独立检查，不再作为 pairing stage 配置。
`roll agent migrate` 只会把启用的旧 `code` 复查池迁入 `.roll/agents.yaml`；旧的
`score`、`design`、`test`、`cycle` 条目已废弃，因为它们没有 scoped 代码复查对应项。

## Review Score —— 同行打分，绝不让作者给自己打分

agent 给自己的交付打分是利益冲突，所以质量评分（**Review Score**）一律由
**全新独立会话**里的 Reviewer 产出，绝不由工作 agent 自评：

- **loop 内**：验收闸通过后，runner 拉起一个全新会话的 Reviewer 给交付打分。
  note 落在卡片 `notes/` 目录，带溯源——`scoring: pair`、`scored-by: <agent>`
  以及全新会话 id（独立性可核验）。
- **Loop 交付**：验收闸通过后，runner 在全新会话里触发同一适配器。
- **设计产出**（`roll-design`，无 loop cycle）：设计工作流可以触发全新会话的 Reviewer
  评**设计**质量（INVEST 拆分、可视 AC 完整、`deliverable_url` 正确、领域/spec 一致），
  而非代码；记为 `stage=design`。设计 agent 只触发、绝不给自己打分；无可用评审则诚实
  标记未评审（fail-loud），绝不合成自评。
- **只要装了别的 agent，builder 的本体 agent 绝不给自己的 cycle 打分**：此时 builder 被
  整个排除出打分池——要么由独立 Evaluator 评分，要么 fail-loud（即便同厂全新会话也不回落成自评）。
  只有真正的单 agent 安装里，builder 的本体 agent 才是评分者，此时同厂全新会话是最低可接受档。
  独立性仍按 session id 核验（更鼓励不同 `agent × model × session` rig），所以单 agent 场景不会死锁。
  任何与 builder 共享会话的打分——包括其子 agent——都被判为自评而拒收。
  无独立候选、超时或协议不符时**不会**回落成自评；缺席通过 `pair:none-available`
  事件留痕，该 story 仍欠一份全新会话的 Review Score 才能 attest（`review_score_missing`）。
- **真实 agent 输出会先归一化再评分**：Evaluator 回复中夹带终端控制字节、ANSI 启动横幅、
  JSONL stream-json 外壳或 bullet/markdown 前缀都能被接受——解析器先归一化，再严格要求一段完整、
  有序的 `SCORE`/`VERDICT`/`RATIONALE` 块（分数 1..10、合法 verdict）。仅在散文里提到这些标记的仍会被拒。
- **重复出现的最终块若一致也会被容忍**：有的 Evaluator 会重绘终端（最终块出现两次），或先打印
  回复模板和分析、再给出真正的块。解析器只取**最终可用块**，并在所有合法 `SCORE` 行一致、所有合法
  `VERDICT` 行一致时采信——重绘属于已确定的同一答案。真正冲突的重复块（分数或 verdict 不同）、
  模板 `<占位符>` 回声、越界分数、不支持的 verdict 仍会被拒。
- **拒收有可观测的具体原因，而非笼统报错**：回复未被采信时，cycle 记录的是具体原因而非一句
  “unparseable”。`roll loop cycle <id> --roles` 会区分 Evaluator 是**返回了类分数文本但未被采信**
  （如重复块冲突、缺字段）还是**完全没返回任何分数内容**，并在角色行上标出确切原因。
