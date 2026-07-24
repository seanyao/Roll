# Workspace-first 交付

Workspace 是 Roll 本地的需求、规划、执行与统一交付边界。Repository 是绑定到
Workspace 的代码资源，不是项目身份，也不是第二套 Roll 控制平面。

一台机器可以保持多个 active Workspace。每个变更命令必须解析到一个精确目标；只有
明确声明的 `--all` 聚合视图可以只读跨 Workspace。

## 心智模型

```text
Machine
├── Agent 能力与容量
├── Workspace registry
├── 共享 repository cache
└── Workspaces
    ├── requirements + backlog
    ├── Story / Issue 记录
    └── runtime projections
```

稳定的 `workspaceId` 才是身份。Registry 把 ID 映射到 canonical path，因此移动
Workspace 只改变位置，不改变身份。系统没有 global current Workspace，也没有单例
active 槽位。

Repository cache 位于 `~/.roll/repos/<repoId>.git`，是机器共享、可删除重建的 bare
cache。删除或重建 cache 不得改变 backlog、Issue 完成状态、merge evidence 或集成验收。

## 创建并激活 Workspace

先在目标目录外写一份版本化 `roll.workspace-create/v1` 配置，再预览确定性计划：

```bash
roll workspace create ws-payments --config /absolute/path/workspace-create.yaml --check --json
```

`--check` 只读校验身份、root、需求绑定、repository remote、alias、integration branch、
cache 决策与已有内容。只应用审阅过的配置：

```bash
roll workspace create ws-payments --config /absolute/path/workspace-create.yaml --json
roll workspace activate ws-payments
```

创建只写入 Workspace 权威文件与 repository binding，不创建常驻 product checkout。
它也不会把 Workspace 设成全局当前目标：activate 控制 scheduler eligibility，每次命令
仍独立解析自己的目标。

只读查看生命周期：

```bash
roll workspace list --all --json
roll workspace show ws-payments --json
```

## 命令与 selector alias

`roll workspace` 是 canonical 命令族；`roll ws` 是完整子命令树的固定 alias，因此
`roll ws create`、`roll ws edit`、`roll ws issue init` 与其他公开 Workspace leaf
都会执行同一个 operation。所有公开 `--workspace <ID|路径>` selector 同时接受
`--ws <ID|路径>`；例如 `roll backlog --ws ws-payments` 与 canonical 写法完全一致。

Alias 只改变 CLI 拼写，不创建第二套命令树，不改变 `workspaceId`，不增加 config key，
也不建立 global current Workspace。Help 与机器可读 next action 始终使用
`roll workspace` 和 `--workspace` 作为 canonical 写法。Workspace 生命周期只有一个
创建入口：`roll workspace create`；已移除的 `init` 子命令会被拒绝并提示迁移到 create。

## 预览并应用 metadata edit

使用版本化 edit config 添加、删除或修改 Workspace metadata。先预览，再应用同一份已审阅
意图：

```bash
roll workspace edit ws-payments --config /absolute/path/workspace-edit.yaml --check --json
roll workspace edit ws-payments --config /absolute/path/workspace-edit.yaml --json
```

Preview 包含 manifest、结果和 reference digest。Apply 获取 Workspace authority lock，
重新读取事实并在锁内重建 plan。Manifest 变化返回 `manifest_changed`；新增 durable reference
使修改不安全时返回 `metadata_referenced`；结果变化返回 `edit_plan_changed`。事务 journal
记录 before/after 状态并支持幂等 retry。只有能证明安全 before 或 after 状态时才自动恢复；
否则停止并给出 doctor action，不猜测。

Edit 只原子替换 `workspace.yaml`。既有 Issue manifest、worktree、requirement revision 与
delivery facts 保持 byte-stable；metadata 修改只影响未来 Issue，绝不追溯改写已创建 Issue。

## 目标解析与 fail-loud

Workspace-aware 命令接受 `--workspace <ID|路径>`（或 `--ws`）。解析先遵循显式参数、
环境、可达 Workspace 与 Issue 事实；这些事实未选出目标时，受限 discovery 才会把当前
requirement 与 registry 中 canonical Workspace manifest、Issue facts 比较。唯一 active
Workspace 只是 lifecycle 事实；当它与当前 requirement 不匹配时，绝不能单独作为选择依据。

例如：

```bash
roll backlog --workspace ws-payments
roll loop status --workspace ws-payments
roll agent --workspace ws-payments
roll delivery list --workspace ws-payments
```

如果两个 Workspace 都处于 active 且没有更强 selector，Roll 会列出候选并以非零退出。
显式参数、环境变量与 cwd 指向不同目标时也会 fail loud。`pause`、`archive`、scheduler
控制和 delivery reconcile 等变更拒绝 `--all`。

精确 Issue identity 或唯一的精确 requirement source 可以自动选择目标。Repository/path
containment 与 semantic similarity 只能参与排序，不能授权 mutation。已选 Workspace 与当前
requirement 冲突时 mutation 会被拒绝；discovery facts 损坏时也会 fail closed，不会回退到
唯一 active Workspace。

Agent 无法确定目标时，会把结构化候选交给 `roll-.clarify workspace_target`。该 skill
概括 requirement，展示 lifecycle/evidence/diagnostics，询问选择既有 Workspace、准备新建或
修复 discovery，然后立即停止。选择既有 Workspace 只让 host 用显式 selector 重跑解析；
选择 create 只授权收集 ID/config 并生成 `roll workspace create ... --check` preview，
不授权 apply；选择 repair 只展示 canonical doctor/repair 命令。Direct CLI 的 TTY 交互使用
同一个封闭 decision，不假装加载 skill。

Interaction 与输出格式相互独立。`--no-input` 始终 non-interactive；`--interactive` 必须有
可用 controlling TTY 或 agent host 提问能力，否则返回 `interaction_unavailable`。`--json`
不会开启或关闭 prompt：prompt 写 stderr/TTY，stdout 仍只有一个 JSON 结果。成功 exit `0`；
选择、冲突、需要 activate/create 等结构化 failure exit `1`，并提供稳定 `error.code`；
non-interactive JSON 还会把 clarification payload 放入 error。

planning 与 delivery 命令只把选定 Workspace 当作 project-data authority。即使从任意
目录运行，也不会创建 `<cwd>/.roll`：

```bash
roll story new US-PAY-102 --title "重试退款" --epic payments --workspace ws-payments
roll idea "改进退款诊断" --workspace ws-payments
roll design "拆分退款恢复方案" --workspace ws-payments
roll attest US-PAY-102 --workspace ws-payments
roll capture status --workspace ws-payments --json
roll truth query US-PAY-102 --workspace ws-payments --json
```

这些命令及其内部 view refresh 只读写 canonical Workspace 下的 `backlog/index.md`、
`features/`、`policy.yaml`、`evidence/`、`runtime/` 与派生 `index.json`。变更所需的
authority 缺失或类型损坏时会 fail closed，绝不会回退创建新的 `.roll` 树。authority
或内部变更路径是 symlink 时，也会在读取或写入前拒绝。legacy `.roll` 只作为 migration
input；Roll 不会同时写两套布局。

`roll idea` 会同时写 Story card 与 canonical linked backlog row，因此可以立即用
`roll backlog show <ID> --workspace ...` 打开。导入 backlog 中仍以 `.roll/features/`
开头的链接只在读取时兼容解析到 canonical `features/`，不会静默改写 backlog。

## Requirement 与 Issue 布局

执行前先采集 requirement revision，并保留 provider ref 与 digest。`backlog/` 中的 Story
契约开始执行后成为一个 Issue：

```text
<workspace>/
├── requirements/<provider>/<requirement>/
├── backlog/.../<storyId>/spec.md
└── issues/<storyId>/
    ├── manifest.json
    ├── events.ndjson
    ├── <repoAlias>/
    ├── artifacts/
    └── evidence/
```

Repository worktree 只能通过 Issue 命令创建或修复：

```bash
roll workspace issue init US-PAY-101 --workspace ws-payments --check --json
roll workspace issue init US-PAY-101 --workspace ws-payments --json
```

可写代码只存在于 `issues/<storyId>/<repoAlias>/` worktree。只读 repository target 可以
提供 context，但不成为必需交付 leg。任一 setup leg 失败时只回滚本次新建状态，而且不会
spawn Builder。

多 repository Issue 的 repository operation 必须从冻结的 Issue context 指定或继承一个
binding，绝不选择“第一个”仓库。只有恰好一个 writable worktree 时 bash 才能默认使用它；
filesystem 写入必须留在 writable binding 内；Git 仍要求显式 cwd，且必须匹配 Issue 声明的
worktree。Repository context 缺失或歧义时返回 `missing_execution_context`，不使用 process cwd。

## 一个 Story，多个独立 repository 事实

Story/Issue 本身就是统一交付单元。Roll 不引入 Delivery Set、Workspace-level codebase
或 superproject 来制造跨 repository 的物理原子性。

每个 required repository 独立记录：

- governed branch 与 TCR commits；
- provider PR 状态与 required CI checks；
- 权威 merge commit。

只有全部 required repository 已 merge，并且 integration command 针对精确 merged SHA
通过，Issue 才算 delivered。单个 PR 已 merge、本地 branch、worktree、绿色单测或 backlog
的 `Done` 声明都不够。

查询与对账统一使用同一个 Issue fold：

```bash
roll delivery show US-PAY-101 --workspace ws-payments
roll delivery reconcile US-PAY-101 --workspace ws-payments --dry-run --json
roll delivery reconcile US-PAY-101 --workspace ws-payments
```

`roll delivery reconcile` 折叠 Issue events 与 provider/main 事实，先刷新 Requirement attest
projection，再更新 backlog projection；它绝不把 backlog Markdown 当成完成真相。
`roll loop reconcile` 只是同一 fold 的 alias，不是第二套 parser。

## Local-only campaign gate

如果 campaign 要求所有本地验收完成后才能产生外部变更，请在专用 integration branch 上配置
`publish_mode: local`。该模式运行同一套本地 evidence gate，并把 commit 落到配置的本地
integration branch；它不会 push 分支，也不会创建 PR。所有依赖 Story 与 requirement-level
critical flow 必须先在同一个精确 integration-branch SHA 上通过。改回 `remote` 是另一个需要
owner 审批的发布决定。

## 强制历史迁移

Repository-local `.roll/` 只是历史输入，不是第二种长期运行模式。不要在它上面再初始化一套
竞争 Workspace。先停止 active runtime，确认产品 Git clean 且远端可达，再采集只读计划：

```bash
roll workspace migrate --from . --check
roll workspace migrate --from . --workspace ws-payments --check --json > workspace-migration-plan.json
```

以下情况会 fail loud：产品 Git dirty 或 unpushed、进行中的 Git operation、不安全 linked
worktree 或 recursive submodule、active runtime、`.roll` 下的 symlink、无法验证的 remote
truth，以及 cache/registry 冲突。

如果 `.roll` 被产品 repository 跟踪，先通过正常受审的 TCR/PR/push cutover 只移除计划内
路径。Apply 会证明专用 cutover commit 已由远端可达，并逐个核对保存的 digest。普通 tracked
metadata 完成后留下 `.roll/RELOCATED.json`，旧路径不能继续静默作为 repository-local runtime。

应用 owner 保存的精确计划：

```bash
roll workspace migrate --from . --workspace ws-payments --plan workspace-migration-plan.json
```

事务先写 journal，再映射 requirement、design、backlog 与 evidence；只创建或复用机器 bare
cache，校验全部 digest，最后才 register/activate。它绝不创建 Workspace-level product
checkout。注册前可以用 `--rollback` 恢复原子移动的源文件。

如果 `.roll` 是独立 Git repository，Roll 只复制映射内容，不会 link、commit 或 push；命令
会输出手工 roll-meta 移交说明，后续继续走 owner 审批的 metadata workflow。

## 诊断与恢复

```bash
roll workspace doctor ws-payments --json
```

Doctor 只读检查 registry/manifest 一致性、cache identity、Requirement projection 与 archive
trust、Issue journal/worktree、runtime lock 和机器容量。每次只能执行一个具名 typed repair；
provider facts、不可变 Requirement archive 与 Issue completion evidence 不会被编造或删除。

## Context policy 与兼容矩阵

每个已注册 CLI、skill 和 tool operation 都声明 Workspace scope、selector 支持、authority
访问与 context consumer。`machine_only` operation 不接收伪造的 Workspace context；
`legacy_migration_only` operation 只能检查显式选择的历史 project layout，不能与 canonical
Workspace authority 双写。其他 required scope 在执行前必须获得已选择并校验的 execution
context。

生成的 [Workspace context compatibility matrix](../../docs/generated/workspace-context-compatibility-matrix.json)
是稳定的 operation-level 清单。它为每个 CLI leaf、skill family 和 tool adapter 记录 scope、
selector 行为、legacy boundary、authority 与 context consumer。独立的
[Workspace context validation-case map](../../docs/generated/workspace-context-validation-cases.json)
把每个 operation 链接到可执行证据。Registry、生成矩阵、validation case 或 source audit
漂移时，release consistency 会失败。

更多细节见[配置](configuration.md)、[Workspace Doctor](workspace-doctor.md)、
[Loop](loop.md)和[历史迁移](legacy-onboarding.md)。
