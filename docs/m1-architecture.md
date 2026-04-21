# M1 Architecture

## Purpose

This document turns the confirmed review decisions from `docs/init-prd.md` into an implementation-facing design for M1.

M1 only covers the CLI crawl engine. Web UI belongs to M2.

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
  - `classifier_failed`
  - `rule_unresolved`
  - `manual_review_required`

### 5. Config Snapshot

Each crawl run stores an immutable `run_config_snapshot`.

Site-level config may keep a current editable draft, but each run must point to a frozen snapshot so results are explainable later.

### 6. Run Success Definition

The accepted M1 rule is strict:

- a page only counts as successful for the run when all target artifacts for that page are complete
- this follows the chosen `6C` decision

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
    - if URL rules are undecided, still enter base queue
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

- whitelist regex for product pages
- blacklist regex for login / account / cart / logout
- path-based include / exclude rules

Use URL rules when a decision can be made from the link alone.

Evaluation point:

- before entering the `base` queue

Expected outcomes:

- `deny`: do not enqueue for base capture
- `allow`: enqueue for base capture
- `undecided`: enqueue for base capture and defer final decision

Important constraint:

- URL-rule `allow` means "eligible for base processing"
- it does not skip Stage 1 classification or tag-based rule evaluation

### 2. Tag-based rules

These are based on classification results after lightweight capture.

Examples:

- blacklist pages tagged as navigation / legal / account-only
- whitelist pages tagged as product / docs / FAQ
- choose artifact targets based on tags

Use tag-based rules when the decision depends on page meaning rather than URL shape.

Evaluation point:

- after Stage 1 base capture and classification

Expected outcomes:

- `deny`: page is not sent to artifact queues
- `allow`: page is sent to configured artifact queues
- `pending`: page stays in business-level review state

### Combined Decision Order

The intended M1 order is:

```text
discovered URL
    │
    ├── URL blacklist match
    │     └── deny immediately
    │
    ├── URL whitelist match
    │     └── enqueue base capture
    │
    └── URL undecided
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

## Queue Topology

M1 uses three execution queues.

```text
Queue 1: base
  - input: sitemap URLs, seed URLs, discovered URLs
  - crawler type: lightweight HTTP / HTML crawler
  - output: page_run + artifact planning

Queue 2: markdown
  - input: pages allowed for markdown capture
  - crawler type: markdown-specific capture flow
  - output: markdown artifact_run

Queue 3: screenshot
  - input: pages allowed for screenshot capture
  - crawler type: browser-backed screenshot flow
  - output: screenshot artifact_run
```

Queue ownership rule:

- queues are run-scoped execution state, not cross-run business state
- each `crawl_run` should use its own named Crawlee queues or equivalent run-scoped storage namespace
- resuming an interrupted run reuses the same run-scoped queues
- starting a new run creates a new set of queues, even if it targets pages seen before

This keeps Crawlee responsible for "what is left to execute in this run" and keeps SQLite responsible for "should this page be executed in this run at all"

Important constraint:

- `markdown` is a first-class capture type in M1
- it is not treated as a simple HTML-to-Markdown conversion step

Each queue should have its own `requestHandler` implementation.

Suggested mapping:

- `base` queue -> base capture `requestHandler`
- `markdown` queue -> markdown capture `requestHandler`
- `screenshot` queue -> screenshot capture `requestHandler`

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
- `configSnapshotId`
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

M1 uses four main business layers.

```text
site_pages
  - identity of a page within a site
  - one row per site + normalized_url

crawl_runs
  - one row per crawl execution
  - points to run_config_snapshot

page_runs
  - one row per page per run
  - holds base capture, classification, rule decision, pending reason

artifact_runs
  - one row per artifact per page per run
  - artifact_type = markdown | screenshot
```

Relationship sketch:

```text
site_pages (1)
   │
   ├──< page_runs (many)
   │         │
   │         └──< artifact_runs (many)
   │
crawl_runs (1) ───────┘
```

## Suggested Table Responsibilities

### `site_pages`

Long-lived page identity.

Do not cache `current_*` fields in M1.

Current status should be derived from `page_runs` and `artifact_runs` by query.

Suggested fields:

- `id`
- `site_id`
- `discovered_url`
- `normalized_url`
- `last_successful_run_id`
- `last_crawled_at`

### `crawl_runs`

Run-level metadata.

Suggested fields:

- `id`
- `site_id`
- `config_snapshot_id`
- `status`
- `started_at`
- `finished_at`
- `target_success_count`
- `successful_page_count`

### `page_runs`

Base-stage truth for a page in a specific run.

Suggested fields:

- `id`
- `run_id`
- `page_id`
- `base_status`
- `classification_status`
- `decision_status`
- `pending_reason`
- `base_capture_path` or structured result reference
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
- `error_code`
- `error_message`

## State Model

### Page Decision State

```text
discovered
   │
   ├── denied_by_url_rule
   ├── denied_by_tag_rule
   ├── pending
   └── allowed
```

### Artifact State

```text
queued
   │
   ├── running
   │    ├── succeeded
   │    └── failed
   └── skipped
```

### Pending Reasons

`pending` must not be a single catch-all bucket.

At minimum:

- `classifier_failed`
- `rule_unresolved`
- `manual_review_required`

## Resume and Multi-Run Behavior

M1 must support:

- resume after interruption
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
   ├── freeze run_config_snapshot
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
- cross-run dedupe and freshness checks happen before enqueue, not inside Crawlee

### URL discovery during a run

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

### Update policy modes

M1 should keep update policy explicit and small.

Recommended initial modes:

- `skip_existing`
- `rerun_failed_artifacts`
- `force_recrawl_all`
- `stale_after_duration`

Each mode must define behavior for:

- whether `base` is re-enqueued
- whether `markdown` is re-enqueued
- whether `screenshot` is re-enqueued
- how previously `pending` pages are treated

These modes belong to SQLite-backed run planning, not to Crawlee queue semantics.

## Decision Contract

Rule evaluation should return one explicit decision object.

Suggested shape:

```text
RuleDecision {
  decision: allow | deny | pending
  pendingReason: classifier_failed | rule_unresolved | manual_review_required | null
  matchedRuleIds: string[]
  requiredArtifacts: artifact_type[]
}
```

Intent:

- URL rules and tag rules both feed one normalized decision output
- downstream code consumes this object instead of re-deriving partial logic
- artifact planning is part of the decision contract, not a separate hidden branch

The decision contract should be persisted or reproducible from persisted run data so later debugging can explain why a page was denied, marked pending, or assigned artifacts.

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

## Config Schema

M1 should use a fixed schema rather than an open-ended JSON blob.

At minimum the schema must include:

- `url_rules`
- `tag_rules`
- `artifact_policy`
- `update_policy`

The schema should prefer:

- explicit field names
- enum-like values for modes and decisions
- stable versioning so config snapshots remain interpretable

Do not let each module invent its own config sub-shape.

## What Already Exists

The current repo does not yet contain implementation code.

The intended implementation should reuse Crawlee primitives rather than replacing them:

- `RequestQueue` for execution queues
- `Request.userData` for cross-request linkage
- `uniqueKey` for queue identity
- Crawlee storage for local execution persistence

## Failure Modes To Design For

### Base stage

- URL matches blacklist before fetch
  - expected handling: do not enqueue base request, optionally persist inventory-only denial record
- lightweight fetch succeeds but classifier fails
  - expected handling: store base result, mark `pending`
- URL discovered multiple times with tracking-param variants
  - expected handling: collapse by `normalized_url`
- run interrupted after base success but before artifact enqueue
  - expected handling: recover from persisted `page_run` and queue state

### Markdown stage

- markdown capture fails while base and screenshot succeed
  - expected handling: artifact failure recorded, page not counted successful under `6C`

### Screenshot stage

- browser render fails or times out
  - expected handling: artifact failure recorded, page not counted successful under `6C`

## Open Follow-Up Design Topics

These are still implementation topics, not yet fully specified:

- exact SQLite schema and indexes
- exact config schema shape
- exact markdown capture mechanism
- retry policy per queue
- update policy semantics for previously crawled pages
- whether `site_pages` current status is computed or denormalized

## Implementation Shape

Keep M1 boring and explicit.

Recommended module boundaries:

- CLI commands
- config snapshot service
- run planner
- rule engine / decision evaluator
- artifact planner
- base crawl pipeline
- markdown pipeline
- screenshot pipeline
- SQLite repositories
- state aggregation / run accounting

Module responsibilities:

- `run planner`
  - reads config snapshot and historical run data
  - applies update policy
  - decides which requests enter this run's queues
- `rule engine / decision evaluator`
  - evaluates URL rules and tag rules
  - produces the unified `RuleDecision`
- `artifact planner`
  - consumes `RuleDecision`
  - creates the frozen artifact plan for `page_runs`
  - enqueues artifact requests
- queue-specific `requestHandler`s
  - execute the actual queue work
  - call external capture tools where applicable
  - write page / artifact execution results

Avoid a single giant hook/function that:

- fetches
- classifies
- applies rules
- mutates all states
- spawns artifact work
- renders browser pages

That shape will become hard to test and harder to trust.
