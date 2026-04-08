---
hidden: true
name: cnx-bb-analyzer
description: Analyze diagnostic reports from cnx-bb-debug. Reads BB diagnostic JSON files (native BB or universal mode) and provides structured analysis of app state, errors, API responses, and performance issues.
---

# BB Analyzer

分析 `cnx-bb-debug` 生成的诊断报告。

## When to Use

- 用户上传诊断文件 (`diagnostics-*.json`, `bb-report.json`)
- 用户说："分析 BB 数据"、"看看诊断文件"
- 调试页面问题（空白、报错、功能异常）

## Supported Report Formats

| Format | Source | Description |
|--------|--------|-------------|
| Native BB | Page with Black Box | `window.__BB_DATA__` or `localStorage.bb_diagnostic` |
| Universal | cnx-bb-debug collector | Playwright injected collector data |
| Legacy | Old diagnostic files | Backward compatible |

## Quick Start

```bash
# 分析现有报告
$cnx-bb-analyzer /tmp/bb-report.json

# 或者先收集再分析
$cnx-bb-debug https://example.com/page
$cnx-bb-analyzer /tmp/bb-report.json
```

## Analysis Process

### Step 1: Load Report

```javascript
const report = JSON.parse(fileContent);
const mode = report.mode; // 'native-bb' | 'universal'
```

### Step 2: Analyze Based on Mode

#### Native BB Mode 字段

```javascript
const bbData = report.diagnostic.bbData;

// 内容状态
bbData.contentState?.hasText
bbData.contentState?.contentLength

// 音频状态
bbData.audioState?.src
bbData.audioState?.error
bbData.hasAudio

// 错误
bbData.errors
```

#### Universal Mode 字段

```javascript
const d = report.diagnostic;

// 控制台
d.console.errors
d.console.warnings

// 网络
d.network.failed
d.network.slow

// DOM
d.dom.title
d.dom['#root']
d.dom.htmlLength

// 性能
d.performance.loadComplete
d.performance.domContentLoaded

// 错误
d.errors
```

### Step 3: Generate Report

```markdown
## 📊 BB 诊断分析报告

### 📋 基本信息
| 字段 | 值 |
|------|-----|
| 诊断模式 | {native-bb / universal} |
| 页面 URL | {url} |

### 🔴 关键发现
| 指标 | 值 | 状态 |
|------|-----|------|
| Console Errors | {N} | {🔴>0 ✅0} |
| Network Failed | {N} | {🔴>0 ✅0} |
| DOM 渲染 | {status} | {✅可见 ❌未渲染} |
| 加载时间 | {X}ms | {✅<2s 🟡2-5s ❌>5s} |

### 🎯 诊断结论
{Root cause}

### 🔧 建议修复
{Fix suggestions}
```

## Common Issues

### 页面空白
- `dom.htmlLength < 500`
- `dom['#root'].visible = false`
- **Fix**: 检查 console errors，添加 error boundary

### 内容不加载
- `hasText = false` / `contentLength = 0`
- **Fix**: 检查 API，刷新 OSS URL，修复 useEffect

### 音频错误
- `audioState.error` exists
- **Fix**: 刷新 signed URL，检查音频格式

### 网络失败
- `network.failed` has 4xx/5xx
- **Fix**: 检查 API 路由，添加 CORS

## No Report File?

如果用户没有诊断文件：

> 未找到诊断文件。先运行 `$cnx-bb-debug` 收集数据：
>
> ```bash
> $cnx-bb-debug https://your-site.com/page
> ```
>
> 然后我会自动分析生成的报告。
