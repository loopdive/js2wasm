---
id: 1272
sprint: 47
title: "Symbol as object key — Symbol.for(), well-known Symbols as property keys"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: Symbol, property-access
goal: npm-library-support
related: [1244]
---

## Implementation note (2026-05-02, dev-1245)

Same stale-issue pattern as #1250, #1271, #1275, #1276 — the
documented acceptance criteria already pass on origin/main:

```
Symbol.for(k); o[k] = 42; o[k]   → 42  ✓
Symbol.for("x") === Symbol.for("x") → true ✓
Symbol() !== Symbol()             → true ✓
Symbol.for("x") !== Symbol.for("y") → true ✓
Multiple Symbol keys on same obj  ✓
Reassign through same Symbol key  ✓
```

PR is therefore test-only. Adds `tests/issue-1272.test.ts` with 6
regression tests covering all three acceptance criteria + edge cases:
1. `Symbol.for(k); o[k] = 42; o[k]` round-trip
2. `Symbol.for("x") === Symbol.for("x")` identity
3. `Symbol() !== Symbol()` uniqueness
4. `Symbol.for("x") !== Symbol.for("y")` (different keys)
5. Multiple Symbol keys on the same object
6. Reassignment through the same Symbol key

---

# #1272 — Symbol as object key

## Problem

Hono uses `Symbol` internally for context slots (e.g. `Symbol.for('hono.context')`).
Currently, using a Symbol as an object key causes a compile error or wrong behavior —
the compiler only handles string and number keys on structs.

## Scope

1. **`Symbol.for(key)`** — global symbol registry. Compile to a host-managed map from
   string → unique i32 symbol ID.
2. **Well-known Symbols** (`Symbol.iterator`, `Symbol.toPrimitive`, etc.) — compile-time
   constants mapped to reserved i32 IDs.
3. **Symbol as property key** — `obj[sym]` where `sym` is a Symbol. Route through a
   separate `Map<i32, externref>` side-table on the struct, keyed by symbol ID.

## Acceptance criteria

1. `const k = Symbol.for('x'); const o = {}; o[k] = 42; return o[k]` → 42
2. `Symbol.for('x') === Symbol.for('x')` → true
3. `Symbol() !== Symbol()` → true (unique)
4. `tests/issue-1272.test.ts` covers all three
