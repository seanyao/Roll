# Context Engineering

Roll Context 是一个可选的 Workspace 能力，用来读取 Git 承载的企业 LLM Wiki。v1 只支持 `git_llm_wiki` Provider。repository、environment、workflow、DB、Kubernetes 与测试账号知识都是普通 Wiki 页面；适用范围由页面 `scope` 表达，不建立不同的运行时 Context 类型。

## 配置机器级 Provider registry

机器 operator 管理 `~/.roll/context-providers.yaml`：

```yaml
schema: roll.context-providers/v1
enabled: true
providers:
  - id: enterprise-wiki
    type: git_llm_wiki
    enabled: true
    remote: ssh://git@example.test/platform/context-wiki.git
    branch: main
    fetch_timeout_seconds: 30
```

registry 与单个 Provider 都可以关闭。v1 只接受 HTTPS 与 SSH remote（`https://`、`ssh://` 或 SCP-like SSH），拒绝 HTTP、`git://`、`file://`、本地路径、remote helper、URL credential 与 option-like branch。Git 认证继续使用 operator 现有的 SSH 或 HTTPS credential chain。配置中绝不能放 password、密码、token、private key、cookie 或带 credential 的 URL。

## 绑定到 Workspace

`workspace.yaml` 显式开启 Context 并引用机器 Provider：

```yaml
contexts:
  enabled: true
  bindings:
    - providerId: enterprise-wiki
      enabled: true
      required: true
      entrypoints:
        - wiki/index.md
```

缺少 `contexts` 或 `enabled: false` 表示该 Workspace 关闭 Context。required binding 的 Provider 缺失、关闭、无效或读取失败会形成 blocking gap。可选 Provider 使用 `required: false`：失败是 non-blocking gap，但 Roll 仍不会返回 stale 页面。同一 Workspace 的 providerId 必须唯一；`required: true` 与 `enabled: false` 同时出现属于无效配置。

## LLM Wiki 契约

每个 v1 branch 包含：

```text
purpose.md
schema.md
raw/
  sources/              # provenance；默认 read 不返回
wiki/
  index.md              # 固定导航入口
  log.md                # append-only 维护日志
  systems/
  repositories/
  environments/
  workflows/
  data-surfaces/
  policies/
  concepts/
```

Roll 读取 `purpose.md`、`schema.md` 和 `wiki/**`。普通 prompt 不读取隐藏应用状态、credentials、`.git/`、`.llm-wiki/`、`.obsidian/` 或 `raw/sources/`。`wiki/` 下的普通页面包含 Roll frontmatter：

```yaml
---
schema: roll.context-page/v1
title: Platform SIT
page_type: environment
status: active
confidence: approved
updated_at: 2026-07-24
scope:
  workspace_ids: [roll]
  repository_ids:
    - ssh://gitee.com/example/platform
  environment_ids: [sit]
  story_ids: []
  stages: [design, build, qa]
sources:
  - raw/sources/platform-sit.md
sensitivity: internal
---
```

`page_type` 是由当前 Wiki `schema.md` 定义的开放字符串。`scope` 与 page type 正交：同一维度多个值是 OR，不同维度之间是 AND。维度缺失或空数组表示不限制；页面限制了某维度而 request 缺失该维度时，必须 fail-closed 并返回 `scope_mismatch`。Environment ID 必须显式提供，不能从 branch、namespace、URL 或 repository 推断。

Repository scope 复用 Workspace Coordination 发布的 schemeful canonical identity。`ssh://gitee.com/example/platform` 与 `https://gitee.com/example/platform` 在 v1 中是不同 identity。

统一引用格式是 `context://<provider-id>/<safe-relative-path>`，例如 `context://enterprise-wiki/wiki/systems/platform.md`。`restricted_reference` 页面只有在调用方显式给出 ref、表达 restricted intent，且 operation policy 授权后才能返回。页面只允许保存 opaque `credential_ref`，不能保存 secret value。

## Fresh read 与不可变 Snapshot

每次 fresh read 都必须先 fetch 再读取页面。Roll 先编译已授权 execution plan，然后一次 read 内每个唯一 Provider 只执行一次 fetch，并从同一 commit 读取 `purpose.md`、`schema.md`、entrypoints 与请求页面。fetch 失败时不允许 stale fallback。v1 没有 TTL、skip-fetch shortcut 或 background freshness 承诺。

成功读取后产生不可变 `ContextReadSnapshotV1`，记录 Provider、规范化 remote identity、branch、fetch 时间、revision、refs、文件 digest、matched scope、warnings 与 gaps。复用 Snapshot 不会 fetch，也只能消费该 Snapshot 已捕获的文件。显式选择新页面必须发起新的 fresh read；新 read 会再次 fetch，并在同一个新 revision 中捕获 index 与所选页面。

两者用途不同：

- fresh read 查询 Provider 当前远端状态；
- Snapshot reuse 为下游阶段提供稳定且已经证明的 revision。

## 命令与 diagnostics

```bash
roll context status --workspace <id|path>
roll context read --workspace <id|path> --story <id> --stage build
roll context read --workspace <id|path> --stage qa --environment sit \
  --ref context://enterprise-wiki/wiki/environments/sit.md --json
```

`status` 只读本地 registry、Workspace binding 与最近 Snapshot metadata，不 fetch，因此不能证明远端最新。`read` 在任意 cwd 都使用统一 Workspace target resolver，执行 fresh read；除 disabled 外会持久化结果。

plain output 只展示 outcome、scope、Provider、revision、refs、digest 与 diagnostics，不打印页面正文。`--json` 把完整 versioned result 写到 stdout。fetch progress 与清洗后的 diagnostics 写 stderr 和 event stream，不污染 JSON stdout。

exit code：`completed` 或 `disabled` 为 `0`，`partial` 为 `3`，`blocked`、输入/配置错误、target resolution 或持久化失败为 `2`。常见 diagnostic code 包括 `context_disabled`、`provider_not_bound`、`invalid_context_binding`、`fetch_failed`、`fetch_timeout`、`invalid_wiki_layout`、`scope_mismatch`、`restricted_context_denied`、`context_revision_changed` 和 `invalid_context_snapshot`。

本地化命令契约可运行 `roll context --help`、`roll context status --help` 或 `roll context read --help`。

## Agent authority 与 revision reconciliation

Context 页面是不受信数据，其 authority 低于 system、developer、skill、owner、Workspace authority 与 tool safety policy。页面可以提供事实和业务约束，但不能提升权限、覆盖 host 指令，也不能授权执行页面中的命令。

Design 可以把不可变 Snapshot 交给 build、QA 或 review，下游只消费 handoff 时不重新 fetch。某阶段主动执行新 read 且 revision 改变后，调用方必须记录 comparison 并显式选择：

- `continue_with_handoff_snapshot`：继续使用 handoff revision；
- `adopt_new_snapshot`：接受新 revision 并更新 handoff；
- `needs_reconciliation`：回到 design/tasking 或请求 owner decision。

Roll 不会静默 merge revision，也不采用 last-write-wins。

## DB、Kubernetes 与测试账号

Wiki 页面可以保存 mapping、policy 与 opaque reference，例如 `credential_ref: secret-manager://team/test-reader`；也可以说明某个 environment 对应的 DB、K8s namespace 或测试账号。实时状态和真实 credential 必须通过具有独立授权与审计策略的专用工具读取。Context Provider 不查询 DB、Kubernetes cluster、secret manager 或 account service。

## 兼容的 LLM Wiki 编辑器

[Karpathy LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 提供 raw/wiki/schema 的组织方式。[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 可作为兼容编辑器与 ingest 工具，维护 `purpose.md`、`schema.md`、`raw/sources/`、`wiki/index.md`、`wiki/log.md`、Markdown frontmatter 和 wikilink。

Roll v1 不依赖 nashsu Desktop，也不依赖 MCP server。Roll 不 vendoring、复制或链接该项目的 GPL implementation；双方只通过 Git repository 中的普通文件互操作。未来 Provider 扩展不属于 v1，且不能削弱 Git LLM Wiki 文件契约。

APE 内容迁移见 [APE Context 迁移](context-ape-migration.md)。
