## 爬虫能力/架构大升级
### 为了更强的反爬能力
- Scrapling: https://github.com/D4Vinci/Scrapling/blob/main/README.md
  能作为完整的爬虫框架也能处理单个页面
  我测试了一下(/Users/tianzhipeng/Desktop/test_scrapling/README.md), 爬kickstarter网站效果比本项目现在的好很多, 也支持点击交互和结构化抽取.
- Crawl4ai: https://github.com/unclecode/crawl4ai/blob/main/README.md
  能作为完整的爬虫框架也能处理单个页面
  我测试了一下(/Users/tianzhipeng/Desktop/test_crawl4ai/README.md), 爬kickstarter网站效果比本项目现在的好很多, 也支持点击交互和结构化抽取.
- CloakBrowser: https://github.com/CloakHQ/CloakBrowser/blob/main/README.md
  通过所有机器人检测测试的隐身Chrome, 类似CloakBrowser/Camoufox对应Firefox。即插即用的 Playwright 替代品，可以集成到各种爬虫框架(包括crawlee/scrapling/Crawl4ai)
  我测试了将他直接集成/替换到本项目现有的playwright, 反爬能力也提升很大. (见)

### 选型对比表
如下是外部调研得到的三种框架对比表(没有结合本项目现状的)
| 维度              | Scrapling                                                                                                                                         | Crawl4AI                                                                                                                                 | Crawlee + Playwright + CloakBrowser/CloakBrowser/Camoufox                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **核心定位**        | 现代 Python 抓取框架，强反爬、抗 DOM 变动、自适应选择器                                                                                                                | 面向 LLM/RAG 的网页清洗、Markdown、JSON 抽取                                                                                                        | 生产级爬虫框架：队列、并发、路由、Session、代理、存储                                                                                                              |
| **反爬能力**        | **很强**。`StealthyFetcher` 明确面向高防动态站点，宣称可自动处理 Cloudflare Turnstile/Interstitial，并处理 CDP/WebRTC/headless/canvas 等检测面。([Scrapling documentation][1])  | **中强**。有 stealth mode、undetected browser、anti-bot fallback、proxy retry，但更像“逐层增强”的通用方案，不是专门的反爬浏览器框架。([Crawl4AI Documentation][2])         | **强，但取决于 CloakBrowser/Camoufox 稳定性与集成质量**。Crawlee 默认有 fingerprint 生成，SessionPool 管理代理/cookie；接入 CloakBrowser/Camoufox 后浏览器指纹层更强。([Crawlee][3])                        |
| **Markdown 抽取** | **中等偏强**。CLI/MCP 支持 HTML→Markdown/Text/HTML、CSS selector 定位、AI-targeted 清洗；但不是 Crawl4AI 那种完整 RAG markdown pipeline。([Scrapling documentation][4]) | **最强**。Markdown 是核心能力，有 raw markdown、fit markdown、BM25/Pruning 过滤、引用链接等，适合 RAG/Agent 输入。([Crawl4AI Documentation][5])                    | **弱到中等**。Crawlee 官方更关注“拿到页面后你自己用 Playwright/BeautifulSoup/Parsel 抽数据”；Markdown 通常要自己接 Readability/Turndown/trafilatura 等。([Crawlee][6])     |
| **截图**          | **中等**。MCP API 有 screenshot，支持 png/jpeg、full page、等待 selector/network idle；普通代码里也能通过 Playwright page action 做。([Scrapling documentation][7])      | **强**。`CrawlerRunConfig(screenshot=True)` 后 `result.screenshot` 直接拿 base64 PNG；同一结果对象还支持 PDF/MHTML。([Crawl4AI Documentation][8])         | **强**。Playwright 原生截图能力 + Crawlee KV store/错误快照/批量任务管理，很适合生产落盘。([Crawlee][9])                                                               |
| **结构化抽取**       | **强在稳定 selector 与抗页面改版**。支持 CSS/XPath/filter/text/regex，adaptive scraping 会保存元素特征，页面结构变化后按相似度重定位。([Scrapling documentation][10])                  | **最强的一体化 JSON 抽取**。支持 CSS/XPath/Regex 的 LLM-free JSON extraction，也支持 LLM schema extraction，适合直接产出结构化 JSON。([Crawl4AI Documentation][11]) | **中强，但更工程化**。基础是你在 handler 里用 Playwright API/BeautifulSoup 手写抽取并 `push_data`；JS 生态可接 StagehandCrawler 用自然语言 + schema 做 AI 抽取。([Crawlee][6]) |
| **大规模爬取工程能力**   | 中强：有 Spider、并发、多 session、pause/resume、proxy rotation。([Scrapling documentation][12])                                                              | 中等：适合多 URL、并发、内容清洗，但不是最典型的生产爬虫框架                                                                                                         | **最强**：Crawlee 的强项就是队列、路由、并发、SessionPool、proxy、storage、部署到 Apify 等                                                                          |
| **易用性**         | Python 友好，API 类 Scrapy/Parsel；强功能需要理解 fetcher/session                                                                                             | 对 LLM/RAG 用户最友好，开箱就是 markdown/extracted_content                                                                                          | 工程师友好，但 markdown/结构化抽取要自己拼装更多组件                                                                                                             |
| **主要风险**        | 反爬能力强但依赖浏览器/指纹组件，维护成本不低                                                                                                                           | 高防站点不一定比 Scrapling/CloakBrowser/Camoufox 强；undetected/stealth 有性能与成功率权衡，官方也提示不是 100% 保证。([Crawl4AI Documentation][2])                                 | CloakBrowser/Camoufox 官方 2026 文档提示新版本仍在活跃开发，预览版“不稳定、不适合生产”；生产上要锁版本、灰度测试。([CloakBrowser/Camoufox][13])                                                                 |

### 如何集成?
上述新框架, 怎么集成? (不是都要集成哦, 是在讨论方案哦)
- 是作为工具集成进来, 尝试把Crawlee当成一个整合框架?
- 还是作为crawlee的替代, 在这个项目内支持切换crawlee / xxx 作为执行框架?

### 可能需要同时考虑的架构改造
- 根据上述某种情况下, 3种爬取可能不拆的那么散? 怎么改设计? 
- base抓取是否要提供跳过的功能?
- 站点级别可以通过一种新规则来配置基础抓取/Markdown抓取/截图抓取三个阶段所使用的工具策略(选项和尝试顺序). 当然目前基础抓取和截图抓取只有一种/Markdown有三种工具, 但是未来会有很多工具.
  所谓的尝试顺序就是同一种工具，比如说Markdown工具 按照顺序第一个失败了尝试第二个，但是这里还存在一个问题，就是定义什么叫失败。可能需要一些简单的规则配置，我能想到的几种判断失败的依据，比如说响应码。但是Markdown好像没有什么响应码。就是它工具返回的是否成功。然后还有一个就是返回的Markdown的内容的长度，或者是内容进行正则匹配，里面包含一些关键词之类的. 

- 需要支持设置proxy, 失败之后加proxy重试, 暂定使用apify的proxy (https://docs.apify.com/platform/proxy/usage)

### 点击交互和结构化抽取
对于某些站点上的数据, 需要一些简单的按钮点击和结构化抽取能力, 比如获取kickstarter评论的场景. 
我在想
- 对于这种需求, 是否应该为每一个站点做一个定制化的adapter(不用考虑开发成本, 需要适配的站点不多, 而且是AI辅助开发)
- 如何和现有框架结合
