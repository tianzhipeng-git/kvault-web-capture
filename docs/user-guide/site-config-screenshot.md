# SiteConfig 截图与多变体配置

本文说明 `SiteConfig.screenshot` 的用法。它控制截图采用兼容旧行为的单规格模式，还是为同一页面生成多个设备、分辨率的完整截图。

截图是否需要生成，仍由 `rulesBeforeStage2Eq` 中的 `artifacts: ["screenshot"]` 决定；`screenshot` 配置只回答“生成哪些规格、截图前如何准备页面”。

## 1. 模式概览

| 配置 | 行为 |
| --- | --- |
| 不配置 `screenshot` | 等价于旧版 basic 行为，生成一张 `screenshot/default` |
| `"screenshot": { "mode": "basic" }` | 单张全页截图，不执行高级页面准备，不展开 variants |
| `"screenshot": { "mode": "complete", ... }` | 每个 variant 独立导航、准备、截图、重试和保存 |

`basic` 模式会忽略 `preparation` 和 `variants`。需要多设备、懒加载触发、滚动容器展开或最大截图高度限制时，应使用 `complete`。

## 2. Basic 单截图

最小配置：

```json
{
  "screenshot": {
    "mode": "basic"
  }
}
```

也可以完全省略 `screenshot`。页面规则命中截图后，系统生成：

```text
{storageRoot}/artifacts/run-{runId}/page-{sitePageId}/screenshot.png
```

basic 保留现有 eager capture 和工具 fallback 行为，适合只需要一张普通全页截图的站点。

## 3. Complete 多变体截图

下面的配置会为每个命中截图规则的页面生成桌面、移动端和自定义宽屏三张截图：

```json
{
  "captureProfile": {
    "tools": [
      "http-base",
      "defuddle-markdown",
      "playwright-screenshot"
    ]
  },
  "screenshot": {
    "mode": "complete",
    "preparation": {
      "dismissSelectors": ["#cookies-decline", "button[aria-label='Close']"],
      "waitForImages": true,
      "waitForFonts": true,
      "scrollDocument": true,
      "scrollContainers": true,
      "expandScrollContainers": true,
      "scrollStepRatio": 0.8,
      "settleMs": 500,
      "stableRounds": 2,
      "maxScrollRounds": 100,
      "maxCaptureHeight": 50000,
      "timeoutMs": 90000,
      "onLimit": "truncate"
    },
    "variants": [
      {
        "key": "desktop-1440",
        "device": "desktop",
        "viewport": { "width": 1440, "height": 900 },
        "deviceScaleFactor": 1
      },
      {
        "key": "mobile-iphone-15",
        "device": "iPhone 15"
      },
      {
        "key": "desktop-1920",
        "device": "desktop",
        "viewport": { "width": 1920, "height": 1080 },
        "deviceScaleFactor": 1
      }
    ]
  }
}
```

complete 模式下，每个 variant 都是独立 artifact task。任一必需 variant 失败时，该页面不会被标记为完整采集成功。

## 4. Variant 配置

`complete` 必须配置 1 到 10 个 variants。同一配置内的 `key` 必须唯一。

### 4.1 自定义桌面 viewport

```json
{
  "key": "desktop-1440",
  "device": "desktop",
  "viewport": {
    "width": 1440,
    "height": 900
  },
  "deviceScaleFactor": 1
}
```

| 字段 | 必填 | 范围 | 说明 |
| --- | --- | --- | --- |
| `key` | 是 | `^[a-z0-9][a-z0-9-]{0,63}$` | variant 标识，也用于文件名和 API |
| `device` | 是 | 固定为 `desktop` | 表示使用自定义桌面 viewport |
| `viewport.width` | 是 | 320–7680 | CSS viewport 宽度 |
| `viewport.height` | 是 | 320–4320 | CSS viewport 高度 |
| `deviceScaleFactor` | 否 | 1–4，默认 1 | 设备像素比；会影响 PNG 实际像素尺寸 |

### 4.2 Playwright 设备预设

```json
{
  "key": "mobile-iphone-15",
  "device": "iPhone 15"
}
```

`device` 必须是当前 Playwright 版本支持的设备名称。设备预设会同时提供 viewport、screen、User-Agent、触摸能力、移动端标记和 DPR，不能在同一个 variant 中覆盖 viewport。

设备预设名称区分大小写。配置保存时若名称不存在，会直接报错。

## 5. 页面准备参数

`preparation` 在 complete 模式下可省略；省略字段会使用下表默认值。

| 字段 | 类型 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `dismissSelectors` | string[] | `[]` | 最多 20 个；单项 1–500 字符 | 按顺序查找可见元素，点击第一个命中的 selector，再开始等待与滚动 |
| `waitForImages` | boolean | `true` | — | 等待已发现图片解码；关闭后 pending image 不阻塞完成 |
| `waitForFonts` | boolean | `true` | — | 等待 `document.fonts.ready` |
| `scrollDocument` | boolean | `true` | — | 分步滚动主文档，触发懒加载和动态内容 |
| `scrollContainers` | boolean | `true` | — | 查找并滚动页面内可滚动容器 |
| `expandScrollContainers` | boolean | `true` | — | 截图前临时展开已经滚到底的普通容器 |
| `scrollStepRatio` | number | `0.8` | 0.1–1 | 每步滚动当前 viewport/容器高度的比例 |
| `settleMs` | integer | `500` | 0–10000 | 每次滚动后等待页面稳定的时间 |
| `stableRounds` | integer | `2` | 1–20 | 连续多少轮稳定后认为准备完成 |
| `maxScrollRounds` | integer | `100` | 1–1000 | 文档与容器滚动总轮数上限 |
| `maxCaptureHeight` | integer | `50000` | 1000–200000 | 截图最大 CSS 高度 |
| `timeoutMs` | integer | `90000` | 1000–170000 | 单个 variant 页面准备超时 |
| `onLimit` | string | `truncate` | `truncate` / `fail` | 达到上限或页面无法完整准备时的处理方式 |

准备期间系统还会临时停止 CSS animation、transition 和平滑滚动，截图结束后恢复临时修改。

`dismissSelectors` 适合 Cookie、地区或订阅遮罩的拒绝/关闭按钮。它按顺序尝试候选值，只点击第一个可见元素；找不到时继续截图。selector 必须指向安全的拒绝或关闭动作，不能指向购买、提交或其他有副作用的控件。若网站会把选择写入 Cookie 或 `localStorage`，搭配 `browser.contextReuse: "site_run"` 可让同一次运行中的后续页面复用该状态。

### `onLimit` 的选择

- `truncate`：保留当前可获得的截图，并在 metadata 中记录 `truncated: true` 和 `limitReason`。
- `fail`：拒绝不完整结果，继续尝试 profile 中下一个支持 complete screenshot 的工具；全部工具失败后进入任务重试。

无限滚动、虚拟列表、无法滚到底的容器、跨域 iframe、准备超时和超过最大高度，都可能产生 truncated 结果。需要稳定批量产出时，通常建议使用 `truncate`。

## 6. 用规则启用截图

variants 不写在规则中。规则只声明当前页面是否需要 `screenshot`：

```json
{
  "rulesBeforeStage2Eq": [
    {
      "name": "capture-product-pages",
      "matchType": "url",
      "listType": "whitelist",
      "ruleType": "regex",
      "values": ["/products/"],
      "artifacts": ["markdown", "screenshot"]
    }
  ]
}
```

如果该站点配置了三个 complete variants，每个命中此规则的页面就会生成三张截图。当前不支持在规则中只选择部分 variants。

完整规则格式见 [SiteConfig 规则格式编写指南](./site-config-rule-format-guide.md)。

## 7. 工具与 fallback

| 工具 | basic | complete 自定义桌面/非移动设备预设 | complete 移动设备预设 |
| --- | --- | --- | --- |
| `playwright-screenshot` | 支持 | 支持 | 支持 |
| `scrapling-page` | 支持 | 支持 | 暂不支持 |
| `crawl4ai-page` | 支持 | 不支持 | 不支持 |

使用移动设备 variant 时，`captureProfile.tools` 必须包含 `playwright-screenshot`。Scrapling 的移动端 Context 合约完成验收前，系统会跳过其 mobile screenshot 能力。

complete screenshot 不会合并到 base eager capture；每个 variant 会按 `captureProfile.tools` 顺序独立 fallback。Profile 的配置方式见 [SiteConfig 抓取 Profile 配置](./site-config-capture-profile.md)。

## 8. 文件、状态与历史复用

complete 截图保存到独立目录，variant 之间不会覆盖：

```text
{storageRoot}/artifacts/run-{runId}/page-{sitePageId}/screenshots/
├── desktop-1440.png
├── mobile-iphone-15.png
└── desktop-1920.png
```

每个 complete variant 都会根据最终 preparation 配置、完整 variant 配置和截图协议版本生成配置指纹：

- `skip_existing` 只复用 key 和指纹都匹配的成功截图。
- `stale_after_duration` 还会按每个 variant 的完成时间判断是否过期。
- `force_recrawl_all` 会重新生成所有当前 variants。
- 修改 viewport、设备、DPR 或 preparation 后，相关指纹会变化，不会误用旧截图。

页面只有在所有当前必需 variants 成功或被 update policy 合法复用后，才会进入完整采集状态。

## 9. 截图结果校验

可以继续使用通用截图大小校验：

```json
{
  "validation": {
    "screenshot": {
      "minBytes": 20000
    }
  }
}
```

complete 模式还会自动校验 variant key、配置指纹、设备 viewport、页面准备状态、truncated 语义和最大截图高度。这些字段不需要在 `validation` 中重复配置。

详见 [SiteConfig 抓取结果校验](./site-config-validation.md)。

## 10. 常见配置错误

| 错误 | 原因与处理 |
| --- | --- |
| `screenshot.variants must contain 1 to 10 variants` | complete 模式没有 variants，或数量超过 10 |
| `key must match ...` | key 包含大写字母、下划线、空格、路径分隔符等不安全字符 |
| `contains duplicate keys` | 同一截图配置中存在重复 variant key |
| `device is not a supported Playwright device` | 设备预设名称不存在或大小写错误 |
| `complete screenshot mode requires ...` | capture profile 没有 `playwright-screenshot` 或 `scrapling-page` |
| mobile 截图最终失败 | profile 只有 Scrapling；为移动 variant 添加 `playwright-screenshot` |
| 页面频繁 truncated | 检查 `limitReason`，按需提高 timeout/round/height 上限，或接受受控截断 |

高级运行语义和内部实现见 [高级多规格完整截图方案](../tech-details/advanced-multi-variant-screenshot-design.md)。
