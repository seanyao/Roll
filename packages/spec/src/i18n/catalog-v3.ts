/**
 * v3-native message catalog. The frozen v2 catalog (catalog.generated.json) is
 * mechanically derived from the bash oracle and must not be hand-edited; strings
 * for behaviour that is new in v3 live here instead (see catalog.ts header).
 *
 * Both en and zh are always present so the single-language contract (output
 * follows ROLL_LANG, never mixes) holds.
 */
import type { Catalog } from "./index.js";

export const v3Catalog: Catalog = {
  "context.usage": {
    en: "Usage: roll context status [--workspace <id|path>] [--json]\n       roll context read [--workspace <id|path>] [--story <id>] --stage <stage> [--environment <id>]... [--ref <context-ref>]... [--include-non-active] [--allow-restricted] [--json]\n  status reads local registry, binding, and snapshot metadata only; it does not fetch and is not proof of remote freshness.\n  read performs a fresh Provider read every invocation. --allow-restricted expresses intent only; operation policy must still authorize access.\n",
    zh: "用法：roll context status [--workspace <ID|路径>] [--json]\n      roll context read [--workspace <ID|路径>] [--story <ID>] --stage <阶段> [--environment <ID>]... [--ref <Context 引用>]... [--include-non-active] [--allow-restricted] [--json]\n  status 只读取本地 registry、binding 和 snapshot 元数据；不会 fetch，也不能证明远端最新。\n  read 每次调用都会重新读取 Provider。--allow-restricted 只表达意图，仍须 operation policy 授权。\n",
  },
  "context.status.usage": {
    en: "Usage: roll context status [--workspace <id|path>] [--json]\n\nInspect the machine registry, resolved Workspace binding, and latest local Snapshot metadata. This command never fetches and is not proof of remote freshness.\n\nOptions:\n  --workspace <id|path>  Resolve this Workspace explicitly; otherwise use the unified target resolver from the current directory.\n  --json                 Write the versioned status object to stdout.\n\nPlain stdout is a metadata summary. Errors go to stderr.\nExit codes: 0=success, 2=target/configuration/snapshot error.\n",
    zh: "用法：roll context status [--workspace <ID|路径>] [--json]\n\n查看机器 registry、解析后的 Workspace binding 与最近本地 Snapshot metadata。该命令绝不 fetch，也不能证明远端最新。\n\n选项：\n  --workspace <ID|路径>  显式解析 Workspace；省略时从当前目录使用统一 target resolver。\n  --json                 把 versioned status object 写到 stdout。\n\nplain stdout 输出 metadata 摘要；错误写 stderr。\n退出码：0=成功，2=target/configuration/snapshot 错误。\n",
  },
  "context.read.usage": {
    en: "Usage: roll context read [--workspace <id|path>] [--story <id>] --stage <clarify|design|tasking|build|qa|review|fix|operation> [--environment <id>]... [--ref <context-ref>]... [--include-non-active] [--allow-restricted] [--json]\n\nPerform a fresh Context read. Every invocation fetches once per unique enabled Provider, then reads purpose, schema, entrypoints, and requested pages from the same commit. Fetch failure has no stale fallback. Snapshot reuse is a separate no-fetch path; requesting a new page requires a new read.\n\nOptions:\n  --workspace <id|path>  Resolve this Workspace explicitly; otherwise use the unified target resolver from the current directory.\n  --story <id>           Bind the request to a Story; it must agree with an Issue-scoped current directory.\n  --stage <stage>        Required execution stage for scope matching.\n  --environment <id>     Add an explicit environment scope value; repeatable.\n  --ref <context-ref>    Add an explicit context:// Provider page; repeatable.\n  --include-non-active   Permit explicitly requested proposed or deprecated pages.\n  --allow-restricted     Express restricted-reference intent; operation policy must still authorize it.\n  --json                 Write the complete versioned result, including page bodies, to stdout.\n\nPlain stdout contains outcome, scope, Provider, revision, refs, digests, and diagnostics, never page bodies. Fetch progress and sanitized diagnostics go to stderr and the event stream.\nExit codes: 0=completed/disabled, 3=partial, 2=blocked/error.\n",
    zh: "用法：roll context read [--workspace <ID|路径>] [--story <ID>] --stage <clarify|design|tasking|build|qa|review|fix|operation> [--environment <ID>]... [--ref <Context 引用>]... [--include-non-active] [--allow-restricted] [--json]\n\n执行 fresh Context read。每次调用对每个唯一且启用的 Provider fetch 一次，然后从同一 commit 读取 purpose、schema、entrypoints 与请求页面。fetch 失败时没有 stale fallback。复用 Snapshot 是独立的 no-fetch 路径；请求新页面必须发起新 read。\n\n选项：\n  --workspace <ID|路径>  显式解析 Workspace；省略时从当前目录使用统一 target resolver。\n  --story <ID>           把 request 绑定到 Story；必须与当前 Issue 目录一致。\n  --stage <阶段>          scope 匹配所需的 execution stage。\n  --environment <ID>     添加显式 environment scope value；可重复。\n  --ref <Context 引用>   添加显式 context:// Provider 页面；可重复。\n  --include-non-active   允许显式请求 proposed 或 deprecated 页面。\n  --allow-restricted     表达 restricted-reference intent；仍须 operation policy 授权。\n  --json                 把包含页面正文的完整 versioned result 写到 stdout。\n\nplain stdout 只包含 outcome、scope、Provider、revision、refs、digest 与 diagnostics，绝不打印页面正文。fetch progress 与清洗后的 diagnostics 写 stderr 和 event stream。\n退出码：0=completed/disabled，3=partial，2=blocked/error。\n",
  },
  "context.error.invalid_arguments": { en: "Invalid arguments; run `roll context --help`", zh: "参数无效；请运行 `roll context --help`" },
  "context.error.invalid_registry": { en: "Context Provider registry is missing or invalid", zh: "Context Provider registry 缺失或无效" },
  "context.error.invalid_workspace": { en: "Workspace manifest is invalid", zh: "Workspace manifest 无效" },
  "context.error.story_conflict": { en: "--story conflicts with the Issue execution context", zh: "--story 与 Issue execution context 冲突" },
  "context.error.snapshot_failure": { en: "Context Snapshot metadata is invalid or could not be persisted", zh: "Context Snapshot 元数据无效或无法持久化" },
  "context.error.read_failure": { en: "Context read failed before a versioned result was produced", zh: "Context read 在生成版本化结果前失败" },
  "context.error.line": { en: "context: %s — %s", zh: "context：%s — %s" },
  "context.status.title": { en: "Context status for Workspace %s", zh: "工作区 %s 的 Context 状态" },
  "context.status.freshness": { en: "Freshness: local observation only; not remote freshness proof (no fetch)", zh: "新鲜度：仅本地观察；不能证明远端最新（未 fetch）" },
  "context.status.registry": { en: "Registry: %s (%d providers)", zh: "Registry：%s（%d 个 Provider）" },
  "context.status.binding": { en: "Binding: %s (%d bindings)", zh: "Binding：%s（%d 个 binding）" },
  "context.status.latest": { en: "Latest snapshot: %s · %s · %s", zh: "最近 snapshot：%s · %s · %s" },
  "context.status.none": { en: "Latest snapshot: none", zh: "最近 snapshot：无" },
  "context.read.progress": { en: "context: fetching fresh Provider content...", zh: "context：正在重新获取 Provider 内容……" },
  "context.read.title": { en: "Context read: %s", zh: "Context 读取：%s" },
  "context.read.scope": { en: "Scope: workspace=%s story=%s stage=%s environments=%s", zh: "范围：workspace=%s story=%s stage=%s environments=%s" },
  "context.read.snapshot": { en: "Snapshot: %s · digest %s", zh: "Snapshot：%s · digest %s" },
  "context.read.provider": { en: "Provider: %s · branch %s · revision %s", zh: "Provider：%s · branch %s · revision %s" },
  "context.read.ref": { en: "  ref: %s · sha256 %s · %d bytes", zh: "  引用：%s · sha256 %s · %d bytes" },
  "context.read.diagnostic": { en: "Diagnostic: %s · %s · provider=%s", zh: "诊断：%s · %s · provider=%s" },
  "context.read.none": { en: "Providers: none", zh: "Provider：无" },
  "workspace.alias.help.command": {
    en: "Alias: roll %s ... (canonical: roll %s ...)",
    zh: "别名：roll %s ...（canonical：roll %s ...）",
  },
  "workspace.alias.help.selector": {
    en: "Workspace selector alias: %s <id|path> (canonical: %s <id|path>)",
    zh: "Workspace selector 别名：%s <ID|路径>（canonical：%s <ID|路径>）",
  },
  "workspace.selector.error.line": {
    en: "%s: %s — %s",
    zh: "%s：%s — %s",
  },
  "workspace.selector.error.duplicate_workspace_selector": {
    en: "Provide exactly one --workspace <id|path>.",
    zh: "请只提供一个 --workspace <ID|路径>。",
  },
  "workspace.selector.error.workspace_selector_missing_value": {
    en: "--workspace requires <id|path>; another flag is not a selector value.",
    zh: "--workspace 需要 <ID|路径>；后续 flag 不能作为 selector 值。",
  },
  "workspace.selector.next.duplicate_workspace_selector": {
    en: "Remove the duplicate and use --workspace <id|path> once.",
    zh: "请移除重复参数，只使用一次 --workspace <ID|路径>。",
  },
  "workspace.selector.next.workspace_selector_missing_value": {
    en: "Provide a value with --workspace <id|path>.",
    zh: "请使用 --workspace <ID|路径> 提供目标。",
  },
  "backlog.usage": {
    en: "Usage: roll backlog [--workspace <id|path>] [--interactive|--no-input]\n       roll backlog show <story-id> [--workspace <id|path>] [--interactive|--no-input]\n       roll backlog --all",
    zh: "用法：roll backlog [--workspace <ID|路径>] [--interactive|--no-input]\n      roll backlog show <Story ID> [--workspace <ID|路径>] [--interactive|--no-input]\n      roll backlog --all",
  },
  "backlog.title": { en: "Backlog %s (%s)", zh: "待办 %s（%s）" },
  "backlog.header": { en: "Workspace\tStory\tStatus\tDescription", zh: "工作区\tStory\t状态\t说明" },
  "backlog.empty": { en: "No backlog items", zh: "没有待办事项" },
  "backlog.show.title": { en: "Story %s in %s", zh: "Story %s（工作区 %s）" },
  "backlog.show.path": { en: "Contract: %s", zh: "契约：%s" },
  "backlog.error.line": { en: "backlog: %s — %s", zh: "待办：%s — %s" },
  "backlog.error.candidates": { en: "Candidates: %s", zh: "候选目标：%s" },
  "backlog.error.migration_command": { en: "Run: %s", zh: "请运行：%s" },
  "backlog.error.story_not_found": { en: "Story contract was not found in this Workspace backlog", zh: "该工作区待办中找不到 Story 契约" },
  "backlog.error.invalid_arguments": { en: "Invalid arguments; run `roll backlog --help`", zh: "参数无效；请运行 `roll backlog --help`" },
  "delivery.usage": {
    en: "Usage: roll delivery <list|show|reconcile> [options]\n  `list [--workspace <id|path> | --all] [--interactive|--no-input] [--json]`\n  `show <story-id> [--workspace <id|path>] [--interactive|--no-input] [--json]`\n  `reconcile [<story-id>] --workspace <id|path> [--dry-run] [--json]`\n  Interaction capability is independent from --json; prompts use the controlling TTY, never stdout. Delivery is an Issue fact view; --all is read-only and reconciliation never reads backlog Markdown as completion truth.\n",
    zh: "用法：roll delivery <list|show|reconcile> [选项]\n  `list [--workspace <ID|路径> | --all] [--interactive|--no-input] [--json]`\n  `show <Story ID> [--workspace <ID|路径>] [--interactive|--no-input] [--json]`\n  `reconcile [<Story ID>] --workspace <ID|路径> [--dry-run] [--json]`\n  交互能力与 --json 相互独立；prompt 只写控制终端，绝不写 stdout。Delivery 是 Issue 事实视图；--all 仅限只读，对账绝不把 backlog Markdown 当作完成真相。\n",
  },
  "delivery.loop_reconcile_usage": {
    en: "Usage: roll loop reconcile [<story-id>] --workspace <id|path> [--dry-run] [--json]\n  Alias of `roll delivery reconcile`; folds Workspace Issue facts and never reads backlog Markdown as completion truth.\n",
    zh: "用法：roll loop reconcile [<Story ID>] --workspace <ID|路径> [--dry-run] [--json]\n  `roll delivery reconcile` 的别名；折叠工作区 Issue 事实，绝不把 backlog Markdown 当作完成真相。\n",
  },
  "delivery.list.title": { en: "Deliveries %s (%d)", zh: "交付 %s（%d）" },
  "delivery.list.header": { en: "Story\tState\tOutstanding", zh: "Story\t状态\t待完成闸门" },
  "delivery.list.empty": { en: "No Issues", zh: "没有 Issue" },
  "delivery.show.title": { en: "Delivery %s (%s)", zh: "交付 %s（%s）" },
  "delivery.show.state": { en: "State: %s", zh: "状态：%s" },
  "delivery.show.repositories": { en: "Required repositories:", zh: "必需仓库：" },
  "delivery.show.repository": { en: "  %s · %s · %s · %s · %s", zh: "  %s · %s · %s · %s · %s" },
  "delivery.show.fact": { en: "    fact: %s", zh: "    事实：%s" },
  "delivery.show.acceptance": { en: "Integration acceptance: %s · profile %s · artifact %s", zh: "集成验收：%s · profile %s · 产物 %s" },
  "delivery.show.outstanding": { en: "Outstanding: %s", zh: "待完成闸门：%s" },
  "delivery.reconcile.title": { en: "Reconcile %s (%d Issues, %s)", zh: "对账 %s（%d 个 Issue，%s）" },
  "delivery.reconcile.dry_run": { en: "dry-run", zh: "只读演练" },
  "delivery.reconcile.applied": { en: "current facts folded", zh: "已折叠当前事实" },
  "delivery.error.line": { en: "delivery: %s — %s", zh: "交付：%s — %s" },
  "delivery.error.candidates": { en: "Candidates: %s", zh: "候选目标：%s" },
  "delivery.error.migration_command": { en: "Run: %s", zh: "请运行：%s" },
  "delivery.error.invalid_arguments": { en: "Invalid arguments; run `roll delivery --help`", zh: "参数无效；请运行 `roll delivery --help`" },
  "delivery.error.story_not_found": { en: "Issue was not found in the selected Workspace", zh: "所选工作区中找不到该 Issue" },
  "delivery.error.invalid_issue": { en: "Issue facts are invalid, unsafe or inconsistent", zh: "Issue 事实无效、不安全或不一致" },
  "delivery.error.invalid_requirement": { en: "Requirement facts are missing, invalid or inconsistent", zh: "Requirement 事实缺失、无效或不一致" },
  "workspace.usage": {
    en: "Usage: roll workspace <create|edit|issue|requirement|doctor|migrate|list|show|register|activate|pause|archive> [options]\n  `create <id> --config <file> [--authorization <file>] [--check] [--json]`\n  `edit <id|path> --config <file> [--check] [--json]`\n  `issue init <story-id> --workspace <id> [--check] [--json]`\n  `requirement add --provider <provider> --ref <ref> --revision <revision> --body-file <file> --story <id> [options]`\n  `doctor <id> [--json] [--repair <typed-action>] [--path <absolute-path>]`\n  `migrate --from <repo> --check [--workspace <id>] [--json]`\n  `migrate --from <repo> --workspace <id> --plan <file> [--rollback] [--json]`\n  `list [--json] [--all]`\n  `show <id|path> [--json]`\n  `register <id> <path> [--json]`\n  `activate|pause|archive <id|path> [--json]`\n  Create/edit/issue/migrate --check and doctor diagnosis are read-only; migrate apply/rollback, typed doctor repairs and lifecycle mutations require one explicit target; --all is read-only.\n",
    zh: "用法：roll workspace <create|edit|issue|requirement|doctor|migrate|list|show|register|activate|pause|archive> [选项]\n  `create <ID> --config <文件> [--authorization <文件>] [--check] [--json]`\n  `edit <ID|路径> --config <文件> [--check] [--json]`\n  `issue init <Story ID> --workspace <ID> [--check] [--json]`\n  `requirement add --provider <来源> --ref <引用> --revision <修订> --body-file <文件> --story <ID> [选项]`\n  `doctor <ID> [--json] [--repair <类型化动作>] [--path <绝对路径>]`\n  `migrate --from <仓库> --check [--workspace <ID>] [--json]`\n  `migrate --from <仓库> --workspace <ID> --plan <文件> [--rollback] [--json]`\n  `list [--json] [--all]`\n  `show <ID|路径> [--json]`\n  `register <ID> <路径> [--json]`\n  `activate|pause|archive <ID|路径> [--json]`\n  create/edit/issue/migrate --check 和 doctor 诊断只读；migrate apply/rollback、doctor 类型化修复和生命周期变更必须显式指定一个目标；--all 仅限只读。\n",
  },
  "workspace.edit.usage": {
    en: "Usage: roll workspace edit <id|path> --config <file> [--check] [--json]\nUse --check to preview; omit it to apply atomically.\n",
    zh: "用法：roll workspace edit <ID|路径> --config <文件> [--check] [--json]\n使用 --check 预览；省略时原子应用。\n",
  },
  "workspace.edit.title": { en: "Workspace %s edit preview: %s", zh: "工作区 %s 编辑预览：%s" },
  "workspace.edit.manifest": { en: "Manifest: %s", zh: "清单：%s" },
  "workspace.edit.digests": { en: "Digests: before=%s after=%s references=%s", zh: "摘要：before=%s after=%s references=%s" },
  "workspace.edit.header": { en: "Safety\tOperation\tPath", zh: "安全性\t操作\t路径" },
  "workspace.edit.blocker": { en: "Blocked: %s at %s (%s)", zh: "已阻止：%s，位置 %s（%s）" },
  "workspace.edit.next": { en: "Next: %s", zh: "下一步：%s" },
  "workspace.edit.applied": { en: "Workspace %s edit %s: %s", zh: "工作区 %s 编辑%s：%s" },
  "workspace.edit.outcome.applied": { en: "applied", zh: "已应用" },
  "workspace.edit.outcome.reused": { en: "reused", zh: "已复用" },
  "workspace.edit.recovery": { en: "Recovery: %s", zh: "恢复操作：%s" },
  "workspace.edit.error.line": { en: "workspace edit: %s — %s", zh: "工作区编辑：%s — %s" },
  "workspace.edit.error.invalid_arguments": { en: "Usage: roll workspace edit <id|path> --config <file> [--check] [--json]", zh: "用法：roll workspace edit <ID|路径> --config <文件> [--check] [--json]" },
  "workspace.edit.error.config_read_failed": { en: "Workspace edit config could not be read safely", zh: "无法安全读取工作区编辑配置" },
  "workspace.edit.error.target_missing": { en: "Workspace edit target was not found", zh: "找不到工作区编辑目标" },
  "workspace.edit.error.invalid_workspace": { en: "Workspace authority is invalid or inconsistent", zh: "工作区权威数据无效或不一致" },
  "workspace.edit.error.reference_index_invalid": { en: "Workspace metadata references are incomplete, unsafe or invalid", zh: "工作区元数据引用不完整、不安全或无效" },
  "workspace.edit.error.concurrent_edit": { en: "Another Workspace authority writer is active", zh: "另一个工作区权威写入正在进行" },
  "workspace.edit.error.manifest_changed": { en: "Workspace manifest changed after preview; run --check again", zh: "预览后工作区清单已变化；请重新运行 --check" },
  "workspace.edit.error.edit_plan_changed": { en: "Workspace edit result changed while the lock was acquired; preview again", zh: "获取锁后工作区编辑结果已变化；请重新预览" },
  "workspace.edit.error.metadata_referenced": { en: "Workspace metadata gained a durable reference and cannot be changed", zh: "工作区元数据新增了持久引用，无法修改" },
  "workspace.edit.error.partial_apply_recovered": { en: "Workspace edit recovery cannot prove a safe before or after state", zh: "工作区编辑恢复无法证明安全的 before 或 after 状态" },
  "workspace.edit.error.io_failure": { en: "Workspace edit transaction failed before it could complete safely", zh: "工作区编辑事务未能安全完成" },
  "workspace.edit.error.unknown_version": { en: "Workspace edit config schema is unsupported", zh: "不支持该工作区编辑配置版本" },
  "workspace.edit.error.unknown_field": { en: "Workspace edit config contains an unknown field", zh: "工作区编辑配置包含未知字段" },
  "workspace.edit.error.invalid_type": { en: "Workspace edit config contains an invalid type", zh: "工作区编辑配置包含无效类型" },
  "workspace.edit.error.invalid_value": { en: "Workspace edit config contains an invalid value", zh: "工作区编辑配置包含无效值" },
  "workspace.edit.error.identity_mismatch": { en: "Command and config Workspace identities do not match", zh: "命令与配置中的工作区 ID 不一致" },
  "workspace.edit.error.duplicate_identity": { en: "Workspace edit config contains duplicate metadata identity", zh: "工作区编辑配置包含重复元数据身份" },
  "workspace.edit.error.unsafe_remote": { en: "Workspace edit repository remote is unsafe", zh: "工作区编辑仓库远端地址不安全" },
  "workspace.edit.error.repo_id_mismatch": { en: "Workspace edit repository identity does not match its remote", zh: "工作区编辑仓库 ID 与远端地址不匹配" },
  "workspace.migrate.usage": {
    en: "Usage:\n  roll workspace migrate --from <repo> --check [--workspace <id>] [--json]\n  roll workspace migrate --from <repo> --workspace <id> --plan <file> [--json]\n  roll workspace migrate --from <repo> --workspace <id> --plan <file> --rollback [--json]\nCheck is read-only. Apply resumes the exact saved plan; rollback is allowed only before registration.\n",
    zh: "用法：\n  roll workspace migrate --from <仓库> --check [--workspace <ID>] [--json]\n  roll workspace migrate --from <仓库> --workspace <ID> --plan <文件> [--json]\n  roll workspace migrate --from <仓库> --workspace <ID> --plan <文件> --rollback [--json]\ncheck 只读；apply 续跑保存的精确计划；rollback 仅允许在注册前执行。\n",
  },
  "workspace.migrate.title": { en: "Historical migration check: %s", zh: "历史迁移检查：%s" },
  "workspace.migrate.source": { en: "Source: %s", zh: "源仓库：%s" },
  "workspace.migrate.workspace": { en: "Workspace: %s (%s)", zh: "工作区：%s（%s）" },
  "workspace.migrate.repository": { en: "Repository: %s (alias %s)", zh: "仓库：%s（别名 %s）" },
  "workspace.migrate.branch": { en: "Integration branch: %s", zh: "集成分支：%s" },
  "workspace.migrate.cache": { en: "Shared cache: %s", zh: "共享缓存：%s" },
  "workspace.migrate.plan_id": { en: "Plan ID: %s", zh: "计划 ID：%s" },
  "workspace.migrate.mappings": { en: "Mappings: %d", zh: "映射：%d" },
  "workspace.migrate.findings": { en: "Findings: %d", zh: "发现：%d" },
  "workspace.migrate.finding.line": { en: "- %s: %s%s", zh: "- %s：%s%s" },
  "workspace.migrate.finding.path": { en: " (%s)", zh: "（%s）" },
  "workspace.migrate.severity.info": { en: "info", zh: "信息" },
  "workspace.migrate.severity.error": { en: "error", zh: "错误" },
  "workspace.migrate.verdict.ready": { en: "ready", zh: "可迁移" },
  "workspace.migrate.verdict.migration_blocked": { en: "blocked", zh: "已阻塞" },
  "workspace.migrate.verdict.repository_cutover_required": { en: "repository cutover required", zh: "需要仓库切换" },
  "workspace.migrate.verdict.manual_metadata_handoff": { en: "manual metadata handoff required", zh: "需要手工移交元数据" },
  "workspace.migrate.finding.workspace_id_defaulted": { en: "Workspace ID was derived from repoId", zh: "工作区 ID 已从 repoId 推导" },
  "workspace.migrate.finding.cache_create_planned": { en: "shared repository cache will be created during apply", zh: "应用阶段将创建共享仓库缓存" },
  "workspace.migrate.finding.product_dirty": { en: "product repository is dirty", zh: "产品仓库存在未提交改动" },
  "workspace.migrate.finding.product_operation_in_flight": { en: "product Git operation is in flight", zh: "产品仓库存在进行中的 Git 操作" },
  "workspace.migrate.finding.head_unpushed": { en: "product HEAD is not reachable from the remote default branch", zh: "产品 HEAD 无法从远端默认分支到达" },
  "workspace.migrate.finding.remote_missing": { en: "repository remote is missing", zh: "仓库远端缺失" },
  "workspace.migrate.finding.remote_default_ambiguous": { en: "remote default branch is ambiguous", zh: "远端默认分支不明确" },
  "workspace.migrate.finding.remote_truth_unverifiable": { en: "authoritative remote tip is absent locally or cannot be verified", zh: "权威远端 tip 不在本地或无法验证" },
  "workspace.migrate.finding.linked_worktree_unsafe": { en: "linked worktree is unsafe", zh: "关联 worktree 不安全" },
  "workspace.migrate.finding.submodule_unsafe": { en: "submodule is unsafe", zh: "submodule 不安全" },
  "workspace.migrate.finding.active_runtime": { en: "historical runtime is active", zh: "历史运行态仍处于活动状态" },
  "workspace.migrate.finding.roll_symlink_unsupported": { en: "symlink under .roll is unsupported", zh: ".roll 下的符号链接不受支持" },
  "workspace.migrate.finding.cache_conflict": { en: "shared repository cache conflicts with the plan", zh: "共享仓库缓存与计划冲突" },
  "workspace.migrate.finding.workspace_conflict": { en: "Workspace registry conflicts with the plan", zh: "工作区 registry 与计划冲突" },
  "workspace.migrate.cutover": { en: "Repository cutover: HEAD %s, %d tracked .roll entries", zh: "仓库切换：HEAD %s，%d 个被产品仓库跟踪的 .roll 条目" },
  "workspace.migrate.cutover.next": { en: "Next: remove product tracking through the existing TCR PR/push flow, then apply this saved plan", zh: "下一步：通过现有 TCR PR/push 流程移除产品仓库跟踪，然后应用这份已保存计划" },
  "workspace.migrate.handoff.gitdir": { en: "Metadata gitdir: %s", zh: "元数据 gitdir：%s" },
  "workspace.migrate.handoff.toplevel": { en: "Metadata top-level: %s", zh: "元数据顶层目录：%s" },
  "workspace.migrate.handoff.state": { en: "Metadata state: %s", zh: "元数据状态：%s" },
  "workspace.migrate.handoff.head": { en: "Metadata HEAD: %s", zh: "元数据 HEAD：%s" },
  "workspace.migrate.handoff.branch": { en: "Metadata branch: %s", zh: "元数据分支：%s" },
  "workspace.migrate.handoff.upstream": { en: "Metadata upstream: %s", zh: "元数据 upstream：%s" },
  "workspace.migrate.handoff.remote": { en: "Metadata remote: %s", zh: "元数据远端：%s" },
  "workspace.migrate.handoff.boundary": { en: "Roll will not link, commit or push the independent metadata repository.", zh: "Roll 不会 link、commit 或 push 这个独立元数据仓库。" },
  "workspace.migrate.none": { en: "none", zh: "无" },
  "workspace.migrate.error.line": { en: "workspace migrate: %s — %s", zh: "工作区迁移：%s — %s" },
  "workspace.migrate.error.invalid_arguments": { en: "Usage: roll workspace migrate --from <repo> --check [--workspace <id>] [--json]", zh: "用法：roll workspace migrate --from <仓库> --check [--workspace <ID>] [--json]" },
  "workspace.migrate.error.collection_failed": { en: "Historical migration facts could not be read safely", zh: "无法安全读取历史迁移事实" },
  "workspace.migrate.error.plan_read_failed": { en: "Saved migration plan could not be read", zh: "无法读取已保存的迁移计划" },
  "workspace.migrate.error.invalid_plan": { en: "Saved migration plan is malformed or not approved", zh: "已保存的迁移计划格式无效或未获批准" },
  "workspace.migrate.error.workspace_mismatch": { en: "Command Workspace ID does not match the saved plan", zh: "命令中的工作区 ID 与已保存计划不一致" },
  "workspace.migrate.error.apply_failed": { en: "Migration apply stopped safely; rerun the same command to resume or rollback before registration", zh: "迁移应用已安全停止；请重跑同一命令续跑，或在注册前执行 rollback" },
  "workspace.migrate.error.rollback_failed": { en: "Migration rollback was refused or could not complete safely", zh: "迁移 rollback 被拒绝或无法安全完成" },
  "workspace.migrate.apply.phase": { en: "Migration phase: %s", zh: "迁移阶段：%s" },
  "workspace.migrate.apply.phase.prepared": { en: "journal and manifest prepared", zh: "journal 与 manifest 已准备" },
  "workspace.migrate.apply.phase.cache_ready": { en: "shared cache ready", zh: "共享缓存已就绪" },
  "workspace.migrate.apply.phase.content_ready": { en: "mapped content verified", zh: "映射内容已校验" },
  "workspace.migrate.apply.phase.workspace_ready": { en: "Workspace staging activated on disk", zh: "工作区 staging 已在磁盘激活" },
  "workspace.migrate.apply.phase.registered": { en: "Workspace registered", zh: "工作区已注册" },
  "workspace.migrate.apply.phase.activated": { en: "Workspace active", zh: "工作区已激活" },
  "workspace.migrate.apply.phase.cleanup_complete": { en: "source cleanup complete", zh: "源端清理完成" },
  "workspace.migrate.apply.result": { en: "Historical migration apply: %s", zh: "历史迁移应用：%s" },
  "workspace.migrate.apply.outcome.migrated": { en: "migrated", zh: "已迁移" },
  "workspace.migrate.apply.outcome.reused": { en: "reused", zh: "已复用" },
  "workspace.migrate.apply.workspace": { en: "Workspace: %s (%s)", zh: "工作区：%s（%s）" },
  "workspace.migrate.apply.cache": { en: "Shared cache: %s", zh: "共享缓存：%s" },
  "workspace.migrate.apply.plan_id": { en: "Plan ID: %s", zh: "计划 ID：%s" },
  "workspace.migrate.apply.handoff": { en: "Independent roll-meta Git was not mutated.", zh: "未对独立 roll-meta 执行 Git 修改。" },
  "workspace.migrate.apply.handoff.next": { en: "Review, link, commit and push roll-meta manually through its existing owner-approved workflow.", zh: "请通过原有 owner 审批流程手工审阅、link、commit 与 push roll-meta。" },
  "workspace.migrate.rollback.result": { en: "Historical migration rollback: %s (%s)", zh: "历史迁移 rollback：%s（%s）" },
  "workspace.migrate.rollback.outcome.rolled_back": { en: "rolled back", zh: "已回滚" },
  "workspace.migrate.rollback.outcome.absent": { en: "no pending transaction", zh: "无待处理事务" },
  "workspace.doctor.usage": {
    en: "Usage: roll workspace doctor <id> [--json] [--repair <typed-action>] [--path <new-workspace-path>]\n  Diagnosis is read-only. Repair accepts only an action emitted by the latest diagnosis.\n  Actions: update_registry_path:<workspace-id> (requires absolute --path), rebuild_cache:<repo-id>, repair_requirement_projection:<requirement-id>, recreate_clean_worktree:<story-id>, cleanup_stale_owned_lease:<lease-id>, cleanup_stale_capacity_broker_lock:broker-lock.\n",
    zh: "用法：roll workspace doctor <ID> [--json] [--repair <类型化动作>] [--path <工作区新路径>]\n  诊断只读。修复仅接受最新诊断输出的动作。\n  动作：update_registry_path:<工作区ID>（必须提供绝对 --path）、rebuild_cache:<仓库ID>、repair_requirement_projection:<需求ID>、recreate_clean_worktree:<Story ID>、cleanup_stale_owned_lease:<lease ID>、cleanup_stale_capacity_broker_lock:broker-lock。\n",
  },
  "workspace.doctor.title": { en: "Workspace %s doctor: %s", zh: "工作区 %s doctor：%s" },
  "workspace.doctor.header": { en: "Status\tFinding\tEvidence\tNext action", zh: "状态\t发现\t证据\t下一步" },
  "workspace.doctor.healthy": { en: "healthy\t-\t-\tnone", zh: "healthy\t-\t-\t无" },
  "workspace.doctor.next": { en: "Next: %s", zh: "下一步：%s" },
  "workspace.doctor.next.none": { en: "none", zh: "无" },
  "workspace.doctor.next.owner": { en: "owner intervention (%s)", zh: "需要 owner 处理（%s）" },
  "workspace.doctor.repair.title": { en: "Workspace doctor repair %s: %s", zh: "工作区 doctor 修复 %s：%s" },
  "workspace.doctor.error.line": { en: "workspace doctor: %s — %s", zh: "工作区 doctor：%s — %s" },
  "workspace.doctor.error.invalid_arguments": { en: "Invalid arguments; run `roll workspace doctor --help`", zh: "参数无效；请运行 `roll workspace doctor --help`" },
  "workspace.doctor.error.not_found": { en: "Workspace is not registered", zh: "工作区未注册" },
  "workspace.doctor.error.invalid_workspace": { en: "Workspace facts could not be read safely", zh: "无法安全读取工作区事实" },
  "workspace.doctor.error.repair_blocked": { en: "Repair is not currently safe or was not offered by the latest diagnosis", zh: "当前修复不安全，或最新诊断未提供该动作" },
  "workspace.issue.usage": {
    en: "Usage: roll workspace issue init <story-id> --workspace <id> [--check] [--json]\n  --check resolves the Story Contract, Workspace bindings and every repository target's state with zero writes.\n  Apply creates/reuses/repairs one Issue root: an immutable roll.issue/v1 manifest and one worktree per declared repository target.\n",
    zh: "用法：roll workspace issue init <Story ID> --workspace <ID> [--check] [--json]\n  --check 只读解析 Story Contract、工作区绑定与每个仓库目标的状态，零写入。\n  Apply 创建/复用/修复一个 Issue root：不可变的 roll.issue/v1 manifest 与每个声明仓库目标各一个 worktree。\n",
  },
  "workspace.issue.check.title": { en: "Issue %s check: manifest %s", zh: "Issue %s 检查：manifest %s" },
  "workspace.issue.check.header": { en: "Alias\tAccess\tRepoId\tCachePath\tCacheState\tBaseSha\tWorktreePath\tWorkBranch\tDecision", zh: "别名\t访问\t仓库ID\t缓存路径\t缓存状态\t基线SHA\t工作区路径\t工作分支\t决策" },
  "workspace.issue.apply.title": { en: "Issue %s apply: %s", zh: "Issue %s 应用：%s" },
  "workspace.issue.error.line": { en: "workspace issue: %s — %s", zh: "工作区 Issue：%s — %s" },
  "workspace.issue.error.invalid_arguments": { en: "Usage: roll workspace issue init <story-id> --workspace <id> [--check] [--json]", zh: "用法：roll workspace issue init <Story ID> --workspace <ID> [--check] [--json]" },
  "workspace.issue.error.invalid_workspace": { en: "Workspace facts could not be read", zh: "无法读取工作区事实" },
  "workspace.issue.error.invalid_story_id": { en: "Story id must match the closed US-/FIX-/REFACTOR-/IDEA-/BUG- syntax with no path separators or traversal", zh: "Story ID 必须符合 US-/FIX-/REFACTOR-/IDEA-/BUG- 闭合语法，不含路径分隔符或路径穿越" },
  "workspace.issue.error.story_not_found": { en: "No Story spec was found for this id", zh: "找不到该 ID 对应的 Story spec" },
  "workspace.issue.error.duplicate_story": { en: "This Story id resolves to more than one spec — must be unique", zh: "该 Story ID 解析到多份 spec —必须唯一" },
  "workspace.issue.error.invalid_config": { en: "Story Contract frontmatter is invalid", zh: "Story Contract frontmatter 无效" },
  "workspace.issue.error.invalid_value": { en: "Story Contract or Issue target state is invalid", zh: "Story Contract 或 Issue 目标状态无效" },
  "workspace.issue.error.invalid_type": { en: "Story Contract contains an invalid type", zh: "Story Contract 包含无效类型" },
  "workspace.issue.error.unknown_field": { en: "Story Contract declares an alias with no matching Workspace repository binding", zh: "Story Contract 声明的别名没有匹配的工作区仓库绑定" },
  "workspace.issue.error.identity_mismatch": { en: "Story spec id does not match the requested Story", zh: "Story spec 中的 ID 与请求的 Story 不一致" },
  "workspace.issue.error.duplicate_identity": { en: "Story Contract repository alias must be unique", zh: "Story Contract 中的仓库别名必须唯一" },
  "workspace.issue.error.rejected": { en: "Issue init plan was rejected before mutation", zh: "Issue 初始化计划已在变更前被拒绝" },
  "workspace.issue.error.manifest_conflict": { en: "Issue manifest on disk conflicts with the resolved Workspace/Story identity", zh: "磁盘上的 Issue manifest 与解析出的工作区/Story 身份冲突" },
  "workspace.issue.error.apply_failed": { en: "Issue init failed; clean new targets were rolled back and a repair journal was written", zh: "Issue 初始化失败；已回滚新建目标并写入修复 journal" },
  "workspace.issue.error.symlink_escape": { en: "Issue root or Story spec path escapes its Workspace via a symlink", zh: "Issue 根目录或 Story spec 路径通过符号链接逃逸出工作区" },
  "workspace.requirement.usage": {
    en: "Usage: roll workspace requirement add [--workspace <id|path>] --provider <jira|github-issue|local-file|user-input> --ref <ref> --revision <revision> --body-file <file> [--context-root <dir> --context <relative-path> ...] --story <id> ... [--json]\n  Captures immutable local evidence; attest.md keeps linked Stories pending. Projection drift stops capture without repair.",
    zh: "用法：roll workspace requirement add [--workspace <ID|路径>] --provider <jira|github-issue|local-file|user-input> --ref <引用> --revision <修订> --body-file <文件> [--context-root <目录> --context <相对路径> ...] --story <ID> ... [--json]\n  采集不可变的本地证据；attest.md 将关联 Story 保持为 pending。投影漂移会中止采集，不会自动修复。",
  },
  "workspace.requirement.error.line": { en: "workspace requirement: %s — %s", zh: "工作区需求：%s — %s" },
  "workspace.requirement.error.invalid_arguments": { en: "Invalid arguments; run `roll workspace requirement --help`", zh: "参数无效；请运行 `roll workspace requirement --help`" },
  "workspace.requirement.error.invalid_workspace": { en: "Workspace facts could not be read", zh: "无法读取工作区事实" },
  "workspace.requirement.error.source_not_declared": { en: "Requirement source is invalid or not declared in workspace.yaml", zh: "需求来源无效或未在 workspace.yaml 中声明" },
  "workspace.requirement.error.story_not_found": { en: "A linked Story does not exist in the Workspace backlog", zh: "关联的 Story 不存在于工作区 backlog" },
  "workspace.requirement.error.unsafe_context": { en: "Requirement body or context is unsafe", zh: "需求正文或上下文不安全" },
  "workspace.requirement.error.context_limit": { en: "Requirement context exceeds its bounded capture limits", zh: "需求上下文超过有界采集限制" },
  "workspace.requirement.error.source_changed": { en: "Requirement input changed during capture", zh: "采集期间需求输入发生变化" },
  "workspace.requirement.error.revision_conflict": { en: "The revision already identifies different evidence", zh: "该修订已对应不同证据" },
  "workspace.requirement.error.concurrent_capture": { en: "Another capture is already running for this Requirement", zh: "该需求已有采集任务正在运行" },
  "workspace.requirement.error.io_failure": { en: "Requirement source could not be persisted", zh: "无法持久化需求来源" },
  "workspace.requirement.error.projection_repair_required": { en: "Current Requirement projection is inconsistent; capture stopped without repair", zh: "当前 Requirement 投影不一致；采集已中止且未自动修复" },
  "workspace.requirement.result.title": { en: "Requirement %s:%s revision %s (%s)", zh: "需求 %s:%s 修订 %s（%s）" },
  "workspace.requirement.result.context": { en: "Context files: %d", zh: "上下文文件：%d" },
  "workspace.requirement.result.stories": { en: "Linked Stories: %d", zh: "关联 Story：%d" },
  "workspace.requirement.result.path": { en: "Path: %s", zh: "路径：%s" },
  "workspace.create.title": { en: "Workspace %s create (%s): %s", zh: "工作区 %s 创建（%s）：%s" },
  "workspace.create.root": { en: "Root: %s", zh: "根目录：%s" },
  "workspace.create.header": { en: "Decision\tKind\tTarget", zh: "决策\t类型\t目标" },
  "workspace.create.error.line": { en: "workspace create: %s — %s", zh: "工作区创建：%s — %s" },
  "workspace.create.error.conversion": { en: "Convert %s: %s -> %s", zh: "转换 %s：%s -> %s" },
  "workspace.create.error.next_action": { en: "Next: %s", zh: "下一步：%s" },
  "workspace.create.error.invalid_arguments": { en: "Usage: roll workspace create <id> --config <file> [--authorization <file>] [--check] [--json]", zh: "用法：roll workspace create <ID> --config <文件> [--authorization <文件>] [--check] [--json]" },
  "workspace.create.error.config_read_failed": { en: "Workspace create config could not be read", zh: "无法读取工作区创建配置" },
  "workspace.create.error.authorization_read_failed": { en: "Workspace create authorization could not be read", zh: "无法读取工作区创建授权" },
  "workspace.create.error.invalid_apply_authorization": { en: "Workspace create authorization must be an exact owner-approved preview", zh: "工作区创建授权必须精确对应 owner 已批准的预览" },
  "workspace.create.error.apply_authorization_required": { en: "Workspace create apply requires an exact preview authorization", zh: "工作区创建应用需要精确的预览授权" },
  "workspace.create.error.apply_authorization_stale": { en: "Workspace create authorization is stale; preview again", zh: "工作区创建授权已过期；请重新预览" },
  "workspace.create.error.legacy_create_recovery_required": { en: "Legacy Workspace init recovery is ambiguous; create stopped before mutation", zh: "旧版工作区 init 恢复状态不明确；创建已在变更前停止" },
  "workspace.create.error.invalid_config": { en: "Workspace create config is invalid", zh: "工作区创建配置无效" },
  "workspace.create.error.legacy_create_config": { en: "Legacy Workspace init config must be converted before create", zh: "旧版工作区 init 配置必须转换后才能创建" },
  "workspace.create.error.unknown_version": { en: "Workspace create config schema is unsupported", zh: "不支持该工作区创建配置版本" },
  "workspace.create.error.unknown_field": { en: "Workspace create config contains an unknown field", zh: "工作区创建配置包含未知字段" },
  "workspace.create.error.invalid_type": { en: "Workspace create config contains an invalid type", zh: "工作区创建配置包含无效类型" },
  "workspace.create.error.invalid_value": { en: "Workspace create config contains an invalid value", zh: "工作区创建配置包含无效值" },
  "workspace.create.error.identity_mismatch": { en: "Command and config Workspace identities do not match", zh: "命令与配置中的工作区 ID 不一致" },
  "workspace.create.error.duplicate_identity": { en: "Workspace repository identities must be unique", zh: "工作区仓库标识必须唯一" },
  "workspace.create.error.unsafe_remote": { en: "Workspace repository remote is unsafe", zh: "工作区仓库远端地址不安全" },
  "workspace.create.error.repo_id_mismatch": { en: "Workspace repository identity does not match its remote", zh: "工作区仓库 ID 与远端地址不匹配" },
  "workspace.create.error.path_conflict": { en: "Workspace root conflicts with machine cache paths", zh: "工作区根目录与机器缓存路径冲突" },
  "workspace.create.error.rejected": { en: "Workspace creation plan was rejected before mutation", zh: "工作区创建计划已在变更前被拒绝" },
  "workspace.create.error.concurrent_create": { en: "Workspace creation is already running for this ID", zh: "该工作区 ID 已有创建任务正在运行" },
  "workspace.create.error.apply_failed": { en: "Workspace creation failed; inspect the repair journal", zh: "工作区创建失败；请检查修复 journal" },
  "workspace.list.title": { en: "Workspaces (%d)", zh: "工作区（%d）" },
  "workspace.list.header": { en: "ID\tLifecycle\tRuntime\tConsistency\tPath", zh: "ID\t生命周期\t运行状态\t一致性\t路径" },
  "workspace.show.title": { en: "Workspace %s", zh: "工作区 %s" },
  "workspace.show.path": { en: "Path: %s", zh: "路径：%s" },
  "workspace.show.lifecycle": { en: "Lifecycle: %s", zh: "生命周期：%s" },
  "workspace.show.runtime": { en: "Runtime: %s (%s)", zh: "运行状态：%s（%s）" },
  "workspace.show.consistency": { en: "Consistency: %s (manifest: %s)", zh: "一致性：%s（清单：%s）" },
  "workspace.lifecycle.registered": { en: "registered", zh: "已注册" },
  "workspace.lifecycle.active": { en: "active", zh: "活跃" },
  "workspace.lifecycle.paused": { en: "paused", zh: "已暂停" },
  "workspace.lifecycle.archived": { en: "archived", zh: "已归档" },
  "workspace.consistency.consistent": { en: "consistent", zh: "一致" },
  "workspace.consistency.stale_path": { en: "stale path", zh: "路径失效" },
  "workspace.consistency.identity_mismatch": { en: "ID mismatch", zh: "ID 不匹配" },
  "workspace.consistency.invalid_manifest": { en: "invalid manifest", zh: "清单无效" },
  "workspace.runtime.unknown": { en: "unknown", zh: "未知" },
  "workspace.runtime.scheduler_not_available": { en: "Workspace scheduler not available", zh: "工作区调度器尚不可用" },
  "workspace.manifest.missing": { en: "unavailable", zh: "不可用" },
  "workspace.success.register": { en: "Registered Workspace %s at %s", zh: "已注册工作区 %s：%s" },
  "workspace.success.activate": { en: "Activated Workspace %s at %s", zh: "已激活工作区 %s：%s" },
  "workspace.success.pause": { en: "Paused Workspace %s at %s", zh: "已暂停工作区 %s：%s" },
  "workspace.success.archive": { en: "Archived Workspace %s at %s", zh: "已归档工作区 %s：%s" },
  "workspace.error.line": { en: "workspace: %s — %s", zh: "工作区：%s — %s" },
  "workspace.error.candidates": { en: "Candidates: %s", zh: "候选目标：%s" },
  "workspace.error.invalid_arguments": { en: "Invalid arguments; run `roll workspace --help`", zh: "参数无效；请运行 `roll workspace --help`" },
  "workspace.error.all_requires_readonly": { en: "--all is read-only and cannot be used for lifecycle mutations", zh: "--all 仅限只读，不能用于生命周期变更" },
  "workspace.error.conflicting_candidates": { en: "Workspace target sources conflict", zh: "工作区目标来源相互冲突" },
  "workspace.error.duplicate_candidate": { en: "Workspace registry contains duplicate targets", zh: "工作区注册表包含重复目标" },
  "workspace.error.identity_mismatch": { en: "Workspace registry and manifest IDs do not match", zh: "工作区注册表与清单 ID 不匹配" },
  "workspace.error.invalid_target": { en: "Workspace target is invalid", zh: "工作区目标无效" },
  "workspace.error.migration_required": { en: "Repository-local state must migrate to a Workspace", zh: "仓库本地状态必须先迁移为工作区" },
  "workspace.error.stale_registry": { en: "Workspace path is stale; repair the registry path first", zh: "工作区路径已失效；请先修复注册表路径" },
  "workspace.error.symlink_escape": { en: "Workspace path escapes its registered canonical root", zh: "工作区路径逃逸出已注册的规范根目录" },
  "workspace.error.target_missing": { en: "Provide one registered Workspace ID or path", zh: "请提供一个已注册的工作区 ID 或路径" },
  "workspace.error.requirement_match_required": { en: "Choose an existing Workspace or create a new Workspace preview", zh: "请选择已有工作区，或进入新工作区创建预览" },
  "workspace.error.create_required": { en: "The original command stopped; preview a new Workspace with the canonical create command", zh: "原命令已停止；请使用规范 create 命令预览新工作区" },
  "workspace.error.workspace_clarification_cancelled": { en: "Workspace clarification was cancelled; no Workspace was selected or changed", zh: "工作区澄清已取消；未选择或修改任何工作区" },
  "workspace.error.invalid_workspace_clarification": { en: "Workspace facts changed or the answer was invalid; reload candidates and try again", zh: "工作区事实已变化或回答无效；请重新加载候选后重试" },
  "workspace.error.interaction_unavailable": { en: "Interactive input requires a readable stdin TTY and writable stderr TTY", zh: "交互输入需要可读 stdin TTY 与可写 stderr TTY" },
  "workspace.error.workspace_discovery_incomplete": { en: "Workspace discovery is incomplete; repair the reported authority before continuing", zh: "工作区发现不完整；继续前请修复报告的权威数据" },
  "workspace.error.workspace_activation_required": { en: "The matching Workspace requires a separate lifecycle activation", zh: "匹配的工作区需要单独授权激活生命周期" },
  "workspace.error.ambiguous_requirement_match": { en: "Multiple Workspaces have an exact requirement match; choose one explicitly", zh: "多个工作区精确匹配当前需求；请显式选择一个" },
  "workspace.error.unrelated_worktree": { en: "Current worktree is unrelated to the Workspace", zh: "当前工作树与该工作区无关" },
  "workspace.error.invalid_registry": { en: "Workspace registry is invalid", zh: "工作区注册表无效" },
  "workspace.error.invalid_path": { en: "Workspace path is invalid", zh: "工作区路径无效" },
  "workspace.error.path_conflict": { en: "Workspace path is already registered", zh: "工作区路径已被注册" },
  "workspace.error.path_change_requires_move": { en: "Workspace path changes require an explicit move", zh: "工作区路径变更必须显式执行 move" },
  "workspace.error.stale_path": { en: "Workspace path no longer exists", zh: "工作区路径已不存在" },
  "workspace.error.not_found": { en: "Workspace is not registered", zh: "工作区尚未注册" },
  "workspace.error.io_failure": { en: "Workspace storage operation failed", zh: "工作区存储操作失败" },
  "workspace.error.concurrent_write": { en: "Another Workspace writer is active", zh: "另一个工作区写入者正在运行" },
  "workspace.error.archived_requires_activation": { en: "Archived Workspace must be activated before other mutations", zh: "已归档工作区必须先激活，才能执行其他变更" },
  "workspace.error.already_archived": { en: "Workspace is already archived", zh: "工作区已经归档" },
  // `north.*` — terminal north-star panel (US-OBS-047). The calculation stays
  // in @roll/core; these strings only label the shared roll.north.v1 report.
  "north.title": {
    en: "North Star",
    zh: "北极星",
  },
  "north.status_title": {
    en: "North",
    zh: "北极星",
  },
  "north.metric.autonomy": {
    en: "autonomy",
    zh: "自主运行",
  },
  "north.metric.deliveryRate": {
    en: "delivery rate",
    zh: "交付率",
  },
  "north.metric.fixTax": {
    en: "fix tax",
    zh: "修复税",
  },
  "north.metric.attributionErrors": {
    en: "attribution errors",
    zh: "归因错误",
  },
  "north.metric_short.autonomy": {
    en: "auto",
    zh: "自主",
  },
  "north.metric_short.deliveryRate": {
    en: "delivery",
    zh: "交付",
  },
  "north.metric_short.fixTax": {
    en: "fix",
    zh: "修复",
  },
  "north.metric_short.attributionErrors": {
    en: "attr",
    zh: "归因",
  },
  "north.no_data": {
    en: "no data",
    zh: "暂无数据",
  },
  "north.reason.no_history": {
    en: "no history",
    zh: "暂无历史",
  },
  "north.reason.no_product_deliveries": {
    en: "no product deliveries",
    zh: "暂无产品交付",
  },
  "north.reason.unknown": {
    en: "unknown reason",
    zh: "原因未知",
  },
  "north.trend.up": {
    en: "↑",
    zh: "↑",
  },
  "north.trend.down": {
    en: "↓",
    zh: "↓",
  },
  "north.trend.flat": {
    en: "→",
    zh: "→",
  },
  "north.status.met": {
    en: "met",
    zh: "达标",
  },
  "north.status.near": {
    en: "near",
    zh: "接近",
  },
  "north.status.miss": {
    en: "miss",
    zh: "未达标",
  },

  // `supervisor.journal.*` — structured supervisor narrative stream (US-OBS-048).
  "supervisor.journal.title": {
    en: "Supervisor journal",
    zh: "督导日志",
  },
  "supervisor.journal.empty": {
    en: "no journal entries",
    zh: "暂无日志条目",
  },
  "supervisor.journal.summary": {
    en: "journal: %d entries",
    zh: "督导日志：%d 条",
  },
  "supervisor.journal.latest": {
    en: "latest: %s by %s · %s",
    zh: "最新：%s · 操作者 %s · %s",
  },
  "supervisor.journal.header": {
    en: "Time · Actor · Action · Story · Note",
    zh: "时间 · 操作者 · 动作 · 卡片 · 备注",
  },
  "supervisor.journal.recorded": {
    en: "Recorded supervisor journal entry %s",
    zh: "已记录督导日志条目 %s",
  },
  "supervisor.journal.invalid_action": {
    en: "Invalid action '%s'. Use: decide, verify, rescue, escalate, note",
    zh: "无效动作 '%s'。可用：decide、verify、rescue、escalate、note",
  },
  "supervisor.journal.missing_action": {
    en: "--action is required",
    zh: "需要提供 --action",
  },
  "supervisor.journal.usage": {
    en: "Usage: roll supervisor journal [list|record] [--limit N] [--story ID] [--action ACTION] [--note TEXT] [--evidence PATH] [--json]\n  list    view recent journal entries (default)\n  record  append a structured supervisor decision/verification/rescue note\n",
    zh: "用法：roll supervisor journal [list|record] [--limit N] [--story ID] [--action ACTION] [--note TEXT] [--evidence PATH] [--json]\n  list    查看近期督导日志条目（默认）\n  record  追加一条结构化督导决策/验证/救场记录\n",
  },

  // `agent.*` — v3-native agent roster compatibility messages (US-AGENT-045).
  "agent.use_removed_agent": {
    en: "'%s' is no longer supported. Use one of: claude, kimi, codex, pi, agy, reasonix, cursor",
    zh: "'%s' 已不再支持。请使用：claude, kimi, codex, pi, agy, reasonix, cursor",
  },
  "agent.usage": {
    en: "Usage: roll agent [--workspace <id|path>|migrate [--dry-run]|list|readiness|cast]\n  Inspect machine Agent Scope, readiness and role casting; --workspace resolves one read-only Workspace casting trace.\n",
    zh: "用法：roll agent [--workspace <ID|路径>|migrate [--dry-run]|list|readiness|cast]\n  查看机器 Agent Scope、就绪状态与角色分工；--workspace 只读解析一个工作区的 casting trace。\n",
  },

  // `agent.*` — v4 default-agent vs project route-profile separation (US-V4-002).
  "agent.default_usage": {
    en: "`roll agent default` is retired. Use `roll agent migrate --dry-run`, then author `supervise` in ~/.roll/agents.yaml.",
    zh: "`roll agent default` 已退役。先用 `roll agent migrate --dry-run`，再在 ~/.roll/agents.yaml 中维护 `supervise`。",
  },
  "agent.default_current": {
    en: "Machine default agent: %s",
    zh: "机器默认 agent：%s",
  },
  "agent.default_none": {
    en: "No machine default agent set yet (falls back to the first installed agent)",
    zh: "尚未设置机器默认 agent（回退到首个已安装的 agent）",
  },
  "agent.default_unknown_agent": {
    en: "Unknown agent '%s'. Use one of: claude, kimi, codex, pi, agy, reasonix, cursor",
    zh: "未知 agent '%s'。可用：claude, kimi, codex, pi, agy, reasonix, cursor",
  },
  "agent.default_saved": {
    en: "Machine default agent set to %s",
    zh: "机器默认 agent 已设为 %s",
  },
  "agent.default_routes_followed": {
    en: "Project routes that followed the old default were updated to %s",
    zh: "原先跟随旧默认的项目路由已更新为 %s",
  },
  "agent.default_routes_preserved": {
    en: "Customized project routes in .roll/agents.yaml were preserved",
    zh: "已保留 .roll/agents.yaml 中自定义的项目路由",
  },
  "agent.use_retired": {
    en: "This legacy agent command is retired. Use `roll agent migrate --dry-run`, then author roles in ~/.roll/agents.yaml or .roll/agents.yaml.",
    zh: "这个 legacy agent 命令已退役。先用 `roll agent migrate --dry-run`，再在 ~/.roll/agents.yaml 或 .roll/agents.yaml 中维护角色绑定。",
  },
  "agent.view_default_label": {
    en: "Default agent (~/.roll/config.yaml)",
    zh: "默认 agent（~/.roll/config.yaml）",
  },
  "agent.view_routes_label": {
    en: "Project routes (.roll/agents.yaml)",
    zh: "项目路由（.roll/agents.yaml）",
  },

  // `ideav3.*` — the live `roll idea` capture command (US-PORT-003). Both en and
  // zh are always present so the single-language contract (output follows
  // ROLL_LANG, never mixes) holds.
  "ideav3.recorded": {
    en: "Recorded as %s",
    zh: "已记录为 %s",
  },
  "ideav3.type": {
    en: "Type",
    zh: "类型",
  },
  "ideav3.section": {
    en: "Section",
    zh: "分区",
  },
  "ideav3.text": {
    en: "Text",
    zh: "描述",
  },
  "ideav3.kind_bug": {
    en: "bug",
    zh: "缺陷",
  },
  "ideav3.kind_idea": {
    en: "idea",
    zh: "想法",
  },
  "ideav3.usage": {
    en: "Usage: roll idea <description>",
    zh: "用法：roll idea <描述>",
  },
  "ideav3.empty": {
    en: "Provide a short description to capture",
    zh: "请提供一句简短描述以记录",
  },
  "ideav3.lint_failed": {
    en: "Description fails backlog lint (%s) — not recorded",
    zh: "描述未过待办校验（%s）— 未记录",
  },
  "ideav3.lint_hint": {
    en: "Shorten to one plain sentence: ≤120 chars, no code, paths, filenames, or function names",
    zh: "精简为一句人话：≤120 字，不含代码、路径、文件名或函数名",
  },
  "ideav3.conflict": {
    en: "Backlog changed on disk — re-run to capture",
    zh: "待办文件已变更 — 请重试以记录",
  },

  // `releasev3.*` — the read-only release-guidance command (US-PORT-004). `roll
  // release` computes the next calver version, surfaces changelog readiness, and
  // prints the PR/tag flow; it NEVER pushes a tag or publishes (release is always
  // a human decision). Both en and zh present so the single-language contract
  // (output follows ROLL_LANG, never mixes) holds.
  "releasev3.usage": {
    en: "Usage: roll release [--dry-run|--yes|--showcase|--json] | roll release verify <version> [--no-latest]\n  The ONE release flow: bump → changelog fold → package gate → commit-push → consistency gate → PR → auto-merge → tag push.\n  Drives the merge itself via GitHub auto-merge (needs \"Allow auto-merge\" on the repo); prints progress while it waits and nudges CI if it stalls.\n  The consistency gate runs BEFORE the PR — a drifting release aborts before anything merges. Stops at the tag push; the tag push creates a DRAFT GitHub Release. npm publish stays yours (2FA).\n  release verify <version>  Phase 2 (FIX-1480): after you `npm publish`, confirm npm has the version (npm is the truth source) and promote the draft GitHub Release to latest; fails loud and leaves the draft untouched if npm lacks it. --no-latest skips the dist-tags.latest check.\n  --showcase  After a successful release, run the golden-path showcase (real models; recommended, non-blocking — never fails the release).",
    zh: "用法：roll release [--dry-run|--yes|--showcase|--json] | roll release verify <版本> [--no-latest]\n  唯一发版流：版本号 → 折叠 changelog → 包闸 → 提交推送 → 一致性闸 → PR → 自动合并 → 推 tag。\n  自驱合并（GitHub auto-merge，需仓库开启 “Allow auto-merge”）；等待期间打印进度，CI 卡住时自动推一下。\n  一致性闸在开 PR 之前先跑——漂移的发版会在任何东西合并前中止。止步于推 tag；推 tag 只会创建**草稿** GitHub Release。npm publish 仍由你执行（2FA）。\n  release verify <版本>  第二阶段（FIX-1480）：你 `npm publish` 之后,核对 npm 上确有该版本（npm 是真相源）并把草稿 GitHub Release 提升为正式；npm 上没有则响亮报错、草稿原样保留。--no-latest 跳过 dist-tags.latest 检查。\n  --showcase  发版成功后跑一次黄金路径 showcase（真模型；建议、非硬卡——绝不让发版失败）。",
  },
  "releasev3.title": {
    en: "Release plan",
    zh: "发版计划",
  },
  "releasev3.current": {
    en: "Current version",
    zh: "当前版本",
  },
  "releasev3.next": {
    en: "Suggested next",
    zh: "建议下一版",
  },
  "releasev3.tag": {
    en: "Tag",
    zh: "标签",
  },
  "releasev3.changelog": {
    en: "Changelog",
    zh: "更新日志",
  },
  "releasev3.changelog_ready": {
    en: "Unreleased section has content",
    zh: "未发布区有内容",
  },
  "releasev3.changelog_empty": {
    en: "nothing under Unreleased — add entries to CHANGELOG.md before releasing",
    zh: "未发布区为空 — 发版前先把条目写进 CHANGELOG.md",
  },
  "releasev3.flow_title": {
    en: "Release flow (run these yourself — a release is always a human decision):",
    zh: "发版流程（请亲手执行 — 发版始终由人拍板）：",
  },
  "releasev3.step_bump": {
    en: "Bump package.json version to %s",
    zh: "把 package.json 版本号改为 %s",
  },
  "releasev3.step_commit": {
    en: "Commit the bump and open a PR to main",
    zh: "提交版本号变更并向 main 开 PR",
  },
  "releasev3.step_merge": {
    en: "After CI is green and the PR is merged, pull main",
    zh: "CI 通过且 PR 合并后，拉取 main",
  },
  "releasev3.step_tag": {
    en: "Tag %s and push the tag — this triggers the release workflow",
    zh: "打标签 %s 并推送 — 触发发版流水线",
  },
  "releasev3.gate_note": {
    en: "The consistency gate runs on tag push and aborts the release on any gap.",
    zh: "一致性闸在推送标签时运行，任一维度对不上即中止发版。",
  },
  "releasev3.gate_preview": {
    en: "Preview locally with: roll release --dry-run",
    zh: "本地预检：roll release --dry-run",
  },
  "releasev3.no_pkg": {
    en: "package.json version not found — run from the repo root",
    zh: "未找到 package.json 版本号 — 请在仓库根目录运行",
  },

  // `loopv3.*` — the retirement notices for the v2 tmux-popup commands
  // `loop monitor` / `loop attach` (US-PORT-007). The v3 self-contained runner
  // already streams every cycle into the tmux session roll-loop-<slug>, so the
  // old auto-refresh popup (monitor) has no object, and attaching is just a
  // plain `tmux attach`. Both en and zh present (single-language contract).
  "loopv3.monitor_retired": {
    en: "roll loop monitor is retired. Use `roll loop status` for a snapshot, or watch the live cycle: tmux attach -t roll-loop-%s",
    zh: "roll loop monitor 已退役。用 `roll loop status` 看快照，或观察实时周期：tmux attach -t roll-loop-%s",
  },
  "loopv3.attach_retired": {
    en: "roll loop attach is retired. Attach to the live cycle directly: tmux attach -t roll-loop-%s",
    zh: "roll loop attach 已退役。直接观察实时周期：tmux attach -t roll-loop-%s",
  },
  // `loop branches` (US-PORT-022): pure user-introspection (listed loop-branch
  // merge status); no internal caller, so it retires rather than port. The one
  // line that reproduced it is offered for anyone who still wants the view.
  "loopv3.branches_retired": {
    en: "roll loop branches is retired. List loop branches directly: git ls-remote --heads origin 'loop/*'",
    zh: "roll loop branches 已退役。直接列出 loop 分支：git ls-remote --heads origin 'loop/*'",
  },

  // FIX-232: doctor proxy-environment check
  "doctor.proxy_env_warning": {
    en: "Stale proxy environment variables",
    zh: "残留的代理环境变量",
  },
  "doctor.proxy_env_hint": {
    en: "Proxy variables are set but unreachable — a closed proxy app may have poisoned launchd. Clean up:",
    zh: "代理变量已设置但目标不可达 — 已关闭的代理软件可能毒化了 launchd。请清理：",
  },

  // FIX-232 AC2: loop egress pre-check messages
  "loop.egress_blocked": {
    en: "egress blocked (proxy?): network pre-check failed — cycle %s refused to start",
    zh: "出网阻断（疑似代理？）：网络预检失败 — 周期 %s 拒绝启动",
  },

  // FIX-298: shared network guard (first-checkpoint connectivity + active recovery).
  // Lines are emitted one per locale (the single-language contract) — EN and ZH
  // are kept on separate lines by the caller, never inline on one line.
  "net.recovering": {
    en: "network unreachable — running the configured proxy-enable command, then re-checking…",
    zh: "网络不可达 — 正在执行已配置的代理启用命令，然后重新检测……",
  },
  "net.recovered": {
    en: "network restored after the proxy-enable command — continuing.",
    zh: "执行代理启用命令后网络已恢复 — 继续。",
  },
  // FIX-1025: announced when the precheck is opted out via
  // `loop_safety.skip_network_check: true` (configured providers reachable directly).
  "net.skipped": {
    en: "network precheck skipped (loop_safety.skip_network_check) — assuming configured providers are reachable.",
    zh: "已跳过网络预检（loop_safety.skip_network_check）——假定所配置的服务可直接访问。",
  },
  // %s is the command name (e.g. `roll loop go`). Halt message: clear, actionable.
  // FIX-1025: the probe defaults to a foreign host; if your domestic providers are
  // reachable directly, point the probe at one (`probe_url`) or opt out
  // (`skip_network_check`) instead of forcing a proxy the work does not need.
  "net.blocked_no_hook": {
    en: "%s needs the network, but the connectivity probe failed. If your configured providers ARE reachable, point the probe at one with `loop_safety.probe_url: <host:port>` or opt out with `loop_safety.skip_network_check: true` in .roll/policy.yaml. Otherwise add `loop_safety.proxy_enable_cmd: <your proxy-on command>` (e.g. your VPN/proxy toggle), check your connection, then retry.",
    zh: "%s 需要网络，但连通性探测失败。若所配置的服务其实可达，请用 `loop_safety.probe_url: <host:port>` 把探测指向其中一个，或在 .roll/policy.yaml 中设置 `loop_safety.skip_network_check: true` 跳过预检。否则请加入 `loop_safety.proxy_enable_cmd: <你的开代理命令>`（例如你的 VPN/代理开关），检查网络后重试。",
  },
  "net.blocked_after_hook": {
    en: "%s needs the network, but the probe STILL failed after running the configured proxy-enable command. Check that the command actually turns on connectivity, or point `loop_safety.probe_url` at a host you do need, then retry.",
    zh: "%s 需要网络，但执行已配置的代理启用命令后探测仍失败。请确认该命令确实能打开网络，或将 `loop_safety.probe_url` 指向你确实需要的主机后重试。",
  },

  // FIX-394 — chromium headless browser messages
  "fix394.chromium_unavailable": {
    en: "headless Chromium unavailable",
    zh: "无头 Chromium 不可用",
  },
  "fix394.chromium_offline_hint": {
    en: "offline or network error — chromium download may have failed",
    zh: "离线或网络错误 — Chromium 下载可能失败",
  },
  "fix394.web_evidence_skipped": {
    en: "web evidence skipped",
    zh: "网页证据已跳过",
  },
  "fix394.chromium_fix_hint": {
    en: "run `roll init` or `npx playwright install chromium` after connecting to the network to enable web screenshots",
    zh: "联网后运行 `roll init` 或 `npx playwright install chromium` 以启用网页截图",
  },
  "fix394.browser_tool_degraded": {
    en: "browser tool unavailable — headless Chromium not installed",
    zh: "浏览器工具不可用 — 无头 Chromium 未安装",
  },

  // `onboard.*` — design handoff nudge (US-ONBOARD-NUDGE-001).
  // %s is $roll-design (baseline); `roll design` command phrasing to be
  // added by US-ONBOARD-NUDGE-005 after US-ONBOARD-NUDGE-004 ships.
  "onboard.design_nudge": {
    en: "Run %s — Found requirement docs but an empty backlog. Turn them into a domain model + INVEST backlog, then roll loop.",
    zh: "运行 %s — 检测到需求文档但待办为空。将其转化为领域模型 + INVEST 待办列表，然后 roll loop。",
  },

  // `design.*` — explicit `roll design` entry point (US-ONBOARD-NUDGE-004 / FIX-1055).
  // Thin wrapper that launches the existing $roll-design skill interactively.
  "design.usage": {
    en: "Usage: roll design [--from-file <path> | \"<requirement>\"] [--agent <name>] [--verbose|--raw]\n  Launch the $roll-design skill in an interactive agent conversation.\n  Default output streams bounded live progress, card-created events, quiet heartbeats, and the final handoff while preserving the raw transcript.\n  When a successful design creates new Todo cards, roll prints agent-pool health and asks whether to start `roll loop go --review auto`.\n  `--from-file` binds a PRD/brief file as the design input.\n  `\"<requirement>\"` binds a free-text design target; it cannot be combined with `--from-file`.\n  `--agent` and `ROLL_DESIGN_AGENT` override only this design session; scoped roles live in ~/.roll/agents.yaml and .roll/agents.yaml.\n  `--verbose` streams lower-priority normalized activity; `--raw` streams the raw child output live.\n  Unlike `roll init`, this command runs an LLM — run it only when you want to design.",
    zh: "用法：roll design [--from-file <path> | \"<requirement>\"] [--agent <name>] [--verbose|--raw]\n  在交互式 agent 对话中启动 $roll-design skill。\n  默认输出会实时显示有界进展、建卡事件、静默心跳和最终交付，同时保留完整原始记录。\n  当成功设计产出新的 Todo 卡时，roll 会打印 agent 池健康概况，并询问是否启动 `roll loop go --review auto`。\n  `--from-file` 会把 PRD/brief 文件绑定为设计输入。\n  `\"<requirement>\"` 会绑定自由文本设计目标；不能与 `--from-file` 混用。\n  `--agent` 与 `ROLL_DESIGN_AGENT` 只覆盖本次 design session；scoped roles 位于 ~/.roll/agents.yaml 和 .roll/agents.yaml。\n  `--verbose` 实时显示较低优先级的规范化活动；`--raw` 实时输出子进程原始流。\n  与 `roll init` 不同，本命令会运行 LLM——只在需要设计时执行。",
  },
  "design.not_roll_project": {
    en: "This directory is not a Roll project (no .roll/). Run `roll init` first.",
    zh: "当前目录不是 Roll 项目（缺少 .roll/）。请先运行 `roll init`。",
  },
  "design.skill_missing": {
    en: "Skill file missing: skills/roll-design/SKILL.md. Run `roll setup` or initialise the skills submodule.",
    zh: "skill 文件缺失：skills/roll-design/SKILL.md。请运行 `roll setup` 或初始化 skills submodule。",
  },
  "design.no_agent": {
    en: "No AI agent detected. Install one (e.g., claude, kimi, pi) and try again.",
    zh: "未检测到 AI agent。请安装一个（如 claude、kimi、pi）后重试。",
  },
  "design.unknown_agent": {
    en: "Agent '%s' is unknown or not installed.",
    zh: "agent '%s' 未知或未安装。",
  },
  "design.from_file_missing": {
    en: "`--from-file` requires a path.",
    zh: "`--from-file` 需要一个文件路径。",
  },
  "design.from_file_not_found": {
    en: "Design source file not found: %s",
    zh: "未找到设计输入文件：%s",
  },
  "design.bare_backlog_help": {
    en: "No design target given. This project already has a backlog with work items.\n  Provide a target to scope the design session:\n    roll design --from-file <path>    — design from a PRD/brief/requirement file\n    roll design \"<requirement>\"       — one-shot design from a free-text requirement\n    roll supervisor next              — pick the next item from the backlog\n    roll loop go --cards <id>         — dispatch a backlog card directly\n  Run `roll design --help` for full usage.",
    zh: "未指定设计目标。该项目已有待办事项。\n  请指定目标以限定设计范围：\n    roll design --from-file <path>    — 从 PRD/brief/需求文件开始设计\n    roll design \"<requirement>\"       — 从自由文本需求开始一次性设计\n    roll supervisor next              — 从待办中选择下一项\n    roll loop go --cards <id>         — 直接分派待办卡\n  执行 `roll design --help` 查看完整用法。",
  },

  // FIX-1055: bounded progress view + final artifact handoff.
  "design.run_started": { en: "Design run started", zh: "设计运行开始" },
  "design.target": { en: "target: %s", zh: "目标：%s" },
  "design.target_from_file": { en: "target: from-file %s", zh: "目标：from-file %s" },
  "design.target_none": { en: "target: none", zh: "目标：无" },
  "design.target_none_label": { en: "none", zh: "无" },
  "design.mode_design_only": { en: "mode: design-only", zh: "模式：design-only" },
  "design.mode_from_file": { en: "mode: from-file · %s", zh: "模式：from-file · %s" },
  "design.mode_design_only_idea": {
    en: "mode: design-only · IDEA cards require owner sign-off before story split",
    zh: "模式：design-only · IDEA 卡片在拆分为实现卡前需要负责人签批",
  },
  "design.agent": { en: "agent: %s", zh: "agent：%s" },
  "design.raw_transcript": { en: "raw transcript: %s", zh: "原始记录：%s" },
  "design.handoff": { en: "Design Review Page handoff", zh: "Design Review Page 交付" },
  "design.status_label": { en: "status: %s", zh: "状态：%s" },
  "design.design_label": { en: "design: %s", zh: "设计产物：%s" },
  "design.review_page_label": { en: "Design Review Page: %s", zh: "Design Review Page：%s" },
  "design.html_label": { en: "Design Review Page: %s", zh: "Design Review Page：%s" },
  "design.cards_label": { en: "cards: %d", zh: "卡片数：%d" },
  "design.why_label": { en: "why: %s", zh: "原因：%s" },
  "design.next_label": { en: "next: %s", zh: "下一步：%s" },
  "design.transcript_label": { en: "transcript: %s", zh: "记录：%s" },
  "design.empty_transcript": { en: "transcript is empty", zh: "记录为空" },
  "design.status.awaiting_signoff": { en: "awaiting owner sign-off", zh: "等待负责人签批" },
  "design.status.cards_created": { en: "%d card(s) created", zh: "已创建 %d 张卡片" },
  "design.status.no_cards": { en: "no cards created", zh: "未创建卡片" },
  "design.status.agent_failed": { en: "agent exited with code %s", zh: "agent 退出码 %s" },
  "design.why.idea_signoff": {
    en: "IDEA cards require owner sign-off before story split",
    zh: "IDEA 卡片在拆分前需要负责人签批",
  },
  "design.next.cards_created": {
    en: "review the created cards and run `roll loop go --cards <id>` to dispatch them",
    zh: "审阅已创建的卡片并运行 `roll loop go --cards <id>` 进行分派",
  },
  "design.next.review_and_split": {
    en: "open the Design Review Page, then ask `roll design` to split %s into implementation cards",
    zh: "打开 Design Review Page 审阅，然后让 `roll design` 把 %s 拆成实现卡",
  },
  "design.next.no_cards": {
    en: "scope is design-only; no implementation cards were created for %s",
    zh: "本次为纯设计；未为 %s 创建实现卡",
  },
  "design.loop.agent_pool": {
    en: "Agent pool: %d active, %d suspended",
    zh: "Agent 池：%d 个可用，%d 个已挂起",
  },
  "design.loop.suspended_agent": {
    en: "suspended: %s (%s)",
    zh: "已挂起：%s（%s）",
  },
  "design.loop.prompt": {
    en: "Start loop now? [y/N]",
    zh: "现在启动 loop 吗？[y/N]",
  },
  "design.loop.manual_next": {
    en: "Next: roll loop go --review auto",
    zh: "下一步：roll loop go --review auto",
  },

  // `setup.*` — legacy setup agent selection (compatibility only).
  "setup.primary_prompt": {
    en: "Multiple AI agents detected. Pick the initial supervise role:",
    zh: "检测到多个 AI agent，请选择初始 supervise 角色：",
  },
  "setup.primary_auto_set": {
    en: "Only %s is installed — recorded as the initial supervise agent.",
    zh: "仅安装了 %s — 已记录为初始 supervise agent。",
  },
  "setup.primary_no_agents": {
    en: "No AI agents installed. Install one (e.g., claude, kimi, pi), then run `roll agent migrate --dry-run` or author ~/.roll/agents.yaml.",
    zh: "未安装 AI agent。请先安装一个（如 claude、kimi、pi），再运行 `roll agent migrate --dry-run` 或维护 ~/.roll/agents.yaml。",
  },
  "setup.primary_reselect": {
    en: "--reselect: pick a new initial supervise agent.",
    zh: "--reselect：重新选择初始 supervise agent。",
  },
  "setup.primary_set": {
    en: "Initial supervise agent recorded as %s.",
    zh: "初始 supervise agent 已记录为 %s。",
  },

  // FIX-1021: `roll init` summary / confirmation
  "init.detected_project_type": {
    en: "Detected project type: %s",
    zh: "检测到项目类型：%s",
  },
  "init.will_scaffold": {
    en: "Roll will scaffold AGENTS.md, .roll/backlog.md, .roll/features/, scoped agent-ready .roll/, and .claude/CLAUDE.md.",
    zh: "Roll 将在此目录生成 AGENTS.md、.roll/backlog.md、.roll/features/、可承载 scoped agent 配置的 .roll/ 与 .claude/CLAUDE.md。",
  },
  "init.proceed_prompt": {
    en: "Proceed?",
    zh: "继续？",
  },
  "init.cancelled": {
    en: "Init cancelled. Run `roll init` again when ready.",
    zh: "初始化已取消。准备就绪后重新运行 `roll init`。",
  },
  "init.auto_non_interactive": {
    en: "Non-interactive mode — proceeding automatically. Use `roll init --auto` to suppress this notice.",
    zh: "非交互模式 — 自动继续。可使用 `roll init --auto` 跳过此提示。",
  },
  "init.onboard_plan_facts_hash_unreadable": {
    en: "could not read factsHash from .roll/onboard-plan.yaml",
    zh: "无法读取 .roll/onboard-plan.yaml 中的 factsHash",
  },
  "init.onboard_plan_facts_hash_stale": {
    en: "plan factsHash is stale: expected %s, got %s",
    zh: "plan factsHash 已过期：当前应为 %s，plan 中为 %s",
  },
  "init.onboard_regenerate_before_apply": {
    en: "Regenerate the plan by running $roll-onboard again before applying.",
    zh: "应用前请重新运行 $roll-onboard 生成 plan。",
  },
  "init.onboard_plan_validated_review": {
    en: "Onboard plan validated. Review .roll/init-diagnosis.yaml and .roll/onboard-plan.yaml before applying.",
    zh: "接入方案已通过校验。应用前请审阅 .roll/init-diagnosis.yaml 和 .roll/onboard-plan.yaml。",
  },
  "init.onboard_apply_review_title": {
    en: "Onboard apply review checkpoint",
    zh: "应用接入方案审阅检查点",
  },
  "init.onboard_apply_review_action": {
    en: "action",
    zh: "动作",
  },
  "init.onboard_apply_review_target": {
    en: "target",
    zh: "路径",
  },
  "init.onboard_apply_review_mode": {
    en: "mode",
    zh: "模式",
  },
  "init.onboard_apply_review_owner_content": {
    en: "owner content",
    zh: "用户内容",
  },
  "init.onboard_apply_review_action_append": {
    en: "append",
    zh: "追加",
  },
  "init.onboard_apply_review_action_create": {
    en: "create",
    zh: "创建",
  },
  "init.onboard_apply_review_action_keep": {
    en: "keep",
    zh: "保留",
  },
  "init.onboard_apply_review_action_merge": {
    en: "merge",
    zh: "合并",
  },
  "init.onboard_apply_review_action_replace": {
    en: "replace",
    zh: "替换",
  },
  "init.onboard_apply_review_mode_append_line": {
    en: "append-line",
    zh: "追加行",
  },
  "init.onboard_apply_review_mode_create_if_missing": {
    en: "create-if-missing",
    zh: "缺失时创建",
  },
  "init.onboard_apply_review_mode_ensure_directory": {
    en: "ensure-directory",
    zh: "确保目录",
  },
  "init.onboard_apply_review_mode_replace": {
    en: "replace",
    zh: "替换",
  },
  "init.onboard_apply_review_mode_section_merge": {
    en: "section-merge",
    zh: "章节合并",
  },
  "init.onboard_apply_review_owner_not_present": {
    en: "not present",
    zh: "不存在",
  },
  "init.onboard_apply_review_owner_preserved": {
    en: "preserved",
    zh: "保留",
  },
  "init.onboard_apply_review_owner_replaced": {
    en: "replaced",
    zh: "会替换",
  },
  "init.onboard_apply_review_owner_roll_owned": {
    en: "roll-owned",
    zh: "Roll 管理",
  },
  "init.onboard_apply_review_sync_note": {
    en: "After confirmation, Roll also syncs conventions to the configured AI tools and registers this project.",
    zh: "确认后，Roll 还会把约定同步到已配置的 AI 工具，并登记这个项目。",
  },
  "init.onboard_apply_auto_required": {
    en: "Non-interactive apply requires explicit review acknowledgement:",
    zh: "非交互应用需要显式确认已审阅：",
  },
  "init.onboard_apply_confirm_prompt": {
    en: "Proceed with these changes?",
    zh: "确认执行这些变更？",
  },
  "init.onboard_apply_failed": {
    en: "Onboard apply failed before completion.",
    zh: "onboard 应用未完成即失败。",
  },
  "init.onboard_apply_recovery": {
    en: "Recovery metadata: .roll/onboard-changeset.yaml if present. Inspect it, then run roll offboard --confirm to reverse Roll-owned artifacts.",
    zh: "恢复元数据：如存在请检查 .roll/onboard-changeset.yaml，然后运行 roll offboard --confirm 回滚 Roll 管理的产物。",
  },
  "init.no_files_changed": {
    en: "No files changed.",
    zh: "未修改任何文件。",
  },

  // FIX-1020: new-project workflow — repo-first next steps
  "init.next_create_repo": {
    en: "Create a GitHub repo and push the initial commit",
    zh: "创建 GitHub 仓库并推送初始提交",
  },
  "init.next_push_commands": {
    en: "gh repo create <name> --public --source=. --push (or `git remote add origin ... && git push -u origin main`)",
    zh: "gh repo create <name> --public --source=. --push（或 `git remote add origin ... && git push -u origin main`）",
  },
  "init.next_loop_on": {
    en: "Enable the loop schedule",
    zh: "启用 loop 定时任务",
  },
  "init.next_repo_required": {
    en: "`roll loop` needs a pushable GitHub remote — create the repo first.",
    zh: "`roll loop` 需要一个可推送的 GitHub remote — 请先创建仓库。",
  },

  // FIX-1019 / FIX-1020: loop repo pushability precheck + pause gate
  "loop.paused_marker_present": {
    en: "loop is paused (PAUSE marker present) — skipping this tick. Run `roll loop resume` when ready.",
    zh: "loop 已暂停（存在 PAUSE 标记）— 跳过本次触发。准备就绪后运行 `roll loop resume`。",
  },
  "loop.repo_unreachable": {
    en: "GitHub repo unreachable — `git ls-remote origin` failed. Create the remote repo and push before running the loop.",
    zh: "GitHub 仓库不可达 — `git ls-remote origin` 失败。请先创建远程仓库并推送，再运行 loop。",
  },
  "loop.no_remote": {
    en: "No git remote configured — `roll loop` needs a pushable GitHub remote. Add one with `git remote add origin ...`",
    zh: "未配置 git remote — `roll loop` 需要一个可推送的 GitHub remote。请用 `git remote add origin ...` 添加。",
  },
  "loop.not_a_git_repo": {
    en: "Not a git repository — `roll loop` needs a git repo with a pushable GitHub remote.",
    zh: "不是 git 仓库 — `roll loop` 需要一个带有可推送 GitHub remote 的 git 仓库。",
  },
  "loop.sched.mount_failed": {
    en: "loop on: %d launchd job(s) failed to mount after retry — scheduling is not active",
    zh: "loop on: 重试后仍有 %d 个 launchd 任务挂载失败 — 排程未生效",
  },
  "loop.sched.domain": {
    en: "domain",
    zh: "域",
  },
  "loop.sched.label": {
    en: "label",
    zh: "标签",
  },
  "loop.sched.cause": {
    en: "cause",
    zh: "原因",
  },
  "loop.sched.retry_exhausted": {
    en: "job was not armed after bootout and bootstrap were retried",
    zh: "bootout 与 bootstrap 重试后任务仍未激活",
  },
  "loop.sched.inspect": {
    en: "Inspect and retry these exact commands:",
    zh: "请执行以下命令排查并重试:",
  },
  "loop.sched.retry": {
    en: "After correcting the reported path or launchd state, run `roll loop on` again.",
    zh: "修正上述路径或 launchd 状态后,再次运行 `roll loop on`。",
  },
  // US-LOOP-108: launchd failure ends unarmed and names the owner-confirmed
  // process fallback WITHOUT starting it automatically.
  "loop.sched.unarmed": {
    en: "scheduler: unarmed — no autonomous work will run",
    zh: "排程:未激活 — 不会运行任何自主任务",
  },
  "loop.sched.fallback_hint": {
    en: "Or, if launchd cannot be repaired, start an owner-confirmed process fallback (NOT a launchd replacement across reboot/login):",
    zh: "或者,若 launchd 无法修复,启动一个 owner 明示确认的进程 fallback(重启/登出后不等价于 launchd):",
  },

  // FIX-1042: agent skill-root pollution (auxiliary dirs mounted as skills)
  "doctor.skill_root_pollution": {
    en: "Polluted agent skill roots (auxiliary directories mounted as skills)",
    zh: "受污染的 agent skill 根目录（辅助目录被当作 skill 挂载）",
  },
  "doctor.skill_root_pollution_hint": {
    en: "These are Roll docs/reports, not skills — re-run `roll setup` to remove them so agents stop warning about missing descriptions.",
    zh: "这些是 Roll 文档/报告，不是 skill —— 重新运行 `roll setup` 即可移除，agent 将不再报告缺少 description 的警告。",
  },

  // US-PHYSICAL-003: Roll Capture.app setup/doctor readiness guidance
  "setup.roll_capture_not_ready": {
    en: "Roll Capture.app is not ready; physical screenshots will honestly skip at capture time.",
    zh: "Roll Capture.app 尚未就绪，物理截图会在捕获时降级为明确跳过。",
  },
  "setup.roll_capture_install": {
    en: "Install Roll Capture.app: place it in ~/Applications or /Applications, then open it once.",
    zh: "安装 Roll Capture.app：将它放到 ~/Applications 或 /Applications，然后打开一次。",
  },
  "setup.roll_capture_permission": {
    en: "Host permission proxy: doctor checks the current terminal host only; Roll Capture.app manages its own Screen Recording permission on first capture.",
    zh: "宿主权限代理：doctor 只检查当前终端宿主；Roll Capture.app 首次捕获时会自行管理屏幕录制权限。",
  },
  "setup.roll_capture_inbox": {
    en: "inbox: %s",
    zh: "inbox：%s",
  },

  // US-LANG-002: language policy mechanical audit
  "doctor.language_audit_title": {
    en: "Language policy audit",
    zh: "语言政策审计",
  },
  "doctor.language_audit_ok": {
    en: "No mixed-language output rules found",
    zh: "未发现混排输出规则",
  },
  "doctor.language_audit_findings_count": {
    en: "policy finding(s)",
    zh: "条政策发现",
  },

  // REFACTOR-072: binary staleness surfaced in doctor (loop run-once side effect preserved)
  "doctor.binary_staleness_title": {
    en: "Loop binary version",
    zh: "Loop 程序版本",
  },
  "doctor.binary_staleness_unknown": {
    en: "No recent version check — run `roll loop run-once` to populate.",
    zh: "暂无近期版本检查记录 — 运行一次 `roll loop run-once` 后将显示。",
  },
  "doctor.binary_staleness_ok": {
    en: "running v%s, up to date (latest %s)",
    zh: "当前 v%s，已是最新 %s",
  },
  "doctor.binary_staleness_stale": {
    en: "running v%s, latest %s — run `roll update`",
    zh: "当前 v%s，最新 %s — 建议运行 `roll update`",
  },

  // FIX-1453 — `roll capture` i18n (was hardcoded English, dual-line mixed).

  "capture.usage": {
    en: "Usage: roll capture <status|migrate|repair|local-window> [--workspace <id|path>]\n  status  [--json]                 gateway/renderer readiness + effective capture policy\n  migrate [--revert] [--dry-run] [--json]  enable best_effort when capabilities are ready; reversible\n  repair  <story-id> [--health <path>] [--json]  evidence-only repair; never reopens the build\n  local-window --story <ID> --url <loopback-url> [--prepare <json>] [--run <id>] [--json]  isolated local synthetic page only\n",
    zh: "用法：roll capture <status|migrate|repair|local-window> [--workspace <ID|路径>]\n  status  [--json]                 网关/渲染器就绪度 + 有效截图策略\n  migrate [--revert] [--dry-run] [--json]  能力就绪时启用 best_effort（可回退）\n  repair  <story-id> [--health <path>] [--json]  仅证据修复；绝不重新打开构建\n  local-window --story <ID> --url <loopback-url> [--prepare <json>] [--run <id>] [--json]  仅捕获隔离的本地合成页面\n",
  },
  "capture.unknown_subcommand": {
    en: "[roll] unknown 'roll capture' subcommand: %s",
    zh: "[roll] 未知 'roll capture' 子命令：%s",
  },

  // local-window
  "capture.refresh.wrote": {
    en: "capture refresh: wrote host capabilities to %s",
    zh: "capture refresh：已将主机能力写入 %s",
  },
  "capture.local_window.usage": {
    en: "Usage: roll capture local-window --story <ID> --url <loopback-url> [--run <id>] [--workspace <id|path>] [--json]",
    zh: "用法：roll capture local-window --story <ID> --url <loopback-url> [--run <id>] [--workspace <ID|路径>] [--json]",
  },
  "capture.local_window.unsafe_id": {
    en: "local-window requires safe story and run identifiers (letters, digits, dot, underscore, hyphen only).",
    zh: "local-window 需要安全的 story 与 run 标识符（仅字母、数字、点、下划线、连字符）。",
  },
  "capture.local_window.loopback_only": {
    en: "local-window only permits loopback HTTP(S) pages; no owner Chrome or remote URL was opened.",
    zh: "local-window 仅允许 loopback HTTP(S) 页面；不会打开用户的 Chrome 或远程 URL。",
  },
  "capture.local_window.result": {
    en: "local-window capture: %s",
    zh: "local-window 截图：%s",
  },
  "capture.local_window.no_extension": {
    en: "  browser extension: not used",
    zh: "  浏览器扩展：未使用",
  },
  "capture.local_window.privacy": {
    en: "  privacy: loopback-only synthetic target in a temporary profile",
    zh: "  隐私：仅在临时 profile 中捕获 loopback 合成页面",
  },
  "capture.local_window.selector": {
    en: "  selector: %s · %s",
    zh: "  选择器：%s · %s",
  },
  "capture.local_window.screenshot": {
    en: "  screenshot: %s",
    zh: "  截图：%s",
  },
  "capture.local_window.receipt": {
    en: "  receipt: %s",
    zh: "  回执：%s",
  },
  "capture.local_window.reason": {
    en: "  reason: %s",
    zh: "  原因：%s",
  },
  "capture.local_window.prepare_must_be_list": {
    en: "prepare must be a JSON action list",
    zh: "prepare 必须是 JSON action 列表",
  },
  "capture.local_window.prepare_max_actions": {
    en: "prepare allows at most 16 actions",
    zh: "prepare 最多允许 16 个 action",
  },
  "capture.local_window.prepare_action_object": {
    en: "prepare action must be an object",
    zh: "prepare action 必须是对象",
  },
  "capture.local_window.prepare_wait_ms": {
    en: "prepare wait requires only kind and an integer ms from 0 to 5000",
    zh: "prepare wait 只需 kind 和 0-5000 之间的整数 ms",
  },
  "capture.local_window.prepare_waits_max": {
    en: "prepare waits may total at most 15000ms",
    zh: "prepare wait 总计不能超过 15000ms",
  },
  "capture.local_window.prepare_selector_required": {
    en: "prepare %s requires only kind and a non-empty selector",
    zh: "prepare %s 只需 kind 和非空选择器",
  },
  "capture.local_window.prepare_fill_required": {
    en: "prepare fill requires only kind, a non-empty selector, and a value of at most 1000 characters",
    zh: "prepare fill 只需 kind、非空选择器和不超过 1000 字符的 value",
  },
  "capture.local_window.prepare_only_permits": {
    en: "prepare only permits click, fill, wait, and scroll actions",
    zh: "prepare 只允许 click、fill、wait、scroll 四种 action",
  },

  // migrate
  "capture.migrate.revert": {
    en: "capture migrate --revert: %s",
    zh: "capture migrate --revert：%s",
  },
  "capture.migrate.result": {
    en: "capture migrate: %s (%s)",
    zh: "capture migrate：%s（%s）",
  },
  "capture.migrate.detail": {
    en: "  %s",
    zh: "  %s",
  },
  "capture.dry_run_not_written": {
    en: " (dry-run; not written)",
    zh: "（dry-run；未写入）",
  },
  "capture.written": {
    en: " (written)",
    zh: "（已写入）",
  },
  "capture.no_change": {
    en: " (no change)",
    zh: "（无变更）",
  },

  // repair
  "capture.repair.usage": {
    en: "Usage: roll capture repair <story-id> [--workspace <id|path>] [--health <path>] [--json]",
    zh: "用法：roll capture repair <story-id> [--workspace <ID|路径>] [--health <path>] [--json]",
  },
  "capture.repair.no_record": {
    en: "no evidence-health record at %s; nothing to repair",
    zh: "%s 没有 evidence-health 记录；无需修复",
  },
  "capture.repair.failed_delivery": {
    en: "delivery failed: normal failure handling, not an evidence repair; build not reopened",
    zh: "交付失败：走正常失败处理，不属证据修复；构建不会重新打开",
  },
  "capture.repair.not_degraded": {
    en: "visual state is \"%s\", not degraded-infrastructure; not evidence-only repairable; build not reopened",
    zh: "visual 状态为 \"%s\"，不是 degraded-infrastructure；不可做仅证据修复；构建不会重新打开",
  },
  "capture.repair.result": {
    en: "capture repair: %s",
    zh: "capture repair：%s",
  },
  "capture.repair.reopened": {
    en: "  reopenedBuild=%s buildUntouched=%s",
    zh: "  reopenedBuild=%s buildUntouched=%s",
  },
  "capture.repair.visual": {
    en: "  visual: %s -> %s",
    zh: "  visual：%s -> %s",
  },

  // capture-policy readiness (shared by `roll capture status` + `roll doctor`)
  "capture.readiness.title": {
    en: "Capture policy readiness",
    zh: "截图策略就绪度",
  },
  "capture.readiness.gateway_ready": {
    en: "  %s v2 capture gateway — ready",
    zh: "  %s v2 capture gateway — 就绪",
  },
  "capture.readiness.gateway_unavailable": {
    en: "  %s v2 capture gateway — unavailable",
    zh: "  %s v2 capture gateway — 不可用",
  },
  "capture.readiness.renderer_ready": {
    en: "  %s browser renderer — ready",
    zh: "  %s browser renderer — 就绪",
  },
  "capture.readiness.renderer_unavailable": {
    en: "  %s browser renderer — unavailable",
    zh: "  %s browser renderer — 不可用",
  },
  "capture.readiness.policy": {
    en: "  · effective capture policy — %s",
    zh: "  · 有效截图策略 — %s",
  },
  "capture.readiness.migration": {
    en: "  · next migration — %s (%s)",
    zh: "  · 下次迁移 — %s（%s）",
  },

  // US-DELTA-003 — protocol-only `roll delta` CLI
  "delta.help.usage": {
    en: "Usage: roll delta <prepare|validate|conclude|status|help>\n\n  Host-guided delegation lifecycle commands (protocol-only; no agent spawning).\n\n  roll delta prepare <story-id> --trigger host-guided|loop-autonomous --topology solo|delta-team|full-delta-team --profile standard|verified|designed --preset <id> --resolution <path> [--json]\n    Atomically claim a delegation frame and host-delegation lease.\n\n  roll delta validate --delegation <id> --stage designer|builder|evaluator|peer [--json]\n    Validate a role-stage submission through the protocol-validator boundary.\n\n  roll delta conclude --delegation <id> --delivery-disposition owner_continue|owner_hold|owner_redelegate [--json]\n    Record owner-approved terminal binding (Option C: handoff_ready/handoff_only).\n\n  roll delta status [--story <id>|--delegation <id>] [--json]\n    Read-only delegation status projection from event truth.\n\n  roll delta help\n    Print this help.\n",
    zh: "用法：roll delta <prepare|validate|conclude|status|help>\n\n  宿主导引的委派生命周期命令（仅协议层；不启任何 agent）。\n\n  roll delta prepare <story-id> --trigger host-guided|loop-autonomous --topology solo|delta-team|full-delta-team --profile standard|verified|designed --preset <id> --resolution <path> [--json]\n    原子化申领委派帧与 host-delegation 租约。\n\n  roll delta validate --delegation <id> --stage designer|builder|evaluator|peer [--json]\n    经过协议校验边界验证角色阶段提交。\n\n  roll delta conclude --delegation <id> --delivery-disposition owner_continue|owner_hold|owner_redelegate [--json]\n    记录 owner 批准的终止绑定（Option C：handoff_ready/handoff_only）。\n\n  roll delta status [--story <id>|--delegation <id>] [--json]\n    从事件真相只读投影委派状态。\n\n  roll delta help\n    打印此帮助。\n",
  },
  "delta.error.unknown_subcommand": {
    en: "roll delta: unknown subcommand '%s'. Try: prepare, validate, conclude, status, help",
    zh: "roll delta：未知子命令 '%s'。可用：prepare、validate、conclude、status、help",
  },
  "delta.error.missing_story": {
    en: "roll delta: <story-id> is required",
    zh: "roll delta：需要提供 <story-id>",
  },
  "delta.error.duplicate_flag": {
    en: "roll delta: duplicate flag '%s'",
    zh: "roll delta：重复标志 '%s'",
  },
  "delta.error.unexpected_positional": {
    en: "roll delta: unexpected positional argument '%s'",
    zh: "roll delta：非预期的位置参数 '%s'",
  },
  "delta.error.unknown_flag": {
    en: "roll delta: unknown flag '%s'",
    zh: "roll delta：未知标志 '%s'",
  },
  "delta.error.missing_required": {
    en: "roll delta: missing required flag '%s'",
    zh: "roll delta：缺少必需标志 '%s'",
  },
  "delta.error.missing_value": {
    en: "roll delta: missing value for '%s'",
    zh: "roll delta：'%s' 缺少值",
  },
  "delta.error.invalid_value": {
    en: "roll delta: invalid value '%s' for '%s'. Expected: %s",
    zh: "roll delta：值 '%s' 对 '%s' 无效。应为：%s",
  },
  "delta.error.cycle_rejected": {
    en: "roll delta: --cycle is not supported for host-guided prepare (no cycle allocation)",
    zh: "roll delta：host-guided prepare 不支持 --cycle（无 cycle 分配）",
  },
  "delta.error.status_selector": {
    en: "roll delta status: provide --story <id> or --delegation <id>",
    zh: "roll delta status：请提供 --story <id> 或 --delegation <id>",
  },
  "delta.status.orphan_header": {
    en: "Uncommitted frames:",
    zh: "未提交帧：",
  },
  "delta.status.orphan_status": {
    en: "unknown: uncommitted_delegation_frame",
    zh: "unknown: 未提交委派帧",
  },
  "delta.status.orphan_recovery": {
    en: "release the host-delegation lease then re-prepare or remove the orphan frame",
    zh: "释放 host-delegation 租约后重新 prepare，或清理孤立帧",
  },
  "delta.status.no_delegation": {
    en: "No delegation found.",
    zh: "未找到委派。",
  },
};
