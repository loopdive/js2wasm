---
id: 1143
title: "Array callback arg push not gated on paramTypes.length — extra args emitted unconditionally"
status: done
created: 2026-04-20
updated: 2026-04-20
completed: 2026-04-20
priority: low
feasibility: easy
reasoning_effort: low
goal: correctness
---
## Problem

Array method callbacks (map, filter, forEach, etc.) push all available arguments (value, index, array) regardless of how many the callback actually declares. This caused incorrect codegen when callbacks declared fewer than 3 params — extra values were pushed onto the Wasm stack.

## Acceptance Criteria

- [x] Callback arg push gated on `paramTypes.length`
- [x] Callbacks with 1 or 2 params receive only the args they declare

## Implementation

Merged via PR #228 (branch `issue-array-index-call-coerce`).
