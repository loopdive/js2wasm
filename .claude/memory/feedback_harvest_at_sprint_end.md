---
name: Run harvest-errors at sprint end, not sprint start
description: Invoke the harvest-errors skill (or spawn a harvester agent) as part of /sprint-wrap-up so the NEXT sprint's backlog is populated from a fresh, post-merge test262 state
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
At the end of every sprint — as part of the `/sprint-wrap-up` skill — run the `harvest-errors` skill (or spawn a dedicated harvester agent) against the current `benchmarks/results/test262-current.jsonl`. The harvester clusters failure patterns, cross-references with existing issues, and files new issue files in `plan/issues/` for buckets above the threshold (default: >50 occurrences).

## Why at sprint end, not sprint start

After the sprint's merges have landed, the test262 failure distribution has **shifted**. Fixes collapse some clusters entirely; they also expose downstream gaps that weren't visible before (today's Sprint 40 DisposableStack regressions are a perfect example — dev-1036's #1036 fix made `new DisposableStack` tests actually run, which exposed the 19-test "Unsupported new expression" gap that only becomes visible after the upstream fix lands).

Running harvest at **sprint start** uses stale data from the previous sprint's failures. Running it at **sprint end** captures the current landscape, which is what the next sprint's planning session needs to slice into themed buckets.

## How to apply

1. `/sprint-wrap-up` Step 7 runs harvest before the final commit
2. Newly-filed issues go into `plan/issues/` with `status: ready` and `sprint: Backlog`
3. The next sprint's PO session (via `po-sprint-N` product-owner agent) sees them and assigns to the new sprint based on theme
4. Tech lead dispatches from the new task queue

## Avoiding assertion-failure blind spots

The 9,400-test assertion-failure bucket (`returned N — assert #N at LN:...`) doesn't get systematic attention unless harvest runs it. Manual sampling catches the top 3-5 patterns but misses the long tail. Scheduled harvest at sprint-end ensures the long tail gets issues filed even when no dev is actively looking at it.

## What harvest runs detect

Harvest clusters by normalized error message and path prefix. Top categories it should surface on each run:
- Compile errors (missing imports, undefined AST nodes, invalid Wasm binary, stack mismatches, type coercion gaps)
- Runtime failures (null deref, illegal cast, timeout, unreachable, assertion patterns)
- Harness false-positives (found 0 asserts, coincidental SyntaxError matches) — worth filing as "close as not-a-bug" so they stop polluting regression counts

## Not cron-scheduled, event-driven

Sprint boundaries don't happen on a cron. Harvest is invoked as part of sprint wrap-up because that's when a sprint actually ends, not 6 hours or 24 hours or whatever fixed interval. Don't set up a CronCreate-based harvest loop — it'll fire at the wrong time and burn tokens on no-ops.
