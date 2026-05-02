---
id: 685
title: "Interprocedural type flow: track return types across call sites"
status: ready
created: 2026-03-20
updated: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: high
goal: performance
files:
  src/codegen/index.ts:
    new:
      - "interprocedural return type analysis"
  src/codegen/expressions.ts:
    breaking:
      - "use inferred return types at call sites"
---
# #685 — Interprocedural type flow: track return types across call sites

## Status: open

Currently each function's return type is resolved from TS declarations. But for untyped functions or functions returning union types, the actual runtime return type may be more specific.

### Approach
1. After compiling a function body, record its actual Wasm return type (not the TS-declared type)
2. At call sites, use the actual return type instead of the declared type
3. This avoids unnecessary boxing/unboxing when a function declared as `any` always returns f64

### Example
```typescript
function getValue() { return 42; }  // TS infers number, but declared return is any in some contexts
const x = getValue();  // Currently: externref. After fix: f64
```

### Implementation
Add `ctx.actualReturnTypes: Map<string, ValType>` populated during function body compilation. At call sites, check this map before falling back to TS type resolution.

## Complexity: M
