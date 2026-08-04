# 一致性 — `roll release` 内置的发版闸

以真相锚点持续核对七个维度。backlog 的 `✅ Done` 行是声明；`main` 上的
merge 证据、验收报告、cycle 终态事件、发版闸事件才是事实。七个维度为：
① 代码 ↔ backlog 声明 · ② 卡片（每条活卡必须拥有
`features/<epic>/<ID>/spec.md`，证据链接不许悬空；卡片制之后已交付且带 AC
的故事必须拥有 `latest/<ID>-report.html`；没有验收项和报告的人工完成卡必须在
Done 状态写 `manual:` 原因。规则启用前已经完成的同 ID 历史记录，只有受版本控制的
`.roll/policy/manual-done-epoch.json` 基线和之后每一次已提交的 backlog 状态都证明它一直
保持完成时，才只计数不拦截；记录缺失、损坏或与当前历史断开时会明确阻断发版）·
③ 文档（changelog / features / guide / README / --help）· ④ 测试 ·
⑤ locale 对等（guide en↔zh + i18n key）· ⑥ 网站 · ⑦ 真相活体
（`ensureDeliveriesFresh` + `queryStoryDelivery` 必须证明发布增量里的每张卡
确实已交付；Done 行有 PR ref 时还要与结构化真相一致）。

```bash
roll release              # 唯一发版流——闸在流程内运行
roll release --dry-run    # 预览计划；不改任何东西
roll release --gate-check # 机器入口（CI 用）；exit 0 = 全部通过
```

## 发版闸

`roll release` 把**一致性闸放在任何不可逆操作之前**，且本地、远端同口径。本地这
一遍跑在发布分支上——版本号 bump 与 changelog 折叠提交之后、**开 PR / 合并之前**。
任一维度失败就在它还只是本地分支时中止发版：bump+changelog 永远不会进 `main`，
所以不会出现“已合并但没打 tag”的半成品。远端则在每个 `v*` tag 上由 `release.yml`
再跑同一道闸，之后才创建 GitHub Release。带着已知漂移发版的唯一方式是把漂移修掉——
不是绕过闸。

`main` 始终受 PR 保护，所以发版即便给自己也要开 PR。随后它用 GitHub 原生**自动合并**
（`gh pr merge --auto --squash`）自驱合并，而不是干等后台看护 lane：CI 转绿即合并，
哪怕你关掉终端也会完成。等待期间每轮轮询打印一行进度；若新 PR 的检查迟迟没调度，
会推一个空提交把 CI“顶”一下。这需要仓库开启 **“Allow auto-merge”**（Settings →
General → Pull Requests）；没开则发版会带着诚实的错误停下，提示你开启该设置或手动
合并 PR——绝不静默挂死。

验收证据闸默认是 `hard`。`loop_safety.attest_gate: soft` 是显式项目策略，
只用于迁移窗口；一致性检查仍会报告缺失或悬空的证据，避免缺口静默消失。

网站维度只检查 site 文案里仍存活的公开顶层命令引用，并解析
`guide/<lang>/*.md` 链接；它不会核对每个已完成故事是否都有网站页面。

真相活体维度是防“假 Done”闸。它先从 `runs.jsonl` 和 first-parent `main`
merge commit 重建交付投影，再对发布增量里的每个 story id 调
`queryStoryDelivery()`。backlog markdown 只是人的声明；`deliveries.jsonl`
是可重建缓存；git merge 与 run 事件才是事实。

## 文档对齐边界

registry 漂移已经是硬红线：命令注册表、README、guide 或 `--help` 彼此不一致时，
FIX-242 守卫会让一致性检查和发版闸失败。`roll attest` 里的 `doc-gap` 信号仍是
shadow-only：当交付 diff 改了用户可见命令面或输出文案文件，却没有在同一 diff
触及 README/docs/guide/site 时，它只在报告里给出警示，暂不改变退出码或 Gate 结论。
