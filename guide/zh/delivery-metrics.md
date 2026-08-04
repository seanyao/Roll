# 交付指标词典

`roll delta metrics [--from <epoch-ms|ISO>] [--to <epoch-ms|ISO>] [--json]`
和 `roll supervisor metrics [--json]` 都是只读投影。它们从不可变事件与交付记录
重建，不维护计数缓存。两条命令仅供建议：绝不路由工作、选择模型组合、改变 backlog
优先级、重试任务、合并 PR，或把 Story 标成已交付。

每次渲染只使用一种 locale。Delta 窗口是对事件记录时间的包含式过滤
（`--from <= ts <= --to`），绝不是 Git author 时间；Supervisor 报告所读取事件的最小和
最大记录时间。JSON 中的 `null` 和终端中的 `?` 表示所需事实缺失、格式损坏或彼此矛盾，
不是零、成功，也不是模型调用的证明。百分位使用 `nearest-rank`，每项耗时均列出样本数。

## Delta 指标

| 指标 | 来源事实与计算 | 时间边界与不完整行为 | 是否交付门 |
| --- | --- | --- | --- |
| `cards` / `attempts` / `mergedCards` | `cards` 为选中 `delta:prepared` 尝试的不同 Story ID；`attempts` 为选中 delegation 数；`mergedCards` 为有 delegation 绑定 `delivery:reconciled` 合并或交付记录 `mergedAt` 的不同 Story。 | 没有有效 `delta:prepared` 的 delegation 是 orphan 并记入诊断。窗口按任一选中观察决定；其来源事实可在过滤范围外。 | 仅建议。 |
| `firstPassMergeRate` | 分子：只有一次 delegation、无 `owner_redelegate`、且该 Story 没有观察到 CI fail/rerun 的已合并 Story；分母：已合并 Story。 | 没有已合并 Story 时为 `value: null` 且 `reason: no_eligible_sample`，绝不是 0%。 | 仅建议。 |
| `redelegateRate` | 分子：尝试含终止 `owner_redelegate` 的 Story；分母：有选中尝试的全部 Story。 | 空分母为 `null`，绝不是 0%。 | 仅建议。 |
| Builder 耗时 / `phaseWallMs.builder` | 每次尝试从首个 `delta:prepared` 到首个 Builder `delta:artifact_published`；聚合取和。`phaseSamples.builder` 给出样本数、总计、P50、P95。 | 边界缺失或时钟倒置会排除该样本并加入诊断。 | 仅建议。 |
| Evaluator 耗时 / `phaseWallMs.evaluator` | 从首个 Builder artifact 发布到首个 Evaluator artifact 发布；聚合/样本规则相同。 | 边界缺失或倒置保持不完整。 | 仅建议。 |
| 合并尾段 / `phaseWallMs.mergeTail` | 从 `delta:terminal(handoff_ready)` 到 delegation 绑定的 reconciliation 合并；否则使用 Story 交付 `mergedAt`；聚合/样本规则相同。 | handoff 不是合并。没有合并证据则该耗时不完整。 | 仅建议。 |
| `tcr.rounds`、`green`、`red`、`testWallMs` | 用 `tcr:round_started`、`tcr:test_finished`、`tcr:committed` 按回合投影。绿/红统计有记录测试结果的回合；`testWallMs` 累加记录的测试耗时。`completeRounds`、`incompleteRounds`、`incompleteAttempts` 显示覆盖度。 | 无 TCR 观察时展示字段为 `null`；部分回合继续诊断，绝不推断。 | 仅建议。 |
| `outcomeCauses` | 统计显式 `delta:attempt_outcome.cause`：`implementation_gap`、`evaluator_finding`、`artifact_protocol`、`identity_or_routing`、`ci_or_test_flake`、`external_liveness`、`owner_scope_change`、`unknown`。 | 没有显式 outcome 会诊断且不归类。artifact 缺失只是观察缺失，不证明模型是否调用。 | 仅建议。 |
| `rigs` | 按解析出的 Builder/Evaluator 宿主和模型分组，报告 attempts、Builder 耗时和，以及模型/提供方多样性比较。 | 角色解析缺失时使用 unknown，`modelDiverse` / `providerDiverse` 为 `null`。 | 仅建议；绝不用于选择组合。 |
| `incomplete` / `diagnostics` | 读取器诊断以及缺失、重复、orphan、格式损坏、时间倒置或不完整投影事实。 | 任一此类事实使 `incomplete: true`；已知行保留，绝不伪造干净结果。 | 不是门；提示 operator 查证来源。 |

## Supervisor 指标

Supervisor 从不可变事件和当前 backlog 状态形成每卡一行。聚合耗时行
（`queueWait`、`dependencyWait`、`firstActionLatency`、`dispatchToMergeLead`、
`prCiTail`、`reconciliationLag`）均含 `sampleSize`、`totalMs`、`p50Ms`、`p95Ms`；
总计是非空卡值之和，P50/P95 用 nearest-rank。

| 指标 | 来源事实与计算 | 时间边界与不完整行为 | 是否交付门 |
| --- | --- | --- | --- |
| `observationWindow` / `sampleSize` | 有效事件时间的最小/最大值，以及在 backlog 或事件边界中出现的卡数。 | 无有效事件时间时两个窗口端点均为 `null`；这不是空且成功的运行。 | 仅建议。 |
| `queueWait` | 第一个包含该 Story 的 `pick:ranked` 到派发（`cycle:start` 或 `delta:prepared`）。 | 端点缺失/倒置为 `null`，并写入 `incompleteFacts`。 | 仅建议。 |
| `dependencyWait` / `dependencyStates` | 第一个 `pick:blocked` 或 `pick:skipped` 依赖观察到派发；统计 `blocked_by_not_done`、`not_yet_dispatched`、`unknown`。 | 依赖时间、后续派发、依赖状态或顺序不可得时为 `null`。 | 仅建议。 |
| `firstActionLatency` | 派发到首个 `cycle:first_edit` 或 Builder `delta:role_started`。 | 端点缺失/倒置为 `null`；绝不虚构动作时间。 | 仅建议。 |
| `dispatchToMergeLead` | 派发到记录的 `delivery:merge_confirmed` 或非 superseded `delivery:reconciled`。 | `handoff_ready` 不提供合并端点。 | 仅建议。 |
| `prCiTail` | 首个 `pr:open` 或 `delivery:published` 到最后一个 `ci:pass`、`ci:fail`、`ci:rerun`，否则回退至记录的 main 合并。 | 端点缺失/倒置为 `null`；fail/rerun 只是观察，不是通过声明。 | 仅建议。 |
| `reconciliationLag` | 记录的 main 合并到非 superseded `delivery:reconciled`。 | 端点缺失/倒置为 `null`。 | 仅建议。 |
| `delivery` / `handoffReady` | 只有记录到 main 合并时 `delivery` 才是 `delivered`；`handoffReady` 只记录 Delta handoff 观察。 | `handoff_ready` 仍是 `not_delivered`，绝不是合并、attest 裁定或 Done 声明。 | 只报告真相，不改变真相。 |
| `truth` / `truthConsistency` | 每卡比较记录的 main 合并、backlog Done 状态和记录的 attest 事实。`truthConsistency.checked` 统计一致加不一致行。 | 来源缺失为 `unavailable` 与 `incomplete`；分歧为 `inconsistent`，绝不静默修复。 | 仅建议；operator 据此调查。 |
| `incompleteFacts`、`incomplete`、`diagnostics` | 显式逐卡缺失来源原因和事件读取诊断。 | 终端和 JSON 均保留它们。 | 不是门。 |

## Operator 示例：归类事实，不猜测 agent 活动

先运行命令，再检查该行背后的事件与交付事实：

```sh
roll delta metrics --from 2026-08-01T00:00:00Z --json
roll supervisor metrics --json
```

只用显式 outcome 或已记录观察区分以下情况：

| 观察 | 如实分类 | 它**不能**证明什么 |
| --- | --- | --- |
| 协议记录了 digest 不匹配、必填 manifest 字段缺失，或 artifact 路径包含性无效。 | `artifact_protocol` | 不能证明模型是否被调用。 |
| 已校验的 Evaluator 报告指出阻塞 finding。 | `evaluator_finding` | 不会让该 finding 变成合并决定。 |
| CI 记录短暂 fail/rerun，后续证据将其识别为 flake。 | `ci_or_test_flake` | 不会把尝试变成首次合并。 |
| 宿主、网络或必需外部服务不可用，且记录的 cause 如此说明。 | `external_liveness` | 不会把它变成产品失败或 agent 健康分数。 |
| 帧没有显式 outcome 或缺少其他必需观察。 | `unknown` 加 diagnostics | artifact 缺失不是模型调用的证明。 |

同样，host attestation 只校验 token 的形状与对应关系；它不证明会话新起、角色/模型被遵守，
也不证明模型调用。指标让测量边界可见，由人决定下一步；没有任何指标会自行改变交付状态。
