# Workspace Doctor

`roll workspace doctor <ID>` 对一个已注册 Workspace 做零写入诊断。它检查 registry 与 manifest、共享 repository cache、Requirement 投影和 archive 可信度、Issue journal 与 worktree、Workspace runtime locks，以及 machine capacity leases。

```bash
roll workspace doctor ws-payments
roll workspace doctor ws-payments --json
```

每个 finding 只有四种状态：

- `healthy`：无需处理。
- `repairable`：Roll 可以用诊断输出的 typed action 恢复技术状态。
- `blocked`：权属、schema 或存活事实不足，必须由 owner 处理。
- `data_loss_risk`：可能触及 dirty、未 push、冲突或损坏证据，Roll 拒绝写入。

证据路径只显示相对 Workspace 或 Roll Home 的位置。remote URL、credential、hostname、PID、owner token、agent model/context 值都不会进入终端或 JSON。

## 类型化修复

复制最新诊断给出的精确 action：

```bash
roll workspace doctor ws-payments --repair rebuild_cache:repo-0123456789ab
roll workspace doctor ws-payments --repair repair_requirement_projection:req-0123456789ab
roll workspace doctor ws-payments --repair recreate_clean_worktree:US-PAY-042
roll workspace doctor ws-payments --repair cleanup_stale_owned_lease:8e54b7d6-...
roll workspace doctor ws-payments --repair update_registry_path:ws-payments \
  --path /absolute/path/to/ws-payments
```

修复边界是闭合的：

| Action | 安全边界 |
|---|---|
| `update_registry_path` | 必须显式给出绝对路径，且其中 `workspace.yaml` 的 ID 与 registry 完全一致；Roll 不搜索也不收编相似目录。 |
| `rebuild_cache` | origin 冲突、任何已登记 worktree 或 Git admin linked worktree 都会拒绝。 |
| `repair_requirement_projection` | 只重建 `requirement.md`、`context/` 和 pending `attest.md`，来源必须是完整 archive audit 为 healthy 的当前不可变 revision。 |
| `recreate_clean_worktree` | 复用 Issue journal 与 pinned base；同一 Issue 任一 target dirty、未 push、foreign 或 conflict 就整体拒绝。 |
| `cleanup_stale_owned_lease` | 只删除精确匹配、同机、超过策略 stale 时间且进程可证明死亡的 lease。 |

registry、cache、Requirement、Issue 修复都复用已有 write-ahead journal。成功后重复同一命令返回 `reused`；中断时 journal 保留，可用相同 action 续跑。修复绝不改写不可变 Requirement revision、Issue completion evidence、remote identity 或 dirty/unpushed work。
