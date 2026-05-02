---
id: 584
title: "Null pointer dereference in 361 tests (unknown function)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: crash-free
test262_fail: 361
files:
  src/codegen/expressions.ts:
    breaking:
      - "null deref at runtime — struct.get on uninitialized class instances"
---
# #584 — Null pointer dereference in 361 tests (unknown function)

## Status: open

361 tests fail at runtime with null pointer dereference. The trap doesn't include a function name ("unknown"), suggesting it occurs in inline code or module initialization.

### Root cause
Most likely from module-level code that accesses class instance properties before the constructor runs, or from destructuring patterns that produce null references.

### Pattern breakdown
- 361 `null deref in unknown` — no function name in the trap message
- Likely in `__module_init` or inlined class field initializers

### Fix
Add `ref.as_non_null` before struct.get in module-level code, or ensure class field initializers produce non-null defaults.

## Complexity: M
