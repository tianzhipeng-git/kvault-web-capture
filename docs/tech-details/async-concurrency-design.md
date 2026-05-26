# 异步与并发设计

本文说明项目里和异步并发相关的主要设计，重点覆盖主入口 `src/app/services.ts`、crawler 创建与 handler 执行、Web server 的事件循环观测、以及 SQLite 写入模型。

## 1. 总体模型

项目的并发模型可以概括为：

- 运行批次由 `M1App` 串行编排。
- 每个 Crawlee crawler 内部按 `maxConcurrency` 并发处理请求。
- 系统使用单队列统一调度具有不同 needs 的任务，取代了原先 base、markdown、screenshot 按阶段顺序运行的设计。
- SQLite 默认使用 `node:sqlite` 的 `DatabaseSync`，repository 暴露 `async` 方法，但 SQLite 调用本身是同步执行。
- Web 入口可以后台启动 run，但 `RunCoordinator` 限制同一站点只能有一个运行中任务，并限制全局同时运行数。
- Web UI 与 crawler 共处同一进程, Web server 会记录 event loop delay，用于判断 run 期间是否存在主线程阻塞。

这意味着项目利用 Crawlee 做 I/O 并发，但避免在应用层实现自己的 worker pool 或长期运行队列。持久业务状态落在数据库和 artifact 文件里，Crawlee queue 只作为单次 run 内的调度器。同时，系统已经尽量把文件读取、文件写入和文件下载路径切到异步或 stream，以减少 Web UI 与 crawler 共处同一进程时对事件循环的额外阻塞。

## 2. 主入口编排

`M1App.create(...)` 会打开数据库、初始化 schema，并构造所有 repository、planner 和 exporter。后续 CLI 和 Web 后端都通过同一个 `M1App` 进入业务写路径。

一次 run 的入口是：

- `runSeed(...)`
- `runCrawl(...)`
- 私有方法 `executeRun(...)`
- 私有方法 `executeRunWithRuntime(...)`

`executeRun(...)` 负责创建 `crawl_runs` 记录和 runtime log。这里的站点目录创建和 runtime log 初始化都已经改成异步流程。真正的 crawler 编排在 `executeRunWithRuntime(...)`：

1. 读取 site 和配置。
2. 创建 Crawlee `Configuration`。
3. 创建本次 run 的三条 request queue。
4. 展开启动 URL：seed、sitemap、历史 inventory。
5. 逐个候选 URL 调用 `RunPlanner.planRequest(...)`。
6. 将允许抓取的候选页面通过 `pageCaptureQueue.addRequest` 写入执行队列。
7. 创建 `CrawleeCaptureRuntime` 与 `PageCaptureExecutor` 及对应的执行工具链。
8. 运行 crawler（`await runtime.run()`）。
9. 刷新统计并结束 run。

在新的执行模型中，单次 run 仅启动一个 `BasicCrawler`。任务间的隔离和顺序依赖，通过任务自身声明的 `needs` 能力要求在 handler 内部判定和拆解，而不再是多个 crawler 分阶段阻塞运行。

当前并没有把 crawler 拆到独立 worker 进程。Web server 与 crawler 仍运行在同一个 Node.js 进程里，共享同一个 JavaScript 事件循环；隔离主要依赖：

- Crawlee handler 的异步等待
- `RunCoordinator` 的 run 数量限制
- 降低同步 I/O 的比例
- event loop delay 监控

## 3. Crawlee 队列

`src/crawlee/queue-factory.ts` 为每次 run 只创建一个命名队列：

- `run-{runId}-page-capture`

`services.ts` 中的 Crawlee `Configuration` 设置了：

```ts
persistStorage: false,
purgeOnStart: true,
```

这表示队列是单次运行内的临时调度结构。 durable state 不依赖 Crawlee storage，而是写入 SQLite 和 artifact 文件。这样做可以避免本地 Crawlee request queue 锁文件在长时间运行中带来的竞争问题，也让 Web 读模型只依赖业务数据库。

## 4. Crawler 内部并发

现在项目统一使用 `src/crawlee/capture-runtime.ts` 创建 `BasicCrawler`，默认 `maxConcurrency = 5`。这意味着最多 5 个 request handler 同时处于进行中。它们可能并发等待网络、分类器、BrowserManager 控制或 Crawlee queue 操作，但每一次同步 SQLite 调用都会在 Node.js 事件循环上独占执行一小段时间。

HTTP 请求由内部工具如 `HttpBaseTool` 的 `sendRequest` 接管，统一走 Crawlee session 机制。截图和 Markdown 生成也交由 BrowserManager 或单独的 Adapter。由于不同任务会按 `needs` 发起真实并发执行，内存占用和带宽压力主要取决于 `PageCaptureExecutor` 中工具链的实际瓶颈。

防封锁共享配置：

- `retryOnBlocked: true`
- `sameDomainDelaySecs: 1`
- `sessionPoolOptions.maxPoolSize = 50`

这些配置不是业务互斥机制，只是降低被目标站点限流或阻断的概率。

## 5. Handler 的异步边界

`src/crawlee/handlers.ts` 是每个请求实际执行的位置。当前入口简化为统一的 `createPageCaptureRequestHandler`，其核心处理根据任务声明的 `needs` 分发：

基础捕获阶段 (`needs` 包含 `'base'`)：
1. 检查 `RunTargetTracker` 是否已达到目标。
2. 调用工具链完成基础内容抓取。
3. 调用 classifier。
4. 执行 stage2 规则。
5. 写 base capture 文件。
6. 创建 `page_runs` 和更新 `site_pages`。
7. 按规则和 update policy 需要进一步产出 markdown / screenshot 时，向队列追加对应的 Artifact-only 任务。
8. 发现链接，交给 `RunPlanner`。

后续产物补齐阶段 (`needs` 包含 `'markdown'`/`'screenshot'`)：
1. 依赖 Executor 选择工具抓取所需产物。
2. 写入 artifact 文件。
3. 创建 `artifact_runs` 和更新 `site_pages` 的聚合 artifact 状态。
4. 写 run log。

这些 handler 是 `async` 函数，Crawlee 可以让多个 handler 交错执行。但 JavaScript 只有一个主线程，未 `await` 的同步代码不会被其它 handler 打断。项目利用这一点让 `RunTargetTracker` 这类内存计数器保持简单。

另外，handler 里的 artifact 落盘现在已经改成异步文件写入, 这减少了 base/markdown/screenshot handler 在写文件时直接阻塞主线程的时间，但并不改变 SQLite 仍然是同步调用这一事实。

## 6. `targetSuccessCount` 是软上限

`RunTargetTracker` 只在单个 `M1App` 进程、单次 run 内生效。它记录 base 阶段中满足“成功候选”的页面数量：

- `crawl_run` 中 stage2 outcome 为 `allow`
- `seed_run` 中 pending reason 为 `seed_run`

达到目标后，base handler 会：

- 跳过尚未开始真正处理的后续 base 请求。
- 停止继续从当前页面扩展新链接。

但它不能取消已经开始的并发 handler，也不能回滚已经入队的 artifact 请求。因此 `targetSuccessCount` 是软上限，最终 `successful_page_count` 需要以 `RunRepository.refreshCounts(...)` 的统计结果为准。

## 7. SQLite 写入模型

数据库入口在 `src/db/database.ts`。默认 SQLite client 是：

```ts
new DatabaseSync(databasePath)
```

`SqliteDbClient` 的方法返回 `Promise`，是为了让 repository 可以同时兼容 PostgreSQL client。但 SQLite 路径下，核心调用仍然是同步的：

```ts
this.db.prepare(sql).run(...params)
this.db.prepare(sql).get(...params)
this.db.prepare(sql).all(...params)
```

这带来几个重要影响：

- 同一 Node.js 进程内，不会有两个 SQLite 语句真正同时执行。
- 多个 Crawlee handler 并发时，SQLite 操作会在事件循环上短暂串行化。
- 同步 DB 调用会阻塞事件循环；如果查询或写入变慢，会影响所有正在等待调度的 handler。
- repository 方法虽然需要 `await`，但这不是 SQLite 自身的异步 I/O。

换句话说，当前代码里的 `async/await` 有两类语义需要区分：

- 真异步 I/O：网络请求、Crawlee 调度、异步文件读写、stream 输出
- 统一接口外观：SQLite repository 方法虽然返回 `Promise`，但底层仍是同步执行

这也是为什么 event loop delay 监控很重要：它能帮助区分“只是外部网站慢”还是“当前进程主线程被同步工作卡住了”。

目前大多数写路径都是单条 SQL 或短序列 SQL，并且没有显式事务。例如 base handler 会先写 `page_runs`，再更新 `site_pages`，再写日志和队列请求。正常运行下这足够简单；如果进程在中间崩溃，可能出现部分状态已经落库、后续聚合状态或日志未完成的情况。

## 8. 关键 repository 写路径

`SitePageRepository` 维护站点级页面清单和聚合状态：

- `upsertDiscovery(...)`：发现或更新页面。
- `getHistoricalState(...)`：为 update policy 提供历史状态。
- `recordBaseCapture(...)`：写入 base 成功后的聚合字段。
- `recordBaseCaptureFailed(...)`：记录 base 失败。
- `recordArtifactResult(...)`：按 artifact 成功或失败更新 markdown/screenshot 状态，并重新推导 inventory status。

`PageRunRepository` 记录某次 run 中的 base 结果：

- 成功路径写标题、正文、分类 label、规则结果、所需 artifact。
- 失败路径写 `base_capture_status = 'failed'` 和 `error_message`。

`ArtifactRunRepository` 记录 markdown / screenshot 的单次 artifact 结果。

`RunRepository.refreshCounts(...)` 在 run 结束时根据 `page_runs`、`artifact_runs` 和 `site_pages` 的最新 artifact 状态回算：

- candidate 页面数
- pending 页面数
- denied 页面数
- successful 页面数

successful 的口径不是“base allow 就算成功”，而是 allow 页面所需 artifact 全部成功。

## 9. Web 入口的后台运行

Web 后端通过 `src/web/services/run-coordinator.ts` 管理后台运行。

`RunCoordinator` 的限制：

- 同一 `siteId` 同时只能有一个 active run。
- 全局 active run 数不能超过 `maxConcurrentRuns`。
- run promise 结束后会从 `activeRuns` 删除。

Web API 触发 seed/crawl 后可以很快返回，实际采集在后台 promise 中继续。这个限制只覆盖当前 Node.js 进程内的 Web 入口；如果同时用 CLI 或另一个进程操作同一个 SQLite 文件，当前代码没有跨进程 run lock。

## 10. Web server 的 I/O 与事件循环观测

当前 Web server 已经做了几项和事件循环相关的优化与观测：

- 前端静态文本资源改为异步 `readFile(...)`，并在进程内缓存
- `/assets/:file` 改为异步读取
- 导出下载使用 `createReadStream(...)`
- artifact 文件下载使用 `createReadStream(...)`
- 页面详情和 runtime log 查询里涉及文件读取的路径改成异步 `readFile(...)`
- runtime log 写入使用异步 `pino.destination({ sync: false })`

这些改动的目标不是让文件系统“并行执行更多工作”，而是减少主线程被同步文件 I/O 卡住的时间。

除此之外，`src/web/server.ts` 现在会使用 `monitorEventLoopDelay(...)` 定期采样 event loop delay：

- 默认采样间隔：`5000ms`
- 默认告警阈值：`100ms`
- 支持环境变量：
  - `KVAULT_EVENT_LOOP_DELAY_INTERVAL_MS`
  - `KVAULT_EVENT_LOOP_DELAY_THRESHOLD_MS`
- `/health` 会暴露最近一次快照
- 当存在 active run，或者 `p99` 超过阈值时，server 会输出一条 event loop delay 日志

这个监控的设计意图是：

- run 在跑，但 event loop delay 低：说明更多是在等网络、等 Playwright、等外部依赖
- run 在跑，同时 event loop delay 明显升高：说明主线程大概率被同步 SQLite、重 CPU、或其他未消除的同步工作卡住

它不是严格的 profiler，但很适合做一线运行中的卡顿判断。

## 11. 设计取舍与注意事项

- 提高 `maxConcurrency` 会增加网络和 adapter 并发，但不会提高 SQLite 写入并行度。
- screenshot 并发最容易消耗内存，调高前应优先观察浏览器进程资源。
- SQLite 同步调用简单可靠，但长查询会阻塞事件循环。
- 文件 I/O 这轮已经尽量改成异步或 stream，但这只能减少一部分主线程阻塞，不能替代数据库层面的异步化或进程隔离。
- 当前没有跨进程互斥，建议同一 SQLite 文件只由一个长期服务进程负责写入。
- 目前 Web server 和 crawler 仍在同一进程；如果未来要拆成独立 worker 进程，需要把 `RunCoordinator.activeRuns` 这类内存态运行状态迁到进程间可见的位置。
- 如果后续要让 markdown 和 screenshot 阶段并行运行，需要重新审视 `site_pages.recordArtifactResult(...)` 的读-改-写窗口，以及截图资源占用。
- 如果需要更强的一致性，可以把 base handler 中“写 page_run + 更新 site_page + 写 log”等短序列操作收敛到事务边界内。

## 12. 后续可能todo
- 观察 event loop lag 监控
- Web 进程 和 crawler worker 进程拆分
- 同步SQLite操作导致阻塞, 改为异步