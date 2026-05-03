---
id: 1289
title: "ESLint linter.js direct compile: array.set type mismatch in FileReport_addRuleMessage"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, arrays, struct-types
goal: npm-library-support
related: [1282, 1247]
---

# #1289 — ESLint linter.js produces invalid Wasm in `FileReport_addRuleMessage`

## Problem

Pointing `compileProject` at `node_modules/eslint/lib/linter/linter.js`
directly produces a 255,141-byte binary, but
`WebAssembly.instantiate` rejects it with:

```
Compiling function #132:"FileReport_addRuleMessage" failed:
  array.set[2] expected type (ref null 80), found array.get of type (ref null 64)
  @+90453
```

The compiled function tries to write a `(ref null 64)` value into an
array of `(ref null 80)` elements. The two struct types are likely
related by inheritance / shape inference but the codegen does not
insert a `ref.cast` on the way into `array.set`.

## Reproducer

```ts
const r = compileProject(
  "/workspace/node_modules/eslint/lib/linter/linter.js",
  { allowJs: true },
);
expect(r.success).toBe(true); // currently passes
await WebAssembly.instantiate(r.binary, imps); // throws
```

Look at function index 132 (`FileReport_addRuleMessage`) and the
`array.set` instruction at offset 90453 in the compiled binary.

## Hypothesis

`FileReport_addRuleMessage` pushes a message struct onto an
internal messages array. The element type was inferred from a
narrower message shape than what this method actually constructs.
When the source assigns to the array, codegen needs a `ref.cast` to
the element type but emits `array.set` with the raw value type
instead.

This may share a root cause with #1247 (typed `string[]` local with
`split()` triggering struct-type mismatch).

## Acceptance criteria

1. `tests/stress/eslint-tier1.test.ts` → Tier 1c unskipped: the
   ESLint `linter.js` direct compile produces a Wasm binary that
   passes `WebAssembly.instantiate`.
2. No regression in lodash / Hono Tier 1+2 stress tests.
