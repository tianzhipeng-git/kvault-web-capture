# SiteConfig 抓取 Profile 配置

本文说明 `SiteConfig.captureProfile` 的用法。每个站点最多配置一个 profile，用于决定单页抓取时按什么工具顺序尝试 base、markdown、screenshot、structured 等能力。

## 1. 默认行为

如果不配置 `captureProfile`，系统使用以下内置工具链：

| 工具名 | 能力 |
| --- | --- |
| `http-base` | `base` |
| `defuddle-markdown` | `markdown` |
| `lightpanda-markdown` | `markdown` |
| `jina-markdown` | `markdown` |
| `playwright-screenshot` | `screenshot` |

各工具的详细说明见 [Capture Tools 参考](../tech-details/capture-tools-reference.md)。

`base` 用于页面基础抓取、链接发现和分类。`markdown`、`screenshot`、`structured` 是否需要，仍由 `rulesBeforeStage2Eq` 的规则结果决定。

截图的 basic/complete 模式、多设备 variants 和页面准备参数见 [SiteConfig 截图与多变体配置](./site-config-screenshot.md)。

若 profile 中存在同时支持 `base` 和 artifact 的一体化工具，例如 `scrapling-page`、`crawl4ai-page`，base task 可能将 artifact 一并写入 `needs`，让工具一次调用抓完。详见 [Base Task Needs 与 Eager Capture](../tech-details/base-task-needs-and-eager-capture.md)。

## 2. 配置格式

```json
{
  "captureProfile": {
    "tools": [
      "http-base",
      "defuddle-markdown",
      "lightpanda-markdown",
      "jina-markdown",
      "playwright-screenshot"
    ]
  }
}
```

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `captureProfile` | 否 | 使用内置默认工具链 | 当前站点唯一的抓取 profile |
| `captureProfile.tools` | 是 | 无 | 工具名数组，按顺序作为 fallback 链执行 |

## 3. 工具执行规则

Executor 按 `tools` 顺序尝试工具，但每个工具只会在它覆盖当前仍缺失的能力时执行。工具失败或产物被 validator 拒绝时，系统继续尝试后续工具；所有需要的能力都满足后结束。工具链执行完仍缺少能力时，本页抓取失败。

## 4. 示例：优先使用 Python 工具

```json
{
  "captureProfile": {
    "tools": [
      "crawl4ai-page",
      "scrapling-page",
      "http-base",
      "defuddle-markdown",
      "lightpanda-markdown",
      "jina-markdown",
      "playwright-screenshot"
    ]
  },
  "validation": {
    "markdown": {
      "minLength": 500,
      "rejectRegex": ["Access Denied", "Just a moment"]
    },
    "screenshot": {
      "minBytes": 20000
    }
  }
}
```

这个配置会先尝试 Crawl4AI 和 Scrapling；如果它们失败、缺能力或产物未通过校验，再回退到内置 Node 工具链。Python 工具安装方式见 [Python 抓取工具安装](./pytools-install.md)。
