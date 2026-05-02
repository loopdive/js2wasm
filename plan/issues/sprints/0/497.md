---
id: 497
title: "Dynamic import() via host-side module loading (442 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: spec-completeness
test262_skip: 442
files:
  src/codegen/expressions.ts:
    new:
      - "compileDynamicImport — host import for runtime module loading"
    breaking: []
  src/runtime.ts:
    new:
      - "dynamic import host — loads, compiles, links Wasm module at runtime"
    breaking: []
---
# #497 — Dynamic import() via host-side module loading (442 tests)

## Status: open

442 tests use `import()` for dynamic module loading.

## Approach

`import("./module.js")` compiles as a host import call:

1. Wasm module calls `__dynamic_import(specifier)` host import
2. Host resolves the specifier, loads the source, compiles to Wasm via ts2wasm
3. Host instantiates the new module, linking shared imports
4. Host returns the module's exports as an externref object
5. The calling code awaits the result (import() returns a Promise)

This is simpler than eval because:
- No scope sharing needed (modules have isolated scope)
- The specifier is typically a string literal (can even be resolved at compile time)
- Return type is well-defined (module namespace object)

### Static optimization
When the specifier is a string literal, the compiler could resolve it at build time and bundle the module — no runtime compilation needed. Only truly dynamic specifiers (`import(variable)`) need the host import.

## Complexity: M

## Acceptance criteria
- [ ] `import("./module.js")` loads and returns module exports
- [ ] `const { foo } = await import("./lib")` works
- [ ] Static specifiers can be resolved at build time (optimization)
- [ ] Host import is optional — if not provided, import() rejects
