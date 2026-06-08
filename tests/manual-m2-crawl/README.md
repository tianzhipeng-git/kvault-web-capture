# M2 手工爬取测试清单

这些配置默认跑本目录的 mock 站点，不要求你的真实站点提供特殊页面。真实站点只建议在 mock 通过后抽 1-2 轮复测。

先启动 mock 服务：

```bash
node --import tsx tests/manual-m2-crawl/mock-server.ts --port 4328
```

建议每轮使用独立 site，base URL 填 `http://127.0.0.1:4328`；或先 `site:import-config` 后 `run:seed` / `run:crawl`。每轮结束后看 `run_logs`、页面状态、sample captures、artifact 文件和 runtime log。

| 轮次 | 配置 | 建议运行 | 测试目的 | 重点观察 |
| --- | --- | --- | --- | --- |
| 1 | `01-baseline-node-chain.json` | `run:seed` 后 `run:crawl --update-policy force_recrawl_all` | 默认 M2 链路：`http-base` + Markdown + Chromium screenshot | base 是否发现链接；crawl_run 是否同时产出 markdown、screenshot；工具诊断是否按 profile 记录 |
| 2 | `02-rules-depth-pending.json` | `run:seed` | URL 规则、label 规则、深度、pending/deny 状态 | 黑名单 URL 是否拒绝；未命中 stage2 规则的页面是否 pending；深度是否控制在预期范围 |
| 3 | `03-validation-fallback.json` | `JINA_API_TOKEN= run:crawl --update-policy force_recrawl_all` | markdown 工具 fallback | `jina-markdown` 缺 token 失败后，是否继续尝试本地 markdown 工具 |
| 4 | `04-crawl4ai-full-stack.json` | `run:crawl --update-policy force_recrawl_all` | Crawl4AI 一体化能力 | 单个 Python tool 是否能覆盖 base、markdown、screenshot、structured；失败时是否回退 Node 工具 |
| 5 | `05-scrapling-structured.json` | `run:crawl --update-policy force_recrawl_all` | Scrapling 结构化抓取与剩余能力补齐 | structured 是否生成；markdown/screenshot 是否由后续工具补齐 |
| 6 | `06-flaky-retry-proxy-session.json` | `run:crawl --update-policy force_recrawl_all` | Crawlee retry、proxy/session 诊断、浏览器身份绑定 | 对临时失败 URL 是否重试；失败日志是否进入 failed handler；proxyPolicy 是否出现在工具失败诊断 |
| 7 | `07-lightpanda-browser.json` | `run:crawl --update-policy force_recrawl_all` | Lightpanda/CDP 浏览器 engine | 配好 `LIGHTPANDA_BINARY` 后，browser lease、CDP、截图/markdown 是否正常；未安装时失败信息是否清楚 |
| 8 | `08-cloakbrowser-browser.json` | `run:crawl --update-policy force_recrawl_all` | CloakBrowser engine | 安装 `cloakbrowser` 后截图是否正常；未安装时是否明确暴露依赖缺失 |

手工记录建议只写结论：通过/失败、runId、失败 URL、失败 tool、关键日志片段、artifact 路径。
