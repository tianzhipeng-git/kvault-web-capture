# 爬虫能力升级目标架构设计

本文记录 Milestone2 爬虫能力升级的目标设计。它只描述架构方向和模块边界，不包含执行计划。

## 1. 背景与核心结论

Milestone2 最初要解决的是早期 M1 架构里 Crawlee 职责过重的问题。当时 Crawlee 同时被用作：

- run 内临时队列和并发调度器
- HTTP 页面抓取器（`CheerioCrawler`）
- DOM 页面抓取器（`LinkeDOMCrawler`）
- 浏览器页面抓取器（`PlaywrightCrawler`）
- 重试、Session、Proxy、blocked retry 等爬虫运行能力提供者

当前主干已经朝 `BasicCrawler + pageCaptureQueue + PageCaptureExecutor + CaptureTool` 的方向迁移；本文保留目标架构和后续浏览器能力升级边界，作为 M2 及其后续演进的设计基线。

Milestone2 希望增强反爬、代理、fallback、点击交互、结构化抽取，以及 Crawl4AI / Scrapling / CloakBrowser 等工具接入能力。继续让 `CheerioCrawler` / `LinkeDOMCrawler` / `PlaywrightCrawler` 作为阶段入口会带来两个问题：

1. 这些 crawler 会在 handler 之前先发起请求；如果它们失败，高级工具策略没有机会介入。
2. handler 中再调用高级工具会导致同一 URL 被重复请求或重复打开浏览器。
3. 浏览器、session、proxy、profile 的身份模型会分散在不同 crawler/tool 中，难以保证 HTTP 抓取、浏览器截图、Python 工具之间的身份一致。

因此目标架构是：

**Crawlee 保留为 runtime kernel；具体抓取能力下沉到独立 CaptureTool。**

在目标架构中，Crawlee 不再通过专用 crawler 决定如何抓页面，而主要提供：

- `RequestQueue`
- `BasicCrawler`
- 并发、重试、failed handler
- `sendRequest` / got-scraping HTTP 能力
- `SessionPool`
- `ProxyConfiguration`
- session/proxy 的健康状态和封禁信号

`CheerioCrawler`、`LinkeDOMCrawler`、`PlaywrightCrawler` 这三个层级会被移除，不保留 legacy 兼容路径。它们提供的能力会被拆解为多个不依赖 Crawlee 专用 crawler 的 `CaptureTool`。

浏览器能力不由 Crawlee `BrowserPool` 作为全局模型承载，而由项目自己的 `BrowserManager` 管理。Playwright/CDP 作为浏览器控制协议层，连接 Chromium、CloakBrowser、Lightpanda 等底层 engine，并向本项目 TS tool、Crawl4AI、Scrapling 等上层工具提供 `PageLease` 或 `CdpLease`。

浏览器分层与复用策略的详细设计见：

- `docs/tech-details/browser-layering-design.md`
- `docs/tech-details/browser-reuse-strategy.md`

## 2. 目标分层

```mermaid
flowchart TD
  APP["M1App"] --> RUNTIME["CrawleeCaptureRuntime"]
  RUNTIME --> QUEUE["pageCaptureQueue"]
  RUNTIME --> BASIC["BasicCrawler"]
  BASIC --> HANDLER["Page task handler"]
  HANDLER --> EXECUTOR["PageCaptureExecutor"]
  EXECUTOR --> RESOLVER["CaptureProfile / strategy resolver"]
  EXECUTOR --> VALIDATOR["Result validators"]
  EXECUTOR --> TOOLS["CaptureTool chain"]
  TOOLS --> HTTP["HTTP / DOM tools"]
  TOOLS --> BROWSER["Browser tools"]
  TOOLS --> PY["Python bridge tools"]
  BROWSER --> MANAGER["BrowserManager"]
  PY --> MANAGER
  MANAGER --> CONTROL["Playwright / CDP"]
  CONTROL --> ENGINES["Chromium / CloakBrowser / Lightpanda"]
  HANDLER --> DB["page_runs / artifact_runs / site_pages"]
  HANDLER --> ARTIFACTS["artifact files"]
```

### 2.1 `M1App`

`M1App` 仍然负责应用级编排：

- 创建 run
- 读取 site config
- 展开 seed / sitemap / inventory URL
- 创建 runtime
- 注入 repositories、artifact writer、classifier、executor
- 结束 run 并刷新统计

`M1App` 不直接关心某个 URL 使用 Crawl4AI、Scrapling、Playwright 还是 HTTP tool。

(注: M1App应该改一个更合理的名字, 并做一定拆分)

### 2.2 `CrawleeCaptureRuntime`

`CrawleeCaptureRuntime` 是 Crawlee 的项目内适配层。它负责把项目自己的 task 模型映射到 Crawlee：

- 打开 run-scoped `RequestQueue`
- 创建 `BasicCrawler`
- 设置并发、重试、session、proxy、same-domain delay 等运行选项
- 在 `BasicCrawler` handler 中反序列化 `PageCaptureTask`
- 向业务 handler 提供 `RuntimeContext`

它是 Crawlee 和业务架构之间的边界。未来如果 Crawlee 的剩余价值下降，可以用另一个 runtime 替换这一层，而不是让业务模块散落依赖 Crawlee。

### 2.3 `PageCaptureTask`

目标架构不再固定三条物理队列。改为一个页面任务队列：

```text
run-{runId}-page-capture
```

队列中的任务只声明本次需要什么能力，而不是声明由哪个 Crawlee crawler 处理，也不区分固定的 task mode。

```ts
type CaptureCapability = 'base' | 'markdown' | 'screenshot' | 'structured';

interface PageCaptureTask {
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  url: string;
  depth: number;
  needs: CaptureCapability[];
  pageRunId?: number;
  purpose?: 'discovery' | 'artifact' | 'refresh';
}
```

`purpose` 只用于日志和业务 handler 判断上下文，不参与工具选择。工具选择只看 `needs`、site config、capture profile 和 validator。

`pageRunId` 只有在 task 明确是为某个已存在 page run 补抓 artifact 时才需要。如果 task 的 `needs` 包含 `base`，业务 handler 可以在 base 结果回来后新建 page run，并把同一个 task 中已经抓到的 artifact 关联到这个新 page run。

这种模型下不需要额外设计 `full` task。所谓 full capture 只是一个普通 task：

```ts
{
  needs: ['base', 'markdown', 'screenshot']
}
```

### 2.4 逻辑阶段与物理队列分离

业务逻辑仍然保留阶段：

- base：页面基础抓取、链接发现、分类、规则判定
- markdown：Markdown artifact
- screenshot：截图 artifact
- structured：新增的结构化 artifact, json文件

但阶段不再等同于物理队列。

旧三队列模型：

```text
baseQueue
markdownQueue
screenshotQueue
```

目标模型：

```text
pageCaptureQueue
  task.needs = ['base']
  task.needs = ['markdown', 'screenshot']
  task.needs = ['base', 'markdown', 'screenshot']
```

这样 Crawl4AI / Scrapling / Playwright 等一次访问可产出多个结果的工具，不会被强迫拆成多个物理 crawler 任务。

## 3. RuntimeContext

`BasicCrawler` 进入 handler 后，应把 Crawlee 的底层能力包装成项目自己的 `RuntimeContext`。

```ts
interface RuntimeContext {
  requestId: string;
  sendRequest: SendRequestLike;
  session?: unknown;
  proxyInfo?: {
    url?: string;
    hostname?: string;
    port?: number;
  };
  abortSignal?: AbortSignal;
}
```

`CaptureTool` 可以通过 `RuntimeContext` 复用 Crawlee 底层能力，但不直接依赖 Crawlee 专用 crawler。

### 3.1 允许复用的 Crawlee 能力

- `BasicCrawler` 调度和 retry
- `sendRequest` / got-scraping HTTP client
- `SessionPool`
- `ProxyConfiguration`
- `failedRequestHandler`

当前项目使用的 `BasicCrawler` 默认启用 `SessionPool`，并且 `CrawleeCaptureRuntime` 显式传入 `sessionPoolOptions.maxPoolSize = 50`。因此 `RuntimeContext.session` 不是未来扩展点，而是当前已经存在的运行时身份信号。

目标架构中，Crawlee session 的定位是：

- 为 HTTP `sendRequest` 提供 cookie jar 和 session health。
- 为 BrowserManager 提供 `session.id`、cookie、`userData`、健康状态等输入。
- 在浏览器侧明确遇到 403/429/captcha/access denied 时接收 `markBad()` 或 `retire()` 反馈。

不把 Crawlee session 当作完整浏览器 profile。完整 profile、storageState、CDP endpoint、browser process/context/page 生命周期由 BrowserManager 管理。

### 3.2 明确不使用的 Crawlee 能力

目标架构中不再使用：

- `CheerioCrawler`
- `LinkeDOMCrawler`
- `PlaywrightCrawler`
- Crawlee `BrowserPool` 作为全局浏览器资源池

也不在 `CaptureTool` 内部手工创建这些 crawler。否则会把完整 crawler 生命周期嵌入 tool，重新引入 handler 前置请求、内部 retry、队列语义和失败路径混乱。

Crawlee `BrowserPool` 可以作为局部参考或实验实现，但不作为 M2 的浏览器生命周期边界。原因是项目需要同时管理 TS tool、Python tool、CDP endpoint、CloakBrowser、Lightpanda 和 persistent profile，这些概念超出了 Crawlee crawler 内部 browser pool 的职责。

## 4. PageCaptureExecutor

`PageCaptureExecutor` 是单页能力执行器。它位于业务 handler 和具体工具之间。

职责：

- 根据 site config 和 task needs 选择 capture profile
- 按工具顺序执行 fallback
- 把 Crawlee runtime context、proxy/session 信息传给 tool
- 调用 result validator 判断工具结果是否可接受
- 合并多个 tool 的部分成功结果
- 产出标准化 `CaptureResult`
- 记录工具级诊断信息供 handler 写入 run log / meta

它不负责：

- 入队 URL
- 写 DB
- 写 artifact 文件
- 执行分类器
- 执行 URL / label 规则
- 调用 `buildStage2EnqueueDecision`

这些仍属于业务 handler 和现有 planner/rules/repository 模块。

Executor 的输出是“工具层结果”，不是“业务决策结果”。即使 task 一次性返回了 `base + markdown + screenshot`，executor 也只说明这些能力是否抓取成功；是否允许写入 artifact、是否进入 pending、是否继续发现链接，仍由业务 handler 根据 base 结果和规则决定。

## 5. CaptureTool

`CaptureTool` 表示“对单个 URL 执行某组抓取能力”的最小单元。

```ts
interface CaptureTool {
  readonly name: string;
  readonly capabilities: CaptureCapability[];

  capture(input: CaptureInput): Promise<CaptureToolResult>;
}
```

`CaptureTool` 不负责队列和 run 生命周期。它只处理一个 URL、一次尝试。一个 tool 可以只产出单一能力，也可以一次产出多种能力。

例如：

| Tool | capabilities | 可能输出 |
|------|--------------|----------|
| `ATool` | `['base']` | title / body / links |
| `BTool` | `['base', 'markdown']` | base + markdown |
| `CTool` | `['markdown']` | markdown |
| `DTool` | `['base', 'markdown', 'screenshot']` | base + markdown + screenshot |
| `ETool` | `['screenshot']` | screenshot |

因此不同站点可以用同一套 task 模型组合不同 profile：

| 站点策略 | 工具组合 | 说明 |
|----------|----------|------|
| 高级一体化 | `DTool` | 一次访问尽量产出全部需要的能力 |
| 半一体化 | `BTool + ETool` | base/markdown 合并，screenshot 单独补齐 |
| 拆分工具链 | `ATool + CTool + ETool` | 每种能力由专门工具产出 |

### 5.1 标准输出

```ts
interface CaptureToolResult {
  toolName: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  title?: string;
  metaDescription?: string;
  bodyText?: string;
  links?: string[];
  markdown?: string;
  screenshot?: Buffer;
  structured?: unknown;
  diagnostics?: Record<string, unknown>;
}
```

不同工具不需要填满所有字段。例如 Markdown 工具可能没有 `statusCode`，截图工具可能没有 `html`。

### 5.2 现有能力拆解

原来的 `CheerioCrawler` 能力拆解为：

- Crawlee runtime：调度、retry、session、proxy、HTTP client
- `HttpHtmlTool`：通过 `RuntimeContext.sendRequest` 获取 HTML
- `BaseExtractTool`：基于 HTML 解析 title、meta、body、links

原来的 `LinkeDOMCrawler` 能力拆解为：

- `HttpHtmlTool`：获取 HTML
- `LinkeDOMDocumentTool`：将 HTML 转成 Document
- `DefuddleMarkdownTool`：基于 Document 产出 Markdown

原来的 `PlaywrightCrawler` 能力拆解为：

- `BrowserManager`：提供 page / browser context / CDP endpoint / browser identity
- `PlaywrightPageTool`：导航、等待、读取 HTML
- `PlaywrightScreenshotTool`：截图

这些 tool 不调用 Crawlee 专用 crawler，但可以复用 Crawlee 的底层 HTTP、session、proxy 信号和 BrowserManager 管理的浏览器资源。

## 6. BrowserManager

`BrowserManager` 是 M2 浏览器能力的项目内边界。它只服务于浏览器类工具和 Python bridge tool，不是 planner、rules、repository、web read model 的业务概念。

它负责统一管理：

- browser process pool
- BrowserContext / persistent context
- persistent profile / `userDataDir`
- `storageState`
- CDP endpoint
- page lease
- proxy/session/profile 的绑定关系
- browser identity 的 retire / recycle
- TS tool 与 Python tool 之间的浏览器共享

`BrowserManager` 之下可以有多个 `BrowserEngine`：

- Chromium / Playwright engine
- CloakBrowser engine
- Lightpanda engine
- 远程浏览器 / CDP provider

### 6.1 Playwright/CDP 控制层

Playwright/CDP 是浏览器控制协议层，不是项目的业务资源模型。

```mermaid
flowchart TD
  Tools["CaptureTool<br/>Playwright / Crawl4AI / Scrapling"] --> Manager["BrowserManager"]
  Manager --> Lease["PageLease / CdpLease"]
  Lease --> Control["Playwright / CDP"]
  Control --> Engines["Chromium / CloakBrowser / Lightpanda"]
```

TS 侧浏览器 tool 优先拿 `PageLease`：

```text
acquire page -> goto -> interact / extract / screenshot -> release page
```

Python 侧 Crawl4AI / Scrapling 优先拿 `CdpLease`：

```text
acquire cdp endpoint -> Python tool connect via cdp_url -> release lease
```

这样可以让多种上层工具共享同一个底层浏览器身份，而不是每个 tool 自己启动浏览器。

### 6.2 BrowserIdentity

BrowserManager 应把 Crawlee runtime、站点配置和 profile 策略合成为 `BrowserIdentity`：

```ts
interface BrowserIdentity {
  siteId: number;
  runId: number;
  sessionId?: string;
  proxyKey?: string;
  engine: 'chromium' | 'cloakbrowser' | 'lightpanda';
  profileMode: 'ephemeral' | 'persistent' | 'storage_state';
  profileKey?: string;
}
```

其中：

- `sessionId` 优先来自 `RuntimeContext.session.id`。
- `proxyKey` 来自 `RuntimeContext.proxyInfo.url` 或代理 session key。
- `profileKey` 可以来自站点配置、账号配置或 `session.userData.profileKey`。
- `engine` 由站点 browser config 或 capture profile 的默认策略决定。

### 6.3 复用策略

默认复用策略：

```text
run 内复用 browser process
site/session/proxy 级创建 context
每个 capture task 创建 page lease
page 用完关闭
run 结束关闭 ephemeral context
```

复用边界：

| 实体 | M2 默认策略 | 说明 |
|------|-------------|------|
| Browser process | 复用 | 按 `engine + runId` 或更细 key 分池，避免每页冷启动 |
| BrowserContext | 按身份复用 | 按 `siteId + sessionId + proxyKey + profileMode` 复用 |
| Page / tab | 不复用 | 单任务短租短还，避免页面残留 |
| Persistent profile | 后置启用 | 只在登录态、强反爬、人工预热场景使用 |
| storageState | 可选启用 | 比完整 profile 更轻，适合登录态恢复 |
| CDP endpoint | 按 engine/identity 复用 | 供 TS/Python 工具连接同一浏览器身份 |

### 6.4 Crawlee session 与 BrowserManager

BrowserManager 应读取 Crawlee session，但不把 Crawlee session 当作完整浏览器 profile。

推荐交互：

- 读取 `session.id` 构造 `BrowserIdentity.sessionId`。
- 读取 `session.getCookies(url)` 注入 BrowserContext。
- 按策略把浏览器侧新 cookie 回写 `session.setCookies(...)`。
- 浏览器侧确认封禁时调用 `session.markBad()` 或 `session.retire()`。
- 只在 `session.userData` 存 profile key、fingerprint key 等轻量 metadata，不存完整 profile。

### 6.5 非目标

M2 不把以下内容作为默认方案：

- 每个 tool 自己启动和关闭浏览器。
- 直接用 Crawlee `BrowserPool` 作为全局浏览器资源池。
- 复用 page/tab 作为默认性能优化。
- 把完整 `userDataDir`、storageState dump 或大量 cookie 塞进 Crawlee session。
- 让业务层直接依赖 Playwright 类型。

## 7. Bridge Tool

Crawl4AI 和 Scrapling 属于 Python 生态。它们在项目中应作为 bridge tool 接入，而不是替换 run runtime。

```mermaid
flowchart LR
  TOOL["Crawl4AITool"] --> BRIDGE["Crawl4AIBridge"]
  BRIDGE --> PY["Python script / sidecar / CLI"]
  PY --> RESULT["JSON / base64 result"]
  RESULT --> TOOL
```

Bridge 职责：

- 接收标准 `CaptureInput`
- 将 URL、proxy、headers、等待策略、抽取配置转成 Python 侧输入
- 从 BrowserManager 获取可选 `cdp_url`，让 Python 工具连接项目管理的浏览器身份
- 调用 Python script、sidecar 或 CLI
- 解析 JSON / base64 输出
- 转换为 `CaptureToolResult`

Bridge 不应该出现在 `M1App`、planner、rules、repository 中。

Bridge tool 不应默认自己启动浏览器。对于 Crawl4AI / Scrapling 这类可连接 CDP 的工具，优先路径是：

```text
CaptureTool -> BrowserManager.acquireCdpEndpoint(...) -> Python bridge payload.cdpUrl -> Python tool connect
```

fallback 路径可以保留“Python 工具自己管理浏览器”，用于本地依赖缺失、CDP engine 不支持某项能力或调试场景。但默认运行形态应尽量复用 BrowserManager 的 browser identity，避免 TS tool、HTTP tool、Python tool 对同一 URL 呈现不同代理、cookie、profile。

## 8. CaptureProfile 与工具策略

工具选择不应塞进现有 URL / label 规则。规则回答“要不要抓、要哪些 artifact”；capture profile 回答“用哪些工具满足 needs、失败后按什么顺序降级”。

示意配置：

```json
{
  "captureProfiles": {
    "default": {
      "tools": ["http-base", "defuddle-markdown", "lightpanda-markdown", "jina-markdown", "playwright-screenshot", "crawl4ai-page"]
    },
    "kickstarter-comments": {
      "tools": ["kickstarter-comments-adapter", "playwright-cloak-screenshot"]
    }
  }
}
```

Executor 会根据 task `needs` 和 tool `capabilities` 计算覆盖关系。例如 task 需要 `['base', 'markdown', 'screenshot']`：

- 如果 profile 中的 `crawl4ai-page` 可以一次覆盖三者，则优先尝试它。
- 如果 `crawl4ai-page` 只产出 base + markdown，executor 继续寻找 screenshot tool 补齐剩余能力。
- 如果某个 tool 返回了部分可接受结果，executor 可以保留已通过 validator 的能力，只 fallback 剩余能力。

后续可以允许规则或站点路径指定 profile，但这属于策略选择，不改变 `rulesBeforeBaseEq` / `rulesBeforeStage2Eq` 的职责。

## 9. ResultValidator

工具返回不等于业务成功。`ResultValidator` 用来判断工具结果是否可接受。

常见判定：

- `statusCode` 是否为 2xx / 3xx
- HTML 是否为空
- Markdown 是否为空
- Markdown 最小长度
- 内容是否包含 `Access Denied`、`Just a moment` 等拒绝页关键词
- 内容是否命中 required regex
- screenshot buffer 是否过小
- structured JSON 是否符合 schema

示意配置：

```json
{
  "validation": {
    "markdown": {
      "minLength": 500,
      "rejectRegex": ["Access Denied", "Just a moment"],
      "requireRegex": []
    },
    "screenshot": {
      "minBytes": 20000
    }
  }
}
```

Validator 由 executor 调用。业务 handler 只关心 executor 最终返回成功还是失败。

## 10. Proxy 与失败升级

Proxy 策略属于 executor/runtime/tool 协作边界。

目标模型：

- runtime 提供基础 proxy/session 能力
- executor 根据 capture profile 判断是否需要 retry with proxy 或切换 tool
- tool 接收当前 attempt 的 proxy/session/browser identity 信息
- BrowserManager 将 proxy/session 绑定到 BrowserContext 或 persistent profile
- 失败后 executor 可以切换 proxy、标记 session bad、retire browser identity、尝试下一个 tool

示意配置：

```json
{
  "proxyPolicy": {
    "mode": "retry_on_failure",
    "provider": "apify"
  }
}
```

如果使用 Apify Proxy，优先通过 Crawlee `ProxyConfiguration` 集成，避免自行拼装代理轮换和 session 生命周期。

需要避免两类身份断裂：

| 断裂 | 结果 |
|------|------|
| HTTP base 走 Crawlee proxy/session，浏览器截图走本机直连 | base 成功但截图看到风控页，或两个结果不是同一地域/身份 |
| Python tool 自己启动浏览器，TS screenshot 使用另一个浏览器 | markdown/screenshot/structured 来自不同 cookie 和 fingerprint |

因此 proxyPolicy 不只是“是否使用代理”，还要决定 proxy 与 browser identity 的绑定方式.

## 11. 站点定制交互与结构化抽取

对于 Kickstarter 评论这类场景，不建议发明复杂通用点击 DSL。目标设计是站点定制 adapter：

```ts
interface SiteAutomationAdapter extends CaptureTool {
  readonly siteKey: string;
  matches(input: CaptureInput): boolean;
}
```

定制 adapter 可以内部使用：

- Playwright / CloakBrowser
- Crawl4AI
- Scrapling
- 站点特定 schema
- 点击、等待、分页、load more、结构化抽取逻辑

外部仍只看到标准 `CaptureToolResult`，例如：

```text
structured + markdown + screenshot
```

这样可以为少量重要站点写高质量适配，而不把通用配置语言做得过早复杂。

## 12. Base 抓取与 artifact 抓取关系

Base 逻辑仍然重要，因为它承担：

- 链接发现
- title / meta / body 基础信息
- 分类输入
- stage2 规则判定
- page_runs 创建

目标架构不鼓励简单粗暴的 `skipBase`。更准确的能力是：

- 复用历史 base
- 由多能力 tool 同次返回 base + artifact
- 对明确配置的站点直接发起 `needs: ['base', 'markdown', 'screenshot']` 的 capture task

默认业务流仍然可以先抓 `needs: ['base']`，再由规则决定是否补抓 artifact；但这只是业务 handler 的决策方式，不是 task model 的限制。

```mermaid
flowchart TD
  START["startup candidate"] --> BASETASK["enqueue base task"]
  BASETASK --> BASECAP["capture needs=['base']"]
  BASECAP --> RULES["classify + stage2 rules"]
  RULES --> LINKS["discover links -> enqueue base task"]
  RULES --> ARTIFACTTASK["if crawl_run allow -> enqueue artifact task"]
  ARTIFACTTASK --> ARTCAP["capture needs=['markdown','screenshot']"]
  ARTCAP --> WRITE["write artifact_runs"]
```

当站点配置明确希望一次性抓取，handler 也可以入队：

```text
needs = ['base', 'markdown', 'screenshot']
```

executor 会按照 profile 用一个或多个 tool 覆盖这些 needs。

## 13. 分类与 Stage2 决策边界

`classifier` 和 `buildStage2EnqueueDecision` 不属于 `PageCaptureExecutor`，也不属于 `CaptureTool`。它们属于页面业务状态机，应由 page task handler 执行。

原因：

- 分类依赖项目级 label definitions 和当前业务配置。
- Stage2 规则会决定 `page_runs`、`site_pages.inventory_status`、`pending_reason` 和 required artifacts。
- `seed_run` 会把 allow 转为 pending，这属于 run type 语义，不是抓取工具语义。
- Tool 只负责“能不能抓到内容”，不应该决定“这个页面是否应该产出 artifact”。

### 13.1 Handler 处理 `needs` 包含 base 的 task

当 task 的 `needs` 包含 `base` 时，page task handler 的顺序是：

```mermaid
flowchart TD
  TASK["task needs includes base"] --> EXEC["executor.capture(needs)"]
  EXEC --> BASEOK["validate base result"]
  BASEOK --> CLASSIFY["classifier.classify(base)"]
  CLASSIFY --> DECISION["buildStage2EnqueueDecision"]
  DECISION --> PAGERUN["create page_run"]
  PAGERUN --> SITEPAGE["recordBaseCapture"]
  SITEPAGE --> LINKS["discover links and enqueue base needs"]
  SITEPAGE --> ARTIFACTS["handle captured or required artifacts"]
```

如果同一个 task 已经顺带抓到了 markdown / screenshot，handler 不能在 stage2 决策前直接写 artifact 成功。正确顺序是：

1. 先用 base 结果执行 classifier。
2. 再执行 `buildStage2EnqueueDecision` 得到 `pageOutcome` 和 `requiredArtifacts`。
3. 如果当前 run 是 `crawl_run` 且 decision allow，才把同 task 中已通过 validator 的 required artifact 写入 `artifact_runs`。
4. 如果还有 required artifact 没被当前 task 满足，再入队一个新的 task，只带剩余 `needs`，并携带刚创建的 `pageRunId`。
5. 如果 decision deny / pending / skipped，则不写入顺带抓到的 artifact；可只把工具诊断写入 run log。

这样可以支持一体化工具，同时不绕过现有规则和状态机。

### 13.2 Handler 处理不包含 base 的 task

当 task 的 `needs` 不包含 `base` 时，它必须携带 `pageRunId`，表示这是为某个已经通过 stage2 决策的 page run 补抓 artifact。

此时 handler 的顺序是：

```mermaid
flowchart TD
  TASK["task needs artifact only"] --> CHECK["require pageRunId"]
  CHECK --> EXEC["executor.capture(needs)"]
  EXEC --> WRITE["write succeeded / failed artifact_runs"]
  WRITE --> SITEPAGE["recordArtifactResult"]
```

这类 task 不执行 classifier，也不重新执行 `buildStage2EnqueueDecision`。是否需要重跑 base 由 `RunPlanner` 和 update policy 在入队前决定。

### 13.3 一体化 task 的业务语义

`needs: ['base', 'markdown', 'screenshot']` 并不表示“跳过 stage2 决策”。它只表示 executor 可以尝试用一个或多个 tool 一次性抓取这些能力。

业务 handler 仍必须先完成：

```text
base -> classifier -> buildStage2EnqueueDecision -> page_run
```

然后再决定是否接受同 task 中的 artifact 结果。

## 14. 状态写入边界

状态写入仍放在业务 handler 层，而不是 tool 层。

| 操作 | 负责模块 |
|------|----------|
| 创建 / 结束 run | `M1App` |
| 规划 URL 是否入队 | `RunPlanner` |
| base 成功 / 失败落库 | page task handler |
| artifact 成功 / 失败落库 | page task handler |
| 写 artifact 文件 | page task handler + `FileArtifactWriter` |
| 记录工具诊断 | page task handler 写入 `run_logs` / `meta` |
| 工具执行与 fallback | `PageCaptureExecutor` |
| 单 URL 抓取 | `CaptureTool` |
| 分类与 Stage2 规则决策 | page task handler |

Tool 不直接 import repository，也不直接写 artifact 文件。

## 15. 与当前架构的主要变化

| 当前 | 目标 |
|------|------|
| 三个物理队列：base / markdown / screenshot | 一个 page capture 队列 |
| `CheerioCrawler` 负责 base 抓取 | `BasicCrawler` 调度，`HttpBaseTool` 抓取 |
| `LinkeDOMCrawler` 给 markdown handler 提供 Document | `HttpHtmlTool` + `LinkeDOM/Defuddle` tool |
| `PlaywrightCrawler` 负责截图页面导航 | `PlaywrightScreenshotTool` 通过 BrowserManager 获取 page 后导航 |
| markdown fallback 藏在 `FallbackMarkdownCaptureAdapter` | executor 统一处理 tool chain fallback |
| 成功判定主要是 tool 没抛错 | validator 明确定义结果是否可接受 |
| 工具策略固定在代码中 | site config 中配置 capture profile |
| Crawlee 同时是 runtime 和抓取实现 | Crawlee 只作为 runtime kernel 和底层能力提供者 |
| 各工具各自决定浏览器生命周期 | BrowserManager 统一管理 browser/context/profile/CDP/page lease |
| HTTP session 与浏览器 session 分裂 | Crawlee session/proxy 作为 BrowserIdentity 输入，必要时同步 cookie 与 retire 信号 |

## 16. 明确的非目标

本文不要求：

- 用 Crawl4AI / Scrapling 替换 Crawlee run runtime
- 保留 `CheerioCrawler` / `LinkeDOMCrawler` / `PlaywrightCrawler` legacy 路径
- 在 tool 内部嵌套创建 Crawlee crawler
- 为 full capture 设计独立 task mode
- 立即设计通用点击 DSL
- 直接使用 Crawlee `BrowserPool` 作为全局浏览器资源池
- 默认复用 page/tab
- 把完整 persistent profile 写入 Crawlee session
- 改变 SQLite 作为业务真相源的原则
- 改变 `RunPlanner` / rules / repository 的核心职责
- 把 classifier 或 stage2 规则下沉到 tool / executor

## 17. 核心判断

目标架构的核心不是“引入更多概念”，而是重新确定边界：

```text
Crawlee:
  run runtime kernel

BasicCrawler:
  task scheduler

PageCaptureExecutor:
  tool strategy / fallback / validation

CaptureTool:
  single URL capture implementation

BrowserManager:
  browser identity / process / context / CDP / page lease

Business handler:
  domain state machine and persistence
```

这个边界可以让项目继续复用 Crawlee 成熟的运行工程能力，同时摆脱专用 crawler 对请求时机和失败路径的控制。Playwright/CDP 作为浏览器控制层，BrowserManager 作为浏览器资源与身份层，为 Crawl4AI、Scrapling、CloakBrowser、Lightpanda、代理重试、站点定制交互和结构化抽取留出清晰接入点。
