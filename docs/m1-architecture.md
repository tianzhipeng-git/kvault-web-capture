# M1 Architecture

当前项目还在初始开发状态, 无线上应用, 修改代码的时候不用考虑兼容性.

## Purpose

This document turns the confirmed review decisions from `docs/init-prd.md` into an implementation-facing design for M1.

M1 only ships the CLI crawl engine. Web UI belongs to M2.

Even though M1 does not ship a web module, M1 must still define the business entities, lifecycle transitions, and read-path contracts that a later web module will consume.

## M1 Scope

- Project / site management through CLI
- Pre-crawl from sitemap and seed URLs
- Base capture for every discovered page
- In-path classification and rule evaluation
- Three capture types in M1:
  - `base`: Meta / Title / body text
  - `markdown`: independent capture path
  - `screenshot`: independent capture path
- Persistent run state and resume
- User-editable crawl config
- Config import / clone workflow through CLI
- Inventory review and run / site status queries through CLI
- Multi-run workflow with `pending` links carried forward

## Technology Stack

M1 should use a boring default stack that matches Crawlee's primary ecosystem.

- runtime: Node.js
- language: TypeScript
- crawler framework: Crawlee
- CLI layer: thin internal CLI wrapper on top of application services
- business storage: SQLite
- config validation / parsing: typed schema validation in TypeScript
- test framework: Vitest

Rationale:

- Crawlee's first-class APIs and examples are in the JS / TS ecosystem
- this project has many state transitions, enum-like decisions, and queue payload shapes
- TypeScript makes `request.userData`, decision contracts, and config snapshots safer to evolve

## Testing

Testing policy and accepted M1 test scope live in [docs/m1-testing.md](/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/docs/m1-testing.md).

## Not In Scope

- Web UI and browser-based management console
- Cross-site global deduplication
- Full canonical URL system in M1
- General-purpose plugin system
- Distributed crawling / multi-machine orchestration
- Packaging as a hosted service

## Core Decisions

### 1. Milestones

- `M1`: CLI crawl engine
- `M2`: Web UI, richer review flows, result browsing

### 2. State Ownership

- `Crawlee storage` owns execution state:
  - request queues
  - retries
  - resume / continuation
  - raw file artifacts
- `SQLite` owns business state:
  - projects
  - sites
  - inventory
  - tags
  - rules
  - run metadata
  - result indexes

There is no second application-level queue that competes with Crawlee scheduling.

### 2A. Crawlee Integration Style

M1 uses Crawlee as-is.

- no Crawlee fork
- no monkey patching
- no deep customization of Crawlee internals

The project integrates with Crawlee through:

- `RequestQueue`
- `Request`
- `requestHandler`
- `userData`
- `uniqueKey`
- crawler-specific navigation hooks when needed

This means the system wraps Crawlee with its own planners, repositories, and decision logic, rather than trying to embed business policy inside Crawlee internals.

### 3. URL Identity in M1

M1 uses `normalized_url`, not a separate `canonical_url`.

Normalization is applied before business deduplication and should include:

- remove fragment
- lowercase host
- remove obvious tracking params such as `utm_*`
- sort query params
- normalize trailing slash consistently

Store both:

- `discovered_url`: raw discovered URL
- `normalized_url`: business dedupe key for M1

### 4. Classification Placement

Classification stays in the main path.

If classification fails:

- base capture is still persisted
- page status becomes `pending`
- `pending_reason` must be explicit:
  - `classifier_failed`: 分类失败
  - `rule_unmatched`: 规则无法判断
  - `seed_run`: 初始的 seed_run 只执行 Stage 1, 不会启动后续 markdown/截图, 所以命中 allow 的页面进入 pending.

### 5. Project / Site Management Model

M1 must treat `project` and `site` as first-class business entities, not just directory names.

- `project` groups sites for organization and migration, tag definations.
- `site` is the execution and configuration boundary
- a site owns its config, inventory, runs, and artifact storage roots
- creating a new site from an existing site's config must be a supported CLI flow

### 6. Run Success Definition

The accepted M1 rule is strict:

- a page only counts as successful for the run when all target artifacts for that page are complete
- this follows the chosen `6C` decision

### 7. Run Types

M1 needs two explicit run types because the PRD describes two distinct operator intents.

#### `seed_run`

Purpose:

- collect initial URLs from sitemap, seed URLs, and shallow discovery
- capture lightweight base information
- classify and tag
- build the initial inventory for review

Constraints:

- does not start Stage 2 artifact queues
- page recursion is bounded by `seedMaxDepth`
- sitemap expansion is recursive only inside sitemap / child sitemap documents
- must not fan out into the full site crawl accidentally
- may stop after base capture and classification without scheduling downstream artifacts

Outputs:

- `site_pages` inventory rows
- `page_runs` for seeded pages
- enough data for rule tuning and manual review

#### `crawl_run`

Purpose:

- execute a configured crawl against the site using a config snapshot
- continue from existing inventory and discover more URLs during crawling
- produce final artifacts for pages allowed by the rules

Outputs:

- `page_runs` for this run
- `artifact_runs` for markdown / screenshot targets
- run-level and site-level progress metrics

Run type is part of `crawl_runs` metadata and must be queryable because M2 will need to distinguish `seed_run` from `crawl_run`.

## M1 Operational Workflow

M1 should make the PRD workflow explicit even though it is exposed by CLI first.

```text
1. create project
2. create site or import config into site config
3. start seed_run
4. inspect inventory / pending / denied / sample captures
5. edit rule config
6. start crawl_run with target success count and update policy
7. inspect run result and site-wide aggregates
8. review pending pages and revise config
9. repeat from step 5 until site coverage is acceptable
```

This workflow is a product requirement, not a web-only convenience.

## Processing Pipeline

This is the key M1 flow.

```text
discovered URL
    │
    ▼
[URL rule evaluation]
    - evaluate regex / pattern blacklist and whitelist
    - if URL rules can decide `deny`, do not enter base queue
    - if URL rules can decide `allow`, enter base queue directly
    │
    ▼
[Stage 1: base queue]
    - lightweight fetch
    - extract Meta / Title / body text
    - normalize URL
    - classify
    - evaluate tag-based blacklist / whitelist rules
    - persist page_run
    - decide required artifact targets
    │
    ├── pending
    │     └── stop here for this run, wait for later config change / manual review
    │
    └── allowed
          ├── enqueue markdown request
          └── enqueue screenshot request

[Stage 2: artifact queues]
    - markdown queue performs independent markdown capture
    - screenshot queue performs independent screenshot capture
    - each artifact writes its own artifact_run
    - aggregate state is written back to page_run and site_page
```

## Rule Evaluation Model

M1 has two rule families with different timing and different input data.

### 1. URL rules

These are based on the URL itself, before page fetch.

Examples:

```yaml
url_rules:
  - name: block_logins
    list_type: blacklist
    rule_type: prefix
    values: 
      - "www.example.com/login"
      - "www.example.com/logout"
  - name: only_example.com
    list_type: scopelist
    rule_type: prefix
    values: 
      - "example.com"
      - "www.example.com"
  - name: block_xx
    list_type: blacklist
    rule_type: regex
    values: 
      - "www.example.com\/ab.*\/"
```

Use URL rules when a decision can be made from the link alone.

Evaluation point:

- before entering the `base` queue

Expected outcomes:
- `deny`: do not enqueue for base capture
- `allow`: enqueue for base capture

Decision precedence:
- blacklist: 匹配了则deny
- scopelist: 仅限匹配了的通过, 其他的deny
- 其余的都是allow

Rule Type:
- prefix: 前缀匹配(不包含http/https://这部分)
- regex: 正则匹配
- 同一个规则下的多个values是"或"的关系.

Important constraint:
- URL-rule `allow` means "eligible for base processing"
- it does not skip Stage 1 classification or tag-based rule evaluation

### 2. Tag-based rules

These are based on classification results after lightweight capture.

Examples:
```
tag_rules:
  - name: product-full-capture
    list_type: whitelist
    when:
      - key: content_type
        op: any_of
        values: [product]
    artifacts: [markdown, screenshot]
  - name: faq-markdown-only
    list_type: blacklist
    when:
      - key: content_type
        op: any_of
        values: [faq]
  - name: guest-docs-screenshot
    list_type: whitelist
    when:
      - key: content_type
        op: any_of
        values: [docs]
      - key: audience
        op: any_of
        values: [guest]
    artifacts: [screenshot]
```

Use tag-based rules when the decision depends on page meaning rather than URL shape.

Evaluation point:

- after Stage 1 base capture and classification

Expected outcomes:

- `deny`: page is not sent to artifact queues
- `allow`: page is sent only to the artifact queues configured by the matched whitelist rule
- `pending`: page stays in business-level review state

Rule matching semantics:

- a rule may constrain one or more tag keys
- for a constrained tag key, the rule may require one or more values
- page matching should use set semantics rather than single-value equality
- M1 should support at least:
  - `any_of`: page has at least one required value for that tag key
  - `all_of`: page has all required values for that tag key
  - `is_empty`: page selected no value for that tag key
- 多个when之间是"且"的关系

Decision precedence:

- blacklist match wins over whitelist match
- whitelist does not just mean "allowed"; it must also declare which artifacts become required
- if no rule can produce a final decision, the page remains `pending`

### Combined Decision Order

The intended M1 order is:

```text
discovered URL
    │
    ├── URL rule deny
    │
    ├── URL rule allow
          └── enqueue base capture
                │
                ▼
              classify + tag
                │
                ├── tag-rule deny
                │     └── stop before artifact queues
                │
                ├── tag-rule allow
                │     └── enqueue markdown / screenshot as configured
                │
                └── tag-rule unresolved or classifier failed
                      └── pending
```

This gives each rule family a clear job:

- URL rules are an early cheap filter
- tag rules are the semantic decision layer

This is the intended M1 default because it keeps artifact scheduling behind Stage 1 and avoids doing heavy capture before semantic filtering.

## Queue Design

M1 uses three execution queues.

```text
Queue 1: base
  - input: seed URLs, resolved sitemap page URLs, discovered URLs
  - enqueue: 启动时将初始页面 URL 入队; 在页面发现的 URL 判断 url rule 后入队;
  - crawler type: lightweight HTTP / HTML crawler
  - output: page_run + artifact planning

Queue 2: markdown
  - input: pages allowed for markdown capture
  - enqueue: 只能由Stage1判断后入队
  - crawler type: markdown-specific capture flow
  - output: markdown artifact_run

Queue 3: screenshot
  - input: pages allowed for screenshot capture
  - enqueue: 只能由Stage1判断后入队
  - crawler type: browser-backed screenshot flow
  - output: screenshot artifact_run
```

Queue ownership rule:

- queues are run-scoped execution state, not cross-run business state
- each `crawl_run` should use its own named Crawlee queues or equivalent run-scoped storage namespace
- resuming an interrupted run reuses the same run-scoped queues
- starting a new run creates a new set of queues, even if it targets pages seen before

This keeps Crawlee responsible for "what is left to execute in this run" and keeps SQLite responsible for "should this page be executed in this run at all"

### Seed Input Expansion

`seed_run` and `crawl_run` both accept two startup sources:

- `seedUrls`: normal page URLs
- `sitemaps`: sitemap entry URLs

The expected startup behavior is:

- if the startup input is a normal URL, enqueue that page into the `base` queue at depth `0`
- if the startup input is a sitemap URL, resolve that sitemap and any child sitemap recursively before enqueue
- only actual page URLs discovered from sitemap documents enter the `base` queue
- actual page URLs discovered from sitemap enter the `base` queue at depth `0`
- page-link recursion after base capture is controlled by run depth (`seedMaxDepth` or `crawlMaxDepth`)

This means sitemap recursion is a planning concern, not a page-crawl depth concern.

### Why sitemap expansion stays before Crawlee page tasks

Sitemap expansion should stay in the application planning layer before page requests are enqueued.

Reasons:

- sitemap XML is an input source, not a business page that should produce `site_pages` / `page_runs`
- URL-rule gating and update-policy gating should run on the final page URL candidates, not on sitemap documents
- it avoids polluting the `base` queue with sitemap XML fetches that are not Stage 1 page captures
- startup planning and runtime link discovery then share the same `RunPlanner.planRequest(...)` gate once a real page URL exists

If later M1 needs very large sitemap handling, the system can still model sitemap fetch as a dedicated "seed expansion" queue, but it should remain separate from the page-capture queues.

Important constraint:

- `markdown` is a first-class capture type in M1
- it is not treated as a simple HTML-to-Markdown conversion step

Each queue should have its own `requestHandler` implementation.

Suggested mapping:

- `base` queue -> base capture `requestHandler`
- `markdown` queue -> markdown capture `requestHandler`
- `screenshot` queue -> screenshot capture `requestHandler`

### URL discovery during a run / Enqueue

When Crawlee discovers a URL during crawling, it should not blindly assume that the URL must be processed.

The expected M1 behavior is:

```text
discovered link
   │
   ├── normalize URL
   ├── upsert / record in SQLite inventory
   ├── evaluate URL rules
   ├── evaluate run update policy against existing business history
   └── only then enqueue a base request for the current run if eligible
```

This avoids split-brain behavior where:

- Crawlee thinks a URL is new because it is not yet in the current queue
- but SQLite already knows the page exists and should be skipped for this run


## Request Model in Crawlee

In Crawlee, the same business page may correspond to multiple requests in one run.

Example:

- one `base` request
- one `markdown` request
- one `screenshot` request

These requests are related through `userData`, but must have distinct `uniqueKey` values to avoid queue deduplication.

Suggested pattern:

```text
base:{runId}:{pageId}
markdown:{runId}:{pageId}
screenshot:{runId}:{pageId}
```

Suggested request metadata:

- `siteId`
- `runId`
- `pageId`
- `pageRunId`
- `artifactType`

`requestHandler` is the main unit of Crawlee-side customization.

Use it for:

- fetching and extraction work for that queue
- calling the underlying capture implementation
- writing run / artifact results
- throwing on execution failure so Crawlee retry behavior remains intact

Do not use hooks as the primary place for business decisions.

Important boundary:

- Crawlee deduplicates requests by `uniqueKey` inside the queue/storage it is using
- Crawlee does not know the business meaning of `skip_existing`, `rerun_failed_artifacts`, or `stale_after_duration`
- those decisions belong to the SQLite-backed planning layer before requests are enqueued for a run

## Business Data Model

M1 uses seven main business layers.

```text
projects: logical grouping for multiple sites

sites: execution and configuration boundary within a project

crawl_runs: one row per crawl execution

site_pages: identity of a page within a site, one row per site + normalized_url

page_runs:  one row per page per run, holds base capture, classification, rule decision, pending reason

artifact_runs
  - one row per artifact per page per run
  - artifact_type = markdown | screenshot
```

Relationship sketch:

```text
projects (1)
   │
   └──< sites (many)
          │
          ├──< site_pages (many)
          │      │
          │      └──< page_runs (many)
          │               │
          │               └──< artifact_runs (many)
          │
          └──< crawl_runs (many) ───────┘
```

## Suggested Table Responsibilities

### `projects`

Logical grouping unit for multiple sites.

Suggested fields:

- `id`
- `name`
- `slug`
- `created_at`
- `tag_definitions`

### `sites`

Primary management unit for one crawl target.

Suggested fields:

- `id`
- `project_id`
- `name`
- `base_url`
- `storage_root`
- `url_rules`
- `tag_rules`
- `updated_at`
- `created_at`

### `site_pages`

Long-lived page identity.

也维护了当前页的状态和爬取记录状态.

Suggested fields:

- `id`
- `site_id`
- `discovered_url`
- `normalized_url`
- `inventory_status`
- `first_discovered_at`
- `discovery_source`
- `discovery_referrer_url`
- `last_url_rule_decision`
- `last_tag_rule_decision`
- `last_base_status`
- `last_base_run_id`
- `last_base_at`
- `last_markdown_status`
- `last_markdown_run_id`
- `last_markdown_at`
- `last_screenshot_status`
- `last_screenshot_run_id`
- `last_screenshot_at`

`site_pages` is the durable inventory backbone.

It must preserve enough provenance for later review flows such as:

- "where did this URL come from"
- "why is this page still pending"
- "was this URL only seen in seed_run or also in a real crawl"

`inventory_status`:
- `discovered_only`: 链接已发现, 未开始爬取.
- `url_rule_denied`: 被基于url的规则拒绝, 不会执行后续动作.
- `base_captured`: 基础信息已抓取.
- `stage2_pending`: 无法决定阶段2重度爬取是否进行, 等待状态.
- `stage2_skipped`: 阶段2跳过.
- `stage2_captured`: 阶段2已爬取.
- 其他更多状态需要再设计

### `crawl_runs`

Run-level metadata.

Suggested fields:

- `id`
- `site_id`
- `tag_definitions_snapshot`
- `url_rules_snapshot`
- `tag_rules_snapshot`
- `run_type`
- `update_policy`
- `status`
- `started_at`
- `finished_at`
- `target_success_count`
- `successful_page_count`
- `candidate_page_count`
- `pending_page_count`
- `denied_page_count`
- 其他的关于run的配置


### `page_runs`

Base-stage truth for a page in a specific run.

Suggested fields:

- `id`
- `run_id`
- `page_id`
- `started_at`
- `finished_at`
- `base_capture_status`
- `base_capture_path` or structured result reference
- `classification_result`
- `decision_result`
- `pending_reason`
- `required_artifacts`

`required_artifacts` is a frozen per-run artifact plan snapshot.

It is decided once after base capture, classification, and rule evaluation.

After that:

- downstream artifact execution must report against this plan
- downstream workers must not silently mutate the required artifact set

### `artifact_runs`

Artifact-level execution records.

Suggested fields:

- `id`
- `run_id`
- `page_run_id`
- `artifact_type`
- `status`
- `started_at`
- `finished_at`
- `output_path`
- `error_message`
## Resume and Multi-Run Behavior

M1 must support:

- resume single crawl_run after interruption
- stopping after a configured number of successful pages
- carrying `pending` pages into later runs after config changes
- updating previously crawled pages based on user policy

Resume depends on:

- Crawlee queue persistence
- SQLite run / page / artifact records
- immutable config snapshots

### Run planning versus queue execution

This boundary must stay explicit:

- SQLite decides which pages are eligible for this run
- SQLite applies update policy against historical `page_runs` and `artifact_runs`
- Crawlee only executes the requests selected for the current run

Recommended flow:

```text
start run
   │
   ├── create crawl_run
   ├── query SQLite for candidate pages
   ├── apply update mode:
   │     - skip_existing
   │     - rerun_failed_artifacts
   │     - force_recrawl_all
   │     - stale_after_duration
   └── enqueue only selected requests into this run's Crawlee queues
```

This means:

- for a new run, Crawlee queues should be treated as fresh execution state
- for resume within the same run, Crawlee queues should be reused
- cross-run dedupe and freshness checks happen before enqueue

### Pending Re-evaluation
- 不提供只是因为config修改,不跑crawl_run而重新evaluate这种功能. 
- pending的要是修改了rule想要重新evaluate, 就要完整启动crawl_run, 经历Stage1/Stage2

### Update policy modes

M1 should keep update policy explicit and small.

Update policy在两个地方生效:
- 创建run的时候, 哪些会直接入base队列
- 运行过程中遇到url时, 入三个队列前判断Update policy

Recommended initial modes:

- `force_recrawl_all`: 忽略之前的运行状态, 所有页面的Stage1/Stage2都要过一下.
- `skip_existing`: 
  - 什么结果都没有的, 正常流程走.
  - 对于已有Stage1和两个Stage2结果的页面, 初始就不入base队列; 
  - 对于已有Stage1, Stage2没有或者不全的, 初始入base队列, 后续判断markdown/截图是否有结果, 没有才入队.
- `stale_after_duration`: 对于已有结果(Stage1/Stage2分别的结果)的页面, 入队前判断一下时间差
## External Capture Tool Integration

External capture tools should be integrated behind queue-specific handlers or adapters, not embedded as ad hoc hook logic.

Example:

- a mature third-party `url -> markdown` tool should be used by the `markdown` queue's `requestHandler`
- the `markdown` request is still planned by this system
- the tool is only the execution mechanism for that artifact type

Sketch:

```text
base queue
  └── RuleDecision requires markdown
        └── enqueue markdown request

markdown queue requestHandler
  ├── call external markdown tool
  ├── persist artifact output
  └── write artifact_run success/failure
```

This keeps the boundary clean:

- this project decides whether markdown should happen
- the external tool decides how markdown is captured

### Hooks usage policy

Crawlee hooks are allowed, but only for narrow crawler-lifecycle customization.

Good uses:

- set request headers, cookies, or timeouts
- adjust navigation options
- inspect page state after navigation
- perform browser/page setup for screenshot or markdown crawlers

Do not use hooks for:

- update policy decisions
- SQLite historical lookups
- rule evaluation
- deciding `pending_reason`
- deciding `required_artifacts`
- run-level enqueue planning

Those belong in `run planner`, `rule engine / decision evaluator`, and `artifact planner`.

## What Already Exists

The current repo does not yet contain implementation code.

The intended implementation should reuse Crawlee primitives rather than replacing them:

- `RequestQueue` for execution queues
- `Request.userData` for cross-request linkage
- `uniqueKey` for queue identity
- Crawlee storage for local execution persistence

## Failure Modes To Design For

### Stage1: Base stage

- URL matches blacklist before fetch
  - expected handling: do not enqueue base request, optionally persist inventory-only denial record
- lightweight fetch succeeds but classifier fails
  - expected handling: store base result, mark `pending`
- URL discovered multiple times with tracking-param variants
  - expected handling: collapse by `normalized_url`
- run interrupted after base success but before artifact enqueue
  - expected handling: recover from persisted `page_run` and queue state

### Stage2: Markdown stage

- markdown capture fails while base and screenshot succeed
  - expected handling: artifact failure recorded, page not counted successful under `6C`

### Stage2: Screenshot stage

- browser render fails or times out
  - expected handling: artifact failure recorded, page not counted successful under `6C`

## Open Follow-Up Design Topics

These are still implementation topics, not yet fully specified:

- exact SQLite schema and indexes
- exact markdown capture mechanism
- retry policy per queue
- exact CLI command surface for config import / run / inspect
- whether read models are implemented as SQL views or service-layer aggregations

## Implementation Shape

Keep M1 boring and explicit.

Recommended module boundaries:
模块化设计

Avoid a single giant hook/function that:

- fetches
- classifies
- applies rules
- mutates all states
- spawns artifact work
- renders browser pages

That shape will become hard to test and harder to trust.
