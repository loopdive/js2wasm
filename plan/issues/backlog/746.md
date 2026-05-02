---
id: 746
title: "Inline property tables: struct-based property access for inferred shapes"
status: blocked
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
goal: compiler-architecture
required_by: [905]
files:
  src/codegen/index.ts:
    new:
      - "defineHiddenClass(): create WasmGC struct type from inferred object shape"
      - "hiddenClassRegistry: map shape signatures to struct type indices"
  src/codegen/expressions.ts:
    breaking:
      - "property access on known shapes: emit struct.get instead of externref lookup"
      - "property assignment on known shapes: emit struct.set instead of externref store"
  src/shape-inference.ts:
    breaking:
      - "extend shape inference to track full property sets, not just array-like patterns"
---
# #746 — Inline property tables: struct-based property access for inferred shapes

## Status: open

## Problem

Property access on untyped objects (`obj.foo`) currently goes through `externref` when the object's shape isn't known from a TypeScript interface or class declaration. This requires JS host calls for every property read/write.

With whole-program analysis (#743), we can infer object shapes from construction sites (object literals, constructor functions) and compile property access as direct `struct.get`/`struct.set` — identical to typed class field access.

## Approach

### Phase 1: Shape collection
During the whole-program analysis pass, collect shapes from:
- Object literals: `{ x: 1, y: 2 }` → shape `{x: f64, y: f64}`
- Constructor patterns: `this.x = ...; this.y = ...` → shape from all assignments
- Property additions: `obj.z = ...` after construction → extended shape

### Phase 2: Hidden class generation
For each distinct shape, generate a WasmGC struct type:
```wasm
(type $shape_xy (struct
  (field $x (mut f64))
  (field $y (mut f64))
))
```

Map property names to field indices at compile time. Property access becomes:
```wasm
;; obj.x where obj has shape {x: f64, y: f64}
(struct.get $shape_xy $x (local.get $obj))  ;; O(1), no lookup
```

### Phase 3: Shape transitions
When an object gains a new property after construction:
- If the extended shape is known at compile time → use the extended struct type
- If dynamic → fall back to externref for that object

### What this enables
| Access pattern | Current | After |
|---------------|---------|-------|
| `obj.x` (typed class) | `struct.get` | `struct.get` (same) |
| `obj.x` (untyped, known shape) | JS host call | `struct.get` |
| `obj[dynamicKey]` | JS host call | JS host call (same) |
| `obj.x` (truly dynamic) | JS host call | JS host call (same) |

### Relation to V8's hidden classes
This is the compile-time equivalent of V8's hidden class / shape system. V8 discovers shapes at runtime; we discover them statically from whole-program analysis. The benefit: no deoptimization needed, shapes are fixed at compile time.

## Complexity: XL
