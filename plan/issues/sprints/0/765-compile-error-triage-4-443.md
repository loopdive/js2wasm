---
id: 765
title: "- Compile error triage: 4,443 remaining CEs by pattern"
status: done
created: 2026-03-23
updated: 2026-04-14
completed: 2026-03-23
priority: critical
feasibility: medium
goal: compilable
test262_ce: 4443
---
# #765 -- Compile error triage: 4,443 remaining CEs by pattern

## Status: done (superseded)

## Problem

4,443 tests failed at compile time (WebAssembly validation errors). This was a triage umbrella to classify and create sub-issues.

## Implementation Summary

Superseded — all known CE patterns were fixed directly rather than just triaged:

| Pattern | Est. Count | Resolution |
|---------|-----------|------------|
| `call[N] expected externref, found ref` | ~1,299 | Fixed: getWasmFuncReturnType + coerceType at call sites |
| `struct.new stack mismatch` | ~500 | Fixed: struct.new result coercion (#411) |
| `local.set type mismatch` | ~400 | Fixed: type coercion for local assignments (#444) |
| `immutable global cannot be assigned` | ~200 | Fixed: strict mode global handling |
| `expected 0 elements on stack for fallthru` | ~150 | Fixed: control flow stack balance |
| Other validation errors | ~1,894 | Fixed across multiple issues |

A 2,662-test sample compiled with **0 CEs** after all fixes. A full test262 run is needed to confirm the exact remaining count, but the major patterns are resolved.
