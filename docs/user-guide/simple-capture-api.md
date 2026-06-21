# 简易采集 API 对接文档

本文档面向外部系统调用方，描述如何通过 API 提交多个 URL 到系统默认站点，并获取本次运行结果。

## 基础地址

**Base URL：** `https://vt-sys.fastinsight.info/capture`

下文中的接口路径均为相对路径，调用时需拼接到上述 Base URL 之后。例如：

| 文档中的路径 | 完整请求地址 |
| --- | --- |
| `POST /api/simple-capture/runs` | `https://vt-sys.fastinsight.info/capture/api/simple-capture/runs` |
| `GET /api/simple-capture/runs/456` | `https://vt-sys.fastinsight.info/capture/api/simple-capture/runs/456` |

## 认证

服务端需配置静态 API Key：

```bash
KVAULT_API_KEY=your-secret-key
```

调用方任选一种方式传递：

```http
X-API-Key: your-secret-key
```

或：

```http
Authorization: Bearer your-secret-key
```

未配置 `KVAULT_API_KEY` 时，外部 API Key 认证不可用，只能通过 Web UI 的登录 cookie 访问接口。

## 前置配置

简易采集入口依赖系统默认站点。默认站点由系统管理员预先在 Web UI 中配置，外部调度方不需要、也不能通过本文档接口修改默认站点。(由本系统管理员已完成)

## 分步接口

分步接口适合外部系统自行轮询状态，并在运行完成后下载结果。

### 1. 提交 URL 列表

```http
POST /api/simple-capture/runs
Content-Type: application/json
```

请求：

```json
{
  "urls": [
    "https://example.com/page-a",
    "https://example.com/page-b"
  ]
}
```

可选字段：

```json
{
  "urls": [
    "https://example.com/page-a",
    "https://example.com/page-b"
  ],
  "updatePolicy": "force_recrawl_all",
  "targetSuccessCount": null,
  "staleAfterMs": null
}
```

说明：

- 该接口会在系统默认站点下启动一次 `crawl_run`。
- `initialUrls` 固定为本次提交的 `urls`。
- `crawlMaxDepthOverride` 固定为 `0`，只采集提交的 URL 列表，不递归扩展。
- 默认 `updatePolicy` 为 `force_recrawl_all`。

响应：

```json
{
  "runId": 456,
  "siteId": 12,
  "statusLabel": "进行中"
}
```

### 2. 查询运行状态

```http
GET /api/simple-capture/runs/456
```

响应示例：

```json
{
  "runId": 456,
  "siteId": 12,
  "runTypeLabel": "正式采集",
  "statusLabel": "已完成",
  "startedAt": "2026-06-08T07:20:00.000Z",
  "finishedAt": "2026-06-08T07:20:12.000Z",
  "successfulPages": 1,
  "pendingPages": 0,
  "deniedPages": 0,
  "targetSuccessCount": null,
  "configSummary": {
    "seedUrlCount": 0,
    "sitemapCount": 0,
    "preFilterRuleCount": 0,
    "captureRuleCount": 1,
    "seedDepth": 1,
    "crawlDepth": 0
  },
  "issues": []
}
```

`statusLabel` 可能为：

- `进行中`
- `已完成`
- `失败`

### 3. 下载运行结果

```http
GET /api/simple-capture/runs/456/download
```

响应：

- `Content-Type: application/zip`
- Body 为标准页面导出 ZIP。

该 ZIP 复用 Web UI 的 page ID 导出格式，范围为该 `runId` 对应的所有 `page_id`。

## 同步阻塞接口

同步阻塞接口会在 HTTP 请求内完成“提交 URL 列表 -> 等待运行结束 -> 返回结果”。调用方需要设置足够长的 HTTP 超时时间。

### 提交并直接下载 ZIP

```http
POST /api/simple-capture/submit-and-download
Content-Type: application/json
```

请求：

```json
{
  "urls": [
    "https://example.com/page-a",
    "https://example.com/page-b"
  ]
}
```

响应：

- `Content-Type: application/zip`
- Body 为标准页面导出 ZIP。

### 提交并直接返回 Markdown

```http
POST /api/simple-capture/submit-markdown
Content-Type: application/json
```

请求：

```json
{
  "urls": [
    "https://example.com/page-a",
    "https://example.com/page-b"
  ]
}
```

响应：

- `Content-Type: text/markdown; charset=utf-8`
- Body 为本次运行成功生成的 Markdown 内容。

响应头：

```http
X-Kvault-Run-Id: 456
X-Kvault-Site-Id: 12
X-Kvault-Page-Count: 2
```

如果站点规则没有产出成功的 Markdown artifact，该接口会返回错误：

```json
{
  "message": "本次运行没有成功 Markdown 产物。"
}
```

## curl 示例

### 分步调用

```bash
curl -X POST 'https://vt-sys.fastinsight.info/capture/api/simple-capture/runs' \
  -H 'X-API-Key: your-secret-key' \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com/page-a","https://example.com/page-b"]}'
```

```bash
curl 'https://vt-sys.fastinsight.info/capture/api/simple-capture/runs/456' \
  -H 'X-API-Key: your-secret-key'
```

```bash
curl 'https://vt-sys.fastinsight.info/capture/api/simple-capture/runs/456/download' \
  -H 'X-API-Key: your-secret-key' \
  -o result.zip
```

### 同步下载 ZIP

```bash
curl -X POST 'https://vt-sys.fastinsight.info/capture/api/simple-capture/submit-and-download' \
  -H 'X-API-Key: your-secret-key' \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com/page-a","https://example.com/page-b"]}' \
  -o result.zip
```

### 同步返回 Markdown

```bash
curl -X POST 'https://vt-sys.fastinsight.info/capture/api/simple-capture/submit-markdown' \
  -H 'X-API-Key: your-secret-key' \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com/page-a","https://example.com/page-b"]}'
```
