---
id: 396
title: "Null pointer dereference in destructuring (118 FAIL)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: crash-free
depends_on: [394]
test262_fail: 118
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileDestructuringPattern — null guard before struct access"
---
# #396 — Null pointer dereference in destructuring (118 FAIL)

## Status: open

All 118 null pointer dereference failures come from destructuring patterns (updated 2026-03-16, was 64). The Wasm runtime traps on `struct.get` when the source value is null — e.g., destructuring from an undefined/null intermediate.

## Details

```javascript
let [a] = someExpr;  // traps if someExpr resolves to null struct ref
```

This is closely related to #394 (wrong return values in destructuring). Fixing the destructuring value extraction will likely fix many of these too. The remaining ones need explicit null guards before struct field access.

## Complexity: S

## Acceptance criteria
- [ ] Destructuring from null/undefined source doesn't trap
- [ ] Reduce null dereference failures to <10
