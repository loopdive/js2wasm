---
id: 798a
title: "#798a -- Emit catch_all in try/catch compilation"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: critical
feasibility: easy
goal: error-model
required_by: [798b, 798c]
test262_fail: ~3000
subtask_of: 798
commit: 1f15a01b
---
# #798a -- Emit catch_all in try/catch compilation

## Implementation summary

Added `catch_all` block after `catch $tag` in try/catch compilation. Foreign JS exceptions (from host imports like TypeError) are now caught via catch_all and stored in the catch variable. Uses the exception handling spec's catch_all instruction which is Wasm-native (no host imports needed for the mechanism itself).

Commit: 1f15a01b
