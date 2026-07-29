# roll-.dream — 代码健康巡检

`roll-.dream` 扫描代码库中的架构摩擦、死代码和技术债，并把发现的问题以 `REFACTOR-NNN`
条目的形式追加到 backlog，等待 loop 领取。

由你来跑:`roll dream run-once` 解析 `roll-.dream` skill 并就地起 agent 扫描。没有任何东西
会替你跑 —— 没有调度、也没有后台进程,想扫的时候扫一次。

## Dream 做什么

每跑一次，dream 完整扫描一遍代码库，输出这些结果：

1. **`.roll/dream/YYYY-MM-DD.md`** — 中文详细报告（按日期一个文件）
2. **BACKLOG.md 条目** — 可操作的 `REFACTOR-NNN` 条目追加到 `## ♻️ Refactor` 表格
3. **`.roll/dream/structure-scan.json`** — 代码结构发现的确定性 TypeScript/AST 证据

报告覆盖以下方面：

- 死代码和未使用函数，先由 TypeScript Language Service 引用图给出证据
- 跨模块的重复逻辑，先由规范化 AST fingerprint 给出证据
- 模块边界违反（一个关注点泄漏到另一个模块）
- 已上线功能缺少测试
- 文档覆盖度缺口（缺 EN/ZH 指南、过时引用）

代码结构类发现现在先走确定性 pre-scan：dead export、不可达分支、重复 AST 形状、
单实现抽象和未文档化 env 变量都会在 agent 运行前写入 `structure-scan.json`。
agent 消费这份 artifact，不再用 grep 式启发兜底。文档覆盖、新鲜度和存在性漂移
仍保留在原有 Dream 流程里。

## 如何读 Dream 报告

```bash
# 查看最近 3 次报告
ls -lt .roll/dream/ | head -4

# 读取最新报告
cat .roll/dream/$(ls -1t .roll/dream/ | head -1)
```

每个报告章节末尾有优先级分类：

- **P0** — 阻碍其他工作，本迭代内处理
- **P1** — 显著摩擦，2 周内处理
- **P2** — 低优先级，有空时处理

## REFACTOR 条目生成

发现具体可操作的问题时，dream 向 BACKLOG.md 追加一行：

```markdown
| REFACTOR-005 | 提取 _for_each_ai_tool() — 4 处重复的迭代逻辑 | 📋 Todo |
```

Loop 按正常优先级处理这些条目（晚于 FIX-XXX，与 US-XXX 并列）。

Dream **不会**生成 REFACTOR 条目的场景：
- 修复需要超过 1 天（改为追加为 IDEA）
- 纯粹的风格偏好问题
- BACKLOG 中已有对应 US 或 FIX 条目的问题

## 什么时候跑

```bash
roll dream run-once   # 现在扫一遍

# 或在 agent 会话里直接调用 skill
$roll-.dream
```

想扫就扫:做规划之前、大重构之后,或者在准备处理 REFACTOR 卡的会话开头跑一次。

Dream 每次运行写入当天日期的文件，并追加到 BACKLOG.md。
同一天运行两次是安全的（只是产生第二次追加，不会覆盖）。
每次运行也会刷新 `.roll/dream/structure-scan.json`；需要核对代码结构 REFACTOR
背后的机器证据时，看这份文件。
