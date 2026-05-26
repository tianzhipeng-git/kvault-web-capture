# Python Capture Tools 安装说明

`crawl4ai-page` 和 `scrapling-page` 是 Node 侧 `CaptureTool` 的 Python bridge 实现。Node 进程会优先按工具级环境变量和约定虚拟环境路径选择 Python 解释器，再执行 `src/capture/pytools/*.py`。

## 1. 创建 Python 环境

建议使用独立虚拟环境，避免污染系统 Python。如果只使用单一 Python tool，可以共用一个环境：

```bash
cd /Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture
python3.12 -m venv .venv-pytools
. .venv-pytools/bin/activate
python -m pip install --upgrade pip
python -m pip install -r src/capture/pytools/requirements.txt
```

如果机器上没有 `python3.12`，也可以使用兼容的 Python 解释器路径。

如果你需要同时启用 `crawl4ai-page` 和 `scrapling-page`，更推荐拆成两个环境。当前上游版本组合 `crawl4ai~=0.8.6` 与 `scrapling[all]~=0.4.8` 可能因为依赖冲突无法稳定共存于同一个虚拟环境：

```bash
cd /Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture

python3.12 -m venv .venv-crawl4ai
. .venv-crawl4ai/bin/activate
python -m pip install --upgrade pip
python -m pip install "crawl4ai~=0.8.6"
deactivate

python3.12 -m venv .venv-scrapling
. .venv-scrapling/bin/activate
python -m pip install --upgrade pip
python -m pip install "scrapling[all]~=0.4.8"
deactivate
```

## 2. 安装浏览器依赖

Crawl4AI 和 Scrapling 都会使用浏览器能力。安装 Python 包后，如果要启用它们各自“自管浏览器”的 fallback 路径，还需要安装浏览器运行时：

```bash
. .venv-pytools/bin/activate
playwright install chromium
scrapling install
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
3. 仓库默认探测的 `.venv-crawl4ai` / `.venv-scrapling`
4. 仓库默认探测的 `.venv`
5. `python3`

如果你使用拆分环境，建议显式设置工具级变量：

```bash
export KVAULT_PYTHON_CRAWL4AI=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-crawl4ai/bin/python
export KVAULT_PYTHON_SCRAPLING=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-scrapling/bin/python
```

如果你使用共享环境，也可以继续只设置：

```bash
export KVAULT_PYTHON=/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/.venv-pytools/bin/python
```

如果常规运行路径是“TS BrowserManager 提供 CDP endpoint，Python tool 复用该浏览器”，那么上面的浏览器安装步骤不是首选必需项；但当 CDP 不可用、工具回退到自管浏览器，或者你需要单独调试 Python tool 时，仍建议安装。部署时也建议显式设置环境变量，避免用错 Python 环境。

## 4. 启用 capture profile

默认站点仍使用内置 Node 工具链：

```json
{
  "tools": ["http-base", "defuddle-markdown", "lightpanda-markdown", "jina-markdown", "playwright-screenshot"]
}
```

需要使用 Python 工具时，在站点配置中加入 profile，例如：

```json
{
  "captureProfiles": {
    "default": {
      "tools": [
        "crawl4ai-page",
        "scrapling-page",
        "http-base",
        "defuddle-markdown",
        "lightpanda-markdown",
        "jina-markdown",
        "playwright-screenshot"
      ],
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
  },
  "defaultCaptureProfile": "default"
}
```

`crawl4ai-page` 优先覆盖 `base`、`markdown`、`screenshot`、`structured`；`scrapling-page` 优先覆盖 `base`、`structured`。如果 BrowserManager 提供 CDP endpoint，Python bridge 会把 `cdpUrl` 传给 Python 工具，让 Crawl4AI / Scrapling 连接项目管理的浏览器身份；否则它们回退到各自默认启动方式。Executor 会按 profile 顺序尝试工具，validator 拒绝或工具失败后继续 fallback。

## 5. 构建产物

`pnpm build` 会复制以下文件到 `dist/src/capture/pytools/`：

- `common.py`
- `crawl4ai_tool.py`
- `scrapling_tool.py`
- `requirements.txt`

部署 dist 时仍需要在目标机器安装 Python 依赖，并设置对应的 `KVAULT_PYTHON_*` 或 `KVAULT_PYTHON`。

## 6. 常见错误

- `bridge failed ... crawl4ai is not installed`：当前 `KVAULT_PYTHON_CRAWL4AI` 或回退到的 Python 环境没有安装 `crawl4ai`。
- `bridge failed ... scrapling is not installed`：当前 `KVAULT_PYTHON_SCRAPLING` 或回退到的 Python 环境没有安装 `scrapling[all]`。
- `bridge returned invalid JSON`：Python 工具 stdout 被污染或脚本异常。当前脚本会把进程 stdout 重定向到 stderr 并只把 JSON 写回原 stdout；如果仍出现该错误，优先查看 run log 中的 stderr。
- 浏览器启动失败：重新运行 `playwright install chromium` 和 `scrapling install`。
