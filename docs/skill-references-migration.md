# Skill 交叉引用修正记录

> 时间：2026-04-22
> 范围：Roll 仓库 skill 命名重构遗留的文档一致性问题
> 参考基准：`andrej-karpathy-skills` 仓库（仅作质量标尺，未引入其 skill）

## 背景

Roll 的 skill 体系在 2026-04-20 ~ 04-21 之间经历了一轮命名合并：

- `roll-story` 与 `roll-fly` 合并为统一入口 `roll-build`
- 隐藏 skill `.code-review` / `.qa-cover` 缩短为 `.review` / `.qa`

重命名在 `skills/` 目录内部大部分已改到位（工作区里还有 10 个 SKILL.md 的未提交 diff），但**外围文档的交叉引用没有跟着走**——方法论 mermaid 图、流程框图、skill 索引表、项目模板里仍在指向已经不存在的 skill 名。任何按 methodology 或按模板初始化新项目的用户，都会命中"书上写 `$roll-.code-review` 但系统里只有 `$roll-.review`"的落差。

## 之前的问题清单

| # | 文件 | 行号 | 旧引用 | 状态 |
|---|------|------|--------|------|
| 1 | `docs/methodology.md` | L34 | `$roll-.code-review`（mermaid 节点） | 指向已删 skill |
| 2 | `docs/methodology.md` | L264 | `$roll-.code-review`（ASCII 流程框） | 同上 |
| 3 | `docs/methodology.md` | L499 | `$roll-.code-review`（skill 索引表） | 同上 |
| 4 | `docs/methodology.md` | L500 | `$roll-.qa-cover`（skill 索引表） | 指向已删 skill |
| 5 | `docs/methodology-en.md` | L35 | `$roll-.code-review` | 英文版同步问题 |
| 6 | `docs/methodology-en.md` | L266 | `$roll-.code-review` | 同上 |
| 7 | `docs/methodology-en.md` | L501 | `$roll-.code-review` | 同上 |
| 8 | `docs/methodology-en.md` | L502 | `$roll-.qa-cover` | 同上 |
| 9 | `conventions/templates/fullstack/CLAUDE.md` | L16 | `$roll-story-build` | 按模板初始化会写入旧名 |
| 10 | `conventions/global/CLAUDE.md` | L20 | `$roll-story` | `roll setup` 会下发给每个用户 |
| 11 | `.claude/CLAUDE.md` | L20 | `$roll-story` | 当前仓库里 `roll setup` 生成的副本 |

## 处理思路

### 1. 先校准"改什么"，不乱扩大范围

与 karpathy-skills 对比后，意识到两者定位不同：

- **Karpathy** = 4 条编码行为准则（Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution）
- **Roll** = 14 个流程编排 skill（design / build / fix / debug / ...）

直接把 karpathy 的模式套到 Roll skill 上会破坏 Roll 的设计。通过 AskUserQuestion 与用户对齐：**karpathy 仅作质量标尺**，不引入新 skill、不并入 AGENTS.md；本次修正**只处理失效交叉引用**，description 风格归一化 / 补 examples 等留作后续迭代。

### 2. 应用 karpathy 的 Surgical Changes 原则

每一行改动都要能追溯到**同一个**重命名事实，不顺手优化相邻内容：

- 不改 description 风格（即使 `roll-build` / `roll-fix` / `roll-jot` 的 description 确实臃肿）
- 不补 "When NOT to Use" 小节
- 不加 `license` 字段
- 不动 AGENTS.md / README.md
- `skills/` 工作区里那 10 个未提交 diff 保持原样（它们和本次主题同属重命名同步）

### 3. 建立重命名映射作为唯一信息源

| 旧引用 | 新引用 | 语义变化 |
|--------|--------|---------|
| `$roll-story` / `$roll-story-build` / `$roll-fly` | `$roll-build` | 三条执行路径合并为统一入口 |
| `$roll-.code-review` | `$roll-.review` | 文件名缩短，语义不变 |
| `$roll-.qa-cover` | `$roll-.qa` | 同上 |

### 4. 闭环三道验证

改完后跑三条只读检查，全部清零才算完成：

```bash
# 1) 全仓扫：不应再有旧名
grep -rn "roll-story\|roll-fly\|roll-\.code-review\|roll-\.qa-cover" \
  docs/ skills/ conventions/ .claude/ AGENTS.md README.md

# 2) skill 目录名 = frontmatter name
for d in skills/*/; do
  name=$(basename "$d")
  fm=$(awk -F': ' '/^name:/{print $2; exit}' "$d/SKILL.md")
  [ "$name" != "$fm" ] && echo "MISMATCH: $name vs $fm"
done

# 3) methodology 里引用的每个 $roll-* 都能在 skills/ 下找到
grep -hoE "\$roll-[a-z.-]+" docs/methodology.md docs/methodology-en.md | sort -u | \
  while read s; do [ ! -d "skills/${s#\$}" ] && echo "MISSING: $s"; done
```

## 实际改动（本轮新增，共 6 个文件）

| 文件 | 改动 |
|------|------|
| `docs/methodology.md` | L34 mermaid 节点、L264 ASCII 框、L499/500 索引表 |
| `docs/methodology-en.md` | L35 / L266 / L501 / L502 镜像同步 |
| `conventions/templates/fullstack/CLAUDE.md` | L16：`$roll-story-build` → `$roll-build` |
| `conventions/global/CLAUDE.md` | L20：`$roll-story` → `$roll-build` |
| `.claude/CLAUDE.md` | L20：`$roll-story` → `$roll-build` |
| `docs/skill-references-migration.md` | 本文档 |

## 额外说明：`skills/` 工作区已有 10 个未提交 diff

以下 SKILL.md 在本次会话**之前**就已经在工作区被修改（推测是前一次 skill 重命名时改完没提交），本轮未再动它们，仅在验证阶段确认其改动与本次主题一致，建议随本次一并落盘提交：

```
skills/roll-.changelog/SKILL.md
skills/roll-.echo/SKILL.md
skills/roll-.qa/SKILL.md         # frontmatter name: .qa-cover → .qa
skills/roll-.review/SKILL.md     # frontmatter name: .code-review → .review
skills/roll-build/SKILL.md       # description 改写（与重命名无关，但同批次）
skills/roll-debug/SKILL.md
skills/roll-design/SKILL.md
skills/roll-fix/SKILL.md
skills/roll-jot/SKILL.md
skills/roll-sentinel/SKILL.md
```

## 未处理、留给后续的事

按 karpathy 的质量基准对比，Roll skill 还有下列改进空间，本轮**刻意不做**：

1. **description 风格归一化**：`roll-build` / `roll-fix` / `roll-jot` 的 description 是超长段落塞满触发词；`roll-debug` / `roll-sentinel` 只有一句话。统一到"一句定位 + 2-3 句触发场景 + Do NOT"三段式。
2. **"When NOT to Use" 小节**：避免 skill 互相误触发，karpathy 风格在这点做得很清晰。
3. **核心 skill 的 EXAMPLES.md**：`roll-build` / `roll-fix` / `roll-design` 值得有真实示例文档。
4. **`.claude-plugin/` manifest**：若计划以 plugin 形式分发，需要补齐 `plugin.json` / `marketplace.json`。

这些是独立议题，下一轮专项处理，不要和本次的重命名修正混在一个 commit 里。
