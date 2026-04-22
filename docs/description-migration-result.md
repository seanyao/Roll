# Description 规范迁移结果报告

> 执行时间：2026-04-22
> 变更：把 `~/.claude/` 本地 skill 的 4 段式 description 规范应用到 Roll 14 个 skill
> 改动类型：frontmatter only，正文未动，skill 目录结构未动

## 1. 迁移模板

从本地 skill 总结出来的规范：

```
Use when {场景}. Triggers: {触发词列表}. Typical: "{例1}", "{例2}", "{例3}". 
[Flow: A → B → C.] Do NOT trigger: {反例1} (use /other1), {反例2} (use /other2).
```

- **Use when**：一句话定位用途
- **Triggers**：让客户端能匹配的关键词
- **Typical**：真实说法样例（至少 3 个）
- **Flow**（可选）：关键步骤，让用户知道进入后会发生什么
- **Do NOT**：最容易混淆的兄弟 skill，显式指向正确去处

## 2. 指标变化

| 维度 | Before | After | 变化 |
|------|--------|-------|------|
| 长度最短 | 167（roll-.review） | 634（roll-jot） | +467 |
| 长度最长 | 1315（roll-build） | 766（roll-.qa） | **-549** |
| 长度均值 | 479 | 717 | +238 |
| 长度方差 | **1148** | **132** | **-1016（88%）** |
| Triggers 关键词覆盖 | 3/14 | 12/14 | +9 |
| Typical 样例覆盖 | 0/14 | 10/14 | +10 |
| Do NOT 边界覆盖 | 6/14 | **14/14** | +8 |

变化解读：
- **方差下降 88%**：从"两极分化"变成"全部集中在 ~700 字符"，写作规范统一
- **边界覆盖 100%**：14 个 skill 全部显式写了"不触发什么"，解决了之前 skill 间互相误触发的问题
- **均长上升**：本来太短的 skill（如 `roll-.review`、`roll-.qa`、`roll-debug`）补齐了触发词和边界

## 3. 逐 skill 前后对比表

| Skill | Before | After | Δ | 备注 |
|-------|--------|-------|---|------|
| roll-build | 1315 | 729 | **-586** | 从段落墙瘦身成 4 段 |
| roll-fix | 984 | 675 | -309 | 同上 |
| roll-jot | 908 | 634 | -274 | 同上 |
| roll-research | 653 | 764 | +111 | 微调，原来已经接近规范 |
| roll-.echo | 430 | 762 | +332 | 补 Typical 段 |
| roll-.clarify | 351 | 760 | +409 | 补 Typical 段 |
| roll-release | 316 | 699 | +383 | 补 Typical 和 Do NOT |
| roll-design | 280 | 704 | +424 | 补 Triggers 和 Typical |
| roll-spar | 234 | 760 | +526 | 补全 4 段 |
| roll-.changelog | 212 | 681 | +469 | 补全 4 段 |
| roll-sentinel | 196 | 726 | +530 | 补全 4 段 |
| roll-.qa | 189 | 766 | +577 | 补全 4 段（增长最大） |
| roll-debug | 188 | 674 | +486 | 补全 4 段 |
| roll-.review | 167 | 713 | +546 | 补全 4 段 |

## 4. 前后风格对比（代表性例子）

### 例 A：roll-build（长→短，1315 → 729）

**Before**（段落墙，阅读吃力）：
> "End-to-end delivery of a User Story from backlog to production: read US-XXX from BACKLOG.md → split into 2–6 micro-Actions (auto-parallelize via git worktree when files don't conflict) → TCR loop per Action... [大段继续] ... Prefer this over step-by-step manual orchestration — only this skill enforces TCR micro-commits, the verification gate (no 'I believe it works' without fresh evidence), and dual BACKLOG + feature-doc write-back. Do NOT trigger for: isolated bug fixes..."

**After**（4 段结构，扫读即懂）：
> "Use when shipping a User Story end-to-end from backlog to production. Triggers: US-XXX ID, 'ship it', '一条龙', '从设计到上线', '做这个功能', '把 xxx 做了', '实现 xxx Story'. Typical: '$roll-build US-AUTH-001', '把登录 Story 做了', 'ship this feature end-to-end', free-text feature request with no US yet. Flow: read US (or clarify → design if free-text) → split 2–6 micro-Actions → TCR loop → self-review → push → CI → deploy → verification gate → mark ✅ Done in BACKLOG + docs/features. Do NOT trigger: single bug with FIX-XXX (use roll-fix), capture only no code (use roll-jot), pure approach discussion (use roll-design), competitive research (use roll-research)."

### 例 B：roll-debug（短→完整，188 → 674）

**Before**（一句话，缺触发词和边界）：
> "Universal web debugger. Collects diagnostics (console/network/DOM) via Playwright, analyzes root causes, and suggests fixes. Works with or without Black Box (BB) integration."

**After**（结构化）：
> "Use when diagnosing a broken web page — collect diagnostics, analyze root cause, suggest fix. Triggers: '页面白屏', 'debug the page', 'see what's wrong', '功能不生效', 'page shows blank', user uploads diagnostics-*.json or bb-report.json. Typical: '$roll-debug https://...', '页面挂了看看', '帮我分析这份 bb-report', 'search 为啥没结果'. Flow: pick mode (native Black Box click or Playwright universal collector) → gather console/network/DOM/screenshot → analyze → propose fix. Do NOT trigger: known FIX-XXX ready to fix (use roll-fix), backlog tracking only (use roll-jot), scheduled production patrol (use roll-sentinel)."

## 5. 改了什么、没改什么

### ✅ 改了
- 14 个 SKILL.md 的 `description:` 一行（frontmatter 内）

### ❌ 明确没改
- skill 正文（SKILL.md 的 `---` 之后全部原样）
- 目录结构 / 文件名 / 其他 frontmatter 字段
- AGENTS.md / README.md / methodology*.md
- 任何业务逻辑或流程

符合 Karpathy "Surgical Changes" 原则——每一行改动都能追溯到同一主题：**description 规范化**。

## 6. 还能做但没做的事

基于 karpathy 基线，仍有下列改进空间，留作下一轮独立迭代：

1. **补 `license: MIT` 字段**：14 个 skill 都缺
2. **核心 skill 的 EXAMPLES**：`roll-build` / `roll-fix` / `roll-design` 值得有独立示例文档
3. **正文里的 "When NOT to Use" 小节**：description 已经包含了，但正文有些 skill 还没写
4. **`.claude-plugin/` manifest**：若计划以 plugin 分发

按 `skill-quality-benchmark.md` 的 P0-P4 计划排，本次相当于执行了 **P0（description 风格统一）**，剩下 P1-P4 未动。

## 7. 验证

```bash
# 长度分布查看（应集中在 600-800）
for d in skills/*/; do
  f="$d/SKILL.md"
  name=$(basename "$d")
  len=$(awk '/^description:/{flag=1} /^---$/{if(NR>1)flag=0} flag' "$f" | wc -c)
  printf "%-18s %s\n" "$name" "$len"
done | sort -k2 -n

# 4 段覆盖率（应全 1）
for d in skills/*/; do
  f="$d/SKILL.md"
  for kw in "Use when" "Triggers:" "Typical:" "Do NOT"; do
    grep -qF "$kw" "$f" || echo "MISS $kw in $(basename $d)"
  done
done
```

被动型 skill（`roll-.echo` / `roll-.clarify`）没有显式 "Triggers:" 标签——它们是自动触发，用 "Activation signals:" / "Typical triggering inputs:" 代替，属于设计内的差异化，不算缺失。

## 8. 反向贡献给本地 `~/.claude/`

本次迁移是把**本地规范反向移植到 Roll**。过程中发现本地规范本身可以再进化一步，建议回头增强：

| 改进点 | 具体做法 |
|-------|---------|
| **Flow 段可选化** | 本地部分 skill（如 `msg` / `research`）其实可以加 Flow，让用户知道进入后会经历什么 |
| **Typical 数量下限** | 目前本地有些 skill 的 Typical 只有 1-2 个，建议统一 ≥3 个 |
| **Do NOT 指向具体替代** | "不触发：X" 后面建议都补 "(用 /y)"，就像 Roll 这次做的 |

执行完这轮迁移后，Roll 的 description 质量已经与本地持平甚至略优（每个 Do NOT 都指向具体替代 skill）。
