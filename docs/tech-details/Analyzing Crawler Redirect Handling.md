# Crawler Redirect Handling

本文说明当前 page-capture runtime 对 301 / 302 等重定向的处理方式，以及它对规则、链接发现和落库归属的影响。

## 1. 当前运行路径

当前实现不再拆成 Base / Markdown / Screenshot 三种 crawler。`src/crawlee/capture-runtime.ts` 使用单个 Crawlee `BasicCrawler` 调度 `page_capture` task，具体抓取由 `PageCaptureExecutor` 按 `needs` 调用 capture tools。

与重定向直接相关的路径：

- `HttpBaseTool` 通过 `RuntimeContext.sendRequest(input.url)` 发起基础 HTML 请求。
- `responseFinalUrl(...)` 优先读取响应对象中的最终 URL，并传给 `extractPageContentFromHtml(finalUrl, html)`。
- `extractPageContentFromHtml(...)` 用最终 URL 解析页面链接，并生成 `extracted.normalizedUrl`。
- `handleBaseTask(...)` 用 `extracted.normalizedUrl` 做 stage2 规则判定、run log URL、链接发现 referrer 和 artifact-only task URL。

浏览器类工具（例如 `playwright-screenshot`、`lightpanda-markdown`）由浏览器导航自然处理重定向；Python bridge tools 连接项目提供的 CDP 或使用自身浏览器能力，最终行为取决于对应 Python 工具。

## 2. 结果归属

重定向后的内容仍关联到入队时的 `sitePageId`。也就是说，如果 `/old-path` 重定向到 `/new-path`，base capture、page_run 和 artifact_run 仍写在 `/old-path` 对应的 inventory 记录上，但日志、规则判定和文件内容里的 source URL 会使用提取后的最终 URL。

当前没有独立的 `redirect_to_url` 字段，也没有把原始 URL inventory 自动合并到最终 URL inventory。

## 3. 规则与链接发现

stage2 规则使用 `extracted.normalizedUrl`。因此，如果一个允许抓取的 URL 跳转到站外，后续 `rulesBeforeStage2Eq` 通常会按最终 URL 判定，避免把站外页面继续当作本站页面扩展。

页面内相对链接也以最终 URL 为 base 解析，而不是以原始请求 URL 解析。重定向本身不增加 `depth`；只有从页面中发现并入队的新链接才会增加深度。

## 4. 当前边界

- Crawlee / tool 默认重定向策略没有在项目层额外配置特殊拦截。
- 重定向循环或超过底层客户端限制时会表现为抓取失败，并进入 Crawlee retry / failed request 路径。
- Update policy 的历史状态检查使用最终 `extracted.normalizedUrl`，但写入聚合状态仍使用原 task 的 `sitePageId`。当多个原始 URL 重定向到同一个最终 URL 时，可能产生内容重复的 inventory 记录。

如果后续要把重定向关系建模成业务状态，应在数据库里显式增加 redirect 关系字段或 canonical 归并流程，而不是只在 handler 里临时改写 URL。
