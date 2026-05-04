---
id: 824
title: "Timeout umbrella is stale: replace old 10s compile-timeout bucket with current 30s worker-timeout model"
status: ready
created: 2026-03-29
updated: 2026-04-09
priority: high
feasibility: medium
reasoning_effort: high
goal: iterator-protocol
test262_ce: 0
---
# #824 -- Timeout umbrella is stale: replace old 10s compile-timeout bucket with current 30s worker-timeout model

## Problem

This issue is no longer accurate as written. It describes an older March state
where `548` tests exceeded a `10s` compile limit and were counted as
`compile_error`.

That is not the current runner model anymore:

- the latest official full run `20260407-111308` has **0**
  `compile_timeout` outcomes in the merged JSONL
- the current real timeout pain shows up as **known 30s worker-kill outliers**
  and slow-path waste, not a giant `548 CE` bucket
- those concrete outliers are already split into `#991` through `#996`

So `#824` should now be treated as the umbrella for reconciling timeout
reporting, stale historical analysis, and the remaining targeted timeout work.

## Current state

Known timeout-heavy cases from the latest completed full-run analysis are now:

- `#991` iterator helper generator-reentrancy cluster
- `#992` `Iterator.prototype.take` timeout
- `#993` legacy `try` timeout cluster
- `#994` class static-private-getter timeout
- `#995` `localeCompare` singleton timeout
- `#996` `toSorted` singleton timeout

In earlier full-run observation these accounted for about **10 known 30s
timeouts** and several minutes of wasted worker time per run, even though the
latest merged JSONL no longer records them as `compile_timeout`.

## Why this issue still exists

1. the original issue is still referenced in older planning docs and graphs
2. the old `548 CE / 10s` framing is misleading and should not drive dispatch
3. the current timeout model needs one umbrella that explains the shift from
   giant historical CE buckets to a small set of concrete 30s worker-kill cases

## Suggested fix

1. keep `#991` to `#996` as the real implementation work
2. retire the stale `548 tests / 10s` narrative in docs and backlog references
3. decide whether timeout cases should again be surfaced explicitly in merged
   reports, or whether the targeted issue split is sufficient
4. close this umbrella once the remaining targeted timeout issues are resolved
   or deliberately reclassified

## Acceptance criteria

- planning/docs no longer treat `#824` as a live `548 CE` bucket
- current timeout outliers are represented by `#991` to `#996`
- timeout reporting is internally consistent with the current runner behavior
