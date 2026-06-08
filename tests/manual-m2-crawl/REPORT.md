# M2 Mock CLI 验收报告

验收时间：2026-06-08

## 结论

8 轮 mock CLI 验收已跑完。除首次受沙箱限制失败的 runId=1 外，正式计入验收的 runId=2-8、10、11、12 均通过对应预期。

过程中发现并修复了一个真实问题：Lightpanda 不能按 Chromium/CloakBrowser 的 run 级 browser/context/page 复用模型运行。并发或复用 target 会触发 `TargetAlreadyLoaded` / `Target page, context or browser has been closed`。修复后，Lightpanda page lease 使用独立短生命周期进程/context/page，并在 release 时回收。

## 执行环境

- Mock 服务：`node --import tsx tests/manual-m2-crawl/mock-server.ts --port 4328`
- 测试 DB：`tests/manual-m2-crawl/.local/state.db`
- 测试 storage：`tests/manual-m2-crawl/.local/storage`
- CLI 运行时显式清空 `KVAULT_DATABASE_URL`，使用 SQLite `--db`
- Python 工具使用 `.env` 中的 `KVAULT_PYTHON_CRAWL4AI` 和 `KVAULT_PYTHON_SCRAPLING`

## 轮次结果

| 轮次 | 计入 runId | 结果 | 关键结果 |
| --- | --- | --- | --- |
| 1 baseline seed | 2 | 通过 | 8 page runs，8 pending，0 artifact |
| 1 baseline crawl | 3 | 通过 | 9 page runs，9 markdown + 9 screenshot，0 failed artifact |
| 2 rules/depth/pending | 4 | 通过 | 9 page runs，4 seed pending，3 rule unmatched pending，2 deny |
| 3 markdown fallback | 12 | 通过 | `jina-markdown` 缺 token 失败后，`defuddle-markdown` 成功产出 2 个 markdown |
| 4 Crawl4AI full stack | 6 | 通过 | 2 markdown + 2 screenshot + 2 structured |
| 5 Scrapling structured | 7 | 通过 | 1 structured + 1 markdown + 1 screenshot |
| 6 retry/proxy/session | 8 | 通过 | flaky URL 首次 500 后 retry 成功；blocked URL 403 重试到上限后 deny |
| 7 Lightpanda browser | 11 | 通过 | 修复后 2 markdown + 2 screenshot，0 failed artifact |
| 8 CloakBrowser browser | 10 | 通过 | 2 screenshot，0 failed artifact |

## 修复验证

- `pnpm typecheck`：通过
- `pnpm test -- tests/playwright-screenshot-tool.test.ts tests/markdown-tool.test.ts tests/page-capture-executor.test.ts`：通过，20 个测试文件、79 个测试
- `pnpm exec vitest run --config vitest.e2e-capture.config.ts tests/capture-stack.e2e-capture.test.ts -t "isolates concurrent lightpanda page leases"`：通过

## 备注

- runId=1 是第一次在沙箱内启动 Crawlee 时的 `spawn EPERM`，未计入验收结果。
- 第 3 轮为了稳定触发 fallback，回归命令使用 `JINA_API_TOKEN=` 清空 token。
- 第 7 轮修复前 runId=9 有 2 个 failed artifact；修复后 runId=11 已通过。
