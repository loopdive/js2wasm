---
id: 591
title: "Split expressions.ts (24,427 lines) into focused modules"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: core-semantics
depends_on: [586, 587]
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "split into binary-ops.ts, call-expression.ts, array-methods.ts, type-coercion.ts"
---
# #591 — Split expressions.ts (24,427 lines) into focused modules

## Status: review

`expressions.ts` is 24,427 lines — the largest file in the project. It mixes binary operations, call expressions, property access, array methods, type coercion, closure compilation, and destructuring.

## Proposed split

| New file | Lines | Content |
|----------|------:|---------|
| type-coercion.ts | ~600 | coerceType, defaultValueInstrs, boxing/unboxing |
| binary-ops.ts | ~1,300 | compileBinaryExpression, compileAnyBinaryDispatch |
| call-expression.ts | ~1,100 | compileCallExpression, method dispatch |
| array-methods.ts | ~3,800 | All Array.prototype inline implementations |
| property-access.ts | ~500 | compilePropertyAccess, compileElementAccess |
| closures.ts | ~400 | compileArrowAsClosure, compileArrowAsCallback |
| expressions.ts | ~16,700 | Remaining (still large but more focused) |

Depends on #586 (array method dedup) and #587 (destructuring dedup) which should reduce the total before splitting.

## Complexity: M

## Implementation Summary (type-coercion.ts extraction)

Extracted 4 functions from `expressions.ts` into `src/codegen/type-coercion.ts`:
- `coerceType` (~570 lines) — Wasm stack value type coercion
- `pushDefaultValue` (~35 lines) — push default value for a given ValType
- `defaultValueInstrs` (~25 lines) — return Instr[] for default values
- `coercionInstrs` (~50 lines) — return Instr[] for type coercion

### Circular dependency handling
`coerceType` calls `compileStringLiteral` (for @@toPrimitive hint strings). To avoid
a circular import (type-coercion.ts -> expressions.ts -> type-coercion.ts), the extracted
`coerceType` accepts an optional `CompileStringLiteralFn` callback parameter. In
`expressions.ts`, the exported `coerceType` wrapper passes the local `compileStringLiteral`.

### Files changed
- `src/codegen/type-coercion.ts` — new file with the 4 functions
- `src/codegen/expressions.ts` — removed function bodies, added import/re-export, thin wrapper for `coerceType`

### What worked
- Callback injection for `compileStringLiteral` avoids circular imports cleanly
- Re-exports from `expressions.ts` maintain backward compatibility for `index.ts`
- All existing tests pass (no regressions)
