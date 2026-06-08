# Base Task Needs 与 Eager Capture

本文说明 `PageCaptureTask.needs` 在入队时如何计算，以及「一体化工具一次抓完 base + artifact」的实现方式。

相关模块：

- `src/planner/base-task-needs.ts` — needs 计算
- `src/planner/run-planner.ts` — 入队前规划（只决定要不要入队，不决定 needs）
- `src/app/run-service.ts` — 启动 URL 入队
- `src/crawlee/handlers.ts` — base / artifact handler、链接发现入队
- `src/capture/executor.ts` — 按 needs 调用工具链

上下游文档：

- 规则如何决定「要不要抓、要哪些 artifact」：[规则格式指南](../rule-format-guide.md)
- capture profile 如何决定工具链：[SiteConfig 抓取 Profile](../site-config-capture-profiles.md)
- executor fallback 与 validator：[Retry、Fallback 与 Validator](./retry-fallback-and-validator.md)
- 总体模块关系：[技术与模块结构说明](../technical-module-structure.md)

## 1. 背景

Page capture 队列中的每个任务通过 `needs` 声明本次需要的能力：

| `needs` | 含义 |
| --- | --- |
| `['base']` | 基础抓取、链接发现、分类、stage2 规则 |
| `['markdown']` 等 | 为已有 `pageRunId` 补抓单个 artifact |
| `['base', 'markdown', ...]` | 一次抓取多种能力 |

`PageCaptureExecutor` 和 handler 早已支持组合 needs：一体化工具（如 `scrapling-page`、`crawl4ai-page`）可以在一次调用中返回 base + 多个 artifact。

问题在于**入队阶段**：若 base task 只写 `needs: ['base']`，即使工具能一次抓完，也会在 base 完成后为每个 artifact 再入队单独 task，导致同一页面被工具调用多次。

Eager capture 的目标：在**入队 base task 时**，若 profile 中存在一体化工具，就把可能需要的 artifact 一并写入 `needs`，让 executor 尽量一次调用完成。

## 2. 职责划分

```text
规则 (rulesBeforeStage2Eq)     → 分类后决定 pageOutcome、requiredArtifacts（权威）
resolveBaseTaskNeeds           → 入队前推断 needs（优化，不能绕过规则）
PageCaptureExecutor            → 按 needs 选工具、fallback
handleBaseTask                 → 分类 + stage2 后决定落盘 / 补抓入队
```

三层决策互不替代：

1. **规则**：最终哪些 artifact 要入库。
2. **needs 计算**：本次工具调用请求哪些能力。
3. **update policy**：历史数据是否允许重新抓取。

## 3. 何时计算 needs

`resolveBaseTaskNeeds(...)` 在两处调用：

1. **启动入队**（`RunService.executeRunWithRuntime`）：seed / sitemap / inventory URL 展开后，每个通过 `RunPlanner.planRequest` 的 URL。
2. **链接发现入队**（`handleBaseTask`）：base 完成后从 `extracted.links` 扩展子 URL 时。

`RunPlanner.planRequest` 只回答「要不要入 base 队列」，**不**负责 needs 内容。needs 在确认 `enqueue: true` 之后单独计算。

## 4. 计算流程

入口：`resolveBaseTaskNeeds`（`src/planner/base-task-needs.ts`）

### 4.1 `seed_run`：固定 `['base']`

`seed_run` 用于摸底和调规则，不产出 artifact。无论站点配置如何，needs 始终为 `['base']`。

即使 stage2 规则命中 allow，handler 也会把 outcome 改成 `stage2_pending`。

### 4.2 `crawl_run`：四步合成 needs

#### Step 1 — 候选 artifact（`resolveProspectiveArtifacts`）

在**尚未分类**时，从站点配置推断「可能需要」的 artifact 集合：

1. **URL 规则**：对当前 URL 在 `rulesBeforeStage2Eq` 的 `matchType: "url"` 规则上执行 `evaluateUrlRules`，取匹配白名单的 `artifacts`。
2. **Label 白名单并集**：对所有 `matchType: "label"` 且 `listType: "whitelist"` 的规则，将其 `artifacts` 做并集。

注意：label 并集是**乐观估计**。最终是否落盘仍由分类后的 stage2 规则决定；分类不匹配时，eager 抓到的 artifact 不会入库，但工具调用可能已发生。

#### Step 2 — 一体化工具过滤（`filterIntegratedEagerArtifacts`）

不是候选 artifact 全部进入 needs，还要看 capture profile 里有没有**一体化工具**。

一体化工具定义：`capabilities` 同时包含 `base` 和至少一种 artifact。

```typescript
integratedTools = profileTools.filter(tool =>
  tool.capabilities.includes('base') &&
  tool.capabilities.some(cap => cap !== 'base')
)

eagerArtifacts = prospectiveArtifacts.filter(artifact =>
  integratedTools.some(tool => tool.capabilities.includes(artifact))
)
```

| Profile 类型 | 示例 | eager 行为 |
| --- | --- | --- |
| 一体化 | `scrapling-page`, `crawl4ai-page` | 候选 artifact 可合并进 needs |
| 拆分链 | `http-base` + `defuddle-markdown` + `playwright-screenshot` | 无一体化工具 → eager 为空 → needs 仅 `['base']` |

拆分链保持原来的「base 一次、artifact 各一次」行为，避免 base 任务因某个 artifact 工具失败而整体失败。

#### Step 3 — Update Policy 过滤

对每个 eager artifact 调用 `shouldEnqueueArtifactByUpdatePolicy`：

| Policy | 行为 |
| --- | --- |
| `force_recrawl_all` | 全部加入 needs |
| `skip_existing` | 历史上已成功的 artifact 不加入 |
| `stale_after_duration` | 未过期的 artifact 不加入 |

#### Step 4 — 合成

```typescript
needs = ['base', ...通过 policy 过滤的 eagerArtifacts]
```

## 5. Handler 执行流程

Handler 按 `task.needs.includes('base')` 分流：

- 含 `base` → `handleBaseTask`
- 不含 `base` → `handleArtifactOnlyTask`

### 5.1 `handleBaseTask`

```text
1. targetTracker 已满 → 跳过
2. executor.capture(task.needs)
3. 必须有 extracted
4. classify(extracted)
5. buildStage2EnqueueDecision → pageOutcome + requiredArtifacts
6. 写 base.md、创建 page_run
7. 若 crawl_run 且 pageOutcome === 'allow'：
   a. 遍历 decision.requiredArtifacts
   b. 若本次 capture 已返回该 artifact：
      - 检查 update policy（capture 前的 history）
      - 通过则 recordArtifactResult 落盘
   c. 仍未抓到的 → 入队 artifact-only task（needs: [artifactType]）
8. 未达深度上限 → 链接发现，对每个子 URL 重新 resolveBaseTaskNeeds 后入队
```

**Stage2 规则仍是落盘权威**：只有 `decision.requiredArtifacts` 中的类型才会入库。needs 里多请求的能力，若规则最终不需要，会被丢弃。

**Update policy 两处生效**：

- 入队时：决定是否把 artifact 放进 base task 的 needs
- base 完成后落盘时：决定是否覆盖仍新鲜的历史 artifact（防止 `skip_existing` 误覆盖）

### 5.2 `handleArtifactOnlyTask`

补抓路径，逻辑未变：按 task.needs 调用 executor，逐个落盘。

## 6. Executor 行为

`PageCaptureExecutor.capture(input.needs)` 逻辑不变：

1. 按 `defaultCaptureProfile` / `captureProfiles` 解析工具链
2. 过滤能覆盖剩余 needs 的工具
3. 每个工具只收到其 capabilities 覆盖的子集：

```typescript
toolNeeds = remainingNeeds.filter(need => tool.capabilities.includes(need))
await tool.capture({ ...input, needs: toolNeeds })
```

4. 合并结果；所有 needs 满足才成功

### 6.1 一体化工具（理想路径）

needs = `['base', 'markdown', 'screenshot', 'structured']`，profile 首位为 `scrapling-page`：

```text
scrapling-page.capture({ needs: ['base','markdown','screenshot','structured'] })
→ 1 次工具调用
→ handler 分类后 allow → 直接落盘，不再入队 artifact task
```

### 6.2 拆分链（原路径）

needs = `['base']`：

```text
http-base.capture({ needs: ['base'] })
→ base handler 完成 → 入队 3 个 artifact task
→ 每个 artifact task 再调对应工具
→ 共 4 次工具调用
```

### 6.3 部分成功 + 补抓

若一体化工具只返回部分 artifact（或 validator 拒绝部分结果），executor 可能：

- 继续 profile 中后续工具补剩余 needs；或
- 全部工具跑完后仍 missing → 抛错 → Crawlee reclaim；或
- base 成功但 artifact 缺失 → handler 为剩余 required artifact 入队 artifact-only task

## 7. 配置示例

以 [default-simple-capture-site-config.json](../default-simple-capture-site-config.json) 为例：

- URL 规则：`.*` → `artifacts: [markdown, screenshot, structured]`
- Profile：`scrapling-page` → `crawl4ai-page` → `jina-markdown`
- 前两个是一体化工具

单页完整路径：

```text
启动 URL
  → planRequest: enqueue=true
  → resolveBaseTaskNeeds:
      prospective = [markdown, screenshot, structured]
      integrated = [scrapling-page, crawl4ai-page]
      eager = [markdown, screenshot, structured]
      needs = [base, markdown, screenshot, structured]
  → handleBaseTask
      scrapling-page 一次调用返回全部
      stage2 allow → 三个 artifact 直接落盘
      不再入队 artifact task
```

## 8. 设计边界

当前实现**刻意不做**的事：

1. **拆分链不 eager** — `http-base + defuddle` 类配置行为与改前一致。
2. **Label 规则不精确预判** — 用的是 label 白名单 artifact 并集，不是分类后的精确匹配；deny/pending 页面可能产生多余的工具调用。
3. **Stage2 不可绕过** — needs 里写了 structured，规则 deny 该页，structured 仍不入库。
4. **seed_run 不 eager** — 始终 `['base']`。

若未来需要 label 站点也在第一次 eager（接受 deny 页面额外开销），或拆分链也尝试合并 needs，需要新增显式配置开关；当前策略是**仅当 profile 存在一体化工具时才合并**。

## 9. 测试

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/base-task-needs.test.ts` | needs 计算、一体化 / 拆分链、update policy |
| `tests/page-capture-handler.test.ts` | handler 对组合 needs 的落盘与补抓入队 |
| `tests/full-capture.integration.test.ts` | 一体化工具一次抓完 base + artifact 的端到端路径 |
