---
name: cnx-fetch
version: 3.1.0
description: |
  CNX 情报收集工具 - 网页抓取、搜索、爬取，支持产品调研、技术方案搜索、信息情报收集。
  
  **核心能力**：
  - 🔍 产品调研 - 竞品分析、市场信息
  - 📚 技术方案 - 搜索最佳实践、文档、开源项目
  - 🌐 网页提取 - 单页内容获取（五层 fallback 策略）
  - 🕷️ 全站爬取 - 深度信息收集
  
  **单页提取** - 五层 fallback 策略确保成功率接近 100%：
  1. Tavily (AI 提取，速度快)
  2. Jina AI Reader (免费，反爬强)
  3. HTTP 直连 (快速兜底，支持 gzip/deflate/br 解压)
  4. Scrapling (本地浏览器)
  5. Browser 自动化 (最终 fallback)

  **全站爬虫** - 深度递归爬取网站所有页面：
  - 自动发现页面链接
  - 可配置爬取深度
  - 同域名限制
  - 批量保存为 Markdown

  **CNX 使用场景**：
  - 产品调研阶段 - 收集竞品信息
  - 技术方案设计 - 搜索现有方案
  - 开发过程中 - 查找文档、示例代码
  - 情报收集 - 爬取网站数据

homepage: https://github.com/seanyao/cybernetix
metadata: 
  openclaw:
    emoji: 🌐
    category: web-scraping
    priority: high
    auto_trigger: 
      - "抓取网页"
      - "提取网页"
      - "获取网页内容"
      - "读取网页"
      - "网页转文本"
      - "网页转Markdown"
      - "fetch"
      - "extract"
      - "抓取"
      - "提取"
      - "爬取网站"
      - "crawl"
    requires: ["tavily", "scrapling-cli"]
    author: "T0_鲁班 (Tech Lead)"
---

# Smart Web Fetch v3.1 - 终极网页提取方案

## 🎯 设计理念

**"用户只需说一句话，系统搞定一切"**

这是团队**默认的网页抓取解决方案**，支持单页提取和全站爬虫，采用智能 fallback 策略，确保对任何网页都能提取到高质量内容。

## 🚀 功能概览

### 1. 单页提取 (Fetch)
五层 fallback 策略，确保单页面提取成功率 ~99.9%

### 2. 全站爬虫 (Crawl)
深度递归爬取，自动发现链接，批量保存

## 📊 单页提取 - 五层 Fallback

```
用户: "抓取 https://example.com"
           ↓
┌─────────────────────────────────────────────────────────────┐
│  Level 1: Tavily Extract                                     │
│  • AI 驱动的网页提取                                          │
│  • 速度快，90% 场景适用                                       │
│  • 质量检查 [通过] → 返回结果 ✓                               │
│    [失败/被拦截] ↓                                           │
├─────────────────────────────────────────────────────────────┤
│  Level 2: Jina AI Reader                                     │
│  • 免费，无需 API Key                                        │
│  • 专门训练的反爬绕过能力                                     │
│  • 质量检查 [通过] → 返回结果 ✓                               │
│    [失败/被拦截] ↓                                           │
├─────────────────────────────────────────────────────────────┤
│  Level 3: HTTP 直连 (支持 gzip/deflate/br 解压)               │
│  • 直接请求，无浏览器开销                                     │
│  • 自动处理压缩编码                                          │
│  • 质量检查 [通过] → 返回结果 ✓                               │
│    [失败] ↓                                                  │
├─────────────────────────────────────────────────────────────┤
│  Level 4: Scrapling (本地浏览器)                              │
│  • 基于 Playwright 的浏览器自动化                             │
│  • 处理 JS 渲染页面                                          │
│  • 多种提取模式自适应                                        │
│  • 质量检查 [通过] → 返回结果 ✓                               │
│    [失败] ↓                                                  │
├─────────────────────────────────────────────────────────────┤
│  Level 5: Browser 自动化                                     │
│  • OpenClaw 原生浏览器工具                                   │
│  • 真实 Chrome 环境                                          │
│  • 最终 fallback，接近 100% 成功率                           │
└─────────────────────────────────────────────────────────────┘
```

## 🕷️ 全站爬虫 (Crawl)

### 路径行为
| 模式 | 说明 | 示例 |
|------|------|------|
| 默认 | 爬取同域名所有页面，**会**上行到根目录 | 从 `/resources/` 开始，会抓到首页 `/` |
| `--stay-in-path` | 限制在起始路径下，**不会**上行 | 从 `/resources/` 开始，只抓 `/resources/*` |

### 功能特点
- ✅ **深度递归** - 可配置爬取深度（默认 2 层）
- ✅ **自动发现** - 从页面内容中提取链接
- ✅ **域名限制** - 默认只爬取同域名页面
- ✅ **路径限制** - 可选限制在子目录内
- ✅ **批量保存** - 每个页面保存为独立 Markdown 文件
- ✅ **智能提取** - 复用单页提取的 fallback 策略
- ✅ **礼貌爬取** - 自动添加延迟，避免对目标站点造成压力

### 爬虫参数
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `maxDepth` | 最大爬取深度 | 2 |
| `maxPages` | 最大页面数 | 50 |
| `stayInPath` | 限制在起始路径下 | false |

## 🛠️ 工具命令

### fetch - 单页提取

**描述**: 抓取单个网页内容，自动选择最佳工具

**参数**:
- `url` (string, required): 要抓取的网页 URL
- `method` (string, optional): 指定方法 - 'auto'(默认), 'tavily', 'jina', 'http', 'scrapling', 'browser'

**使用示例**:
```
抓取 https://example.com
提取 https://github.com/openclaw/openclaw 的内容
获取网页 https://example.com
```

**返回**:
```json
{
  "success": true,
  "url": "https://example.com",
  "tool_used": "tavily",
  "fallback_used": false,
  "content": "...",
  "title": "页面标题",
  "quality_score": 0.95,
  "quality_check": "passed"
}
```

### crawl - 全站爬虫

**描述**: 深度爬取整个网站，自动发现页面并批量保存

**参数**:
- `url` (string, required): 起始 URL
- `maxDepth` (number, optional): 最大爬取深度 (默认: 2)
- `maxPages` (number, optional): 最大页面数 (默认: 50)
- `stayInPath` (boolean, optional): 限制在起始路径下，不上行到父目录 (默认: false)

**使用示例**:
```
爬取 https://example.com
爬取 https://docs.openclaw.ai 深度 3 限制 100
抓取整个网站 https://example.com

# 限制在子目录内（不上行到根目录）
爬取 https://www.biposervice.com/resources/ --stay-in-path
```

**说明**:
- 默认情况下，爬虫会抓取同域名下的**所有页面**，包括从子目录回到首页的链接
- 使用 `--stay-in-path` 参数，爬虫只会抓取路径以起始 URL 为前缀的页面

**返回**:
```json
{
  "start_url": "https://example.com",
  "total_pages": 25,
  "successful": 23,
  "failed": 2,
  "output_directory": "/tmp/crawl_123456",
  "pages": [
    {
      "url": "https://example.com",
      "depth": 0,
      "title": "Home",
      "tool": "http",
      "file": "/tmp/crawl_123456/0001_index.md",
      "quality_score": 0.87
    }
  ]
}
```

### search - 搜索

**描述**: 使用 Tavily 搜索相关内容

**参数**:
- `query` (string, required): 搜索关键词
- `max_results` (number, optional): 最多返回结果数 (默认: 5)

## 🔍 质量检测系统

### 检测维度
1. **内容长度**: 最少 200 字符
2. **关键词过滤**: 识别验证码、登录提示等
3. **内容结构**: 检测段落、标题、列表
4. **富内容**: 链接、图片、代码块等

### 质量评分 (0-1)
```
评分组成:
├── 内容长度 (0-30)
├── 内容密度 (0-25)
├── 结构指标 (0-25)
└── 富内容 (0-20)
```

## 💡 使用场景对比

### 场景 1: 单篇文章
```
输入: 抓取 https://news.example.com/article
输出: Tavily → 秒级响应，质量 0.95
```

### 场景 2: 反爬严格网站
```
输入: 抓取 https://mp.weixin.qq.com/s/xxx
过程: Tavily 被拦截 → Jina 成功 → 质量 0.88
输出: 完整文章内容
```

### 场景 3: 爬取整个文档站点
```
输入: 爬取 https://docs.example.com 深度 3
过程: 
  - 首页 → 提取链接
  - 发现 25 个相关页面
  - 逐个抓取并保存
输出: /tmp/crawl_xxx/ 目录下 25 个 markdown 文件
```

## 🔧 命令行使用

```bash
# 单页提取
smart-web-fetch fetch https://example.com
smart-web-fetch fetch https://example.com jina

# 全站爬虫
smart-web-fetch crawl https://example.com
smart-web-fetch crawl https://example.com 3 100  # 深度3，最多100页

# 基准测试
smart-web-fetch benchmark https://example.com

# 搜索
smart-web-fetch search "OpenAI GPT-5" 10
```

## 📝 更新日志

### v3.1.0 (2025-03-11)
- ✨ 新增 **全站爬虫 (crawl)** 功能
- ✨ 支持 gzip/deflate/br 自动解压
- ✨ HTTP 请求优化，处理压缩内容
- 🚀 成功率保持 ~99.9%

### v3.0.0 (2025-03-11)
- ✨ 新增 Jina AI Reader 作为 Level 2 fallback
- ✨ 新增 HTTP 直连作为 Level 3 fallback
- ✨ 新增 Browser 自动化作为 Level 5 fallback
- ✨ 增强质量检测系统
- 🚀 成功率从 ~95% 提升至 ~99.9%

## 🔗 相关资源

- **Tavily**: https://tavily.com - AI 网页提取 API
- **Jina AI Reader**: https://jina.ai/reader - 免费网页提取
- **Scrapling**: https://github.com/D4Vinci/Scrapling - 本地浏览器抓取
- **OpenClaw Browser**: 内置浏览器自动化工具

---

**记住**: 无需指定工具，直接说 "抓取 [URL]" 或 "爬取 [URL]" 即可！