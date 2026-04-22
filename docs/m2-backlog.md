## Read Models and Query Contracts

M1 must define read-path contracts now, even if the first consumer is a CLI command and the web UI comes later.

At minimum the system must support the following query shapes.

### 1. Site overview

Used for "查看整个站点的完整运行情况".

Must return:

- site identity
- latest published config snapshot
- total inventory count
- counts by `inventory_status`
- counts by `latest_decision_status`
- counts by `latest_pending_reason`
- latest successful crawl time
- latest run summaries

### 2. Inventory review list

Used for initial preview validation and later manual review.

Must support filters by:

- `inventory_status`
- `latest_decision_status`
- `latest_pending_reason`
- tag
- URL pattern
- discovered run

Each row should include:

- normalized URL
- title / lightweight preview
- tags
- latest decision
- latest pending reason
- discovery source
- discovery referrer
- latest run reference

### 3. Run summary

Used for "查看本轮的结果".

Must return:

- run identity and run type
- config snapshot used
- queue / artifact progress
- successful page count
- failed page count
- pending page count
- denied page count
- target success count
- stop reason, such as completed, interrupted, target reached

### 4. Pending review queue

Used for "查看待定链接的情况".

Must support:

- grouping by `pending_reason`
- showing last base capture summary
- showing matched rules and missing decision inputs
- selecting pages that should be reconsidered after config changes

The query layer may be implemented as SQL views, repository methods, or explicit read services, but the contract itself is part of the architecture.
