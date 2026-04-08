---
hidden: true
name: cnx-bb-debug
description: Universal web debugger using Playwright. Works with or without Black Box (BB) integration. Auto-detects diagnostic capability, collects console/network/DOM data, analyzes issues, and suggests fixes.
---

# BB Debug

通用 Web 调试工具，支持两种模式：
- **原生 BB 模式**: 页面已集成 Black Box，点击收集诊断数据
- **通用诊断模式**: 页面无 BB，用 Playwright 直接收集 console/network/DOM/截图

## When to Use

- "调试一下页面"
- "看看什么问题"
- "页面显示空白"
- "功能不工作"
- 任何需要诊断网页问题的场景

## Two Diagnostic Modes

### Mode 1: Native BB (Page has Black Box integrated)

```
Page with BB  →  Playwright clicks BB button  →  Download diagnostic JSON
```

Requirements:
- Page has `[data-testid="bb-toggle"]` button
- Or exposes `window.__BB_DATA__`
- Or stores data in `localStorage.bb_diagnostic`

### Mode 2: Universal Diagnostic (No BB required)

```
Any page  →  Playwright injects collector  →  Gather console/network/DOM/screenshot
```

Collects:
- Console logs (error/warn/info)
- Network requests (failed XHR/fetch)
- DOM state (key elements visibility)
- Screenshot (full page + viewport)
- Performance metrics (load time, render blocking)
- JavaScript errors

## Quick Start

```bash
# 诊断并自动分析（推荐）
$cnx-bb-debug https://example.com/page
# 自动收集 → 自动调用 $cnx-bb-analyzer 分析 → 输出诊断结论

# 仅收集数据（不自动分析）
$cnx-bb-debug https://example.com/page --no-analyze

# 强制通用诊断模式
$cnx-bb-debug https://example.com/page --universal

# 诊断并自动修复
$cnx-bb-debug https://example.com/page --fix
```

## Usage Examples

### Example 1: Auto-detect + Auto-analyze (默认)

```bash
$cnx-bb-debug https://yyy.up.railway.app/story/cars/chapter/1

🔍 Detecting diagnostic capability...
├── ✅ BB found: [data-testid="bb-toggle"]
└── ✅ Using: Native BB mode

📊 Collecting data...
├── Console: 3 errors, 5 warnings
├── Network: 2 failed requests
├── DOM: #app rendered, .content empty
└── Screenshot: saved to /tmp/bb-screenshot.png

📝 Report: /tmp/bb-report.json

🔍 Auto-analyzing with $cnx-bb-analyzer...

## 📊 BB 诊断分析报告

### 🔴 关键发现
| 指标 | 值 | 状态 |
|------|-----|------|
| contentLength | 0 | ❌ 未加载 |
| audioState.src | "" | ❌ 未设置 |
| hasText | false | ❌ 无内容 |

### 🎯 诊断结论
useEffect 依赖错误导致内容未加载。依赖 `[chapter?.id]` 应为 `[chapter?.number]`

### 🔧 建议修复
修改 Player.tsx 第 45 行，将 useEffect 依赖从 `[chapter?.id]` 改为 `[chapter?.number]`
```

### Example 2: Universal mode (no BB)

```bash
$cnx-bb-debug https://example.com --universal

🔍 Universal diagnostic mode (no BB required)

📊 Collected:
├── Console Errors: 2
│   ├── TypeError: Cannot read property 'id' of undefined
│   │   at Player.tsx:45
│   └── ReferenceError: AudioContext is not defined
├── Failed Network: 1
│   └── GET https://api.example.com/data 404
├── DOM State:
│   ├── body.innerHTML length: 2340
│   ├── #root: ✅ rendered
│   ├── .loading: ❌ still visible (timeout?)
│   └── .error-message: ✅ visible
├── Performance:
│   ├── DOMContentLoaded: 1.2s
│   ├── First Contentful Paint: 2.3s
│   └── Largest Contentful Paint: 4.5s
└── Screenshot: /tmp/bb-screenshot.png

📝 Report: /tmp/bb-report.json
```

### Example 3: Batch diagnostic

```bash
# Diagnose multiple pages
$cnx-bb-debug https://site.com/page1,https://site.com/page2,https://site.com/page3

# Or from file
$cnx-bb-debug --file urls.txt
```

## Workflow

```
User: "调试一下页面"
    │
    ▼
┌─────────────────────────────────────┐
│ 1. Auto-detect diagnostic mode      │
│    ├── Try BB button → found?       │
│    ├── Try window.__BB_DATA__?      │
│    └── Fallback to Universal        │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ 2. Collect diagnostic data          │
│    ├── Console logs                 │
│    ├── Network requests             │
│    ├── DOM state                    │
│    └── Screenshot                   │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ 3. Auto-analyze (call $cnx-bb-analyzer) │
│    ├── Read /tmp/bb-report.json     │
│    ├── Root cause analysis          │
│    ├── Issue severity               │
│    └── Fix suggestions              │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ 4. Auto-fix (if --fix flag)         │
│    ├── Generate fix                 │
│    ├── Apply via TCR                │
│    └── Deploy & verify              │
└─────────────────────────────────────┘
```

**Note:** 默认自动调用 `$cnx-bb-analyzer` 分析。使用 `--no-analyze` 跳过分析仅收集数据。

## Data Format

### Native BB Mode Output

```json
{
  "mode": "native-bb",
  "timestamp": "2024-01-15T10:30:00Z",
  "url": "https://example.com/page",
  "bbData": { /* Original BB data */ },
  "collected": {
    "console": [...],
    "network": [...]
  }
}
```

### Universal Mode Output

```json
{
  "mode": "universal",
  "timestamp": "2024-01-15T10:30:00Z",
  "url": "https://example.com/page",
  "diagnostic": {
    "console": {
      "errors": [{"message": "...", "stack": "...", "timestamp": "..."}],
      "warnings": [...],
      "logs": [...]
    },
    "network": {
      "failed": [{"url": "...", "status": 404, "method": "GET"}],
      "slow": [{"url": "...", "duration": 5000}]
    },
    "dom": {
      "title": "Page Title",
      "keyElements": {
        "#root": {"exists": true, "visible": true, "children": 5},
        ".error": {"exists": false}
      }
    },
    "performance": {
      "navigationStart": 1234567890,
      "domContentLoaded": 1234568000,
      "loadEventEnd": 1234568200
    }
  },
  "screenshots": {
    "viewport": "/tmp/bb-viewport.png",
    "fullPage": "/tmp/bb-fullpage.png"
  }
}
```

## Comparison

| Feature | Native BB Mode | Universal Mode |
|---------|---------------|----------------|
| Requires BB integration | ✅ Yes | ❌ No |
| Console logs | ✅ | ✅ |
| Network data | ✅ | ✅ |
| DOM state | ✅ Detailed | ✅ Key elements |
| App-specific metrics | ✅ | ❌ |
| Screenshot | ✅ | ✅ |
| Performance metrics | ✅ | ✅ |
| Works on any site | ❌ | ✅ |

## Implementation Notes

### Universal Mode Injection

When page has no BB, we inject a lightweight collector:

```javascript
// Injected via Playwright page.evaluate()
window.__BB_DEBUG_COLLECTOR__ = {
  console: [],
  network: [],
  errors: [],
  
  init() {
    // Hook console methods
    ['error', 'warn', 'log', 'info'].forEach(method => {
      const original = console[method];
      console[method] = (...args) => {
        this.console.push({method, args, timestamp: Date.now()});
        original.apply(console, args);
      };
    });
    
    // Hook fetch/XHR
    // ... network interception
    
    // Listen to errors
    window.addEventListener('error', e => {
      this.errors.push({message: e.message, stack: e.error?.stack});
    });
  },
  
  getData() {
    return {
      console: this.console,
      network: this.network,
      errors: this.errors,
      dom: this.captureDOM(),
      performance: this.capturePerformance()
    };
  }
};
```

### No "Removal" Needed

The injected collector:
- Only exists in the Playwright browser context
- Page refresh → collector gone
- New session → no trace
- No need to "uninstall"

## Integration with Build Skills

After `$cnx-bb-debug` finds issues:

```bash
# User: "修复这个问题"
# → Automatically create FIX-XXX in backlog
# → $cnx-fix-build FIX-XXX

# Or for complex issues
# → Create US-XXX in backlog  
# → $cnx-story-build US-XXX
```
