# 日志方案

本文说明项目中“日志”的设计与使用方式。当前日志分成两层：

- 结构化事件日志：写入数据库表 `run_logs`，用于 Web UI 展示、按 run/page 查询、定位业务状态变化。
- runtime 详细日志：写入站点 `storageRoot` 下的 `runs/{runId}/runtime.log`，用于保留应用运行期和 Crawlee 的详细输出。

这两层日志解决的问题不同。`run_logs` 是业务事件索引，适合回答“这个 run 发生了哪些关键步骤”；`runtime.log` 是排障材料，适合回答“运行过程中底层组件输出了什么细节”。

## 1. 总体链路

一次 run 创建后，`M1App.executeRun(...)` 会先创建 `crawl_runs` 记录，再调用 `openRuntimeLog(...)` 打开本次运行的文件日志：

```text
site.storageRoot/
  runs/
    {runId}/
      runtime.log
```

随后系统会立即写入一条结构化事件：

```text
event = runtime_log_ready
meta.relativePath = runs/{runId}/runtime.log
```

这条事件是数据库和文件日志之间的桥。Web 后端查询 runtime log 时不会猜路径，而是先从 `run_logs` 里找到 `runtime_log_ready`，再取 `meta.relativePath`，最后在当前站点的 `storage_root` 下读取文件。

run 的核心执行被包在 `withRuntimeLog(runtimeLog, async () => { ... })` 中。这个调用通过 `AsyncLocalStorage` 绑定当前异步上下文，使业务代码里的 `logger.info/warn/error(...)` 能写入当前 run 的 `runtime.log`。

## 2. 结构化事件日志

结构化事件日志由 `RunLogRepository` 写入 `run_logs` 表。Schema 在 `src/db/database.ts`：

```text
run_logs
  id
  crawl_run_id
  level
  event
  url
  site_page_id
  page_run_id
  message
  meta_json
  created_at
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `crawl_run_id` | 日志所属 run |
| `level` | `info` / `warn` / `error` |
| `event` | 稳定事件名，供 UI 和查询使用 |
| `url` | 相关页面 URL，可为空 |
| `site_page_id` | 相关 inventory 页面，可为空 |
| `page_run_id` | 相关 base 页面运行记录，可为空 |
| `message` | 给人看的简短说明 |
| `meta_json` | 结构化补充信息，JSON 字符串 |
| `created_at` | 写入时间，由注入的 `Clock` 生成 |

当前事件类型定义在 `src/db/repositories/run-log-repository.ts`：

| event | 触发位置 | 用途 |
| --- | --- | --- |
| `runtime_log_ready` | run 初始化后 | 记录 `runtime.log` 的相对路径 |
| `crawl_started` | crawler 开始前 | 标记 run 正式启动 |
| `crawl_finished` | run 成功结束后 | 标记 run 成功完成 |
| `crawl_error` | run 顶层异常 | 记录 run 失败和 stack |
| `base_page_done` | base handler 成功处理页面后 | 记录页面 base 捕获和 stage2 结果 |
| `base_page_failed` | base 请求重试耗尽后 | 记录 base 页面失败 |
| `base_page_skipped_target_reached` | 已达到 `targetSuccessCount` 后 | 记录软上限触发后的跳过 |
| `target_success_count_reached` | 第一次达到目标成功数时 | 记录软上限被达到 |
| `artifact_done` | markdown/screenshot 成功后 | 记录 artifact 输出 |
| `artifact_failed` | markdown/screenshot 失败后 | 记录 artifact 失败和 stack |

结构化事件日志的设计原则是：只记录对产品状态和用户排障有意义的关键事件，不承担完整 debug trace 的职责。需要大量细节时，应写入 runtime log。

## 3. runtime 详细日志

runtime log 由 `src/utils/runtime-logger.ts` 管理，底层使用 `pino` 写文件：

```ts
pino.destination({
  dest: absolutePath,
  append: true,
  mkdir: true,
  sync: false,
})
```

几个关键点：

- 文件路径固定为 `runs/{runId}/runtime.log`，位于当前站点的 `storageRoot` 下。
- `append: true` 表示同一个 runId 再次打开时会追加写入。
- `sync: false` 表示使用异步 destination，减少 crawler 和 Web server 共处同一进程时对事件循环的阻塞。
- 日志级别由 `KVAULT_LOG_LEVEL` 控制，默认是 `info`。
- pino `base` 中会带上 `source: "app"` 和 `crawlRunId`。

项目对外暴露了一个轻量 logger：

```ts
logger.info(message, meta)
logger.warn(message, meta)
logger.error(message, meta)
```

如果当前代码运行在 `withRuntimeLog(...)` 绑定的异步上下文内，这些日志会写入对应 run 的 `runtime.log`；否则会退回到 `console.info/warn/error`。这个退回逻辑让工具函数也能在 CLI、测试或非 run 场景中安全使用。

run 结束时，`executeRun(...)` 的 `finally` 会调用 `runtimeLog.close()`，先 flush destination，再 end destination，避免进程继续运行但文件缓冲未落盘。

## 4. Crawlee 日志桥接

Crawlee 自己有一套 `log` 输出。项目在 `openRuntimeLog(...)` 中调用 `installCrawleeLogBridge()`，把 Crawlee logger 替换为自定义的 `RuntimeCrawleeLogger`。

桥接逻辑如下：

- 如果当前存在 `AsyncLocalStorage` runtime log context，Crawlee 输出直接写入当前 run 的 `runtime.log`。
- 如果当前没有 runtime log context，则回退到 Crawlee 默认 console 输出。
- 桥接只安装一次，避免重复覆盖 Crawlee 全局 logger。

这意味着 Crawlee 的底层请求、重试、错误输出会和项目自己的 runtime 日志进入同一个文件，便于按 run 排查问题。

需要注意：Crawlee logger 是全局替换，而 runtime log context 是按异步上下文区分。当前 Web 入口通过 `RunCoordinator` 限制同一站点运行，并限制全局并发 run 数；如果未来支持多个 run 在同一进程里高并发运行，需要继续关注 Crawlee 全局 logger 与异步上下文之间的隔离效果。

## 5. 其他文件输出与标准输出

从“日志文件”角度看，当前应用内显式管理的文件日志只有 `runs/{runId}/runtime.log`。代码中没有发现第二套类似 `app.log`、`error.log`、访问日志文件或按日期滚动的日志文件。

但项目还会写入几类非日志业务文件：

| 类型 | 写入位置 | 说明 |
| --- | --- | --- |
| SQLite 数据库 | 配置的 database path | `run_logs`、`crawl_runs` 等业务状态会进入数据库文件 |
| base capture | `artifacts/run-{runId}/page-{sitePageId}/base.md` | 页面基础提取结果，不是日志 |
| markdown artifact | `artifacts/run-{runId}/page-{sitePageId}/markdown.md` | markdown 采集结果，不是日志 |
| screenshot artifact | `artifacts/run-{runId}/page-{sitePageId}/screenshot.png` | 截图结果，不是日志 |
| project export | 用户指定导出路径 | 导出包通过 stream 写出，不是日志 |

另外，`examples/manual-screenshot.ts` 会把手动截图写到指定输出路径；这是示例脚本的产物，也不属于应用日志体系。

进程的标准输出和标准错误目前没有被项目统一重定向到文件：

- CLI 命令使用 `console.log(...)` 输出 JSON 结果和帮助信息。
- CLI 顶层异常使用 `console.error(...)` 输出错误。
- Web server 启动成功时会 `console.log(...)` 打印监听地址。
- Web server 的 event loop delay 观测会按阈值使用 `console.info(...)` 或 `console.warn(...)`。
- migration 脚本使用 `console.log/warn/error(...)` 输出迁移进度和错误。
- `logger.info/warn/error(...)` 在没有 runtime log context 时会退回到 `console.info/warn/error(...)`。
- Crawlee bridge 在没有 runtime log context 时会退回到 Crawlee 默认 console 输出。

因此，stdout/stderr 的最终去向取决于启动方式：本地终端会显示在终端里，systemd、Docker、pm2、Nginx upstream wrapper 等进程管理器可能会自行采集或重定向。这个仓库本身没有把 stdout/stderr 再写入某个应用日志文件。

如果使用 PM2 启动，`console.log/info/warn` 通常会进入 PM2 的 out log，`console.error` 会进入 PM2 的 error log。默认路径一般在：

```text
~/.pm2/logs/{app-name}-out.log
~/.pm2/logs/{app-name}-error.log
```

实际路径以 PM2 当前进程配置为准，可以用下面命令确认：

```bash
pm2 describe <app-name>
pm2 logs <app-name>
```

这部分 PM2 日志是进程级日志，记录服务启动信息、CLI/script 输出、未进入 runtime context 的 fallback console 输出，以及进程崩溃时的 stderr。它和项目内的 `runs/{runId}/runtime.log` 是两套不同的日志：前者按 PM2 app/process 归档，后者按 crawl run 归档。

当前代码没有发现读取 `process.stdin` 的路径。也就是说，标准输入不参与日志方案，也不是 CLI 的交互输入来源。

## 6. 使用约定

新增日志时优先按下面规则选择写入位置：

| 场景 | 推荐写法 |
| --- | --- |
| 影响用户可见状态、run/page/artifact 生命周期 | 写 `runLogs.log(...)` |
| 需要 UI 列表中可筛选、可解释的事件 | 写 `runLogs.log(...)` |
| 大量调试上下文、外部服务返回、规划过程明细 | 写 `logger.info/warn/error(...)` |
| Crawlee 底层输出 | 交给 Crawlee bridge 写 runtime log |
| 顶层运行失败 | 同时写 `crawl_runs.error_message` 和 `crawl_error` |

结构化事件名应该保持稳定，避免把动态值放进 `event`。动态信息放在 `message` 或 `meta`：

```ts
await runLog.log({
  crawlRunId,
  level: 'info',
  event: 'artifact_done',
  url,
  sitePageId,
  pageRunId,
  message: `[markdown] done ${url}`,
  meta: { tool, outputPath },
});
```

`meta` 里可以放用于排障的结构化字段，但要避免塞入过大的正文、HTML、截图二进制或敏感配置。大内容应写 artifact 文件，日志只保存路径和摘要。

## 7. 排障入口

排查一次异常 run 时，建议按这个顺序看：

1. `crawl_runs.status` 和 `crawl_runs.error_message`：确认 run 是否顶层失败。
2. `run_logs`：查看是否有 `crawl_error`、`base_page_failed`、`artifact_failed`。
3. `run_logs.meta`：查看 stack、outputPath、tool 等结构化信息。
4. `runtime.log`：查看 Crawlee 重试、请求过程、分类器异常、启动 URL 规划等细节。
5. artifact 文件：根据 `outputPath` 检查实际产物。

常见判断：

- 有 `crawl_error`：run 顶层异常，先看 `meta.stack` 和 `runtime.log`。
- 只有局部 `artifact_failed`：run 可能仍然结束，但部分页面缺 markdown 或 screenshot。
- 有 `runtime_log_ready` 但 runtime log 内容为空：可能文件刚创建尚未写入，或进程在初始化后很早失败。
- UI 看不到详细日志按钮：通常是缺少 `runtime_log_ready` 事件，说明 run 初始化阶段未完成或历史数据来自旧版本。

## 8. 当前边界

当前方案有几个边界需要明确：

- `run_logs` 只有 `crawl_run_id` 索引；按大 run 查询时会返回全部事件，后续如果日志量增大，可以考虑增加 `(crawl_run_id, site_page_id)` 或时间索引。
- runtime log 没有轮转和压缩策略；长 run 可能产生较大文件。
- runtime log 查询使用整文件读取后再 tail，适合当前日志规模；如果文件继续变大，应改为从文件尾部流式读取。
- `run_logs.meta_json` 没有 schema 约束，新增字段需要保持向后兼容。
- Crawlee logger bridge 是全局安装，未来如果引入多进程或更高并发 run，需要重新验证日志归属。

总体上，当前日志方案刻意保持“两层分工”：数据库保存可查询的关键业务事件，文件保存完整运行细节。这样既能让 Web UI 保持清爽，也能在需要时拿到足够多的排障信息。
