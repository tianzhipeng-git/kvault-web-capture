# Capture Tools 参考

本文是项目内所有 `CaptureTool` 的集中说明，供配置 `captureProfiles` 时查阅。Profile 的配置方式见 [SiteConfig 抓取 Profile 配置](./site-config-capture-profiles.md)；Python 工具的安装见 [Python 抓取工具安装](./tech-details/pytools-install.md)。

## 1. 能力类型

| 能力 | 含义 | 典型产物 |
| --- | --- | --- |
| `base` | 页面基础抓取 | title、meta description、body text、链接列表；用于分类、规则判定和链接发现 |
| `markdown` | 正文 Markdown | `markdown.md` |
| `screenshot` | 全页截图 | `screenshot.png` |
| `structured` | 结构化 JSON | `structured.json` |

Executor 按 profile 中的 `tools` 顺序尝试工具；每个工具只在它**覆盖当前仍缺失的能力**时执行。工具失败或产物未通过 validator 时，继续尝试后续工具。

## 2. 默认注册顺序

`M1App` 启动时按以下顺序注册工具（与内置默认 profile 工具链一致，另含 Python 工具与站点适配器）：

```text
http-base
defuddle-markdown
lightpanda-markdown
jina-markdown
playwright-screenshot
crawl4ai-page
scrapling-page
kickstarter-comments
```

内置默认 profile（未配置 `captureProfiles` 时）只使用前 5 个 Node 工具。Python 工具与站点适配器需在 `captureProfiles.<name>.tools` 中显式加入。

## 3. 工具清单

| 工具名 | 能力 | 说明 |
| --- | --- | --- |
| `http-base` | `base` | 通过 Crawlee `RuntimeContext.sendRequest` 发起 HTTP 请求，解析 HTML 得到 title、meta、body、links |
| `defuddle-markdown` | `markdown` | BasicCrawler sendRequest抓取 HTML 后，用 Defuddle 转为 Markdown |
| `lightpanda-markdown` | `markdown` | 通过 BrowserManager 启动 Lightpanda CDP，调用 `LP.getMarkdown` 生成 Markdown |
| `jina-markdown` | `markdown` | 调用 Jina Reader API（`https://r.jina.ai/`），需配置 `JINA_API_TOKEN` |
| `playwright-screenshot` | `screenshot` | 通过 BrowserManager 打开页面，Playwright 全页 PNG 截图 |
| `crawl4ai-page` | `base`, `markdown`, `screenshot`, `structured` | Python Crawl4AI bridge；可连接项目 CDP 或自管浏览器 |
| `scrapling-page` | `base`, `markdown`, `screenshot`, `structured` | Python Scrapling `StealthyFetcher` bridge；Markdown 由 HTML 经 markdownify 转换，截图通过 `page_action` 完成 |
| `kickstarter-comments` | `structured`, `markdown` | Kickstarter 评论页站点适配器；仅当 URL 匹配 `kickstarter.com` 评论页时执行 |

如果 profile 中写了未注册的工具名，运行时会报 `Unknown capture tool`。

## 4. 按类型说明

### 4.1 HTTP / Node 单能力工具

**`http-base`** — 最轻量的 base 抓取，不启动浏览器。适合静态页或作为 Python 工具失败后的 fallback。

**`defuddle-markdown`** — 依赖 BasicCrawler sendRequest 响应体，不执行 JS。收到非 2xx 时仍可能返回 body，是否接受由 validator 决定。

**`jina-markdown`** — 外部 SaaS，不经过项目浏览器。缺 token 时会立即失败，便于 fallback 到本地 markdown 工具。

**`playwright-screenshot`** — 使用站点 `browser` 配置中的 engine（chromium / cloakbrowser / lightpanda 等），遵循 BrowserManager 的 identity 与租约策略。

### 4.2 浏览器 Markdown

**`lightpanda-markdown`** — 强制使用 `lightpanda` engine，需配置 `LIGHTPANDA_BINARY`。适合需要 JS 渲染但希望用 Lightpanda 提取正文的场景。

### 4.3 Python 一体化工具

**`crawl4ai-page`** 与 **`scrapling-page`** 均可在一次 fetch 中按 `needs` 产出多种能力：

| 能力 | crawl4ai-page | scrapling-page |
| --- | --- | --- |
| `base` | Crawl4AI 返回 HTML + 解析字段 | `html_content` + 本地解析 |
| `markdown` | Crawl4AI 内置 markdown | HTML → markdownify |
| `screenshot` | CrawlerRunConfig `screenshot=true` | StealthyFetcher `page_action` + Playwright screenshot |
| `structured` | 基础 structured 摘要 | title / meta / contentLength 等摘要 |

两者优先连接 BrowserManager 提供的 CDP endpoint，与 TS 侧浏览器身份一致；CDP 不可用时回退到各自默认浏览器启动方式。安装与 venv 拆分见 [Python 抓取工具安装](./tech-details/pytools-install.md)。

### 4.4 站点适配器

**`kickstarter-comments`** — 实现 `SiteAutomationAdapter`：Executor 会先调用 `matches()`，不匹配则跳过（不会报错）。从页面内嵌 JSON 抽取评论列表，同时产出 structured 与 markdown。

## 5. 相关文档

| 文档 | 内容 |
| --- | --- |
| [SiteConfig 抓取 Profile 配置](./site-config-capture-profiles.md) | profile 字段、执行规则、配置示例 |
| [SiteConfig 抓取结果校验](./site-config-validation.md) | validator 规则 |
| [Python 抓取工具安装](./tech-details/pytools-install.md) | crawl4ai-page / scrapling-page 环境 |
| [M2 技术设计](./m2-tech-design.md) | CaptureTool 架构、Bridge、BrowserManager |
| [Retry / Fallback / Validator](./tech-details/retry-fallback-and-validator.md) | 工具链 fallback 与 Crawlee retry |

实现入口：`src/capture/captools/`；默认注册：`src/app/services.ts`。
