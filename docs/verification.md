# 质量体系

roll 的可靠性不靠「线上没出事」来证明，靠可执行、可证伪的测试来证明。分三层。

## L1 · 混沌测试

对 12 条不变量（[01-system](01-system.md) I1–I12）的每一条，主动注入故障，验证系统正确响应。这些测试进 CI，红即阻塞发布。

| # | 注入的故障 | 期望行为 |
|---|-----------|---------|
| I1 | Cycle 跑到一半 kill agent 进程 | ≤watchdog 阈值内落 failed，无僵尸 running |
| I2 | spawn 后立即 SIGKILL 整个进程组 | 重入检测孤儿（锁龄/心跳/PID）→ 安全接管，无脏锁，无丢提交 |
| I3 | 并发 Cycle 处理同一多仓 Story | 同一 Issue 的每个 repository target 只产生 1 个 governed PR；不同 required target 可各有一个 PR |
| I4 | 标 Done 但 PR 不 merge | Cycle 末对账 → 自动退回 |
| I5 | 注入一个永远失败的 Story | 其他 Story 照常交付；毒 Story 连败 N 次 → 进暂缓，不再被选取 |
| I6 | primary agent 连败 3 次 | PAUSE + ALERT + 通知均发生；不自动换 agent 重试 |
| I7 | 两个 ID 相近的 Workspace 并行运行并共享同一 remote cache | registry/runtime/Issue/evidence 互不污染；只复用一个可重建 bare cache，cache 重建不改变交付事实 |
| I8 | 写 cycle_end 前杀进程 | 仅凭事件流重建出正确终态；trap 补写 |
| I9 | 两个 loop 同时写 Backlog | 乐观锁重试，不丢更新；精确匹配不误伤 depends-on 行 |
| I10 | 角色候选 agent 不可用 | 当前 resolution 记录 skipped runtime health；无可用候选则 PAUSE + ALERT，不静默改写静态池 |
| I11 | 模拟成本逼近日上限 | 自动降级到便宜槽 或 暂停 + ALERT |
| I12 | 制造 0 个 TCR 提交的 Cycle | 判定失败 + ALERT；Feature 可 revert 到 Cycle 1 且仓库干净 |

## L2 · Evals（结果评估）

每个 Cycle 收尾按六维打分，0–1 加权汇总为 1–10。

| 维度 | 权重 | 评估内容 |
|------|------|---------|
| outcome | 3 | 是否真的 merge 进 main（对齐 I4） |
| correctness | 2 | 产出 PR 的 CI 是否绿 |
| scope_fidelity | 2 | 是否完成了被路由的那个 Story（无漂移、无空转） |
| quality | 1 | 是否加了测试、是否立刻返工 |
| efficiency | 1 | 实际耗时 vs 预估 |
| cleanliness | 1 | 无孤儿 worktree/分支、无 ALERT |

缺失维度记 unknown，从加权中剔除并重新归一——缺数据 ≠ 0 分。连续多 Cycle 同一维度低分 → 生成改进候选（落 signals 候选文件，标「待人确认」，不自动改代码——Goodhart 护栏）。

## L3 · 成熟度评级

12 条能力逐条评 S/A/B。每个 release 更新 scorecard。目标 = 消灭所有 B。

| 能力 | 起点 | 目标 | 度量 |
|------|------|------|------|
| I1–I4, I7, I8, I12 | S | 保持 S | 对应 L1 混沌测试常绿 + L2 outcome/cleanliness 趋势 |
| I5 | A | S | L1-I5 通过 + 毒 Story 不拖累吞吐 |
| I9 | A | S | L1-I9 通过 + 无 Backlog 写冲突丢更新 |
| I10 | A | S | L1-I10 通过 + 角色解析可预测性 |
| I11 | B | S | L1-I11 通过 + 成本不破上限 |

任何能力从 S 降级 = 回归，触发 ALERT。

## diff-test

port 期间，每个从 v2.0 迁移的函数和命令，输出必须与 bash 版对齐：

```bash
diff <(v2.0-bash <cmd>) <(v3-ts <cmd>)
```

分层验收：每完成一层，该层 difftest 全绿才进下一层。允许白名单例外——TS 版刻意改进的输出差异须显式声明并记录原因。

## 验收档案布局

一张卡的交付物收口在卡夹 `.roll/features/<epic>/<ID>/`：

- **生命周期**：loop 周期开始时先创建 `<ID>/<run-id>/` 证据框，并通过 `ROLL_RUN_DIR` 交给内层 agent；`ROLL_EVIDENCE_DIR` 与 `ROLL_SCREENSHOTS_DIR` 指向本次 run 的 `evidence/` 与 `screenshots/`。
- **过程采集**：`roll test`、截图通道和手工证据都写入本次 run；`ac-map.json` 放在卡片根目录，声明每条 AC 由哪些证据支撑。
- **收尾硬闸**：runner 在交付末尾调用 `roll attest <ID> --run-dir "$ROLL_RUN_DIR"`；默认 `loop_safety.attest_gate: hard`，带 AC 的交付若没有新鲜且内容充足的报告会被拦住。`attest_gate: soft` 只用于显式迁移窗口。
- **证据模式**：`evidence_mode` 决定 QA/Evaluator 应看的证据矩阵，不是空口截图豁免。`visual_ui` 保持截图硬闸；`refactor_contract` / `data_state` / `docs_content` 用测试、build/typecheck、grep、fixture、事件、链接等证明，只有视觉表面变化、AC 明确要求或 layout 风险出现时升级截图。
- **落位**：一次验收写进 `<ID>/<run-id>/`（run-id 为时间戳，永不覆盖），`latest` 软链指向最新；主入口是 `<ID>-review.html` 验收 Review Page，`<ID>-report.html` 在一个发版周期内保留为旧报告兼容别名。
- **索引**：归档重建 从 `backlog.md` 生成 `.roll/index.json`（ID→epic，确定性、幂等）。attest 先查索引定位 epic，查不到回落 `features/uncategorized/<ID>/`；验收收尾会尽力刷新 story 交付段与 `.roll/index.json`。
- **回收**：`roll loop gc` 按阈值清理陈旧 run（保最近 N 次 + M 天内，二者满足其一即留；只删「又旧又超额」的尾部）。阈值 `--keep-latest`（默认 10）/`--keep-days`（默认 30），`--dry-run` 预演。
- **读取兼容**：迁移窗口内旧布局 `.roll/verification/<ID>/` 仍可读（attest gate、ac-map、报告解析都先查卡夹再回落旧树）；存量迁移与兼容代码移除由 US-META-002 收尾。

Workspace 模式不写上述 legacy 卡夹：每个 cycle 的证据框固定落在
`issues/<story>/evidence/<cycle>/`。其中 `ac-map.json` 逐条引用 Workspace backlog 的真实 Story AC，
repository 与 integration verification 只提供 exact-cycle 证据绑定；AC 是否真正满足由独立
Evaluator 结合 Story AC、evaluation contract 与多仓 diff 判断。

## 证据可见性模型（US-PHYSICAL-008）

截图/图片类证据涉及隐私，因此在 `git add` 之前必须确认目标仓库的远程可见性：

| 布局 | 目标仓库 | 判定策略 | 图片证据 |
|------|----------|----------|----------|
| 独立 roll-meta | `.roll` 自身所在的私有仓 | `gh api repos/<slug>` 或 `git ls-remote`；判定为 private 则放行 | 私有仓放行 |
| 公开产品仓 + 独立 roll-meta | 产品仓本身不接收 `.roll` 证据；证据进私有 roll-meta | 同 roll-meta | 私有仓放行 |
| in-repo `.roll` | 产品主仓（`.roll` 随代码一起 tracked） | 检查主仓 remote 可见性 | public / 未知 一律拒绝 |

保守规则：判定失败（无 remote、`gh` 不可用、API 失败、非 GitHub 且无法推断可见性）一律按 **public** 处理，拒绝图片证据并触发 ALERT。

逃生口：owner 可在 `.roll/local.yaml` 中显式声明

```yaml
evidence_public_waiver: true
```

放行公开仓的图片证据，同时留下审计痕迹。in-repo 项目首次成功判定后会把 `evidence_visibility` + `evidence_remote` 写入同一文件；remote URL 变化时自动重判。

## 门

| 门 | 条件 | 频率 |
|----|------|------|
| 持续门 | L1 混沌 12 项全绿 + TCR 硬校验 + CI 绿 + 关键路径 difftest 全绿 | 每次合并 |
| 层级门 | 每层全部卡 difftest 对齐 v2.0 + 向 owner 汇报、点头后进下一层 | 每层收尾 |
| 切换门（P4） | v3 loop 连跑 20 Cycle ≥90%、unstick <10% + L1 全绿 + difftest 达标 | 一次 |
| 发布门 | 成熟度 scorecard 无 B + 稳定性基线 ≥ v2.0 + release 永远人点头 | 每次发布 |
