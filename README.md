## 一句话说明

Kvault Web Capture 用“先摸底、再配置、再正式采集、再复核迭代”的方式，把一个站点中的页面发现出来，**按规则和分类决定是否采集，并产出 base 文本、Markdown 和截图等结果**。

技术架构见[technical-module-structure](docs/technical-module-structure.md)

外部系统和 Agent 对接见 [HTTP API 与自解释 Agent CLI](docs/user-guide/http-api.md)；只需简易采集时参考[简易采集 API 对接文档](docs/user-guide/simple-capture-api.md)。

## 核心业务概念

- 项目：顶层管理单元，用于把多个站点归在一起。
- 站点：一个具体采集目标，拥有 base URL、存储目录和采集配置。
- 页面清单：站点内所有发现过的页面，按 normalized URL 去重。
- 运行批次：一次 `seed_run` 或 `crawl_run`。
- Base capture：轻量页面信息，包括 title、meta description、body text 和链接发现。
- 分类标签：页面 base 信息经过分类器后得到的 label，例如 `content_type: docs`。
- 采集规则：根据 URL 或 label 决定页面是否继续采集，以及需要哪些 artifact。
- Artifact：当前支持 `markdown` 和 `screenshot`。

## 典型工作流

```text
1. 创建项目
2. 创建站点，填写 base URL 和 storageRoot
3. 配置 seedUrls、sitemaps、URL 规则、label 规则和抓取深度
4. 启动 seed_run 做初步摸底
5. 查看页面清单、待确认页面、样本 base capture
6. 调整规则
7. 启动 crawl_run 正式采集 Markdown / Screenshot
8. 查看运行日志、页面详情、artifact 预览和采集统计
9. 根据 pending / failed / stale 情况继续迭代
```

## 项目管理

用户可以创建项目。项目主要用于组织站点，并为后续迁移或多站点管理提供边界。

项目 slug 会由项目名生成；如果同 slug 项目已存在，创建命令会返回已有项目。

## 站点管理

站点属于项目，是实际采集配置和存储边界。创建站点时需要：

- 项目 ID 或项目 slug
- 站点名
- base URL
- storageRoot

创建站点时会生成默认配置：base URL 作为 seed，并默认允许 `docs`、`product`、`generic` 页面产出 Markdown。

## 站点配置

站点配置决定从哪里开始发现页面、怎样过滤页面、哪些页面需要深入采集。

主要字段：

- `seedUrls`：普通入口页面。
- `sitemaps`：站点地图入口，会递归解析 sitemap index。
- `rulesBeforeBaseEq`：base 前 URL 规则。
- `rulesBeforeStage2Eq`：base + 分类之后的 URL / label 规则。
- `runOptions.seedMaxDepth`：seed run 链接递归深度。
- `runOptions.crawlMaxDepth`：crawl run 链接递归深度。

## 规则功能

规则分两层执行。

### 基础入队规则

`rulesBeforeBaseEq` 只看 URL，用于避免无意义页面进入 base 队列。例如登录页、下载页、跨站链接等。

支持：

- `blacklist`
- `scopelist`
- `whitelist`
- `prefix`
- `regex`

默认结果是 allow。

### 深度爬取规则

`rulesBeforeStage2Eq` 在 base capture 和分类之后执行。它可以看 URL，也可以看分类 label。这个阶段决定页面最终是：

- deny：不继续采集
- pending：等待用户调整规则或人工复核
- allow：进入 artifact 采集

allow 规则应声明 `artifacts`，例如：

```json
{
  "name": "docs-full-capture",
  "matchType": "label",
  "listType": "whitelist",
  "when": [
    {
      "key": "content_type",
      "op": "any_of",
      "values": ["docs"]
    }
  ],
  "artifacts": ["markdown", "screenshot"]
}
```

label 条件支持：

- `any_of`
- `all_of`
- `is_empty`

多个 `when` 条件之间是 AND。

## 初步摸底：Seed Run

Seed run 用于快速建立页面清单，不做最终重采集。

行为：

- 从 `seedUrls` 和 `sitemaps` 开始。
- sitemap 会递归解析，只把实际页面 URL 放入队列。
- base crawler 抓 title、meta、body text 和链接。
- 分类器打 label。
- 执行 stage2 规则，但不运行 markdown / screenshot。
- 原本 allow 的页面会变成 pending，原因是 `seed_run`。
- 运行中发现的链接也会进入同一套规划流程。

适合 seed run 后查看：

- inventory summary
- pending pages
- sample captures
- site overview
- pages list

## 正式采集：Crawl Run

Crawl run 用于根据当前配置产出最终 artifact。

启动来源：

- `seedUrls`
- `sitemaps`
- 已存在页面清单中的 URL

运行顺序：

1. base crawler
2. markdown crawler
3. screenshot crawler

只有 stage2 判定 allow 且 required artifacts 包含对应类型时，才会进入 markdown 或 screenshot 队列。

## 更新策略

Crawl run 支持三种更新策略：

- `force_recrawl_all`：全部重新进入采集流程。
- `skip_existing`：已有完整成功结果则跳过；配置变化、失败、pending 或缺少 artifact 时重跑。
- `stale_after_duration`：超过 `staleAfterMs` 的 base 或 artifact 会重跑。

当配置变化导致一个页面需要新的 artifact，例如从只要 Markdown 变成 Markdown + Screenshot，`skip_existing` 会让页面重新进入流程以补齐缺失 artifact。

## 页面清单与业务状态

每个发现过的页面都会进入 `site_pages`，用 normalized URL 在站点内去重。

常见状态含义：

- `discovered_only`：只发现了 URL。
- `url_rule_denied`：base 前 URL 规则拒绝。
- `base_captured`：base 成功，且无需 stage2 artifact。
- `stage2_pending`：需要复核或补规则。
- `stage2_skipped`：base 后规则判定跳过深入采集。
- `stage2_captured`：要求的 artifact 全部成功。

页面列表支持按状态、关键词、label、pending reason、discovery source 和 run 过滤。

## 页面详情与预览

页面详情视图会聚合：

- 当前业务状态
- 发现来源和 referrer
- 最新 label
- 最新 base / markdown / screenshot 状态
- 最新 page run
- base 和 markdown 内容预览
- screenshot artifact 文件入口
- 历史 run 记录

截图会按扩展名返回图片 content type；非截图 artifact 以文本返回。

## 运行日志与监控

每次运行会写入 `crawl_runs` 和 `run_logs`。

日志事件包括：

- `crawl_started`
- `crawl_finished`
- `crawl_error`
- `base_page_done`
- `base_page_failed`
- `artifact_done`
- `artifact_failed`
