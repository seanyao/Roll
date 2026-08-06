# Roll — 测试工作流

Roll 在整个交付过程中强制执行测试优先原则：

- **TCR**（Test && Commit || Revert）— 每个微步骤通过测试后才提交。
- **E2E Deposit** — 每个完成的 Story 留下一个 E2E 测试，覆盖其核心用户路径。
- **CI E2E Gate** — Deposit 的 E2E 在每次推送时运行，失败则阻止合并。
- **proof-of-pass** — pre-commit hook 物理拦截未经测试的提交。

## E2E Deposit

TCR 微步骤通过后，`$roll-build` Phase 5.5 自动 Deposit E2E 测试：

1. 检测项目已有的 E2E 基础设施（框架、目录、命名规范）。
2. 编写一个覆盖 Story 关键用户路径的 E2E 测试。
3. 运行它——若红则通过 TCR 修复。
4. 提交：`tcr: e2e deposit for <story-id>`。

Deposit 的测试成为持久的回归守门，CI 在每次推送时重放，失败则阻止合并。

## Pre-commit Hook（proof-of-pass）

Roll 的 pre-commit hook 要求：测试必须在 **60 秒内**、**与当前暂存树完全匹配**的情况下通过：

```bash
# 测试运行器写入：
# .roll/last-test-pass  ← 时间戳 + 树哈希

# 提交时 hook 检查：
# - 距离上次测试通过 < 60 s
# - 树哈希与当前暂存树匹配
```

使用 TCR（roll-build 的默认节奏）时此过程自动完成。

## CI E2E Gate

PR CI 还会发布一个名为 `doc-drift` 的检查。它获取 `origin/main`，用
`merge-base HEAD origin/main` 比较 PR，并按
[`policy/rules.yaml`](../../policy/rules.yaml) 中注册表驱动的判定执行。当前
`gates.doc_drift: soft` 时，命中会以 annotation 形式可见且以 exit 0 结束；没有
豁免通道。缺少 base 或注册表无效则 fail closed。CI 从不写 `.roll` 事件。在本仓
形态下，这个结果对手工 GitHub UI 合并仍然只是 advisory：它记录结果，不是可信的
合并授权。

hard doc-drift 模式尚未启用，仍受可信 owner 授权与校准设计阻塞。peer 会话、TTY 或
`actor` 字段都不能认证 owner。将其翻为 hard 由 US-RULE-006 跟踪，该卡处于 **Hold**：
loop 不得自动拾取；激活前必须先完成可信 owner 授权与校准设计。如果该设计完成且注册表
启用 hard，命名检查才可以和 `test-ts` 一起进入 Roll 驱动的 exact-SHA 合并闸。审计只
报告**已注册 N** 条规则仍然有效，不代表已经穷尽仓库规则；源码派生的权属视图见生成的
[职责地图](../../docs/maps/)。
[`policy/rules-inventory.yaml`](../../policy/rules-inventory.yaml) 是规则候选文件上的
可审计覆盖面谓词：声明的 roots、include 模式与带理由的排除项，逐条分类 registered 或
out-of-scope。覆盖面 = 该谓词 + 其排除项，绝非关键字搜索式完备性；审计对未分类候选与
孤儿锚点报错，而不是假定所有规则都已注册。

模板 CI 工作流（`.github/workflows/ci.yml`）将 E2E 测试作为独立任务，必须通过才能合并。失败时：

1. 查看失败测试名——对应一个 Story ID。
2. 在本地复现。
3. 在 `BACKLOG.md` 开 `FIX-XXX` 条目，或直接用 `$roll-fix` 修复。

## 失败分诊

`$roll-.qa` 为测试金字塔每层提供结构化诊断指引：

| 层级 | 运行命令 | 分诊入口 |
|------|----------|----------|
| 单元测试 | `pnpm --filter @roll/<pkg> test` | 失败测试文件 → 函数名 |
| 集成测试 | `pnpm --filter @roll/cli test` | 捕获的 stdout/退出码、fixture cwd |
| E2E | `<项目 E2E 命令>` | 用户路径、环境 |
| Smoke | `roll doctor` | 工具链健康 |

## TCR 测试策略（Phase 3.0）

TCR 的每个 micro-step 都需要秒级反馈。测试套件是 pnpm 工作区上的 **Vitest**；
门只跑 diff 触及的部分。

### `roll test` 只跑被 diff 覆盖的测试

```bash
roll test               # 仅 affected（TCR micro-step 闸）；写测试通过证明
pnpm --filter @roll/cli exec vitest run test/<file>.test.ts   # 单文件
pnpm -r test            # 全套（pre-push / CI / release）
pnpm test:cov           # 全套 + v8 覆盖率
```

`roll test` 把 diff 映射到受影响的 Vitest 文件、跑它们、并写下提交闸要检查的
通过证明（见下）。纯文档改动无受影响测试，exit 0。pre-push / CI / release
一律跑全套 `pnpm -r test`。

### 运行器兼容性与保守回退

`roll test` 从**目标项目**解析闸命令，而不是假定某一个固定 flag，因此始终与
项目里已安装的测试运行器兼容（FIX-1274）：

- Roll 自己的 wrapper 继续用 `--affected`。
- 普通 Vitest 项目改用该版本支持的 `--changed` changed-test 模式。Roll 绝不把
  `--affected` 传给 Vitest——Vitest CLI 会把它当未知选项拒绝，否则会卡死提交。
- 当无法确认安全的 changed 模式（Vitest 版本探测不到/过旧、非 Vitest 运行器），
  或 `--changed` 匹配到**零个**测试时，roll 改跑项目的**全量**测试命令。回退永远
  比 affected 闸**更严格**——绝不放过部分或空测试。

**证明保证**：`.roll/last-test-pass` **只在**受支持的命令真正执行且返回 0 后写入，
记录被测树哈希、实际执行的命令、所选模式和时间戳。失败、未知选项、零测试的运行
都不会生成证明，因此一份证明永远代表一次真实的绿色测试运行，且绑定到确切的提交树。
无法解析的项目（`package.json` 没有 `scripts.test`）会带结构化诊断和安全的下一步
明确报错，而不是静默通过。

## 测试质量评分卷（rubric）

`guide/zh/testing/quality-rubric.md`（由 `$roll-.dream` Scan 7 消费）列出
夜检扫描会按 `REFACTOR-XXX [test-quality:❶|❷|...|❽]` 输出的八类反模式：

| # | 反模式 | 修复方向 |
|---|--------|---------|
| ❶ | 硬编码业务数据（价格、版本号、产品文案） | 通过 monkey-patch / 构造注入 fixture；断言行为而非数据表 |
| ❷ | 过度 mock（数据库、文件系统、真实边界） | 用真实子系统配小型适配 mock；优先内存测试替身 |
| ❸ | 断言实现细节（私有符号名、内部数据形状） | 通过 public API 断言可观察行为 |
| ❹ | Fixture 顺序耦合（测试间共享可变状态） | 每个测试独立 setup/teardown；用不可变 fixture |
| ❺ | 测私有函数 / 绕过 public API | 改走 public 入口；如果难以到达，说明 API 设计有问题 |
| ❻ | 断言框架行为（在测 Vitest 本身） | 删测试；信任框架 |
| ❼ | 内联外部工具行为（测试体里复制 `sed`/`grep`/`awk` 流水线） | 调项目自己的 helper；或抽到测试 helper 模块共享 |
| ❽ | 断言 repo 之外的文件（`~/.codex`/`~/.kimi`/`~/.roll` 或系统路径） | 用临时目录（`mkdtempSync`）沙箱化，环境变量重定向到那里，不碰用户真实配置 |

dream 每轮最多 emit 5 条 REFACTOR，避免 backlog 被噪音淹没。
按优先级逐个收拾。

### ❼ 和 ❽ 两类

These two are the ones reviewers reject most often. Nothing blocks a merge on them
automatically; `roll dream run-once` reports violations as REFACTOR rows and a
reviewer is expected to catch them in the diff.

这两类是评审最常打回的:不可能失败的测试、以及断言自己夹具的测试。写测试时当硬规则守。
没有任何东西会因此自动拦合并 —— `roll dream run-once` 会把违规报成 REFACTOR 行,评审
(人或 Evaluator)应当在 diff 里抓住它。

❶..❻ 同样由 dream 标成 REFACTOR,在常规迭代里慢慢清。

带 `# test-quality:allow` 注释的行会被扫描器跳过（文档校验类测试里
合法使用 `awk` 解析 markdown 时用，不触碰生产代码）。

`packages/core/test/prices.difftest.test.ts` 是 ❶ 类范例 —— 之前的断言读
生产费率表，每次价格调整就把套件打红，即便算术没动。现在算术喂固定
fixture 价格表，对生产费率只断结构不变量（cache_read < input 等）。

## 另见

- [loop.md](loop.md) — loop 如何在每个 Story 中强制 TCR 纪律
- [skills.md](skills.md) — `$roll-build`（交付 + Deposit E2E）
