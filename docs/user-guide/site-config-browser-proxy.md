# SiteConfig 浏览器与代理配置

本文说明 `SiteConfig.browser` 和 `SiteConfig.proxyPolicy` 的用法。它们影响浏览器工具、截图工具、Python 工具连接项目 BrowserManager 时使用的浏览器身份、context 复用和代理绑定。

## 1. 默认行为

不写 `browser` 时，运行时等价于以下默认策略：

```json
{
  "browser": {
    "engine": "chromium",
    "profileMode": "ephemeral",
    "reuse": "run_browser",
    "contextReuse": "site_session_proxy",
    "pageReuse": "none",
    "proxyBinding": "session"
  }
}
```

不写 `proxyPolicy` 时，不额外声明代理策略。实际代理信息仍来自 Crawlee runtime 传入的 `proxyInfo`；浏览器是否把它纳入身份由 `browser.proxyBinding` 决定。

## 2. browser 字段

```json
{
  "browser": {
    "engine": "chromium",
    "profileMode": "ephemeral",
    "reuse": "run_browser",
    "contextReuse": "site_session_proxy",
    "pageReuse": "none",
    "proxyBinding": "session"
  }
}
```

字段说明：

| 字段 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `engine` | `chromium`, `cloakbrowser`, `lightpanda` | `chromium` | 使用的浏览器引擎 |
| `profileMode` | `ephemeral`, `persistent`, `storage_state` | `ephemeral` | 浏览器身份的 profile 模式 |
| `reuse` | `run_browser`, `site_browser` | `run_browser` | browser process 的复用范围 |
| `contextReuse` | `site_session_proxy`, `site_run` | `site_session_proxy` | BrowserContext 的复用 key |
| `pageReuse` | `none` | `none` | 当前版本只支持不复用 page |
| `proxyBinding` | `session`, `none` | `session` | 是否把 runtime proxy 绑定到浏览器身份 |

### 2.1 engine

`chromium` 使用 Playwright Chromium。macOS 上如果存在 `/Applications/Google Chrome.app`，会优先使用系统 Chrome channel。

`cloakbrowser` 会尝试动态导入 `cloakbrowser` 包。未安装时会报错。

`lightpanda` 会启动 `LIGHTPANDA_BINARY` 环境变量指定的 binary；未设置时使用 `lightpanda`。它通过本地 CDP endpoint 接入 Playwright。

### 2.2 reuse

`reuse` 控制 browser process 的复用范围：

| 值 | process key | 适用场景 |
| --- | --- | --- |
| `run_browser` | `engine + runId` | 默认值；一次 run 内复用 browser process，run 结束后关闭 |
| `site_browser` | `engine + siteId` | 按站点生成 browser process key；在当前应用默认 run 生命周期中，BrowserManager 仍会在 run 结束时关闭 |

### 2.3 contextReuse

`contextReuse` 控制 BrowserContext 的复用范围：

| 值 | context key | 适用场景 |
| --- | --- | --- |
| `site_session_proxy` | `engine + profileMode + siteId + sessionId + proxy + profileKey` | 默认值；尽量保持 Crawlee session、proxy、profile 的身份一致 |
| `site_run` | `engine + profileMode + siteId + runId` | 同站点同 run 使用同一个 context；隔离更少，复用更多 |

BrowserManager 会在创建 context 时尝试从 Crawlee session 同步 cookie 到浏览器 context，并在 page release 时把浏览器 cookie 同步回 Crawlee session。

### 2.4 profileMode

`profileMode` 当前参与浏览器 identity 和 context key。也就是说，不同 `profileMode` 不会共用同一个 context。

当前版本尚未为 `persistent` 自动创建用户数据目录，也尚未为 `storage_state` 自动读写 storage state 文件；它们是为后续持久化 profile 策略预留的配置值。需要长期保持登录态时，应先确认当前工具链是否已经提供对应的 profile 管理能力。

### 2.5 proxyBinding

`proxyBinding: "session"` 时，BrowserManager 会把 runtime 的 `proxyInfo.url` 纳入浏览器 identity，并传给 Playwright context、CloakBrowser 或 Lightpanda。

`proxyBinding: "none"` 时，浏览器 identity 不绑定 runtime proxy，也不会主动把该 proxy 设置到浏览器 context。

## 3. proxyPolicy 字段

```json
{
  "proxyPolicy": {
    "mode": "retry_on_failure",
    "provider": "crawlee"
  }
}
```

字段说明：

| 字段 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `off`, `always`, `retry_on_failure` | 不配置 | 站点期望的代理策略 |
| `provider` | `crawlee`, `apify` | `crawlee` | 代理来源标识；省略时诊断信息按 `crawlee` 展示 |

当前版本中，`proxyPolicy` 主要作为站点策略声明和失败诊断信息使用：工具失败时，diagnostics 会记录当前策略，帮助判断后续 fallback 是否应该使用 runtime proxy/session。

实际代理 URL 来自 Crawlee runtime 的 `proxyInfo`，并被传给浏览器工具和 Python 工具。`proxyPolicy.mode: "off"` 本身不会清空已经存在的 runtime proxy；如果要让浏览器不绑定 runtime proxy，应同时设置：

```json
{
  "browser": {
    "proxyBinding": "none"
  },
  "proxyPolicy": {
    "mode": "off"
  }
}
```

## 4. 示例：高防站点优先保持身份一致

```json
{
  "browser": {
    "engine": "chromium",
    "profileMode": "ephemeral",
    "reuse": "run_browser",
    "contextReuse": "site_session_proxy",
    "pageReuse": "none",
    "proxyBinding": "session"
  },
  "proxyPolicy": {
    "mode": "retry_on_failure",
    "provider": "crawlee"
  }
}
```

这个配置适合希望 HTTP base、浏览器截图、Python 工具尽量使用同一 Crawlee session/proxy 身份的站点。

## 5. 示例：轻量站点减少隔离

```json
{
  "browser": {
    "engine": "chromium",
    "profileMode": "ephemeral",
    "reuse": "run_browser",
    "contextReuse": "site_run",
    "pageReuse": "none",
    "proxyBinding": "none"
  },
  "proxyPolicy": {
    "mode": "off"
  }
}
```

这个配置适合不需要代理身份隔离、希望同一个 run 内尽量复用浏览器 context 的轻量站点。
