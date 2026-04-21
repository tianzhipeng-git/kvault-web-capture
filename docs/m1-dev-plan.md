# M1 Development Plan

## Purpose

This plan is intentionally front-loaded around the seam between project code and Crawlee.

The goal is not to fully build M1 immediately. The goal is to first prove that the integration boundary is clean:

- our code decides what to run
- Crawlee executes queue work
- `requestHandler` is the main execution entry
- SQLite records the business state we care about

Only after that seam is proven should the rest of M1 be expanded.

## Planning Principle

Start with a hello-world vertical slice at the Crawlee boundary, not a broad horizontal build-out.

That slice should prove:

- one run can be created
- one page can be enqueued
- one `base` `requestHandler` can execute
- one SQLite record path can be written
- one artifact follow-up request can be planned and executed

If that slice feels awkward, the architecture should be corrected before the project grows.

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

## Phase 1: Foundation After The Spike

Only start this phase after the integration spike feels structurally right.

### Workstream 1: Project Scaffold

- initialize Node.js + TypeScript project
- add Crawlee
- add SQLite driver
- add Vitest
- add basic lint / typecheck / scripts

### Workstream 2: Minimal Business Schema

Start with the smallest schema that supports the spike and future growth:

- `sites`
- `site_pages`
- `crawl_runs`
- `page_runs`
- `artifact_runs`

Do not over-model configuration yet.

### Workstream 3: Core Interfaces

Define the thin interfaces that separate our code from Crawlee:

- `RunPlanner`
- `RuleDecision`
- `MarkdownCaptureAdapter`
- repository interfaces for run/page/artifact writes

These interfaces should stay small and explicit.

## Phase 2: Real Base Pipeline

Expand the spike into the real `base` pipeline.

### Deliverables

- URL normalization
- URL-rule allow / deny / undecided
- base fetch and extraction
- deterministic classifier stub
- tag-rule evaluation
- frozen `required_artifacts`
- `pending_reason`

### Main output

At the end of this phase, `base` should be able to:

- deny early
- mark pending
- allow and enqueue artifact work

## Phase 3: Real Markdown Pipeline

Replace the fake markdown adapter with the real external `url -> markdown` tool.

### Deliverables

- queue-specific `markdown requestHandler`
- adapter wrapper around the external tool
- artifact file output handling
- `artifact_run` persistence
- error mapping and retry behavior

### Goal

Prove that a real external tool integrates cleanly through the queue boundary.

## Phase 4: Screenshot Pipeline

Add the screenshot queue only after `base` and `markdown` are stable.

### Deliverables

- browser-backed screenshot `requestHandler`
- narrow Crawlee hook usage where actually needed
- screenshot artifact persistence
- artifact failure handling

## Phase 5: Config Snapshots And Update Modes

Once all three pipelines work, add the heavier business policy layer.

### Deliverables

- typed config schema
- `run_config_snapshot`
- update modes:
  - `skip_existing`
  - `rerun_failed_artifacts`
  - `force_recrawl_all`
  - `stale_after_duration`

### Goal

Move from "one run works" to "multiple runs behave predictably".

## Phase 6: CLI Surface And Operator Queries

After pipeline correctness is established:

- improve CLI commands
- add run status queries
- add pending-page listing
- add result inspection commands

## Test Plan By Phase

### Phase 0

- one integration test for `base -> markdown`
- one unit test for `RuleDecision`
- one repository integration test for `page_runs` and `artifact_runs`

### Phase 2

- URL normalization tests
- URL-rule tests
- tag-rule tests
- pending-state tests

### Phase 3

- markdown adapter integration tests
- artifact failure / retry tests

### Phase 4

- screenshot artifact tests
- browser failure tests

### Phase 5

- update mode tests
- multi-run history tests
- stop-condition / success-count tests

## Parallelization Strategy

Initial implementation should be mostly sequential.

The seam is the risk. Parallelizing too early just creates merge conflicts around the exact modules that are still being discovered.

Suggested order:

```text
Lane A
  Phase 0 spike
    -> Phase 1 scaffold/schema
    -> Phase 2 base pipeline
    -> Phase 3 markdown pipeline
    -> Phase 4 screenshot pipeline
    -> Phase 5 config/update modes
    -> Phase 6 CLI/status polish
```

Parallel work only becomes reasonable after Phase 0 succeeds.

At that point:

- one lane can deepen repositories / schema work
- one lane can deepen pipeline handlers
- one lane can deepen CLI/status commands

## Definition Of Success

This plan is successful if:

1. The Phase 0 spike proves the Crawlee seam is clean.
2. The project grows from a tested vertical slice, not from speculative abstractions.
3. External tools such as `url -> markdown` fit naturally into queue-specific handlers.
4. Business policy stays outside Crawlee internals.
