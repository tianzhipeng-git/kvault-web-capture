# SiteConfig 抓取结果校验

本文说明 `SiteConfig.validation` 的用法。校验用于判断某个工具产出的 base、markdown、screenshot、structured 是否可以接受；被拒绝后 Executor 会继续尝试 capture profile 中的后续工具。

## 1. 配置位置

全局校验写在站点根配置：

```json
{
  "validation": {
    "base": {
      "minLength": 100,
      "rejectRegex": ["Access Denied"]
    },
    "markdown": {
      "minLength": 500
    },
    "screenshot": {
      "minBytes": 20000
    }
  }
}
```

每个站点只有这一处结果校验配置，`captureProfile` 只负责工具链与 fallback 顺序。

## 2. 字段说明

每种能力都可以配置一个校验规则：

```json
{
  "minLength": 500,
  "minBytes": 20000,
  "rejectRegex": ["Access Denied", "Just a moment"],
  "requireRegex": ["example\\.com|Example"]
}
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `minLength` | 非负数字 | `1` | 文本长度下限 |
| `minBytes` | 非负数字 | `1` | 二进制产物大小下限，目前用于 screenshot |
| `rejectRegex` | 字符串数组 | `[]` | 命中任一正则即拒绝 |
| `requireRegex` | 字符串数组 | `[]` | 每个正则都必须命中 |

所有正则按 JavaScript `RegExp` 解析，并以忽略大小写方式匹配。配置加载时会校验正则语法，空字符串正则会被拒绝。

## 3. 各能力的校验逻辑

| 能力 | 校验对象 | 默认校验 |
| --- | --- | --- |
| `base` | `bodyText` 的长度、HTML 的内容 | HTTP status 必须是 2xx/3xx；HTML 和 extracted page 必须存在；`bodyText.trim().length >= 1` |
| `markdown` | Markdown 文本 | Markdown 必须存在且非空；`markdown.trim().length >= 1` |
| `screenshot` | 截图 Buffer | 截图必须存在；大小至少 1 byte |
| `structured` | 结构化结果 | 结果必须存在，且可以被 JSON 序列化 |

`base.rejectRegex` 和 `base.requireRegex` 匹配的是 HTML。`base.minLength` 匹配的是提取后的 `bodyText`。

`markdown.rejectRegex` 和 `markdown.requireRegex` 匹配的是 Markdown 文本。

`screenshot` 当前只使用 `minBytes`。`structured` 当前只检查是否存在和是否可 JSON 序列化。

## 4. 内置拒绝模式

base 和 markdown 默认会拒绝常见反爬/拦截页面。内置模式包括：

```json
[
  "Access Denied",
  "Just a moment",
  "verify you are human",
  "Please enable JavaScript"
]
```

这些内置模式不需要显式配置。你仍然可以通过 `rejectRegex` 追加站点特有的拦截文案。

## 5. 示例：识别拦截页并回退工具

```json
{
  "captureProfile": {
    "tools": [
      "defuddle-markdown",
      "lightpanda-markdown",
      "jina-markdown"
    ]
  },
  "validation": {
    "markdown": {
      "minLength": 800,
      "rejectRegex": [
        "Access Denied",
        "captcha",
        "正在验证"
      ],
      "requireRegex": [
        "Example Product|Example Docs"
      ]
    }
  }
}
```

在这个例子里，如果 `defuddle-markdown` 产出的 Markdown 太短、像拦截页，或没有包含期望内容，Executor 会继续尝试后面的 markdown 工具。
