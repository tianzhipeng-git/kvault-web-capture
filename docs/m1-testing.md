# M1 Testing Strategy

## Purpose

This document captures the testing decisions for M1 so they do not stay mixed into the main architecture document.

M1 focuses on the CLI crawl engine. Web UI testing belongs to M2.

## Stack

- framework: `Vitest`
- scope emphasis: `unit + integration`

## Test Layers

### Unit tests

Primary targets:

- `rule engine / decision evaluator`
- `run planner`
- URL normalization
- config schema validation
- success-count / completion accounting

### Integration tests

Primary targets:

- SQLite repositories
- run planning against stored history
- queue orchestration boundaries
- persistence of `page_runs` and `artifact_runs`
- queue-specific `requestHandler` behavior at the application boundary

### E2E tests

E2E remains a possible layer, but M1 does not require a formal local fixture-site strategy yet.

## Test Philosophy

- business decisions should be tested mostly outside Crawlee internals
- queue-specific `requestHandler`s should be tested through integration and selected end-to-end flows where useful
- external capture tools should be wrapped so they can be replaced with deterministic test doubles in unit/integration tests

## Accepted M1 Test Scope

The review locked these M1 testing decisions:

- primary focus is `unit + integration`
- E2E exists as a possible layer, but M1 does not require a formal local fixture-site strategy yet
- classification behavior in tests uses deterministic stubs rather than the real model
- `6C` run success semantics do not require a dedicated contract-test suite in M1; they should be covered by normal unit/integration coverage where relevant

## Minimum Required Coverage

Unit and integration coverage should at minimum exercise:

- URL normalization
- URL-rule allow / deny / undecided behavior
- tag-rule allow / deny / pending behavior
- fixed precedence inside each execution point
- stage2 applying URL and tag rules in the same execution point
- `RuleDecision` generation
- run planning for:
  - `skip_existing`
  - `force_recrawl_all`
  - `stale_after_duration`
- frozen `required_artifacts` planning
- persistence of `page_runs` and `artifact_runs`
- resume within the same run
- new-run planning against prior business history
- success counting and stop conditions

## Explicitly Deferred From M1 Test Scope

- a mandatory local fixture-site catalog for stable E2E
- testing against the real classifier in automated suites
- a standalone `6C` contract-test suite

## Known Risks

Because of the accepted scope cuts above:

- E2E coverage may stay thinner and more brittle until fixture sites are introduced
- classifier quality drift is not detected by M1 automated tests
- `6C` semantics rely on ordinary coverage discipline instead of a dedicated guardrail suite
