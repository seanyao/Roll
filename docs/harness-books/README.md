# 《Claude Code 和 Codex 的 Harness 设计哲学》

> 副标题：殊途同归，还是各表一枝

> "人活在世上，就是为了忍受摧残。做 harness 也是。区别只在于，有人把摧残写进控制流，有人把摧残写进制度层。"

---

## 全书目录

1. [阅读地图：如何理解第一本书与这本比较书](chapter-00-reading-map.md)
2. [序言：两套 Harness，不必假装是同一匹马的附件](preface.md)
3. [第 1 章 为什么要把 Claude Code 和 Codex 放在一起看](chapter-01-why-this-comparison.md)
4. [第 2 章 两种控制面：Prompt 拼装与 Instruction Fragment](chapter-02-two-control-planes.md)
5. [第 3 章 心跳放在哪：Query Loop 对照 Thread、Rollout 与 State](chapter-03-loop-thread-and-rollout.md)
6. [第 4 章 工具、沙箱与策略语言：谁来阻止模型动手太快](chapter-04-tools-sandbox-and-exec-policy.md)
7. [第 5 章 技能、Hook 与本地规则：系统如何学会守乡约](chapter-05-skills-hooks-and-local-governance.md)
8. [第 6 章 委派、验证与持久状态：谁来防止系统自己给自己打高分](chapter-06-delegation-verification-and-state.md)
9. [第 7 章 殊途同归，还是各表一枝](chapter-07-convergence-and-divergence.md)
10. [第 8 章 如果你要自己做：该向谁学，先学什么](chapter-08-how-to-choose-or-build.md)

---

## 核心观点

### 三个判断前提

1. Claude Code 和 Codex 比较的重点**不在模型，而在 harness**
2. harness 是一种**权力分配方式**，而不是若干功能的拼盘
3. 工程系统的差别，常常不在名词，而在**秩序住在哪一层**

### 殊途同归

两者都承认：
- prompt 不等于控制全部
- 工具必须受约束
- 长会话一定需要状态治理
- 本地规则必须进入系统
- 多代理必须有分工和验证

### 各表一枝

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| **控制面** | 动态 prompt 装配线 | 显式控制层 |
| **连续性** | query loop | thread + rollout + state |
| **工具治理** | 运行时审批链 | 策略语言与参数化审批 |
| **本地治理** | 现场记忆与运行时注入 | 结构化资产与生命周期事件 |
| **多代理** | 运行时职责分离 | 显式委派与状态承接 |

### 两种 harness 政体

- **Claude Code** = 运行时共和制（现场调度、经验型控制力）
- **Codex** = 控制面立宪制（制度设计、显式控制层）

---

## 与 CNX 的关系

这本书讨论的 harness 设计哲学，正是 **Cybernetix** 的理论基础之一：

> 如何把模型的不可靠性驯化成可持续的工程秩序。

CNX 的 PDCA 循环（Plan → Do → Check → Act）正是对这一哲学的工程化实现：
- **Plan** = cnx-backlog（需求规划）
- **Do** = cnx-roll-build / cnx-story-build（执行）
- **Check** = cnx-sentinel / cnx-probe（检查）
- **Act** = cnx-fix-build（修复改进）

---

*抓取时间: 2026-04-03*  
*来源: https://harness-books.agentway.dev/book2-comparing*
