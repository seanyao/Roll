---
name: cnx-fetch
description: Web page fetching and crawling for AI agents. Extract content from URLs for research, documentation, and competitive analysis.
---

# CNX Fetch - Web Content Extraction

Extract content from web pages for research and analysis.

## When to Use

- Product research (competitor analysis)
- Technical documentation gathering
- Code examples and best practices
- Full site crawling for backup/analysis

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

### Single Page Fetch

```
User: "Fetch https://docs.example.com/api"
→ Use Tavily API or native fetch
→ Return clean markdown content
```

### Full Site Crawl

```
User: "Crawl https://docs.example.com"
→ Start from homepage
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
| Quick article | Tavily/Native | Direct fetch |
| API docs | Crawl | Recursively fetch all pages |
| SPA site | Browser | Playwright automation |
| Paywall content | Browser | Manual extraction |
