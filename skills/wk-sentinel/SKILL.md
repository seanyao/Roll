---
hidden: true
name: cnx-sentinel
description: Smart patrol inspector for production systems. Scheduled randomized sampling checks based on BACKLOG requirements. Cost-controlled AI validation with intelligent spot-checking logic.
---

# Sentinel

**Smart Patrol Inspector** - Scheduled, randomized, cost-controlled patrol and acceptance checks for production systems.

## Core Principle

```
┌─────────────────────────────────────────────────────────────┐
│                   Smart Patrol Logic                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Not full-coverage checks! Think of it like a security      │
│  guard on patrol:                                           │
│                                                             │
│  🕐 Scheduled Triggers - Auto-patrol on schedule            │
│       └── "Patrol once every 6 hours"                       │
│                                                             │
│  🎲 Random Sampling - Different samples each time           │
│       └── "Check Stories 1-10 this time, 50-60 next time"   │
│                                                             │
│  💰 Cost Control - AI checks are expensive, use sparingly   │
│       └── "Only check 10 each time, not all 100"            │
│                                                             │
│  🎯 BACKLOG-Based - Validate against requirements           │
│       └── "US-001 says login works, so verify login"        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Patrol Strategy

### Sampling Logic

```javascript
// Sampling logic for each patrol
function selectSamples(backlog, strategy = 'smart') {
  const completedStories = backlog.filter(s => s.status === '✅');
  
  switch(strategy) {
    case 'random':
      // Fully random: randomly select N from all completed Stories
      return shuffle(completedStories).slice(0, 10);
    
    case 'weighted':
      // Weighted random: prioritize recently modified and frequently used
      return completedStories
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(0, 5)  // 5 most recent
        .concat(shuffle(completedStories).slice(0, 5)); // + 5 random
    
    case 'coverage':
      // Coverage sampling: ensure different modules are all covered
      const byModule = groupBy(completedStories, 'module');
      return Object.values(byModule).map(
        stories => randomPick(stories)
      );
  }
}
```

### Cost Control

| Strategy | Sample Size | Frequency | Use Case |
|----------|-------------|-----------|----------|
| **Light** | 5 Stories | Once daily | Stable period |
| **Normal** | 10 Stories | Every 6 hours | General monitoring |
| **Intensive** | 20 Stories | Every hour | Post-release period |
| **Full** | All | Once weekly | Weekly patrol |

```yaml
# sentinel.config.yml
cost_control:
  daily_budget: 100  # AI call budget
  
  light_patrol:
    samples: 5
    schedule: "0 9 * * *"  # Daily at 9am
    
  normal_patrol:
    samples: 10
    schedule: "0 */6 * * *"  # Every 6 hours
    
  # Intensive patrol after deployment
  post_deploy:
    trigger: "after_deploy"
    samples: 20
    duration: "2h"  # Lasts 2 hours
```

### Uncertainty Handling

```javascript
// Systems have uncertainty; a single check may be inaccurate.
// Use multiple random checks to increase confidence.

class UncertaintyHandler {
  // Track check result history
  history = new Map(); // storyId -> [check1, check2, ...]
  
  // Determine if an issue is real
  isRealIssue(storyId, currentResult) {
    const pastResults = this.history.get(storyId) || [];
    pastResults.push(currentResult);
    
    // Only consider it a real issue if it fails 3 times consecutively
    const recent3 = pastResults.slice(-3);
    if (recent3.every(r => r.status === 'FAIL')) {
      return true; // Real issue
    }
    
    // If it fails occasionally, it may be intermittent; keep observing
    if (recent3.filter(r => r.status === 'FAIL').length === 1) {
      return false; // Likely intermittent, don't alert yet
    }
    
    return false;
  }
}
```

## When to Patrol

### Scheduled Patrols

```bash
# Daily patrol - randomly check a few each day
$cnx-sentinel patrol --mode=normal

# Late-night patrol - full check during off-peak hours
$cnx-sentinel patrol --mode=full --schedule="0 3 * * *"

# Weekend walkthrough - check the week's accumulation on Sunday
$cnx-sentinel patrol --mode=weekly --schedule="0 10 * * 0"
```

### Event-Triggered

```bash
# Intensive patrol for 2 hours after deployment
$cnx-sentinel patrol --mode=intensive --duration=2h --after-deploy

# Emergency check after an alert
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
| Cost Estimate | $0.07 |

### 🎲 Random Sample
| # | Story | Module | Last Checked | Result |
|---|-------|--------|--------------|--------|
| 1 | US-LOGIN-001 | Auth | 6h ago | ✅ |
| 2 | US-STORY-042 | Content | 12h ago | ✅ |
| 3 | US-AUDIO-015 | Player | 2h ago | 🟡* |
| 4 | US-SEARCH-003 | Search | 18h ago | ✅ |
| 5 | ... | ... | ... | ... |

\* US-AUDIO-015: Occasional playback stuttering (2nd occurrence, under observation)

### 🔴 Issues Found
None (no confirmed issues found in this sample)

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
| Total Cost | $2 |
| Budget Used | 15% of monthly |
```

## Smart Detection Logic

### Pattern 1: Intermittent vs Real Issue

```javascript
// Don't alert on the first failure; look at the trend
const checks = [
  { time: 'T-6h', status: 'PASS' },
  { time: 'T-12h', status: 'FAIL' },  // Intermittent?
  { time: 'T-18h', status: 'PASS' },
  { time: 'Now', status: 'FAIL' },    // Failed again!
];

// 2 consecutive failures → Create Issue
if (lastN(checks, 2).all(c => c.status === 'FAIL')) {
  createBacklogItem('FIX-XXX');
}
// Occasional failure → Log for observation
else if (checks.filter(c => c.status === 'FAIL').length <= 1) {
  logForObservation('Might be flaky, continue monitoring');
}
```

### Pattern 2: Hotspot Detection

```javascript
// Some Stories frequently show issues when sampled.
// Automatically increase their check frequency.

const hotSpots = analyzeHistory();
// hotSpots = [
//   { story: 'US-AUDIO-015', failRate: 0.3 }, // 30% failure rate
//   { story: 'US-SEARCH-003', failRate: 0.1 },
// ]

// Increase weight for hotspots
if (hotSpots.some(h => h.story === selectedStory)) {
  // If it's a hotspot, even if not randomly selected, add extra check probability
  if (Math.random() < 0.3) {
    extraCheck(story);
  }
}
```

## Cost Optimization

### Tiered Checking

```
Level 1: Lightweight Check (cheap)
  └── HTTP ping / API health check
  └── Cost: $0.001 per check

Level 2: Functional Check (moderate)
  └── Playwright critical path
  └── Cost: $0.01 per check

Level 3: AI Deep Check (expensive)
  └── AI-powered content quality analysis
  └── Cost: $0.07 per check

Strategy:
- Each patrol: 90% Level 1 + 10% Level 2
- Once weekly: Level 3 deep inspection
```

### Smart Batching

```javascript
// Batch checks to reduce cost.
// Instead of 10 separate checks, open one browser for all 10.

async function batchCheck(stories) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  
  // Reuse browser session to check multiple Stories
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
│              Issue Discovery Workflow via Patrol             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Sentinel Patrol (scheduled random sampling)             │
│     └── Sample: US-AUDIO-015                                │
│                                                             │
│  2. Check Result                                            │
│     └── Status: FAIL (playback stuttering)                  │
│                                                             │
│  3. Uncertainty Check                                       │
│     └── Check history: this is the 2nd failure              │
│     └── 1st was 6h ago (possibly intermittent)              │
│     └── Decision: continue observing, don't create Issue    │
│                                                             │
│  4. Next Patrol                                             │
│     └── US-AUDIO-015 sampled again (hotspot weighting)      │
│     └── Status: FAIL (failed again!)                        │
│     └── Check history: 2 consecutive failures               │
│     └── Decision: create FIX-AUDIO-015                      │
│                                                             │
│  5. Create Backlog Item                                     │
│     └── Add FIX-AUDIO-015 to BACKLOG.md                     │
│     └── Status: 📋 Todo                                     │
│     └── Awaiting human fix                                  │
│                                                             │
│  6. Human Fix                                               │
│     └── User: "Fix FIX-AUDIO-015"                           │
│     └── $cnx-fix-build FIX-AUDIO-015                            │
│                                                             │
│  7. Verification                                            │
│     └── Next patrol will prioritize verifying this FIX      │
│     └── Status: ✅ Fixed                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Integration with Other Skills

```
┌─────────────────────────────────────────────────────────────┐
│                Complete Monitoring System                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  $cnx-sentinel patrol        Scheduled random patrol (main) │
│       ↓                                                     │
│  Issue found? ──┬── Yes ──→ Create BACKLOG item             │
│                 │           Await $cnx-fix-build             │
│                 │                                           │
│                 └── No  ──→ Continue patrolling              │
│                                                             │
│  $cnx-bb-debug               On-demand deep diagnosis (aux) │
│  (When Sentinel finds an issue, manually trigger deep dive) │
│                                                             │
│  $cnx-story-build            Post-fix regression verify     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Best Practices

1. **Don't do full-coverage checks** - Expensive and unnecessary
2. **Random + Hotspots** - Balance coverage and cost
3. **Multi-check confirmation** - Avoid false positives from intermittent failures
4. **Budget control** - Set daily/monthly AI call limits
5. **Progressive intensity** - Light during stable periods, Intensive after releases
