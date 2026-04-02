---
name: cnx-sentinel
description: Smart patrol inspector for production systems. Scheduled randomized sampling checks based on BACKLOG requirements. Cost-controlled AI validation with intelligent spot-checking logic.
---

# Sentinel

**智能巡检员** - 定时、随机、控成本地走查验收生产系统。

## Core Principle

```
┌─────────────────────────────────────────────────────────────┐
│                    智能巡检逻辑                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  不是全量检查！而是像保安巡逻一样：                           │
│                                                             │
│  🕐 定时触发 - 按 schedule 自动巡逻                          │
│       └── "每6小时巡逻一次"                                  │
│                                                             │
│  🎲 随机抽检 - 每次抽查不同样本                              │
│       └── "这次查 Stories 1-10，下次查 50-60"                │
│                                                             │
│  💰 成本控制 - AI检查贵，要省着用                            │
│       └── "每次只查10个，不是全量100个"                      │
│                                                             │
│  🎯 基于 BACKLOG - 对照需求验收                              │
│       └── "US-001说能登录，我就验证能不能登"                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Patrol Strategy

### Sampling Logic (采样策略)

```javascript
// 每次 patrol 的采样逻辑
function selectSamples(backlog, strategy = 'smart') {
  const completedStories = backlog.filter(s => s.status === '✅');
  
  switch(strategy) {
    case 'random':
      // 完全随机：从所有完成的 Stories 中随机选 N 个
      return shuffle(completedStories).slice(0, 10);
    
    case 'weighted':
      // 加权随机：近期修改的、高频使用的优先
      return completedStories
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(0, 5)  // 5个最近的
        .concat(shuffle(completedStories).slice(0, 5)); // +5个随机
    
    case 'coverage':
      // 覆盖采样：确保不同模块都被覆盖到
      const byModule = groupBy(completedStories, 'module');
      return Object.values(byModule).map(
        stories => randomPick(stories)
      );
  }
}
```

### Cost Control (成本控制)

| 策略 | 样本量 | 频率 | 适用场景 |
|------|--------|------|----------|
| **Light** | 5个 Stories | 每天1次 | 稳定期 |
| **Normal** | 10个 Stories | 每6小时 | 一般监控 |
| **Intensive** | 20个 Stories | 每小时 | 发布后期 |
| **Full** | 全部 | 每周1次 | 周巡检 |

```yaml
# sentinel.config.yml
cost_control:
  daily_budget: 100  # AI调用次数预算
  
  light_patrol:
    samples: 5
    schedule: "0 9 * * *"  # 每天9点
    
  normal_patrol:
    samples: 10
    schedule: "0 */6 * * *"  # 每6小时
    
  # 发布后的密集巡逻
  post_deploy:
    trigger: "after_deploy"
    samples: 20
    duration: "2h"  # 持续2小时
```

### Uncertainty Handling (应对不确定性)

```javascript
// 系统有不确定性，单次检查可能不准
// 用多次随机检查来提高置信度

class UncertaintyHandler {
  // 记录检查结果历史
  history = new Map(); // storyId -> [check1, check2, ...]
  
  // 判断是否真的有问题
  isRealIssue(storyId, currentResult) {
    const pastResults = this.history.get(storyId) || [];
    pastResults.push(currentResult);
    
    // 如果连续3次失败，才认为是真问题
    const recent3 = pastResults.slice(-3);
    if (recent3.every(r => r.status === 'FAIL')) {
      return true; // 真问题
    }
    
    // 如果偶尔失败，可能是偶发，继续观察
    if (recent3.filter(r => r.status === 'FAIL').length === 1) {
      return false; // 可能是偶发，暂不报警
    }
    
    return false;
  }
}
```

## When to Patrol

### Scheduled Patrols (定时巡逻)

```bash
# 日常巡逻 - 每天随机查几个
$cnx-sentinel patrol --mode=normal

# 深夜巡检 - 每天凌晨低峰期全量
$cnx-sentinel patrol --mode=full --schedule="0 3 * * *"

# 周末走查 - 周日检查一周积累
$cnx-sentinel patrol --mode=weekly --schedule="0 10 * * 0"
```

### Event-Triggered (事件触发)

```bash
# 发布后密集巡逻2小时
$cnx-sentinel patrol --mode=intensive --duration=2h --after-deploy

# 报警后紧急检查
$cnx-sentinel patrol --mode=focus --target=US-XXX
```

## Patrol Report

```markdown
## 🛡️ Sentinel Patrol Report #247
**Time**: 2024-01-15 14:00 UTC  
**Patrol ID**: patrol-20240115-1400  
**Mode**: Normal (Random Sampling)

### 📊 Sampling Info
| Metric | Value |
|--------|-------|
| Total Stories | 150 |
| Sample Size | 10 |
| Sampling Rate | 6.7% |
| Cost Estimate | ¥0.5 |

### 🎲 Random Sample
| # | Story | Module | Last Checked | Result |
|---|-------|--------|--------------|--------|
| 1 | US-LOGIN-001 | Auth | 6h ago | ✅ |
| 2 | US-STORY-042 | Content | 12h ago | ✅ |
| 3 | US-AUDIO-015 | Player | 2h ago | 🟡* |
| 4 | US-SEARCH-003 | Search | 18h ago | ✅ |
| 5 | ... | ... | ... | ... |

\* US-AUDIO-015: 播放偶尔卡顿（第2次出现，观察中）

### 🔴 Issues Found
None (本次抽检未发现确定问题)

### 📈 Patrol Statistics (7 days)
| Metric | Value |
|--------|-------|
| Total Patrols | 28 |
| Stories Checked | 280 |
| Issues Found | 3 |
| False Positives | 1 |
| Coverage | 85% of all stories |

### 💰 Cost Report
| Item | Usage |
|------|-------|
| AI Checks | 280 calls |
| Playwright Runs | 28 sessions |
| Total Cost | ¥15 |
| Budget Used | 15% of monthly |
```

## Smart Detection Logic

### Pattern 1: 偶发 vs 真问题

```javascript
// 不是一查就报，要看趋势
const checks = [
  { time: 'T-6h', status: 'PASS' },
  { time: 'T-12h', status: 'FAIL' },  // 偶发？
  { time: 'T-18h', status: 'PASS' },
  { time: 'Now', status: 'FAIL' },    // 又失败了！
];

// 连续2次失败 → 创建 Issue
if (lastN(checks, 2).all(c => c.status === 'FAIL')) {
  createBacklogItem('FIX-XXX');
}
// 偶尔失败 → 记录观察
else if (checks.filter(c => c.status === 'FAIL').length <= 1) {
  logForObservation('Might be flaky, continue monitoring');
}
```

### Pattern 2: 热点识别

```javascript
// 某些 Stories 经常被抽到有问题
// 自动增加检查频率

const hotSpots = analyzeHistory();
// hotSpots = [
//   { story: 'US-AUDIO-015', failRate: 0.3 }, // 30%失败率
//   { story: 'US-SEARCH-003', failRate: 0.1 },
// ]

// 对热点增加权重
if (hotSpots.some(h => h.story === selectedStory)) {
  // 如果是热点，即使随机没选中，也有概率额外检查
  if (Math.random() < 0.3) {
    extraCheck(story);
  }
}
```

## Cost Optimization

### Tiered Checking (分层检查)

```
Level 1: 轻量检查 (便宜)
  └── HTTP ping / API health check
  └── Cost: ¥0.01 per check

Level 2: 功能检查 (中等)
  └── Playwright 关键路径
  └── Cost: ¥0.1 per check

Level 3: AI 深度检查 (贵)
  └── AI 分析内容质量
  └── Cost: ¥0.5 per check

策略：
- 每次 Patrol 90% Level 1 + 10% Level 2
- 每周一次 Level 3 深度巡检
```

### Smart Batching

```javascript
// 批量检查降低成本
// 不是查10次，而是开一次浏览器查10个

async function batchCheck(stories) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  
  // 复用浏览器会话检查多个 Stories
  for (const story of stories) {
    const page = await context.newPage();
    await checkStory(page, story);
    await page.close();
  }
  
  await browser.close();
  // Cost: 1 session for 10 checks
}
```

## Workflow: Find Issue → Backlog

```
┌─────────────────────────────────────────────────────────────┐
│                    巡检发现问题流程                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Sentinel Patrol (定时随机抽检)                           │
│     └── Sample: US-AUDIO-015                                │
│                                                             │
│  2. Check Result                                            │
│     └── Status: FAIL (播放卡顿)                              │
│                                                             │
│  3. Uncertainty Check (不确定性处理)                         │
│     └── 查历史：这是第2次失败                                 │
│     └── 第1次在 6h ago (可能是偶发)                          │
│     └── Decision: 继续观察，暂不创建 Issue                    │
│                                                             │
│  4. Next Patrol (下次巡逻)                                   │
│     └── 又抽到了 US-AUDIO-015 (热点加权)                     │
│     └── Status: FAIL (又失败了！)                            │
│     └── 查历史：连续2次失败                                   │
│     └── Decision: 创建 FIX-AUDIO-015                        │
│                                                             │
│  5. Create Backlog Item                                     │
│     └── BACKLOG.md 添加 FIX-AUDIO-015                       │
│     └── Status: 📋 Todo                                     │
│     └── 等待人工修复                                        │
│                                                             │
│  6. Human Fix                                               │
│     └── User: "修复 FIX-AUDIO-015"                          │
│     └── $cnx-fix-build FIX-AUDIO-015                            │
│                                                             │
│  7. Verification                                            │
│     └── Next patrol 会优先验证这个 FIX                       │
│     └── Status: ✅ Fixed                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Integration with Other Skills

```
┌─────────────────────────────────────────────────────────────┐
│                    完整监控体系                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  $cnx-sentinel patrol        定时随机巡检 (主力)                 │
│       ↓                                                     │
│  发现问题? ──┬── 是 ──→ 创建 BACKLOG 项                      │
│              │         等待 $cnx-fix-build                      │
│              │                                              │
│              └── 否 ──→ 继续巡逻                             │
│                                                             │
│  $cnx-bb-debug               按需深度诊断 (辅助)                 │
│  (当 Sentinel 发现问题后，人工触发深入调查)                   │
│                                                             │
│  $cnx-story-build            修复后回归验证                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Best Practices

1. **不要全量检查** - 成本高，没必要
2. **随机+热点** - 平衡覆盖率和成本
3. **多次确认** - 避免偶发误报
4. **预算控制** - 设置每日/每月 AI 调用上限
5. **渐进增强** - 稳定期 Light，发布后 Intensive
