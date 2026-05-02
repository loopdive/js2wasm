---
id: 369
title: "- globalThis support"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: medium
goal: standalone-mode
test262_skip: 10
files:
  src/codegen/expressions.ts:
    new:
      - "compileGlobalThis — globalThis built-in support"
    breaking: []
---
# #369 -- globalThis support

## Status: open

10 tests use the `globalThis` built-in.

## Details

```javascript
globalThis.parseInt === parseInt; // true
globalThis.undefined === undefined; // true
typeof globalThis; // "object"
```

`globalThis` provides a universal way to access the global object. In a Wasm context without a JS host, this needs to be a synthetic global object that provides access to built-in globals (parseInt, NaN, undefined, Infinity, etc.).

Implementation:
1. Create a globalThis struct with fields for each global property
2. Recognize `globalThis` as a special identifier in expression compilation
3. Property access on globalThis resolves to the corresponding global

## Complexity: M

## Acceptance criteria
- [ ] `globalThis` is recognized as a valid identifier
- [ ] Property access on `globalThis` resolves built-in globals
- [ ] `typeof globalThis` returns "object"
- [ ] 10 previously skipped tests are now attempted
