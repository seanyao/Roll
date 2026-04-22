---
name: roll-debug
description: 'Use when diagnosing a broken web page — collect diagnostics, analyze root cause, suggest fix. Triggers: "页面白屏", "debug the page", "see what''s wrong", "功能不生效", "page shows blank", user uploads diagnostics-*.json or bb-report.json. Typical: "$roll-debug https://...", "页面挂了看看", "帮我分析这份 bb-report", "search 为啥没结果". Flow: pick mode (native Black Box click or Playwright universal collector) → gather console/network/DOM/screenshot → analyze → propose fix. Do NOT trigger: known FIX-XXX ready to fix (use roll-fix), backlog tracking only (use roll-jot), scheduled production patrol (use roll-sentinel).'
---

# Roll Debug

Universal web debugging tool that combines diagnostic collection and analysis into a single workflow: **Diagnose → Analyze → Suggest Fix**.

Two collection modes:
- **Native BB Mode**: Page has Black Box integrated; click button to collect rich diagnostic data
- **Universal Diagnostic Mode**: Page has no BB; use Playwright to directly collect console/network/DOM/screenshot data

## When to Use

- "Debug the page"
- "See what's wrong"
- "Page shows blank"
- "Feature not working"
- User uploads a diagnostic file (`diagnostics-*.json`, `bb-report.json`)
- "Analyze BB data", "look at the diagnostic file"
- Any scenario requiring web page diagnosis

## Quick Start

```bash
# Full workflow: collect + analyze + suggest fix (recommended)
$roll-debug https://example.com/page

# Collect data only, skip analysis
$roll-debug https://example.com/page --no-analyze

# Force universal diagnostic mode (no BB)
$roll-debug https://example.com/page --universal

# Collect + analyze + auto-fix
$roll-debug https://example.com/page --fix

# Analyze an existing report file (skip collection)
$roll-debug --report /tmp/bb-report.json

# Batch: diagnose multiple pages
$roll-debug https://site.com/page1,https://site.com/page2
$roll-debug --file urls.txt
```

## Two Collection Modes

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
- Network requests (failed XHR/fetch, slow requests)
- DOM state (key elements visibility, HTML length)
- Screenshot (full page + viewport)
- Performance metrics (load time, FCP, LCP, render blocking)
- JavaScript errors with stack traces

## Full Workflow

```
User: "Debug the page"
    │
    ▼
┌─────────────────────────────────────┐
│ 1. Auto-detect collection mode      │
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
│ 3. Analyze report                   │
│    ├── Read /tmp/bb-report.json     │
│    ├── Root cause analysis          │
│    ├── Issue severity               │
│    └── Structured findings          │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ 4. Suggest (or apply) fix           │
│    ├── Actionable fix suggestions   │
│    ├── Auto-fix via TCR (--fix)     │
│    └── Deploy & verify              │
└─────────────────────────────────────┘
```

## Usage Examples

### Example 1: Full auto-detect + analyze (default)

```bash
$roll-debug https://yyy.up.railway.app/story/cars/chapter/1

Detecting diagnostic capability...
├── BB found: [data-testid="bb-toggle"]
└── Using: Native BB mode

Collecting data...
├── Console: 3 errors, 5 warnings
├── Network: 2 failed requests
├── DOM: #app rendered, .content empty
└── Screenshot: saved to /tmp/bb-screenshot.png

Report: /tmp/bb-report.json

Analyzing...

## Diagnostic Analysis Report

### Basic Info
| Field | Value |
|-------|-------|
| Diagnostic Mode | native-bb |
| Page URL | https://yyy.up.railway.app/story/cars/chapter/1 |

### Key Findings
| Metric | Value | Status |
|--------|-------|--------|
| contentLength | 0 | Not loaded |
| audioState.src | "" | Not set |
| hasText | false | No content |
| Console Errors | 3 | Critical |
| Network Failed | 2 | Critical |

### Diagnosis Conclusion
useEffect dependency error causing content not to load.
Dependency `[chapter?.id]` should be `[chapter?.number]`

### Suggested Fix
Modify Player.tsx line 45, change useEffect dependency
from `[chapter?.id]` to `[chapter?.number]`
```

### Example 2: Universal mode (no BB)

```bash
$roll-debug https://example.com --universal

Universal diagnostic mode (no BB required)

Collected:
├── Console Errors: 2
│   ├── TypeError: Cannot read property 'id' of undefined
│   │   at Player.tsx:45
│   └── ReferenceError: AudioContext is not defined
├── Failed Network: 1
│   └── GET https://api.example.com/data 404
├── DOM State:
│   ├── body.innerHTML length: 2340
│   ├── #root: rendered
│   ├── .loading: still visible (timeout?)
│   └── .error-message: visible
├── Performance:
│   ├── DOMContentLoaded: 1.2s
│   ├── First Contentful Paint: 2.3s
│   └── Largest Contentful Paint: 4.5s
└── Screenshot: /tmp/bb-screenshot.png

Report: /tmp/bb-report.json

Analyzing...

### Key Findings
| Metric | Value | Status |
|--------|-------|--------|
| Console Errors | 2 | Critical |
| Network Failed | 1 | Critical |
| DOM Rendering | Partial | Warning |
| Load Time (LCP) | 4.5s | Slow |

### Diagnosis Conclusion
API endpoint returning 404 causes content not to load.
AudioContext undefined suggests missing polyfill or browser incompatibility.

### Suggested Fix
1. Fix API route for /data endpoint (404)
2. Add AudioContext polyfill or guard with `typeof AudioContext !== 'undefined'`
```

### Example 3: Analyze existing report file

```bash
$roll-debug --report /tmp/bb-report.json

Reading report: /tmp/bb-report.json (mode: universal)

### Key Findings
...
```

## Analysis: Supported Report Formats

| Format | Source | Description |
|--------|--------|-------------|
| Native BB | Page with Black Box | `window.__BB_DATA__` or `localStorage.bb_diagnostic` |
| Universal | Playwright collector | Injected collector data |
| Legacy | Old diagnostic files | Backward compatible |

### Native BB Mode Fields

```javascript
const bbData = report.diagnostic.bbData;
bbData.contentState?.hasText
bbData.contentState?.contentLength
bbData.audioState?.src
bbData.audioState?.error
bbData.hasAudio
bbData.errors
```

### Universal Mode Fields

```javascript
const d = report.diagnostic;
d.console.errors
d.console.warnings
d.network.failed
d.network.slow
d.dom.title
d.dom['#root']
d.dom.htmlLength
d.performance.loadComplete
d.performance.domContentLoaded
d.errors
```

## Analysis Report Template

```markdown
## Diagnostic Analysis Report

### Basic Info
| Field | Value |
|-------|-------|
| Diagnostic Mode | {native-bb / universal} |
| Page URL | {url} |
| Collected At | {timestamp} |

### Key Findings
| Metric | Value | Status |
|--------|-------|--------|
| Console Errors | {N} | {Critical if >0, OK if 0} |
| Network Failed | {N} | {Critical if >0, OK if 0} |
| DOM Rendering | {status} | {OK / Not rendered} |
| Load Time | {X}ms | {OK <2s, Slow 2-5s, Critical >5s} |

### Diagnosis Conclusion
{Root cause in plain language}

### Suggested Fix
{Actionable fix steps}
```

## Common Issue Patterns

### Blank Page
- `dom.htmlLength < 500` or `dom['#root'].visible = false`
- Fix: Check console errors, add error boundary

### Content Not Loading
- `hasText = false` or `contentLength = 0`
- Fix: Check API, refresh OSS URL, fix useEffect dependencies

### Audio Error
- `audioState.error` exists
- Fix: Refresh signed URL, check audio format compatibility

### Network Failure
- `network.failed` has 4xx/5xx responses
- Fix: Check API routes, add CORS headers

### Performance Issues
- LCP > 5s or DOMContentLoaded > 3s
- Fix: Code-split large bundles, lazy-load images, cache API responses

## Implementation Notes

### Universal Mode Injection

When page has no BB, inject a lightweight collector via `page.evaluate()`:

```javascript
window.__ROLL_DEBUG_COLLECTOR__ = {
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

    // Hook fetch/XHR for network interception

    // Listen for JS errors
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

The injected collector only exists in the Playwright browser context — no cleanup needed.

## Data Output Formats

### Native BB Mode

```json
{
  "mode": "native-bb",
  "timestamp": "2024-01-15T10:30:00Z",
  "url": "https://example.com/page",
  "bbData": {},
  "collected": {
    "console": [],
    "network": []
  }
}
```

### Universal Mode

```json
{
  "mode": "universal",
  "timestamp": "2024-01-15T10:30:00Z",
  "url": "https://example.com/page",
  "diagnostic": {
    "console": {
      "errors": [{"message": "...", "stack": "...", "timestamp": "..."}],
      "warnings": [],
      "logs": []
    },
    "network": {
      "failed": [{"url": "...", "status": 404, "method": "GET"}],
      "slow": [{"url": "...", "duration": 5000}]
    },
    "dom": {
      "title": "Page Title",
      "htmlLength": 2340,
      "keyElements": {
        "#root": {"exists": true, "visible": true, "children": 5},
        ".error": {"exists": false}
      }
    },
    "performance": {
      "domContentLoaded": 1200,
      "loadComplete": 2300,
      "firstContentfulPaint": 2300,
      "largestContentfulPaint": 4500
    }
  },
  "screenshots": {
    "viewport": "/tmp/roll-debug-viewport.png",
    "fullPage": "/tmp/roll-debug-fullpage.png"
  }
}
```

## Capability Comparison

| Feature | Native BB Mode | Universal Mode |
|---------|---------------|----------------|
| Requires BB integration | Yes | No |
| Console logs | Yes | Yes |
| Network data | Yes | Yes |
| DOM state | Detailed | Key elements |
| App-specific metrics | Yes | No |
| Screenshot | Yes | Yes |
| Performance metrics | Yes | Yes |
| Works on any site | No | Yes |

## Integration with Build Skills

After `$roll-debug` finds issues:

```bash
# For a single-file bug fix
# → Create FIX-XXX in backlog
# → $roll-fix FIX-XXX

# For a complex multi-step fix
# → Create US-XXX in backlog
# → $roll-build US-XXX
```
