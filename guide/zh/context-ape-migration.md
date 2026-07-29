# 从 APE Context 迁移到 Roll

APE 的 `ape-context` 与 `ape-shared-execution-context` 统一映射到同一个 Roll Context 模型：普通 LLM Wiki 页面加显式 `scope`。不存在特殊 shared runtime type；所谓共享，只是页面 scope 允许多个 Workspace、repository、environment、Story 或 stage 使用。

## 内容映射

| 现有 APE 内容 | Roll LLM Wiki 目标 |
|---|---|
| `index.md` | `wiki/index.md` |
| `log.md` | `wiki/log.md` |
| `contexts/global/**` | `wiki/policies/**` 或 `wiki/concepts/**` |
| `contexts/systems/**` | `wiki/systems/**` |
| `contexts/repos/**` | `wiki/repositories/**` |
| `contexts/workflows/**` | `wiki/workflows/**` |
| `contexts/data-surfaces/**` | `wiki/data-surfaces/**` |
| `schema/*.md` | `schema.md`，必要时加 `wiki/schemas/**` |
| `sources/**` | `raw/sources/**` |
| scoped shared execution notes | 带 repository、environment、Story 与 stage scope 的普通 Wiki 页面 |
| `credentials/**` | 不迁移 credential value，改为 opaque `credential_ref` |

旧引用：

```text
ape-context:contexts/systems/platform.md
shared-execution-context:release-batch/index.md
```

迁移后：

```text
context://enterprise-wiki/wiki/systems/platform.md
context://enterprise-wiki/wiki/scopes/release-batch.md
```

第二个目标仍是普通页面，只是较窄的 `scope` 说明它适用于某个 execution batch。

## 迁移检查单

1. 创建 `purpose.md`、`schema.md`、`wiki/index.md` 与 `wiki/log.md`。
2. 把来源证据放到 `raw/sources/`，不要让 raw file 进入默认 Context output。
3. 把每个内容页转换为 `schema: roll.context-page/v1` frontmatter。
4. 使用 Workspace 相同的 schemeful identity 规范化 repository ID，不合并 SSH 与 HTTPS identity。
5. 把 shared applicability 转为显式 scope 维度；request 缺失受限维度时 fail-closed。
6. 把 DB、Kubernetes 与测试账号值替换为 mapping、policy 与 opaque credential reference。
7. 不迁移任何 credential value、token、password、cookie、private key、DSN 或 connection string。
8. 在 `~/.roll/context-providers.yaml` 注册 Git Provider，在 `workspace.yaml` 绑定，然后使用 `roll context status` 与 fresh `roll context read` 验证。

完整 Provider、read、Snapshot、authority 与 diagnostic 契约见 [Context Engineering](context.md)。
