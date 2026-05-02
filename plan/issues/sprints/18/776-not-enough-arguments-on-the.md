---
id: 776
title: "- 'not enough arguments on the stack for call' (362 CE)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: compilable
test262_ce: 362
---
# #776 -- "not enough arguments on the stack for call" (362 CE)

## Problem

362 tests fail with Wasm validation error "not enough arguments on the stack for call". The codegen pushes fewer values than the callee expects.

## Likely causes

- Optional parameters not padded with defaults at call sites
- Variadic/rest parameter functions called with fewer args than compiled signature expects
- Callback functions with mismatched arity (e.g. Array.map callback compiled with 3 params but called with 1)

## Acceptance criteria

- Call sites push correct number of arguments
- Missing args filled with type-appropriate defaults
