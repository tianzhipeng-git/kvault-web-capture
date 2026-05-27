# 规则格式编写指南

## 1. 先选执行点

系统目前有两个规则执行点：`rulesBeforeBaseEq` 和 `rulesBeforeStage2Eq`。

### 1.1 基础入队规则`rulesBeforeBaseEq`

`rulesBeforeBaseEq` 在页面进入 base 抓取队列之前执行。

适合用来做“明确不用访问”的 URL 过滤，例如：

- 排除登录页、注册页、购物车、搜索页
- 限制采集范围只在某个域名或路径下
- 避免抓取明显无效或无限扩展的 URL

这个执行点的特点：

- 只支持 `matchType: "url"`
- 不支持 label 规则，因为页面还没抓取，也还没有分类结果
- 默认结果是 `allow`，也就是没有规则命中时仍会进入 base 抓取
- 命中 `deny` 后页面不会进入 base 队列
- 即使 URL 规则带了 `artifacts`，在这个执行点也不会触发 artifact 抓取

典型写法：

```json
{
  "rulesBeforeBaseEq": [
    {
      "name": "block-login",
      "matchType": "url",
      "listType": "blacklist",
      "ruleType": "prefix",
      "values": ["example.com/login"]
    }
  ]
}
```

### 1.2 深度爬取规则`rulesBeforeStage2Eq`

`rulesBeforeStage2Eq` 在 base 抓取和页面分类完成之后执行，用来决定页面是否需要进入第二阶段 artifact 抓取。

适合用来做“是否产出 Markdown / 截图 / 结构化结果”的判断，例如：

- 文档页抓 Markdown
- 产品页抓 Markdown 和截图
- 评论页抓结构化数据
- 某些 URL 路径虽然会被 base 抓取，但不产出 artifact
- 根据分类 label 决定采集策略

这个执行点的特点：

- 支持 `matchType: "url"` 和 `matchType: "label"`
- URL 规则和 label 规则会一起参与判断
- 默认结果是 `pending`，也就是没有任何 whitelist 产出 artifact 时，页面会进入待确认状态
- 只有规则最终产出至少一个 `artifact` 时，页面才会进入第二阶段 artifact 抓取
- `seed_run` 中即使规则判断为 allow，也会被转成 `stage2_pending`，用于摸底和调规则，不会真正产出 artifact

典型写法：

```json
{
  "rulesBeforeStage2Eq": [
    {
      "name": "allow-docs-markdown",
      "matchType": "label",
      "listType": "whitelist",
      "when": [
        {
          "key": "content_type",
          "op": "any_of",
          "values": ["docs"]
        }
      ],
      "artifacts": ["markdown"]
    }
  ]
}
```

### 1.3 执行点选择速查

| 目标 | 应该写在哪里 | 推荐规则 |
| --- | --- | --- |
| 不访问登录页、搜索页、购物车等 URL | `rulesBeforeBaseEq` | URL blacklist |
| 只允许某个域名或路径进入 base 抓取 | `rulesBeforeBaseEq` | URL scopelist |
| 页面可以被发现和分类，但不一定产出 artifact | `rulesBeforeStage2Eq` | URL / label whitelist |
| 根据页面分类决定抓 Markdown 还是截图 | `rulesBeforeStage2Eq` | label whitelist |
| 某类分类结果一律不产出 artifact | `rulesBeforeStage2Eq` | label blacklist |
| 某个路径下的页面一律抓截图 | `rulesBeforeStage2Eq` | URL whitelist + `artifacts: ["screenshot"]` |
| 某类页面抓结构化 JSON | `rulesBeforeStage2Eq` | URL / label whitelist + `artifacts: ["structured"]` |

## 2. 再选规则类型

每条规则都有两个维度：

- `matchType`：规则匹配什么对象，支持 `url` 或 `label`
- `listType`：规则命中后在名单体系里的含义，支持 `blacklist`、`scopelist`、`whitelist`

单条规则对象也提供了 JSON Schema，可用于编辑器提示或配置校验：
[site-rule.schema.json](./site-rule.schema.json)。

### 2.1 `matchType: "url"`

URL 规则根据页面 URL 匹配。

字段格式：

```json
{
  "name": "allow-docs-url",
  "matchType": "url",
  "listType": "whitelist",
  "ruleType": "prefix",
  "values": ["example.com/docs"],
  "artifacts": ["markdown"]
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | 规则名。不填时会使用配置路径作为默认名；建议显式填写，便于排查命中结果 |
| `matchType` | 否 | URL 规则可以省略；省略时按 `url` 解析 |
| `listType` | 是 | `blacklist`、`scopelist` 或 `whitelist` |
| `ruleType` | 是 | `prefix` 或 `regex` |
| `values` | 是 | 字符串数组，任一值匹配即认为这条 URL 规则命中 |
| `artifacts` | 否 | 只在 `rulesBeforeStage2Eq` 中有实际意义，支持 `markdown`、`screenshot`、`structured` |

URL 匹配时，系统使用 `host + pathname + search` 做比较，不包含协议。例如：

- `https://example.com/docs/api` 会按 `example.com/docs/api` 比较
- `http://127.0.0.1:4318/docs` 会按 `127.0.0.1:4318/docs` 比较

因此 `prefix` 推荐写成不带协议的形式：

```json
{
  "name": "allow-docs-prefix",
  "matchType": "url",
  "listType": "scopelist",
  "ruleType": "prefix",
  "values": ["example.com/docs"]
}
```

如果 `values` 里写了 `http://` 或 `https://`，系统会在 prefix 匹配前去掉协议。

`regex` 使用 JavaScript 正则表达式字符串：

```json
{
  "name": "block-query-print",
  "matchType": "url",
  "listType": "blacklist",
  "ruleType": "regex",
  "values": ["example\\.com/docs/.*[?&]print=1"]
}
```

### 2.2 `matchType: "label"`

label 规则根据页面分类结果匹配，只能写在 `rulesBeforeStage2Eq` 中。

字段格式：

```json
{
  "name": "allow-product-screenshot",
  "matchType": "label",
  "listType": "whitelist",
  "when": [
    {
      "key": "content_type",
      "op": "any_of",
      "values": ["product"]
    }
  ],
  "artifacts": ["screenshot"]
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | 规则名。不填时会使用配置路径作为默认名；建议显式填写 |
| `matchType` | 是 | 必须是 `label` |
| `listType` | 是 | `blacklist`、`scopelist` 或 `whitelist` |
| `when` | 是 | 条件数组，数组里的所有条件都必须匹配 |
| `artifacts` | 否 | 支持 `markdown`、`screenshot`、`structured`；label 规则未填写时默认 `["markdown"]` |

`when` 中每个条件的格式：

```json
{
  "key": "content_type",
  "op": "any_of",
  "values": ["docs", "product"]
}
```

条件字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | 分类 label 的键，例如 `content_type` |
| `op` | 是 | `any_of`、`all_of` 或 `is_empty` |
| `values` | 视情况 | `any_of` 和 `all_of` 必填；`is_empty` 不需要 |

条件操作符：

| `op` | 含义 |
| --- | --- |
| `any_of` | 分类结果中只要包含 `values` 任意一个值就匹配 |
| `all_of` | 分类结果中必须包含 `values` 全部值才匹配 |
| `is_empty` | 对应 key 没有任何值时匹配 |

例如，当前默认分类器会产出类似结果：

```json
{
  "labels": {
    "content_type": ["docs"]
  }
}
```

匹配文档页：

```json
{
  "key": "content_type",
  "op": "any_of",
  "values": ["docs"]
}
```

匹配没有语言标签的页面：

```json
{
  "key": "language",
  "op": "is_empty"
}
```

## 3. 理解名单语义

`listType` 决定规则命中后的语义。两个执行点都遵循相同优先级：

1. 只要命中 `blacklist`，立即 `deny`
2. 所有 `scopelist` 都必须匹配；任意一个不匹配则 `deny`
3. 命中的 `whitelist` 会 `allow`，并合并其 `artifacts`
4. 如果没有命中 whitelist，则使用该执行点的默认结果

### 3.1 `blacklist`

黑名单用于明确排除。

示例：排除登录页。

```json
{
  "name": "block-login",
  "matchType": "url",
  "listType": "blacklist",
  "ruleType": "prefix",
  "values": ["example.com/login"]
}
```

黑名单优先级最高。即使同一个页面也命中了 whitelist，最终仍然会被 deny。

### 3.2 `scopelist`

范围名单用于定义必须满足的边界。所有 scopelist 都必须匹配，否则页面会被 deny。

示例：只允许 `example.com/docs` 范围内的 URL 进入 base 抓取。

```json
{
  "name": "scope-docs",
  "matchType": "url",
  "listType": "scopelist",
  "ruleType": "prefix",
  "values": ["example.com/docs"]
}
```

注意：多个 scopelist 是“全部必须匹配”的关系，不是“任意匹配”。如果你写了两个互斥的 scopelist，例如一个要求 `/docs`，另一个要求 `/blog`，普通页面通常会全部被排除。

### 3.3 `whitelist`

白名单用于明确允许，并决定需要产出哪些 artifact。

示例：文档页抓 Markdown。

```json
{
  "name": "allow-docs-markdown",
  "matchType": "label",
  "listType": "whitelist",
  "when": [
    {
      "key": "content_type",
      "op": "any_of",
      "values": ["docs"]
    }
  ],
  "artifacts": ["markdown"]
}
```

多个 whitelist 可以同时命中，系统会合并它们的 `artifacts`。

例如下面两条规则同时命中产品页后，最终会抓 `markdown` 和 `screenshot`：

```json
[
  {
    "name": "allow-product-markdown",
    "matchType": "label",
    "listType": "whitelist",
    "when": [
      {
        "key": "content_type",
        "op": "any_of",
        "values": ["product"]
      }
    ],
    "artifacts": ["markdown"]
  },
  {
    "name": "allow-product-screenshot",
    "matchType": "label",
    "listType": "whitelist",
    "when": [
      {
        "key": "content_type",
        "op": "any_of",
        "values": ["product"]
      }
    ],
    "artifacts": ["screenshot"]
  }
]
```

## 4. Artifact 写法

`artifacts` 表示页面进入第二阶段后要产出的内容类型。

支持值：

```json
["markdown", "screenshot", "structured"]
```

常见组合：

| 目标 | 写法 |
| --- | --- |
| 只抓 Markdown | `"artifacts": ["markdown"]` |
| 只抓截图 | `"artifacts": ["screenshot"]` |
| 只抓结构化结果 | `"artifacts": ["structured"]` |
| Markdown 和截图都抓 | `"artifacts": ["markdown", "screenshot"]` |
| Markdown 和结构化结果都抓 | `"artifacts": ["markdown", "structured"]` |

注意事项：

- `artifacts` 只有在 `rulesBeforeStage2Eq` 的 allow 结果中才会触发实际抓取
- URL 规则的 `artifacts` 是可选字段；不填时不贡献 artifact
- label 规则不填 `artifacts` 时默认 `["markdown"]`
- 如果最终没有任何规则贡献 artifact，`rulesBeforeStage2Eq` 会返回 `pending`，不会抓第二阶段 artifact

## 5. 完整 JSON 示例

下面是一个较完整的配置示例：

```json
{
  "seedUrls": [
    "https://example.com/docs"
  ],
  "sitemaps": [
    "https://example.com/sitemap.xml"
  ],
  "rulesBeforeBaseEq": [
    {
      "name": "scope-docs",
      "matchType": "url",
      "listType": "scopelist",
      "ruleType": "prefix",
      "values": [
        "example.com/docs"
      ]
    },
    {
      "name": "block-login",
      "matchType": "url",
      "listType": "blacklist",
      "ruleType": "prefix",
      "values": [
        "example.com/login"
      ]
    }
  ],
  "rulesBeforeStage2Eq": [
    {
      "name": "block-deprecated-pages",
      "matchType": "url",
      "listType": "blacklist",
      "ruleType": "prefix",
      "values": [
        "example.com/docs/deprecated"
      ]
    },
    {
      "name": "allow-docs-markdown",
      "matchType": "label",
      "listType": "whitelist",
      "when": [
        {
          "key": "content_type",
          "op": "any_of",
          "values": [
            "docs"
          ]
        }
      ],
      "artifacts": [
        "markdown"
      ]
    },
    {
      "name": "allow-product-markdown-and-screenshot",
      "matchType": "label",
      "listType": "whitelist",
      "when": [
        {
          "key": "content_type",
          "op": "any_of",
          "values": [
            "product"
          ]
        }
      ],
      "artifacts": [
        "markdown",
        "screenshot"
      ]
    },
    {
      "name": "allow-api-url-screenshot",
      "matchType": "url",
      "listType": "whitelist",
      "ruleType": "prefix",
      "values": [
        "example.com/docs/api"
      ],
      "artifacts": [
        "screenshot"
      ]
    }
  ],
  "runOptions": {
    "seedMaxDepth": 1,
    "crawlMaxDepth": 2
  }
}
```

这个配置的效果：

- 只有 `example.com/docs` 范围内的 URL 会进入 base 抓取
- `example.com/login` 不会进入 base 抓取
- `example.com/docs/deprecated` 可以被 base 抓取和分类，但不会进入第二阶段
- 分类为 `docs` 的页面抓 Markdown
- 分类为 `product` 的页面抓 Markdown 和截图
- URL 在 `example.com/docs/api` 下的页面额外抓截图

## 6. 编写检查清单

写完规则后，建议逐项检查：

- `rulesBeforeBaseEq` 里是否只写了 URL 规则
- `rulesBeforeStage2Eq` 里决定 artifact 的规则是否都写了 `artifacts`
- `name` 在同一个规则数组内是否唯一
- URL `values` 是否使用了 `host + path` 的形式，例如 `example.com/docs`
- 多个 `scopelist` 是否真的是“全部必须满足”的关系
- `regex` 字符串里的反斜杠是否按 JSON 规则转义，例如 `example\\.com`
- label 规则的 `when` 是否能对应分类器实际产出的 label key 和 value
- 需要正式产出 artifact 时，是否运行的是 `crawl_run`，而不是 `seed_run`
