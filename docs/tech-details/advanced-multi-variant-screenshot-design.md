# 高级多规格完整截图方案

> 状态：设计方案，待实现  
> 范围：`crawl_run` 的 `screenshot` artifact  
> 核心实现：Playwright + Scrapling  
> 更新：2026-07-15

## 1. 背景与结论

当前 `screenshot` 已接入规则、任务队列、`PageCaptureExecutor`、BrowserManager、数据库、文件存储和导出，但实现仅在 `load` 后固定等待 3 秒，再执行 Playwright `fullPage: true`。它不能保证懒加载资源、动态内容和局部滚动容器已经完整呈现，也不支持一次 run 同时产出多个设备或分辨率。

本方案锁定以下决策：

1. 不新增 `screenshot-plus`。产物仍是 `screenshot`，高级能力属于截图要求和工具支持等级。
2. artifact 增加 variant 维度，同一页面可在一次 run 产出多个 screenshot variants。
3. 每个 variant 是独立 artifact task，独立导航、准备、fallback、重试和落库。
4. Playwright 和 Scrapling 都是一等实现，遵守相同配置、页面准备语义、metadata 和验收标准。
5. 规则仍只决定是否需要 screenshot；命中后由 run 配置展开全部 variants。
6. 页面成功要求全部所需 variants 成功，部分成功不能进入 `stage2_captured`。
7. variant 配置指纹参与历史复用，防止同名规格变更后误用旧截图。

## 2. 目标与非目标

目标是支持桌面、移动设备预设和自定义 viewport，一次 run 产出多个规格；等待图片、字体与布局稳定，滚动文档和局部容器触发懒加载，并把普通局部容器展开为单张完整图。无限滚动、虚拟列表和超长页面必须受上限约束并返回 `truncated`。Playwright/Scrapling 使用相同输入、输出和 fallback 语义，同时复用现有 Crawlee retry、BrowserManager、artifact、导出及 SQLite/PostgreSQL 体系。

第一版不展开跨域 iframe，不保证无限流可以无限滚到底，也不拼接多个独立滚动面板的全部交互状态；不新增独立截图服务或队列，不让 Crawl4AI 满足 `mode: complete`，也不在同一 Page 上反复 resize 模拟多个设备。

## 3. 领域模型

### 3.1 Artifact requirement

`artifactType` 表示产物类别，`variantKey` 表示同类产物规格：

```text
page_run 42
├── markdown / default
├── screenshot / desktop-1440
├── screenshot / mobile-iphone-15
└── screenshot / custom-1920
```

```typescript
interface ArtifactRequirement {
  artifactType: ArtifactType;
  variantKey: string;              // 非多规格 artifact 固定为 default
  configFingerprint: string | null;
}
```

示例身份：

```text
markdown/default/null
screenshot/desktop-1440/<sha256>
screenshot/mobile-iphone-15/<sha256>
```

`variantKey` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，在同一截图配置内唯一，用于任务、日志、文件和 API。它不能单独决定历史复用。

### 3.2 配置指纹

```text
SHA-256(canonical JSON(
  screenshot.mode
  + screenshot.preparation 的最终默认值
  + 当前 variant 完整配置
  + protocolVersion
))
```

canonical JSON 对对象 key 排序、数组保序、剔除 `undefined` 并补齐默认值。`protocolVersion` 必须参与指纹，确保未来准备算法语义变化时旧结果失效。

## 4. SiteConfig

### 4.1 示例

```json
{
  "captureProfile": {
    "tools": [
      "http-base",
      "defuddle-markdown",
      "playwright-screenshot",
      "scrapling-page"
    ]
  },
  "screenshot": {
    "mode": "complete",
    "preparation": {
      "waitForImages": true,
      "waitForFonts": true,
      "scrollDocument": true,
      "scrollContainers": true,
      "expandScrollContainers": true,
      "scrollStepRatio": 0.8,
      "settleMs": 500,
      "stableRounds": 2,
      "maxScrollRounds": 100,
      "maxCaptureHeight": 50000,
      "timeoutMs": 90000,
      "onLimit": "truncate"
    },
    "variants": [
      {
        "key": "desktop-1440",
        "device": "desktop",
        "viewport": { "width": 1440, "height": 900 },
        "deviceScaleFactor": 1
      },
      { "key": "mobile-iphone-15", "device": "iPhone 15" },
      {
        "key": "custom-1920",
        "device": "desktop",
        "viewport": { "width": 1920, "height": 1080 },
        "deviceScaleFactor": 1
      }
    ]
  }
}
```

### 4.2 类型

```typescript
type ScreenshotMode = 'basic' | 'complete';

interface ScreenshotConfig {
  mode: ScreenshotMode;
  preparation: ScreenshotPreparationConfig;
  variants: ScreenshotVariantConfig[];
}

type ScreenshotVariantConfig =
  | {
      key: string;
      device: 'desktop';
      viewport: { width: number; height: number };
      deviceScaleFactor?: number;
    }
  | { key: string; device: string }; // 项目允许的 device preset

interface ScreenshotPreparationConfig {
  waitForImages: boolean;
  waitForFonts: boolean;
  scrollDocument: boolean;
  scrollContainers: boolean;
  expandScrollContainers: boolean;
  scrollStepRatio: number;
  settleMs: number;
  stableRounds: number;
  maxScrollRounds: number;
  maxCaptureHeight: number;
  timeoutMs: number;
  onLimit: 'truncate' | 'fail';
}
```

### 4.3 校验

variants 数量为 1 到 10，key 唯一且满足安全字符规则。viewport width 320 到 7680、height 320 到 4320、DPR 1 到 4；`scrollStepRatio` 0.1 到 1，`maxScrollRounds` 1 到 1000，`maxCaptureHeight` 1000 到 200000（部署默认建议 50000）。`timeoutMs` 小于 Crawlee handler timeout并为清理预留时间；device preset 来自明确 allowlist。complete profile 没有合格 tool 时在 run 启动前失败。

## 5. 运行时流程

```text
rulesBeforeStage2Eq → required type: screenshot
        │
        ▼
expandArtifactRequirements(config snapshot)
        ├── desktop-1440 / fp-a
        ├── mobile-iphone-15 / fp-b
        └── custom-1920 / fp-c
        │
        ▼
Update Policy 按 requirement 过滤
        │
        ▼
每个 requirement 独立入队
        │
        ▼
Executor: Playwright → Scrapling fallback
        │
        ▼
Validator → PNG + artifact_runs → 聚合状态刷新
```

### 5.1 规则展开

URL/label 规则仍使用：

```json
{ "artifacts": ["markdown", "screenshot"] }
```

规则不直接列 variant。Stage 2 命中 screenshot 后，使用本 run 的 `config_snapshot_json.screenshot.variants` 展开全部 requirements。规则回答“是否截图”，SiteConfig 回答“截哪些规格”。按规则选择部分 variants 不在本次范围。

### 5.2 Task

```typescript
interface PageCaptureTask {
  // 现有字段省略
  needs: CaptureCapability[];
  artifactRequirement?: ArtifactRequirement;
}
```

```typescript
task.needs = ['screenshot'];
task.artifactRequirement = {
  artifactType: 'screenshot',
  variantKey: 'desktop-1440',
  configFingerprint: '...'
};
```

唯一键：

```text
artifact:{runId}:{sitePageId}:{artifactType}:{variantKey}:{configFingerprint}
```

### 5.3 screenshot 不做 eager capture

多规格 screenshot 不再合并进 base task：

- Stage 2 前尚不确定是否需要截图。
- 一次 base 调用不能正确返回多个设备 Context 的截图。
- 独立任务才能隔离 retry、fallback、超时和部分成功。

Markdown/structured 保留现有 eager capture；`resolveBaseTaskNeeds` 只排除 screenshot。

## 6. Tool 支持与 fallback

### 6.1 支持协议

```typescript
interface CaptureSupport {
  supported: boolean;
  reason?: string;
}

interface CaptureTool {
  readonly name: string;
  readonly capabilities: readonly CaptureCapability[];
  supports(capability: CaptureCapability, input: CaptureInput): CaptureSupport;
  capture(input: CaptureInput): Promise<CaptureToolResult>;
}
```

Executor 同时检查粗粒度 capability 和 `supports()`。一体化工具不支持当前 complete screenshot 时，只从该次 `toolNeeds` 排除 screenshot；base、markdown、structured 仍可执行。

| Tool | basic | complete desktop/custom | complete mobile |
| --- | --- | --- | --- |
| `playwright-screenshot` | 是 | 是 | 是 |
| `scrapling-page` | 是 | 是 | Context 级设备模拟验收后支持 |
| `crawl4ai-page` | 是 | 否 | 否 |

Scrapling 的 `page_action(page)` 可完成滚动、等待和截图，但 mobile 必须在导航前配置 viewport、screen、UA、touch、`isMobile` 和 DPR。只在 `page_action` resize 不能算移动端支持。实现前需验证当前 Scrapling API 能否在 CDP 模式创建正确 Context；不能则扩展 adapter 的标准启动路径，不得静默桌面降级。

### 6.2 Fallback

```text
Playwright
  ├── accepted → variant 完成
  └── 抛错/metadata 不合格
                 ▼
             Scrapling
               ├── accepted → variant 完成
               └── failed → executor 抛错 → Crawlee request retry
```

每个 tool 在单次 handler 中最多一次，variants 互不重试对方。

## 7. 页面准备协议

### 7.1 跨语言边界

不构造跨进程 Page 抽象，只共享协议、配置、metadata 和测试：

```text
ScreenshotPreparationProtocol v1
├── preparePlaywrightPage(page, config)
└── prepare_scrapling_page(page, config)
```

PythonBridge payload 增加当前 `artifactRequirement`、最终 `screenshotConfig` 和 variant。Scrapling 返回与 Playwright 相同的 metadata。

### 7.2 固定阶段

```text
1. Context 设备模拟
2. goto(load)
3. 初始图片/字体等待
4. 发现文档和局部滚动容器
5. 从内到外渐进滚动
6. 每步等待资源与布局稳定
7. 动态增长后重新扫描
8. 展开普通局部滚动容器
9. 最终稳定检查
10. full-page PNG
11. finally 恢复临时 DOM 样式
12. 返回 metadata
```

所有阶段共享总 deadline，不能为每个阶段分别使用完整 timeout。

### 7.3 资源等待

- 当前 DOM 中 `img.complete && naturalWidth > 0` 视为完成，其余尝试 `decode()`。
- decode 失败记录 warning，不无限等待；每轮滚动后重新扫描新图片。
- 支持时等待 `document.fonts.ready`。
- CSS background image 由布局稳定与短网络安静窗口辅助判断，不承诺逐个 decode。
- 不把 `networkidle` 作为唯一条件，避免埋点、轮询和长连接永久阻塞。

### 7.4 滚动与展开

滚动候选：

```text
document.scrollingElement
OR (
  scrollHeight > clientHeight + tolerance
  AND overflow-y in [auto, scroll, overlay]
  AND 可见且达到最小高度
)
```

忽略 textarea/select 和微小装饰容器。按 DOM 深度从内到外，以 `clientHeight × scrollStepRatio` 为步长；每步检查 scrollTop、scrollHeight、新图片、页面高度和 mutation。到达底部后重新扫描动态新增容器。

普通容器截图前临时设置 height/max-height、`overflow-y: visible`、`scrollTop: 0`，保存原 style 并在 finally 恢复。展开后重新等待布局稳定。

以下情况不强制展开并标记 truncated：虚拟列表回收 DOM、超过高度/像素预算、跨域 iframe、展开后持续不稳定。

### 7.5 稳定与上限

连续 `stableRounds` 次采样中，文档/容器高度、未完成图片和 mutation 无实质变化才稳定；使用像素 tolerance 避免亚像素动画永久阻塞。可注入固定 CSS 暂停 animation/transition，此行为必须固定并进入 fingerprint。

达到 `timeoutMs`、`maxScrollRounds`、`maxCaptureHeight` 或像素预算时：

- `onLimit: truncate`：截图并设置 `truncated: true` 和 `limitReason`。
- `onLimit: fail`：拒绝结果并 fallback；所有工具失败后 Crawlee retry。

## 8. Metadata 与 Validator

```typescript
interface ScreenshotMetadata {
  protocolVersion: 1;
  mode: ScreenshotMode;
  variantKey: string;
  configFingerprint: string;
  device: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  documentScrollCompleted: boolean;
  scrollContainersFound: number;
  scrollContainersCompleted: number;
  scrollContainersExpanded: number;
  imagesFound: number;
  imagesPending: number;
  fontsReady: boolean;
  truncated: boolean;
  limitReason: string | null;
  preparationDurationMs: number;
  captureWidth: number | null;
  captureHeight: number | null;
  warnings: string[];
}
```

handler 将 metadata 与 tool 名写入 `artifact_runs.meta_json`。complete validator 除 `minBytes` 外还验证：

- metadata 和协议版本存在。
- key/fingerprint、设备和 viewport 与 requirement 一致。
- 文档及要求的非豁免滚动容器已完成。
- 图片/字体状态符合配置。
- truncated 与 `onLimit` 一致。
- PNG 尺寸、字节和像素量在限制内。

仅返回 PNG 不能满足 complete；metadata 不合格时 fallback。

## 9. 数据库与状态

### 9.1 Schema

```sql
ALTER TABLE artifact_runs
  ADD COLUMN variant_key TEXT NOT NULL DEFAULT 'default';
ALTER TABLE artifact_runs
  ADD COLUMN config_fingerprint TEXT;

CREATE INDEX idx_artifact_runs_requirement_latest
ON artifact_runs(
  site_page_id, artifact_type, variant_key, config_fingerprint, id DESC
);
```

不加唯一约束，因为 artifact_runs 保存重试、fallback 和跨 run 历史。旧行变为 `default/NULL`；旧 screenshot fingerprint 不匹配新 complete requirement，不会被复用。

### 9.2 Requirement snapshot 迁移

`page_runs.required_artifacts_json` 从字符串数组升级为 `ArtifactRequirement[]`，保留列名避免 SQLite 重建：

```json
[
  { "artifactType": "markdown", "variantKey": "default", "configFingerprint": null },
  { "artifactType": "screenshot", "variantKey": "desktop-1440", "configFingerprint": "..." },
  { "artifactType": "screenshot", "variantKey": "mobile-iphone-15", "configFingerprint": "..." }
]
```

`initializeSchema()` 一次性迁移旧 JSON；正常代码只接受新结构。`site_pages.last_stage_decision_json` 中的 required artifact 快照同步迁移，避免长期双格式兼容。

### 9.3 聚合状态

`site_pages.last_screenshot_status/run_id/at` 保留为列表缓存，不再作为 variant 事实来源：

```text
全部当前 variants succeeded → succeeded
任一 variant 最终 failed     → failed
部分成功且仍有缺失            → NULL
```

每次 artifact 成功或最终失败后，统一根据最新 page run requirements 和 artifact_runs 刷新。不能在第一张 screenshot 成功时直接写 succeeded。

run/page 完成计算的 Map key 从 `artifact_type` 改为：

```text
artifactType + variantKey + configFingerprint
```

三个 variants 全成功只增加一个 `successful_page_count`，但 artifact 明细数增加三个。

## 10. Update Policy

| Policy | 行为 |
| --- | --- |
| `force_recrawl_all` | 所有当前 variants 重抓 |
| `skip_existing` | 仅跳过最新成功且 key + fingerprint 匹配的 variant |
| `stale_after_duration` | 按每个 variant 的成功时间判断 |

只要任一当前 requirement 缺失、失败、过期或 fingerprint 改变，页面就不能因粗粒度 `last_screenshot_status` 整体跳过。历史查询必须返回 requirement 级最新结果。

## 11. BrowserManager 与 Scrapling

Playwright 移动模拟必须在 `browser.newContext()` 应用完整 device descriptor。Context key 增加 emulation fingerprint：

```text
engine + site/run/session/proxy/profile + variant config fingerprint
```

`acquirePage` 输入增加明确 emulation 配置；BrowserManager 只管理资源与身份，滚动/等待/DOM 展开放在 Preparer。

Scrapling 继续通过 PythonBridge 使用 CDP endpoint，但 endpoint 仅代表浏览器进程，不代表设备配置。它必须：

1. 导航前创建符合 variant 的独立 Context/Page。
2. 导航后在 `page_action` 执行 Preparer、截图和 metadata 收集。

如果 Scrapling 公开 API 无法在 CDP 模式传入 Context 参数，先扩展 adapter 的标准启动路径；不能只 `set_viewport_size()` 后声称 mobile 完整支持。

## 12. 文件、导出与 UI

### 12.1 路径

```text
{storageRoot}/artifacts/run-{runId}/page-{sitePageId}/
├── base.md
├── markdown.md
├── structured.json
└── screenshots/
    ├── desktop-1440.png
    ├── mobile-iphone-15.png
    └── custom-1920.png
```

只使用校验后的 key，禁止 `..`、路径分隔符和 Unicode 视觉混淆字符。ZIP 保持相同目录，并增加 screenshot manifest，记录 key、path、tool、viewport、truncated 和 fingerprint。

Exporter latest Map 按 `(sitePageId, artifactType, variantKey, configFingerprint)` 建 key，不能再按 type 折叠。

### 12.2 API/UI

run 始终使用 config snapshot，运行中修改站点配置不影响已启动任务。运行详情按 variant 返回 succeeded/failed/pending；页面详情显示每个 variant 的状态、tool、错误和预览，列表页可继续显示聚合状态。预览按需加载单张超长 PNG，避免一次加载所有 variants。

日志事件必须带 `artifactType/variantKey/configFingerprint/tool/truncated/durationMs`，不得记录完整 HTML、Cookie、代理认证或图片二进制。

## 13. 并发与资源

`P` 个页面、`V` 个 variants 的最坏导航数约为 `P × V × attempts`。要求：

- variants 独立任务，共享 run 级 browser process，Context 按设备/身份隔离。
- screenshot task 使用独立浏览器并发预算，避免 PNG 同时编码导致 OOM。
- 除 `maxCaptureHeight` 外限制 `width × height × DPR²`。
- Buffer 落盘后及时释放，不长期聚合多个 variants。
- Scrapling bridge、Preparer、Crawlee handler timeout 从内到外递增。
- 生产并发值由 1/3/10 variants benchmark 决定，不在方案中猜测硬编码。

## 14. 失败语义

| 失败 | 行为 |
| --- | --- |
| 图片/字体超时 | warning，按 `onLimit` truncate 或 fallback |
| 长连接导致 network idle 不出现 | 继续按资源和布局稳定判断 |
| 无限滚动/虚拟列表 | 达上限后 truncated 或 failed |
| 展开容器导致布局抖动 | finally 恢复样式，fallback |
| Playwright 崩溃 | 释放 lease，fallback Scrapling |
| Scrapling 超时 | 终止子进程、释放 CDP lease，进入 retry |
| 单 variant 失败 | 只重试该 variant，其他成功保留 |
| 同 key 配置变化 | fingerprint 不匹配，重新截图 |
| PNG 超像素预算 | 截图前阻止并给出 limitReason |
| 跨域 iframe 不完整 | warning，不宣称 iframe 内完整 |

complete 结果若缺少 metadata、未执行要求步骤且未明确标记 truncated，必须失败，禁止静默接受。

## 15. 测试方案

### 15.1 单元测试

- 配置：桌面/custom/device preset、重复/非法 key、未知 device、边界值。
- fingerprint：默认值补齐、key 顺序无关、任一有效配置变化都会改变。
- requirement 展开、unique key、variant 级 update policy 和聚合状态。
- complete validator：metadata 缺失、fingerprint/viewport 不匹配、truncated 两种策略。

### 15.2 Playwright/Scrapling 合约测试

本地 test server 提供：普通图片、lazy 图片、滚动后插图、延迟字体、单/嵌套滚动容器、动态增长容器、虚拟列表、无限文档、sticky header、跨域 iframe、永久轮询。

同一组断言分别运行两个实现：资源被触发、容器到底或明确 truncated、metadata 与实际一致、成功/超时后资源均释放。Scrapling mobile 必须额外验证 UA、touch、viewport、DPR 和 mobile media query。

### 15.3 集成测试

```text
desktop succeeded + mobile succeeded + custom succeeded
→ page stage2_captured，successful_page_count +1，artifact count +3

desktop succeeded + mobile succeeded + custom failed
→ page 不得 stage2_captured
```

同时验证不同队列 key、文件不覆盖、三条 artifact_runs、ZIP/manifest、Playwright→Scrapling fallback，以及一体化 Scrapling 不支持截图时仍可产出 base/markdown。

### 15.4 Update Policy 与迁移

- 三个匹配 variants 全成功时 `skip_existing` 全跳过；只缺一个时只补一个。
- 同 key 改 viewport 后只重抓 fingerprint 改变的 variant。
- stale 按各 variant 时间判断；旧 `fingerprint=NULL` 不满足新 complete requirement。
- SQLite/PostgreSQL 新库、旧库幂等迁移、JSON 转换和 SQLite→PostgreSQL 复制脚本。

### 15.5 性能与清理

- 1/3/10 variants 的 RSS、耗时、PNG 大小。
- 超长页面在 OOM 前被像素预算阻止。
- 成功、失败、timeout、fallback、取消后 Page/Context/CDP lease/Python 子进程均释放。

## 16. 实施顺序

### Phase 1：模型与持久化

实现 ScreenshotConfig、ArtifactRequirement、fingerprint、artifact_runs 字段/索引、JSON 迁移、repository、状态、update policy、variant 文件路径和 exporter；用 fake tool 跑通三规格链路。

验收：未实现高级滚动前，多 variant 已不会覆盖、折叠或误判完成。

### Phase 2：Playwright 参考实现

实现 BrowserManager Context emulation identity、TS Preparer、metadata、complete validator 和合约测试页。

验收：桌面、移动、custom、懒加载和局部滚动测试通过。

### Phase 3：Scrapling 一等实现

实现 PythonBridge 配置透传、Context 级设备模拟、Python Preparer 和统一 metadata，并运行与 Playwright 相同的合约测试。

验收：声明支持的 variants 达到相同语义；mobile 未通过前不得打开支持标记。

### Phase 4：API、UI 与上线

实现 variant 进度、错误、预览和导出 manifest，更新关联文档；benchmark 后确定生产并发，小批量试运行再扩大。

## 17. 影响模块

| 模块 | 变化 |
| --- | --- |
| `domain/config` | ScreenshotConfig、requirements、解析和 fingerprint |
| `planner` | requirement 展开、variant update policy、禁用 screenshot eager |
| `crawlee/handlers` | variant 入队、unique key、逐 requirement 落库 |
| `capture` | `supports()`、Preparer、metadata、validator、fallback |
| `browser-provider` | Context emulation 与 identity key |
| `python-bridge/pytools` | 配置透传、Scrapling Preparer |
| `db` | variant 字段、迁移、聚合和历史查询 |
| `export/web` | 多文件、manifest、variant 状态和预览 |
| `tests` | 合约、集成、迁移、性能和泄漏测试 |

核心类型、handler、数据库状态和 exporter 高度共享，应按 Phase 串行落地，不适合并行实现后再拼接。

## 18. 完成标准

一次 run 能为同一页面稳定生成至少 desktop 和 mobile 两个 variants，且 Playwright/Scrapling 通过同一套 complete 合约测试。任一 variant 失败时页面不得误判完整成功；`skip_existing` 必须精确复用 key + fingerprint 并只补缺失项。

文件、数据库、ZIP、API 和 UI 不得折叠或覆盖 variants；无限流、虚拟列表、跨域 iframe、超长页面必须有明确 truncated/failed。所有资源在成功、失败、超时和取消路径释放；SQLite/PostgreSQL 新库、迁移和复制测试通过，相关文档同步更新。
