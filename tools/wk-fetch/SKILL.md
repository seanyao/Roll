---
hidden: true
name: wk-fetch
description: Web page fetching and crawling for AI agents. Extract content from URLs for research, documentation, and competitive analysis.
---

# CNX Fetch - Web Content Extraction

Extract content from web pages for research and analysis.

## When to Use

- Product research (competitor analysis)
- Technical documentation gathering
- Code examples and best practices
- Full site crawling for backup/analysis

## Environment Setup

Configure API keys per machine:

```bash
# Required for Tavily
export TAVILY_API_KEY=tvly-dev-...

# Optional for cloud browser fallback
export BROWSER_USE_API_KEY=bu-...
```

Or create `.env` file in project root:
```
TAVILY_API_KEY=tvly-dev-...
BROWSER_USE_API_KEY=bu-...
```

## Methods

### 1. Tavily API (Recommended)

Best quality extraction, requires `TAVILY_API_KEY`.

```bash
# Using Tavily CLI or API
curl -X POST https://api.tavily.com/extract \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://example.com"],
    "api_key": "your_tavily_api_key"
  }'
```

**Pros**: AI-optimized extraction, handles complex layouts
**Cons**: Requires API key, rate limited

### 2. LLM Native Fetch (Default)

Use your built-in URL fetching capability directly.

**When to use**: When Tavily is unavailable or for quick checks.

**Note**: Most modern AI agents (Kimi, Codex, Claude) have native URL fetching. Use `FetchURL` tool or equivalent.

### 3. Browser Automation (Fallback)

Local browser automation for stubborn pages using **[browser-use](https://github.com/browser-use/browser-use)**.

**How to Choose:**

| If | Then Use | Why |
|----|---------|-----|
| `BROWSER_USE_API_KEY` in env | **Cloud** | Managed browsers, less setup |
| No API key, but `browser-use` installed | **Local** | Free, no external dependency |
| Neither | Skip to manual extraction | Tell user "Need browser automation setup" |

**Option A: Local (Free, No API Key)**
```python
from browser_use import Agent, Browser, BrowserConfig
import asyncio

async def fetch_page(url):
    # Pure local, no API key needed
    browser = Browser(config=BrowserConfig(headless=True))
    await browser.start()
    page = await browser.get_current_page()
    await page.goto(url)
    content = await page.content()
    await browser.stop()
    return content

# Run
content = asyncio.run(fetch_page("https://example.com"))
```

**Option B: Cloud API**
```python
from browser_use import Agent

agent = Agent(
    task=f"Extract the main content from {url} and return as markdown",
    llm="moonshot"  # or openai, anthropic
)
result = await agent.run()
```

**Setup** (Local):
```bash
pip install browser-use
playwright install chromium
```

## Usage

### CLI Usage (via smart-web-fetch.js)

```bash
# Auto mode (Tavily → Native → Browser)
node smart-web-fetch.js fetch https://example.com

# Explicit method
node smart-web-fetch.js fetch https://example.com tavily
node smart-web-fetch.js fetch https://example.com native
node smart-web-fetch.js fetch https://example.com browser

# Search
node smart-web-fetch.js search "Python async" 5
```

### Programmatic Usage

```javascript
const { smartFetch, smartSearch } = require('./smart-web-fetch.js');

// Fetch a page
const result = await smartFetch('https://example.com');
console.log(result.content);

// Search
const searchResult = await smartSearch('OpenAI GPT-5', 5);
console.log(searchResult.results);
```

### Single Page Fetch

```
User: "Fetch https://docs.example.com/api"
→ Use smart-web-fetch.js with auto mode
→ Return clean markdown content
```

### Full Site Crawl

```
User: "Crawl https://docs.example.com"
→ Use smart-web-fetch.js recursively
→ Extract all internal links
→ Recursively fetch up to max depth (default: 2)
→ Save each page as separate markdown file
```

## Output Format

Always return clean Markdown:
- Extract main content only (remove nav, ads, footers)
- Preserve code blocks and tables
- Include source URL as header

## Quality Check

Validate extracted content:
- Min length: 500 chars (reject if shorter)
- Check for captcha/error messages
- Verify main content structure (headings, paragraphs)

## Examples

| Task | Method | Command |
|------|--------|---------|
| Quick article | Auto | `node smart-web-fetch.js fetch https://blog.example.com` |
| API docs | Tavily | `node smart-web-fetch.js fetch https://docs.example.com tavily` |
| SPA site | Browser | `node smart-web-fetch.js fetch https://spa.example.com browser` |
| Search | Tavily | `node smart-web-fetch.js search "Python async" 5` |
| Fallback test | Native | `node smart-web-fetch.js fetch https://example.com native` |
