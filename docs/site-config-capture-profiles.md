# SiteConfig 抓取 Profile 配置

本文说明 `SiteConfig.captureProfiles` 和 `SiteConfig.defaultCaptureProfile` 的用法。它们决定单页抓取时按什么工具顺序尝试 base、markdown、screenshot、structured 等能力。

## 1. 默认行为

如果不配置 `captureProfiles`，系统会使用内置默认 profile，名称显示为 `default`，工具链为：

```json
[
  "http-base",
  "defuddle-markdown",
  "lightpanda-markdown",
  "jina-markdown",
  "playwright-screenshot"
]
```

默认工具链的含义：

| 工具名 | 能力 |
| --- | --- |
| `http-base` | `base` |
| `defuddle-markdown` | `markdown` |
| `lightpanda-markdown` | `markdown` |
| `jina-markdown` | `markdown` |
| `playwright-screenshot` | `screenshot` |

各工具的详细说明见 [Capture Tools 参考](./capture-tools-reference.md)。

`base` 用于页面基础抓取、链接发现和分类。`markdown`、`screenshot`、`structured` 是第二阶段 artifact 能力，是否需要这些能力仍由 `rulesBeforeStage2Eq` 的规则结果决定。

若 profile 中存在**一体化工具**（同时支持 `base` 和 artifact，如 `scrapling-page`、`crawl4ai-page`），入队 base task 时可能把 artifact 一并写入 `needs`，让工具一次调用抓完。拆分链（`http-base` + 独立 markdown / screenshot 工具）不会合并 needs，仍走 base → 单独 artifact task 路径。详见 [Base Task Needs 与 Eager Capture](./tech-details/base-task-needs-and-eager-capture.md)。

## 2. 配置格式

```json
{
  "captureProfiles": {
    "default": {
      "tools": [
        "http-base",
        "defuddle-markdown",
        "lightpanda-markdown",
        "jina-markdown",
        "playwright-screenshot"
      ]
    }
  },
  "defaultCaptureProfile": "default"
}
```

字段说明：

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `captureProfiles` | 否 | 使用内置默认工具链 | profile 名到 profile 配置的映射；profile 名不能为空字符串 |
| `captureProfiles.<name>.tools` | 是 | 无 | 工具名数组，按顺序作为 fallback 链执行 |
| `captureProfiles.<name>.validation` | 否 | 无 | 仅作用于该 profile 的结果校验，见 [SiteConfig 抓取结果校验](./site-config-validation.md) |
| `defaultCaptureProfile` | 否 | `default` | 当前站点使用的 profile 名 |

如果设置了 `defaultCaptureProfile`，必须同时设置 `captureProfiles`，并且该名称必须存在于 `captureProfiles` 中。

如果只配置了其他名称的 profile，但没有配置 `defaultCaptureProfile`，系统仍会查找名为 `default` 的 profile；找不到时回退到内置默认工具链。

## 3. 工具执行规则

Executor 会按 profile 中的 `tools` 顺序尝试工具，但每个工具只会在它覆盖当前还缺失的能力时执行。例如当前任务只需要 `markdown` 时，`http-base` 会被过滤掉；当前任务需要 `markdown` 和 `screenshot` 时，markdown 工具成功后仍会继续执行 screenshot 工具。

一个工具失败，或产物被 validator 拒绝时，系统会继续尝试后续工具。所有需要的能力都满足后，本页抓取结束；如果工具链执行完仍缺少能力，本页抓取失败。

可用工具的名称、能力与说明见 [Capture Tools 参考](./capture-tools-reference.md)。

## 5. 一体化工具与 Eager Capture

`crawl4ai-page` 和 `scrapling-page` 等工具可在一次 fetch 中按 `needs` 返回 base + 多种 artifact。当它们出现在 profile 工具链中时，系统会在入队 base task 时尝试把可能需要的 artifact 合并进 `needs`，减少同一页面的重复工具调用。

这与 profile 内的 fallback 顺序正交：eager capture 决定「一次请求哪些能力」，fallback 决定「第一个工具失败时换谁」。

完整算法、update policy 交互和设计边界见 [Base Task Needs 与 Eager Capture](./tech-details/base-task-needs-and-eager-capture.md)。

## 4. 示例：优先使用 Python 工具

```json
{
  "captureProfiles": {
    "default": {
      "tools": [
        "crawl4ai-page",
        "scrapling-page",
        "http-base",
        "defuddle-markdown",
        "lightpanda-markdown",
        "jina-markdown",
        "playwright-screenshot"
      ],
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
  },
  "defaultCaptureProfile": "default"
}
```

这个配置会先尝试 Crawl4AI 和 Scrapling；如果它们失败、缺能力或产物未通过校验，再回退到内置 Node 工具链。Python 工具安装方式见 [Python 抓取工具安装](./tech-details/pytools-install.md)；各工具能力说明见 [Capture Tools 参考](./capture-tools-reference.md)。
