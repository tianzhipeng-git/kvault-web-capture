# M1 Current Implementation

## Purpose

This document describes the actual internal implementation shape of M1 after completing `m1-dev-plan.md` Phase 1 / Phase 2 / Phase 3.

It is implementation-oriented:

- what modules exist now
- how requests move through the system
- how SQLite and Crawlee divide responsibilities
- what is intentionally still missing

This document should be read together with:

- `docs/m1-architecture.md`: target architecture and rules
- `docs/m1-dev-plan.md`: phased delivery plan

## High-Level Module Map

```mermaid
flowchart LR
    CLI["src/cli.ts\nCLI commands"] --> APP["src/app/services.ts\nM1App"]

    APP --> CFG["src/config/site-config.ts\nconfig load / validation"]
    APP --> DB["src/db/database.ts\nschema bootstrap"]
    APP --> REPOS["src/db/repositories.ts\nbusiness repositories"]
    APP --> QF["src/planner/queue-factory.ts\nrun queue naming/open"]
    APP --> RP["src/planner/run-planner.ts\nstartup/runtime planning"]
    APP --> UP["src/planner/update-policy.ts\nhistory gating"]
    APP --> H["src/crawlee/handlers.ts\nqueue request handlers"]

    H --> EXT["src/extract/extract-page.ts\nbase extraction"]
    H --> RULES["src/rules/rule-decision.ts\nURL rules / tag rules / stage decision"]
    H --> CLS["src/classification/classifier.ts\nClassifier interface"]
    H --> MD["src/markdown/fake-markdown-adapter.ts\nMarkdown adapter interface + fake impl"]
    H --> SS["src/screenshot/fake-screenshot-adapter.ts\nScreenshot adapter interface + fake impl"]
    H --> AW["src/export/file-artifact-writer.ts\nArtifact export writer"]

    REPOS --> SQLITE[("SQLite")]
    QF --> CRAWLEE["Crawlee RequestQueue\nCheerioCrawler / BasicCrawler"]
    H --> CRAWLEE
```

## Responsibility Boundaries

### CLI and application service

- `src/cli.ts` only parses commands and flags.
- `src/app/services.ts` is the orchestration entry point for all operator workflows.
- `M1App` owns:
  - DB open / schema init
  - repository construction
  - run creation
  - startup URL expansion
  - crawler and queue wiring
  - inventory read APIs used by CLI

### Planning and decisions

- `src/config/site-config.ts` validates and loads `SiteConfig`.
- `src/rules/rule-decision.ts` handles:
  - fixed-precedence evaluation for `rulesBeforeBaseEq`
  - fixed-precedence evaluation for `rulesBeforeStage2Eq`
  - final stage decision for `seed_run` vs `crawl_run`
- `src/planner/run-planner.ts` is the enqueue gate:
  - normalize URL
  - upsert / find `site_pages`
  - evaluate `rulesBeforeBaseEq`
  - for `crawl_run`, apply update policy
- `src/planner/update-policy.ts` evaluates historical eligibility for:
  - `force_recrawl_all`
  - `skip_existing`
  - `stale_after_duration`

### Crawlee execution seam

- `src/crawlee/handlers.ts` is the main Crawlee-side business seam.
- `createBaseRequestHandler` does:
  - base extraction
  - classification
  - evaluate `rulesBeforeStage2Eq`
  - `page_runs` write
  - `site_pages` status update
  - artifact enqueue for `crawl_run`
  - runtime-discovered URL planning
- `createMarkdownRequestHandler` and `createScreenshotRequestHandler` do capture, export, and success persistence.
- queue-specific `failedRequestHandler`s record the final failed artifact attempt after Crawlee retries are exhausted.

### Persistence

- `src/db/database.ts` creates the schema.
- `src/db/repositories.ts` owns all SQLite business writes and read models.
- Current read paths come from SQLite only, not Crawlee internals.

## Internal Module Relationship Diagram

```mermaid
flowchart TD
    subgraph Interface
      CLI["CLI"]
    end

    subgraph AppLayer
      APP["M1App"]
    end

    subgraph Planning
      CFG["SiteConfig loader"]
      RP["RunPlanner"]
      UP["Update policy"]
      RULES["Rule decision"]
      URL["URL normalize"]
    end

    subgraph Execution
      BQ["base queue"]
      MQ["markdown queue"]
      SQ["screenshot queue"]
      BH["base requestHandler"]
      MH["markdown requestHandler"]
      MF["markdown failedRequestHandler"]
      SH["screenshot requestHandler"]
      SF["screenshot failedRequestHandler"]
      EXT["extract page"]
      CLS["Classifier"]
      MDA["Markdown adapter"]
      SDA["Screenshot adapter"]
      AW["Artifact writer"]
    end

    subgraph State
      REPOS["Repositories"]
      SQLITE["SQLite"]
      CRAWLEE["Crawlee storage"]
    end

    CLI --> APP
    APP --> CFG
    APP --> RP
    APP --> REPOS
    APP --> BQ
    APP --> MQ
    APP --> SQ
    RP --> URL
    RP --> RULES
    RP --> UP
    RP --> REPOS
    BQ --> BH
    MQ --> MH
    MQ --> MF
    SQ --> SH
    SQ --> SF
    BH --> EXT
    BH --> CLS
    BH --> RULES
    BH --> RP
    BH --> REPOS
    MH --> MDA
    MH --> AW
    MH --> REPOS
    MF --> REPOS
    SH --> SDA
    SH --> AW
    SH --> REPOS
    SF --> REPOS
    REPOS --> SQLITE
    BQ --> CRAWLEE
    MQ --> CRAWLEE
```

## Runtime Flow: Seed Run

Current implementation uses `M1App.runSeed(siteId)`.

Key behavior:

- `run_type = seed_run`
- `update_policy = force_recrawl_all`
- base queue runs
- markdown/screenshot queues are created but not executed
- pages that would otherwise be `allow` become `pending` with `pending_reason = seed_run`

```mermaid
flowchart TD
    A["CLI: run:seed"] --> B["M1App.executeRun(runType=seed_run)"]
    B --> C["load site config"]
    C --> D["create crawl_runs row"]
    D --> E["expand startup URLs\nseedUrls + recursive sitemap page URLs"]
    E --> F["RunPlanner.planRequest for each URL"]
    F --> G{"URL rule deny?"}
    G -- yes --> H["mark site_pages as url_rule_denied\nskip enqueue"]
    G -- no --> I["enqueue base request"]
    I --> J["CheerioCrawler base handler"]
    J --> K["extract title/meta/body/links"]
    K --> L["classify"]
    L --> M["buildStageDecision"]
    M --> N["write page_runs"]
    N --> O["update site_pages\nstage2_pending + seed_run"]
    O --> P{"depth < seedMaxDepth?"}
    P -- no --> Q["done"]
    P -- yes --> R["plan discovered links through RunPlanner"]
    R --> S["eligible links enter base queue"]
```

## Runtime Flow: Crawl Run

Current implementation uses `M1App.runCrawl(...)`.

Key behavior:

- startup candidates come from:
  - `seedUrls`
  - recursively resolved sitemap page URLs
  - existing `site_pages` inventory
- runtime-discovered URLs go through the same planner path
- `crawl_run` may enqueue markdown/screenshot requests
- base, markdown, and screenshot are executed sequentially:
  - base crawler first
  - markdown crawler second
  - screenshot crawler third

```mermaid
flowchart TD
    A["CLI: run:crawl"] --> B["M1App.executeRun(runType=crawl_run)"]
    B --> C["create crawl_runs row with config snapshot"]
    C --> D["startup URLs = seeds + sitemaps + known inventory"]
    D --> E["RunPlanner.planRequest"]
    E --> F{"URL rule allow?"}
    F -- no --> G["persist url_rule_denied / skip"]
    F -- yes --> H{"update policy says enqueue?"}
    H -- no --> I["skip current run"]
    H -- yes --> J["enqueue base request"]
    J --> K["base handler"]
    K --> L["extract + classify + tag-rule decision"]
    L --> M["persist page_runs + site_pages"]
    M --> N{"artifact policy says enqueue?"}
    N -- no --> O["skip already-fresh artifacts"]
    N -- yes --> P["enqueue markdown/screenshot requests"]
    P --> Q["BasicCrawler artifact handlers"]
    Q --> R{"capture success?"}
    R -- yes --> S["artifact_runs success\nsite_pages aggregate stage2 status"]
    R -- no --> T["Crawlee retries"]
    T --> U["failedRequestHandler"]
    U --> V["artifact_runs failed\nsite_pages aggregate stage2 status"]
    K --> W["discovered links -> RunPlanner.planRequest"]
    W --> X["eligible links re-enter base queue"]
```

## Planning Logic Detail

### Startup and runtime planning share the same gate

Both paths use `RunPlanner.planRequest(...)`.

```mermaid
flowchart LR
    URL["discovered URL"] --> N["normalizeUrl"]
    N --> U["site_pages.getHistoricalState"]
    N --> R["evaluateUrlRules"]
    R --> D{"deny?"}
    D -- yes --> X["markUrlRuleDenied\nreturn enqueue=false"]
    D -- no --> Y{"runType=seed_run?"}
    Y -- yes --> Z["return enqueue=true"]
    Y -- no --> P["shouldEnqueueByUpdatePolicy"]
    P --> Q["return enqueue true/false"]
```

### Update policy behavior as implemented

- `force_recrawl_all`
  - always enqueue
- `skip_existing`
  - skip when base and every required artifact already succeeded
  - enqueue when base is missing, pending, failed, or any required artifact is missing/failed
- `stale_after_duration`
  - enqueue when base is stale
  - enqueue when a required artifact is stale

## SQLite Business Model

Current schema:

- `projects`
  - logical grouping
- `sites`
  - config boundary and storage root
- `crawl_runs`
  - run metadata and counters
- `site_pages`
  - durable inventory row per normalized URL
- `page_runs`
  - Stage 1 result per page per run
- `artifact_runs`
  - per-artifact execution result per page per run

```mermaid
erDiagram
    projects ||--o{ sites : contains
    sites ||--o{ crawl_runs : executes
    sites ||--o{ site_pages : inventories
    crawl_runs ||--o{ page_runs : records
    site_pages ||--o{ page_runs : records
    page_runs ||--o{ artifact_runs : produces
    site_pages ||--o{ artifact_runs : aggregates
```

## Sequence Diagram: One Allowed Crawl Page

```mermaid
sequenceDiagram
    participant CLI
    participant App as M1App
    participant Planner as RunPlanner
    participant Base as BaseHandler
    participant Rules as RuleDecision
    participant Repos as Repositories
    participant MD as MarkdownHandler
    participant SS as ScreenshotHandler

    CLI->>App: run:crawl --site --update-policy
    App->>Repos: createRun(config snapshot)
    App->>Planner: planRequest(seed URL)
    Planner->>Repos: getHistoricalState / upsertDiscovery
    Planner-->>App: enqueue=true
    App->>Base: base request
    Base->>Rules: buildStageDecision(classification, runType)
    Base->>Repos: create page_runs
    Base->>Repos: recordBaseCapture
    Base->>App: enqueue artifact requests
    App->>MD: markdown request
    MD->>Repos: create artifact_runs success
    MD->>Repos: recordArtifactResult
    App->>SS: screenshot request
    SS->>Repos: create artifact_runs success
    SS->>Repos: recordArtifactResult
    App->>Repos: refreshCounts / finishRun
```

## What Is Implemented Versus Deferred

### Implemented now

- project/site creation
- site config import and clone
- config validation for seed URLs, sitemaps, `rulesBeforeBaseEq`, `rulesBeforeStage2Eq`, and run options
- seed-run flow
- crawl flow with history-aware planning
- runtime link discovery through the same planner path
- markdown/screenshot artifact execution
- exported artifact files with stored `output_path`
- SQLite-backed inventory query commands

### Still deferred or partial

- resume semantics for interrupted run
- stop when `target_success_count` is reached
- full run status / site status operational commands
- real classifier and real capture-tool integrations

## Practical Read Order For Current Code

If you want to understand the code quickly, read in this order:

1. `src/cli.ts`
2. `src/app/services.ts`
3. `src/planner/run-planner.ts`
4. `src/rules/rule-decision.ts`
5. `src/crawlee/handlers.ts`
6. `src/db/repositories.ts`
7. `src/db/database.ts`

That sequence follows the real runtime call chain.
