---
id: 19
title: "Issue 19: Type Narrowing and Union Types"
status: done
created: 2026-02-28
updated: 2026-04-14
completed: 2026-02-28
goal: compilable
---
# Issue 19: Type Narrowing and Union Types

## Status: done

## Summary
Support `typeof` guards, truthiness checks, and basic union type discrimination at runtime.

## Motivation
TypeScript's type narrowing is core to the language: `if (typeof x === "string")`, `if (x)`, `if (x !== null)`. Without it, any code handling mixed types or nullable values is impossible.

## Design

### Challenge
WASM has fixed types per local — a local is either f64, i32, or externref. TypeScript union types like `string | number` don't map to a single WASM type.

### Approach: Tagged externref for unions
For union types, use externref to hold the JS value and `typeof`-check host imports:

```
__typeof: (externref) -> externref  // returns "string", "number", etc.
__to_f64: (externref) -> f64        // unbox number
__to_bool: (externref) -> i32       // unbox boolean
```

For non-union narrowing (e.g., `x !== null` where x is `T | null`):
```wat
local.get $x
ref.is_null
i32.eqz
if
  ;; x is non-null here, type is T
end
```

### typeof operator
`typeof x` → call `__typeof(x)` import, returns string externref.
`typeof x === "number"` → call `__typeof(x)`, compare with string literal.

### Truthiness narrowing
`if (x)` where x is externref → host import `__is_truthy(externref) -> i32`

## Scope
- `src/codegen/expressions.ts`: typeof operator, truthiness coercion
- `src/codegen/index.ts`: union type host imports
- Complex: full union type support requires rethinking the type system

## Complexity: L

## Out of scope (first pass)
- Discriminated unions (`type A = { kind: "a" } | { kind: "b" }`)
- `instanceof` checks
- User-defined type guards (`function isString(x): x is string`)

## Acceptance criteria
- `typeof x === "number"` compiles and narrows correctly
- `if (x)` works as truthiness check for externref values
- `x !== null` narrows externref to non-null
