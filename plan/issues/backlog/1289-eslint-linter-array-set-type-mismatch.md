---
id: 1289
sprint: 47
title: "ESLint linter.js direct compile: array.set type mismatch in FileReport_addRuleMessage"
status: done
created: 2026-05-03
updated: 2026-05-03
completed: 2026-05-03
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

1. The specific `array.set[2] expected type (ref null X), found array.get
   of type (ref null Y)` error in `FileReport_addRuleMessage` is gone
   when compiling `eslint/lib/linter/linter.js` directly. ✅
2. No regression in lodash / Hono Tier 1+2 stress tests. ✅
3. Tier 1d (instantiate the linter.js binary) — partially advanced; the
   FileReport_addRuleMessage error is fixed but a separate
   `extern.convert_any` validation error in `Config_new` (offset
   ~104394) is now exposed. Filing as a follow-up issue, distinct from
   the vec-coercion fix that #1289 addresses.

## Resolution (2026-05-03)

The bug lived in `emitVecToVecBody` in `src/codegen/type-coercion.ts`.
That helper coerces one vec type to another by element-by-element copy
with optional element-type coercion:

```ts
fctx.body.push({ op: "array.get", typeIdx: srcVec.arrTypeIdx });
if (srcVec.elemType.kind !== dstVec.elemType.kind) {
  coerceType(ctx, fctx, srcVec.elemType, dstVec.elemType);
}
fctx.body.push({ op: "array.set", typeIdx: dstVec.arrTypeIdx });
```

The `kind` check is too lax: when both vec elements are `kind: "ref"`
(or `ref_null`) but with different `typeIdx` (i.e. unrelated struct
shapes), the coercion is skipped and the `array.set` fails Wasm
validation because the value's type doesn't match the destination
array's element type.

In `FileReport_addRuleMessage`, shape inference produced two slightly
different message-shape structs across the eslint module graph (the
function calls `createProblem({...})` which builds an object literal
with conditional fields, while sibling methods `addError` /
`addWarning` push results from `createLintingProblem` with a different
field set). The vec-to-vec coercion path was therefore copying from a
vec of one struct type into a vec of another, hitting the kind-only
check and skipping the cast.

Fix: compare both `.kind` AND `.typeIdx` for ref/ref_null elements and
route through `coerceType` (which emits a guarded `ref.cast` to the
destination element type) whenever they differ.

Regression test: `tests/issue-1289.test.ts` — minimal mixed-shape repro
(works in JS mode where TS strict checks don't reject the heterogeneous
push) plus a smoke test that pins the ESLint linter.js binary not
failing with the FileReport_addRuleMessage array.set pattern.

## Follow-up

The remaining `extern.convert_any[0] expected type anyref, found
extern.convert_any of type externref` error in `Config_new` is a
distinct codegen bug (double-emitted extern.convert_any), filed as
follow-up. Tier 1d remains skipped pending that fix.
