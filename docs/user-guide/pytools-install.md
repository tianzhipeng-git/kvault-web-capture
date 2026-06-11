# Python Capture Tools 安装说明

`crawl4ai-page` 和 `scrapling-page` 是 Node 侧 `CaptureTool` 的 Python bridge 实现。Node 进程会优先按工具级环境变量和仓库 `.venv` 选择 Python 解释器，再执行 `src/capture/pytools/*.py`。

## 1. 创建 Python 环境

建议使用仓库内的 `.venv`，避免污染系统 Python。当前上游版本组合里，`crawl4ai==0.8.6` 声明 `lxml~=5.3`，而 `scrapling[all]==0.4.8` 需要 `lxml>=6.1.0`。项目用 uv override 明确把合并环境固定到 `lxml==6.1.1`：

```bash
cd /Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture
uv venv .venv --python 3.11
uv pip install --python .venv/bin/python \
  -r src/capture/pytools/requirements.txt \
  --overrides src/capture/pytools/uv-overrides.txt
```

如果机器上没有 uv，也可以先安装 uv；不建议用普通 `pip install -r` 安装这个组合，因为 pip/uv 的标准 resolver 会正确地拒绝上游 metadata 中的 `lxml` 互斥约束。

旧的拆分环境仍可作为 fallback 使用，或者通过工具级环境变量显式指定：

```bash
export KVAULT_PYTHON_CRAWL4AI=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-crawl4ai/bin/python
export KVAULT_PYTHON_SCRAPLING=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-scrapling/bin/python
```

## 2. 安装浏览器依赖

Crawl4AI 和 Scrapling 都会使用浏览器能力。安装 Python 包后，如果要启用它们各自“自管浏览器”的 fallback 路径，还需要安装浏览器运行时：

```bash
. .venv/bin/activate
playwright install chromium
python -m cloakbrowser install
scrapling install
```

系统依赖:
```
/home/bluewii/.conda/envs/prefect-env/bin/playwright  install-deps chromium
```

如果 Crawl4AI 环境需要额外初始化，可运行：

```bash
crawl4ai-setup
crawl4ai-doctor
```

`crawl4ai-doctor` 只用于检查环境，不是每次运行必需。

## 3. 让 Node 使用该 Python

启动 CLI 或 Web 服务前设置。解释器选择优先级如下：

1. `KVAULT_PYTHON_CRAWL4AI` / `KVAULT_PYTHON_SCRAPLING`
2. `KVAULT_PYTHON`
3. 仓库默认探测的 `.venv`
4. 仓库默认探测的旧拆分环境 `.venv-crawl4ai` / `.venv-scrapling`
5. `python3`

默认不需要设置环境变量。如果你使用拆分环境，建议显式设置工具级变量：

```bash
export KVAULT_PYTHON_CRAWL4AI=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-crawl4ai/bin/python
export KVAULT_PYTHON_SCRAPLING=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-scrapling/bin/python
```

如果你使用非默认共享环境，也可以只设置：

```bash
export KVAULT_PYTHON=/path/to/shared-python/bin/python
```

如果常规运行路径是“TS BrowserManager 提供 CDP endpoint，Python tool 复用该浏览器”，那么上面的浏览器安装步骤不是首选必需项；但当 CDP 不可用、工具回退到自管浏览器，或者你需要单独调试 Python tool 时，仍建议安装。部署时也建议显式设置环境变量，避免用错 Python 环境。

## 4. 启用 capture profile

完整配置说明见 [SiteConfig 抓取 Profile 配置](./site-config-capture-profile.md)。工具能力与说明见 [Capture Tools 参考](../tech-details/capture-tools-reference.md)。

默认站点仍使用内置 Node 工具链：

```json
{
  "tools": ["http-base", "defuddle-markdown", "lightpanda-markdown", "jina-markdown", "playwright-screenshot"]
}
```

需要使用 Python 工具时，在站点配置中加入 profile，例如：

```json
{
  "captureProfile": {
    "tools": [
      "crawl4ai-page",
      "scrapling-page",
      "http-base",
      "defuddle-markdown",
      "lightpanda-markdown",
      "jina-markdown",
      "playwright-screenshot"
    ]
  },
  "validation": {
    "markdown": {
      "minLength": 500,
      "rejectRegex": ["Access Denied", "Just a moment"]
    },
    "screenshot": {
      "minBytes": 20000
    }
  }
}
```

`crawl4ai-page` 优先覆盖 `base`、`markdown`、`screenshot`、`structured`；`scrapling-page` 同样覆盖这四类能力。如果 BrowserManager 提供 CDP endpoint，Python bridge 会把 `cdpUrl` 传给 Python 工具，让 Crawl4AI / Scrapling 连接项目管理的浏览器身份；否则它们回退到各自默认启动方式。Executor 会按 profile 顺序尝试工具，validator 拒绝或工具失败后继续 fallback。

## 5. 构建产物

`pnpm build` 会复制以下文件到 `dist/src/capture/pytools/`：

- `common.py`
- `crawl4ai_tool.py`
- `scrapling_tool.py`
- `requirements.txt`
- `uv-overrides.txt`

部署 dist 时仍需要在目标机器安装 Python 依赖，并设置对应的 `KVAULT_PYTHON_*` 或 `KVAULT_PYTHON`，或者把依赖安装到仓库默认 `.venv`。

## 6. 常见错误

- `bridge failed ... crawl4ai is not installed`：当前 `KVAULT_PYTHON_CRAWL4AI` 或回退到的 Python 环境没有安装 `crawl4ai`。
- `bridge failed ... scrapling is not installed`：当前 `KVAULT_PYTHON_SCRAPLING` 或回退到的 Python 环境没有安装 `scrapling[all]`。
- `bridge returned invalid JSON`：Python 工具 stdout 被污染或脚本异常。当前脚本会把进程 stdout 重定向到 stderr 并只把 JSON 写回原 stdout；如果仍出现该错误，优先查看 run log 中的 stderr。
- 浏览器启动失败：重新运行 `playwright install chromium` 和 `scrapling install`。
