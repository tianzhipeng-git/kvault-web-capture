# M1 Development Plan

当前项目还在初始开发状态, 无线上应用, 修改代码的时候不用考虑兼容性.

## Phase 0: Integration Spike First

### Goal

Build the smallest possible vertical slice that proves the code/Crawlee seam.

### Scope

- TypeScript project scaffold
- SQLite connection and minimal schema
- one CLI command to start a toy run
- one `base` queue
- one `markdown` queue
- minimal `requestHandler` implementations
- minimal `run planner`
- one deterministic fake classifier
- one deterministic fake markdown adapter

### Hello World Scenario

Use one known URL or one tiny local test page.

Flow:

```text
CLI command
   │
   ├── create crawl_run
   ├── insert one site_page
   ├── enqueue one base request
   │
   ▼
base requestHandler
   ├── fetch page
   ├── extract title/meta/body text
   ├── produce stub RuleDecision = allow + markdown
   ├── persist page_run
   └── enqueue markdown request
   │
   ▼
markdown requestHandler
   ├── call fake markdown adapter
   ├── persist artifact_run
   └── finish run
```

### What this spike must prove

- `run planner -> Crawlee queue` handoff is clean
- `request.userData` is sufficient to recover business context
- `page_runs` and `artifact_runs` can be written without awkward cross-layer leakage
- `markdown` integration belongs in a queue-specific `requestHandler`, not in hooks
- Crawlee retries can remain intact while business state is still understandable

### What this spike should NOT include

- screenshot support
- real classifier integration
- full config schema
- full update policy matrix
- sitemap crawling breadth
- production-grade CLI UX

## Exit Criteria For Phase 0

Do not move on until the spike can clearly answer these questions:

1. Is `requestHandler` enough as the main execution seam?
2. Is `userData` sufficient, or is the business context awkward to reconstruct?
3. Do SQLite writes feel natural, or are handlers doing too much coordination?
4. Does the `base -> markdown` follow-up flow feel obvious and testable?
5. Are Crawlee hooks still narrow lifecycle helpers, not business logic containers?

If any answer is "not really", fix the architecture before Phase 1.

## Phase 1: Stabilize The M1 Core Model

### Goal

Turn the spike into a durable M1 skeleton with the right business boundaries, while keeping the proven Crawlee seam intact.

### Scope

- expand the SQLite schema from spike tables into M1 business tables and fields:
  - `projects`
  - `sites`
  - `crawl_runs`
  - `site_pages`
  - `page_runs`
  - `artifact_runs`
- add the run metadata that later phases depend on:
  - `run_type`
  - config snapshots
  - update policy
  - status / timing fields
  - durable page and artifact status fields
- introduce typed site config loading and validation for:
  - seed URLs
  - sitemap inputs
  - URL rules
  - tag rules
  - run options
- refactor the Phase 0 code into explicit application modules:
  - repositories
  - rule engine
  - artifact planner
  - run planner
  - queue factory / queue naming helpers
- keep classifier and markdown capture behind interfaces so tests can continue using deterministic doubles

### What this phase should NOT include

- full seed-run workflow
- screenshot execution
- multi-run update policy behavior
- final CLI command surface

## Exit Criteria For Phase 1

Do not move on until these are true:

1. The schema can represent the M1 entities described in `m1-architecture.md`, not just the Phase 0 spike.
2. A run can persist immutable config snapshots and run type metadata.
3. Rule evaluation, run planning, and queue orchestration are separate modules, not blended into handlers.
4. Phase 0 tests still pass after the refactor.
5. Unit and integration tests cover the stabilized core model, especially URL normalization, repositories, and rule contracts.

## Phase 2: Ship Seed Run

### Goal

Deliver the first real M1 operator workflow: create a site, run `seed_run`, and inspect durable inventory output from the CLI.

### Scope

- implement CLI flows for:
  - create project
  - create site
  - import config into a site
  - clone config from an existing site
  - start `seed_run`
- add input expansion for seed runs:
  - seed URLs
  - recursive sitemap expansion into real page URLs
  - shallow page discovery only
- implement URL-rule evaluation before entering the `base` queue
- implement Stage 1 base capture for seed runs:
  - fetch lightweight page data
  - normalize URL
  - classify
  - evaluate tag rules
  - persist `site_pages` and `page_runs`
- make seed-specific outcomes explicit:
  - `url_rule_denied`
  - `pending`
  - `seed_run` pending reason where Stage 2 is intentionally not started
- add CLI read paths for inventory review:
  - site inventory summary
  - pending pages
  - denied pages
  - sample base captures
- wire a real classifier adapter only if it fits cleanly behind the existing classifier boundary; tests should still use deterministic stubs

### What this phase should NOT include

- full recursive crawl execution
- Stage 2 artifact queues
- resume / stop-condition behavior

## Exit Criteria For Phase 2

Do not move on until these are true:

1. An operator can create a site config and run `seed_run` entirely through CLI commands.
2. Seed runs cannot accidentally turn into full-site crawl runs.
3. URL-rule denials, pending pages, and seed-only outcomes are stored explicitly and queryable.
4. Inventory review works off SQLite business state rather than Crawlee internals.
5. Integration tests cover sitemap expansion, URL-rule gating, and pending persistence.

## Phase 3: Add Crawl Planning Against History

### Goal

Make `crawl_run` a real business workflow that plans work from existing inventory and historical results instead of treating every run as a fresh spike.

### Scope

- implement explicit `crawl_run` creation with:
  - config snapshot
  - update policy
  - target success count
- add run-planning queries against historical `site_pages`, `page_runs`, and `artifact_runs`
- implement the initial update policy set:
  - `force_recrawl_all`
  - `skip_existing`
  - `stale_after_duration`
- make runtime URL discovery follow the same business path as startup planning:
  - normalize URL
  - upsert inventory
  - evaluate URL rules
  - evaluate update policy
  - enqueue only if eligible
- ensure new runs use fresh run-scoped queues, while keeping SQLite as the source of cross-run truth
- keep pending re-evaluation explicit:
  - config changes alone do not re-evaluate pages
  - pages are re-evaluated only through a new `crawl_run`

### What this phase should NOT include

- screenshot execution
- full success accounting for all artifacts
- final resume semantics within an interrupted run

## Exit Criteria For Phase 3

Do not move on until these are true:

1. `crawl_run` planning is reproducible from stored business history.
2. Update policy decisions happen before enqueue, not inside Crawlee hooks.
3. Runtime-discovered URLs follow the same rule and policy gates as startup candidates.
4. Starting a new run does not create split-brain behavior between SQLite state and Crawlee queues.
5. Integration tests cover multi-run planning for `skip_existing`, `force_recrawl_all`, and `stale_after_duration`.

## Phase 4: Complete Stage 2 Artifact Execution

### Goal

Finish the M1 execution model by supporting the full Stage 2 artifact set and the strict success semantics defined by the architecture.

### Scope

- add the `screenshot` artifact type and queue
- replace the Phase 0 fake markdown path with the real markdown capture integration, while keeping the adapter boundary
- freeze `required_artifacts` in `page_runs` immediately after Stage 1 decision-making
- create queue-specific handlers for:
  - `markdown`
  - `screenshot`
- persist artifact execution records with:
  - status
  - timing
  - output reference
  - error message
- aggregate artifact outcomes back into:
  - `page_runs`
  - `site_pages`
  - `crawl_runs`
- implement the strict M1 success rule:
  - a page is successful only when all required artifacts for that run are complete
- keep Crawlee hooks narrow and lifecycle-oriented; artifact decisions must stay in planners / handlers

### What this phase should NOT include

- broad CLI polish unrelated to artifact execution
- performance tuning beyond what is needed to validate the model

## Exit Criteria For Phase 4

Do not move on until these are true:

1. A page can require `markdown`, `screenshot`, or both based on Stage 1 decision output.
2. Partial artifact failure is recorded cleanly and does not count as page success.
3. `required_artifacts` is frozen per run and not mutated by downstream workers.
4. Run and site aggregates reflect pending, denied, partial, and successful outcomes accurately.
5. Tests cover artifact success, artifact failure, and the strict all-required-artifacts success rule.

## Phase 5: Resume, Stop Conditions, And CLI Operations

### Goal

Make the CLI crawl engine operationally complete for M1 by supporting interruption recovery, progress tracking, and the iterative review loop described in the architecture.

### Scope

- implement resume within the same `crawl_run` using:
  - run-scoped queue names
  - persisted Crawlee storage
  - SQLite run / page / artifact state
- implement stop conditions:
  - `target_success_count`
  - correct run finalization when the target is reached or no more eligible work remains
- add operator-facing CLI commands for:
  - resume run
  - inspect run status
  - inspect site status
  - list pending pages
  - list denied pages
  - inspect artifact failures
- polish config management flows:
  - import
  - clone
  - snapshot visibility
- close the M1 testing minimums from `m1-testing.md`, especially:
  - resume within the same run
  - new-run planning against prior business history
  - success counting and stop conditions

### Exit Criteria For Phase 5

M1 is ready when these are all true:

1. An interrupted run can resume without duplicating already-finished work in the same run.
2. Operators can complete the review-adjust-run loop entirely through CLI workflows.
3. Run status, site status, pending inventory, and artifact failures are queryable from business state.
4. The minimum required unit and integration coverage in `m1-testing.md` is satisfied.
5. The codebase still keeps the original Phase 0 promise:
   - our code decides what should run
   - Crawlee executes queue work
   - handlers remain the execution seam
   - SQLite remains the business source of truth
