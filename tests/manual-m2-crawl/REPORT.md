# M2 Mock CLI 验收报告

验收时间：2026-06-08

## 结论

已重新从干净的 `tests/manual-m2-crawl/.local` 完整跑完 8 组 mock CLI 测试。9 个实际 run 全部为 `succeeded`，所有 CLI run 命令 exit code 均为 0。

本轮判断不是只看 artifact 数量：同时审计了 SQLite 的 `crawl_runs`、`page_runs`、`artifact_runs`、`run_logs`，以及每个 run 的 `runtime.log`。日志确认了 fallback、retry、proxyPolicy 诊断、Python bridge、CDP lease、Lightpanda/CloakBrowser engine、规则 pending/deny 等关键行为。

## 执行环境

- Mock 服务：`node --import tsx tests/manual-m2-crawl/mock-server.ts --port 4328`
- 测试 DB：`tests/manual-m2-crawl/.local/state.db`
- 测试 storage：`tests/manual-m2-crawl/.local/storage`
- CLI 输出：`tests/manual-m2-crawl/.local/cli-output`
- 每条 CLI 显式传 `KVAULT_DATABASE_URL=`，避免 `.env` 中的 Postgres 配置覆盖 `--db`
- Python 工具使用 `.env` 中的 `KVAULT_PYTHON_CRAWL4AI` 和 `KVAULT_PYTHON_SCRAPLING`

## 轮次结果

| 轮次 | runId | 结果 | 深入日志确认 |
| --- | --- | --- | --- |
| 1 baseline seed | 1 | 通过 | 8 个 `http-base` base capture；8 个页面全部 `pending/seed_run`；Crawlee `8 succeeded, 0 failed` |
| 1 baseline crawl | 2 | 通过 | 9 个 base、9 个 `defuddle-markdown`、9 个 `playwright-screenshot`；Chromium page lease acquire/release 各 9 次 |
| 2 rules/depth/pending | 3 | 通过 | 9 个 base；4 个 `seed_run` pending，3 个 `rule_unmatched` pending，`/search?q=m2` 和 `/search?q=blog` deny |
| 3 markdown fallback | 4 | 通过 | 两个 docs 页面均先 `jina-markdown` 失败：`Missing JINA_API_TOKEN`，随后 `defuddle-markdown` 成功 |
| 4 Crawl4AI full stack | 5 | 通过 | 5 个 base、2 screenshot、2 structured 由 `crawl4ai-page` 成功；`/docs` markdown 首次 Crawl4AI 失败后 fallback 到 `defuddle-markdown`；CDP lease acquire/release 各 11 次 |
| 5 Scrapling structured | 6 | 通过 | `scrapling-page` 完成 base 和 structured；markdown/screenshot 由 `crawl4ai-page` 补齐；Python bridge 均有 started/finished |
| 6 retry/proxy/session | 7 | 通过 | flaky URL 首次 500 后 Crawlee reclaim retry，随后成功；always-blocked 403 重试到上限后 failed handler 记录 deny；失败诊断包含 `proxyPolicy=retry_on_failure provider=crawlee` |
| 7 Lightpanda browser | 8 | 通过 | 2 个 `lightpanda-markdown`、2 个 screenshot；runtime log 确认 engine=`lightpanda`，4 个 `lightpanda:lease:*` 短生命周期 process/context/page 均 retire |
| 8 CloakBrowser browser | 9 | 通过 | 2 个 screenshot；runtime log 确认 engine=`cloakbrowser` 和 `processKey=cloakbrowser:run:9`；stderr 只有 CloakBrowser 版本更新提示 |

## 重要观察

- `04-crawl4ai-full-stack` 的实际表现不是“全部 artifact 都由 Crawl4AI 一次完成”：`/docs` 的 markdown 先因 Crawl4AI bridge 导航错误失败，executor 继续尝试 `defuddle-markdown` 并成功。最终 run 仍通过，但报告应保留这个 fallback 事实。
- `05-scrapling-structured` 符合设计：Scrapling 只覆盖 base/structured，剩余 markdown/screenshot 由后续工具补齐。
- `06-flaky-retry-proxy-session` 不能只看最终 1 个 markdown + 1 个 screenshot；runtime log 明确显示 500 被 reclaim 后成功，403 被重试到最大次数后进入 failed handler。
- `07-lightpanda-browser` 本轮未复现之前的 target 复用错误；日志显示每个 Lightpanda page lease 使用独立 `lightpanda:lease:*` 并在 release 后 retire。
- `.env` 中如果存在 `KVAULT_DATABASE_URL`，当前 CLI 会优先连接 Postgres，即使传了 `--db`。本报告的正式结果均来自显式清空 `KVAULT_DATABASE_URL` 后的 SQLite 隔离运行。

## 验证命令

- 完整 CLI mock 测试：通过，正式 runId 为 `1-9`
- `pnpm typecheck`：通过
- `pnpm test -- tests/playwright-screenshot-tool.test.ts tests/markdown-tool.test.ts tests/page-capture-executor.test.ts`：通过，20 个测试文件、80 个测试
- `pnpm exec vitest run --config vitest.e2e-capture.config.ts tests/capture-stack.e2e-capture.test.ts -t "isolates concurrent lightpanda page leases"`：通过
