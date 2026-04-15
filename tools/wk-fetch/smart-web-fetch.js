#!/usr/bin/env node
/**
 * Smart Web Fetch Skill - Simplified 3-Layer Strategy
 * 三层策略: Tavily → LLM Native → Browser
 * 移除 mcporter, 直接 HTTP 调用, Key 从环境变量获取
 */

const { execSync } = require('child_process');
const https = require('https');

// Configuration
const TAVILY_TIMEOUT = 30000;
const BROWSER_TIMEOUT = 90000;
const MIN_CONTENT_LENGTH = 200;
const MAX_RETRIES = 2;

// Blocked content keywords
const BLOCKED_KEYWORDS = [
  // Chinese
  '验证', 'captcha', '请登录', '环境异常', '登录后', '需要验证',
  '请完成验证', '安全检查', '访问受限', 'blocked', 'access denied',
  '拖动滑块', '完成拼图', '点击验证', '继续访问', '登录查看',
  '验证后即可', '异常访问', '安全验证', '人机验证',
  // English
  'verify', 'verification', 'complete the verification', 'captcha required',
  'please log in', 'sign in to', 'access denied', 'blocked',
  'security check', 'human verification', 'prove you\'re human'
];

/**
 * Check if content is blocked or low quality
 */
function isBlockedOrLowQuality(content, source = 'unknown') {
  if (!content || content.length < MIN_CONTENT_LENGTH) {
    return { blocked: true, reason: 'Content too short or empty', severity: 'high' };
  }
  
  const lowerContent = content.toLowerCase();
  const foundKeywords = [];
  
  for (const keyword of BLOCKED_KEYWORDS) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      foundKeywords.push(keyword);
    }
  }
  
  if (foundKeywords.length > 0) {
    const isLikelyBlocked = foundKeywords.some(k => 
      ['验证', 'captcha', '环境异常', '请登录', '拖动滑块'].includes(k)
    );
    return { 
      blocked: isLikelyBlocked, 
      reason: `Detected keywords: ${foundKeywords.slice(0, 3).join(', ')}`,
      severity: isLikelyBlocked ? 'high' : 'medium'
    };
  }
  
  return { blocked: false };
}

/**
 * Calculate content quality score
 */
function calculateQualityScore(content) {
  if (!content) return 0;
  
  let score = 0;
  const length = content.length;
  
  // Length score (0-30)
  score += Math.min(Math.log10(length) * 10, 30);
  
  // Content density (0-25)
  const wordCount = content.split(/\s+/).length;
  const avgWordLength = content.length / wordCount;
  if (avgWordLength > 3 && avgWordLength < 15) score += 15;
  if (content.match(/[。\.]/g)?.length > 5) score += 10;
  
  // Structure indicators (0-25)
  if (content.includes('#') || content.includes('##')) score += 8;
  if (content.includes('###')) score += 5;
  if (content.includes('- ') || content.includes('* ')) score += 6;
  if (content.includes('```')) score += 6;
  
  // Rich content indicators (0-20)
  if (content.match(/\[.*?\]\(.*?\)/)) score += 5;
  if (content.match(/\!\[.*?\]\(.*?\)/)) score += 5;
  if (content.match(/\*\*.*?\*\*/)) score += 5;
  if (content.match(/`.*?`/)) score += 5;
  
  return Math.min(score / 100, 1.0);
}

/**
 * Level 1: Tavily API (HTTP direct call)
 */
function tryTavily(url, retries = 0) {
  console.error(`[SmartFetch] Level 1: Trying Tavily for: ${url}`);
  
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { 
      success: false, 
      tool: 'tavily', 
      error: 'TAVILY_API_KEY not set in environment',
      needs_fallback: true
    };
  }
  
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      urls: [url],
      api_key: apiKey,
      extract_depth: 'advanced',
      include_images: false
    });
    
    const options = {
      hostname: 'api.tavily.com',
      path: '/extract',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: TAVILY_TIMEOUT
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (response.results && response.results[0]) {
            const result = response.results[0];
            const content = result.raw_content || result.content || '';
            
            if (content.length > MIN_CONTENT_LENGTH) {
              resolve({
                success: true,
                tool: 'tavily',
                content: content,
                title: result.title || '',
                url: result.url || url
              });
            } else {
              resolve({ 
                success: false, 
                tool: 'tavily', 
                error: 'Content too short',
                needs_fallback: true
              });
            }
          } else if (response.error) {
            resolve({ 
              success: false, 
              tool: 'tavily', 
              error: response.error,
              needs_fallback: true
            });
          } else {
            resolve({ 
              success: false, 
              tool: 'tavily', 
              error: 'No results',
              needs_fallback: true
            });
          }
        } catch (e) {
          resolve({ 
            success: false, 
            tool: 'tavily', 
            error: `Parse error: ${e.message}`,
            needs_fallback: true
          });
        }
      });
    });
    
    req.on('error', (err) => {
      if (retries < MAX_RETRIES) {
        console.error(`[SmartFetch] Tavily error, retrying... (${retries + 1}/${MAX_RETRIES})`);
        resolve(tryTavily(url, retries + 1));
      } else {
        resolve({ 
          success: false, 
          tool: 'tavily', 
          error: err.message,
          needs_fallback: true
        });
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      if (retries < MAX_RETRIES) {
        console.error(`[SmartFetch] Tavily timeout, retrying... (${retries + 1}/${MAX_RETRIES})`);
        resolve(tryTavily(url, retries + 1));
      } else {
        resolve({ 
          success: false, 
          tool: 'tavily', 
          error: 'Timeout',
          needs_fallback: true
        });
      }
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Level 2: LLM Native Fetch (return instruction for caller)
 */
function tryLLMNative(url) {
  console.error(`[SmartFetch] Level 2: LLM Native Fetch for: ${url}`);
  
  return {
    success: false,
    tool: 'llm_native',
    error: 'LLM Native fetch requires caller to use FetchURL tool',
    instruction: `Use FetchURL tool to fetch "${url}" and return the content`,
    needs_fallback: true,
    native_fetch: true,
    url: url
  };
}

/**
 * Check if browser-use is installed locally
 */
function isBrowserUseInstalled() {
  try {
    execSync('/opt/homebrew/bin/python3.11 -c "import browser_use"', { 
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe'
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Level 3: Browser Automation (Local first, then Cloud)
 */
async function tryBrowser(url) {
  console.error(`[SmartFetch] Level 3: Trying Browser automation for: ${url}`);
  
  // Try local browser-use first
  if (isBrowserUseInstalled()) {
    console.error('[SmartFetch] Using local browser-use...');
    
    try {
      const result = execSync(
        `/opt/homebrew/bin/python3.11 -c "
import asyncio
import sys
from browser_use import Browser, BrowserConfig

async def fetch():
    browser = Browser(config=BrowserConfig(headless=True))
    await browser.start()
    try:
        page = await browser.get_current_page()
        await page.goto('${url}', wait_until='networkidle')
        content = await page.content()
        title = await page.title()
        print(f'TITLE:{title}')
        print('---CONTENT---')
        print(content)
    finally:
        await browser.stop()

asyncio.run(fetch())
        "`,
        { 
          encoding: 'utf-8', 
          timeout: BROWSER_TIMEOUT,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      
      // Parse output
      const lines = result.split('\n');
      let title = '';
      let content = result;
      
      for (const line of lines) {
        if (line.startsWith('TITLE:')) {
          title = line.substring(6);
        } else if (line === '---CONTENT---') {
          const idx = lines.indexOf(line);
          content = lines.slice(idx + 1).join('\n');
          break;
        }
      }
      
      // Convert HTML to text (simple)
      const textContent = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .trim();
      
      if (textContent.length > MIN_CONTENT_LENGTH) {
        return {
          success: true,
          tool: 'browser_local',
          content: textContent,
          title: title,
          url: url
        };
      }
      
      return { 
        success: false, 
        tool: 'browser_local', 
        error: 'Content too short' 
      };
      
    } catch (error) {
      console.error(`[SmartFetch] Local browser failed: ${error.message.split('\n')[0]}`);
      // Fall through to cloud
    }
  } else {
    console.error('[SmartFetch] Local browser-use not installed, trying cloud...');
  }
  
  // Try Cloud browser-use (if API key available)
  const cloudApiKey = process.env.BROWSER_USE_API_KEY;
  if (!cloudApiKey) {
    return { 
      success: false, 
      tool: 'browser', 
      error: 'Browser automation failed. Local browser-use not installed, and BROWSER_USE_API_KEY not set for cloud.'
    };
  }
  
  // Cloud browser-use would be implemented here
  // For now, return error with setup instructions
  return {
    success: false,
    tool: 'browser_cloud',
    error: 'Cloud browser-use not yet implemented. Please install local browser-use: pip install browser-use && playwright install chromium'
  };
}

/**
 * Smart fetch with 3-layer fallback
 * Strategy: Tavily → LLM Native → Browser
 */
async function smartFetch(url, options = {}) {
  const method = options.method || 'auto';
  const skipQualityCheck = options.skipQualityCheck || false;
  
  console.error(`[SmartFetch] Starting fetch for: ${url} (method: ${method})`);
  
  // Explicit method selection
  if (method !== 'auto') {
    switch (method) {
      case 'tavily': return await tryTavily(url);
      case 'native': return tryLLMNative(url);
      case 'browser': return await tryBrowser(url);
      default: return { success: false, error: 'Unknown method' };
    }
  }
  
  // Auto mode: 3-layer cascade
  
  // Level 1: Tavily
  const tavilyResult = await tryTavily(url);
  
  if (tavilyResult.success) {
    const quality = isBlockedOrLowQuality(tavilyResult.content, 'tavily');
    
    if (skipQualityCheck || !quality.blocked) {
      const score = calculateQualityScore(tavilyResult.content);
      console.error(`[SmartFetch] ✓ Tavily succeeded (quality: ${score.toFixed(2)})`);
      
      return {
        ...tavilyResult,
        fallback_used: false,
        quality_score: score,
        quality_check: 'passed'
      };
    }
    
    console.error(`[SmartFetch] Tavily content blocked: ${quality.reason}`);
  } else {
    console.error(`[SmartFetch] Tavily failed: ${tavilyResult.error}`);
    
    // If Tavily key not set, skip to next level
    if (!tavilyResult.needs_fallback) {
      return tavilyResult;
    }
  }
  
  // Level 2: LLM Native Fetch
  console.error('[SmartFetch] Falling back to LLM Native...');
  const nativeResult = tryLLMNative(url);
  
  // Return instruction for caller to handle
  return {
    ...nativeResult,
    fallback_used: true,
    fallback_chain: ['tavily']
  };
  
  // Note: Browser (Level 3) is called by the agent if native fetch fails
}

/**
 * Smart search with Tavily (HTTP direct)
 */
function smartSearch(query, maxResults = 5) {
  console.error(`[SmartFetch] Searching: ${query}`);
  
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { 
      success: false, 
      error: 'TAVILY_API_KEY not set in environment'
    };
  }
  
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      query: query,
      api_key: apiKey,
      max_results: maxResults,
      search_depth: 'advanced',
      include_answer: true
    });
    
    const options = {
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: TAVILY_TIMEOUT
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve({
            success: true,
            query: query,
            results: response.results || [],
            answer: response.answer || ''
          });
        } catch (e) {
          resolve({ success: false, error: `Parse error: ${e.message}` });
        }
      });
    });
    
    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });
    
    req.write(postData);
    req.end();
  });
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (command === 'fetch') {
    const url = args[1];
    const method = args[2] || 'auto';
    
    if (!url) {
      console.log(JSON.stringify({ error: 'URL required' }));
      process.exit(1);
    }
    
    smartFetch(url, { method }).then(result => {
      console.log(JSON.stringify(result, null, 2));
    }).catch(err => {
      console.log(JSON.stringify({ error: err.message }));
      process.exit(1);
    });
  }
  
  else if (command === 'search') {
    const query = args[1];
    const maxResults = parseInt(args[2]) || 5;
    
    if (!query) {
      console.log(JSON.stringify({ error: 'Query required' }));
      process.exit(1);
    }
    
    smartSearch(query, maxResults).then(result => {
      console.log(JSON.stringify(result, null, 2));
    });
  }
  
  else {
    console.log(`
Smart Web Fetch Skill - 3-Layer Strategy

Usage:
  smart-web-fetch fetch <url> [method]
  smart-web-fetch search <query> [max_results]

Methods: auto (default), tavily, native, browser

3-Layer Strategy:
  1. Tavily        - AI extraction, best quality (needs TAVILY_API_KEY)
  2. LLM Native    - Use FetchURL tool (for agents with native capability)
  3. Browser       - Local browser-use (fallback for stubborn pages)

Environment Variables:
  TAVILY_API_KEY       - Required for Tavily API
  BROWSER_USE_API_KEY  - Optional for cloud browser (local preferred)

Examples:
  smart-web-fetch fetch https://example.com
  smart-web-fetch fetch https://example.com tavily
  smart-web-fetch search "OpenAI GPT-5" 10

Install local browser:
  pip install browser-use
  playwright install chromium
`);
  }
}

module.exports = { smartFetch, smartSearch, tryTavily, tryLLMNative, tryBrowser };
