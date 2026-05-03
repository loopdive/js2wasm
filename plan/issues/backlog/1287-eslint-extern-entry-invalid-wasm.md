---
id: 1287
title: "ESLint entry-point compileProject emits invalid Wasm (`Type index 10 is out of bounds`)"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: extern, npm-package-imports
goal: npm-library-support
related: [1282, 1279, 1277]
---

# #1287 — ESLint entry-point produces invalid Wasm (Type index 10 out of bounds)

## Problem

When `compileProject` is pointed at a tiny ESLint Linter entry:

```ts
import { Linter } from "eslint";
const linter = new Linter();
export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
```

`compileProject` returns `success: true` and a 12,751-byte binary, but
`WebAssembly.instantiate` rejects it with:

```
WebAssembly.instantiate(): Type index 10 is out of bounds @+58
```

The binary is unloadable. The compile-time resolver cannot find a
satisfiable definition for `Linter` (the `eslint` package is an npm
dependency that the project tree-shaker treats as opaque), so the
codegen falls back to extern handling — but the generated module
references a Wasm type index that was never registered.

## Reproducer

```ts
// tests/stress/eslint-tier1.test.ts → Tier 1b
const r = compileProject("./entry.ts", { allowJs: true });
expect(r.success).toBe(true); // currently passes
const imps = buildImports(r.imports as never, undefined, r.stringPool);
await WebAssembly.instantiate(r.binary, imps as never); // throws
```

`r.imports` only contains 4 builtins (`__new_plain_object`,
`__get_undefined`, `__make_iterable`, `__extern_length`) — no
`Linter_new` or any other extern slot is registered. The codegen
emits something that references a struct/func type that was never
declared in the type section.

## Hypothesis

`compileProject` succeeds because the TypeScript checker sees `Linter`
as a class type (from `node_modules/eslint/lib/types/index.d.ts`). The
codegen then tries to lower `new Linter()` as a class constructor,
but never registered the type — likely the inverse of the #1284 path:
extern class info exists but the `_new` import was suppressed by the
collision guard, leaving a phantom type ref behind.

## Suggested investigation

1. `wasm-dis /tmp/eslint-min.wasm` reports
   `invalid type: Heap type has an undeclared child at index 8`.
   The struct/array type at index 8 references a heap type that was
   never emitted. Inspect the type section to find the missing slot.
2. Check `compileNewExpression` for `new Linter()` when both
   `ctx.classSet.has("Linter")` is false and
   `ctx.externClasses.get("Linter")` is missing — does it still emit a
   typed `struct.new` referencing a non-existent type idx?
3. Likely fix: when `new ClassName()` cannot resolve to a defined or
   extern class, fall back to a defined `__new_plain_object` host
   import returning `externref` and skip the `struct.new` path.

## Acceptance criteria

1. `tests/stress/eslint-tier1.test.ts` → Tier 1b unskipped: the
   minimal Linter entry compiles AND instantiates without
   "Type index out of bounds".
2. The instantiated module's `test()` may still fail at runtime
   (Linter is not actually implemented in the module graph), but
   the binary must be valid Wasm.

## Resolution (2026-05-03)

### Actual root cause

The original hypothesis (extern import suppression leaving a phantom
type ref) was wrong. The real bug: **interfaces declared in `.d.ts`
files were being lowered to WasmGC struct types**, dragging in their
field types recursively. For a real-world npm package like `eslint`,
this pulls in chains like:

```
Linter → Linter.LintMessage[] → @eslint/core types
       → @types/estree.Comment / SwitchCase / VariableDeclarator …
       → @types/json-schema.JSONSchema4 / ValidationError
```

Each interface registers a struct type. Each `T[]` field registers an
array of `ref<struct T>` and a vec wrapper struct. Hundreds of types
get queued; the dead-elim pass then compacts the surviving ones, and
the surviving order produces forward heap-type references — vec at
new index 6 reads `data: ref<9>` where new type 9 is itself another
struct (not an array). Wasm validation rejects: "Type index 9 is out
of bounds @+41".

`acorn` and `typescript` imports work because their `.d.ts` exports
are smaller / don't have the same chain of array-of-interface fields
that triggers the forward-ref pattern.

### Fix

Three guards, layered defensively:

1. **`src/codegen/declarations.ts::collectDeclarations`** — skip
   `collectInterface` and `collectObjectType` (alias to object) when
   the source file is a `.d.ts`. This is the primary fix — it
   prevents the struct types from ever being registered.
2. **`src/codegen/declarations.ts::collectClassesFromStatements` /
   `compileClassesFromStatements`** — extend the existing `declare`
   modifier guard to also catch `.d.ts` source files, so that
   `export class Foo` in a `.d.ts` is treated as ambient (no body).
3. **`src/codegen/index.ts::ensureStructForType`** — early skip for
   types whose declarations are all in `.d.ts` files (defense in
   depth — catches paths where the type-checker hands us a `.d.ts`
   type indirectly).
4. **`src/checker/type-mapper.ts::isDeclareContext`** — also returns
   true for nodes in `.d.ts` files, so `isExternalDeclaredClass`
   correctly classifies `.d.ts` `export class` as extern.

The four guards together close every path that previously turned a
declaration-file shape into a real Wasm struct. Consistent with the
project rule that types from `.d.ts` describe host JS values; their
runtime form is `externref`, not a WasmGC struct.

### Test results

- `tests/stress/eslint-tier1.test.ts` Tier 1b unskipped — passes via
  `WebAssembly.validate(binary)`. Tier 1a/1c continue to pass.
- The full minimal Linter binary is now 9,814 bytes (was 12,751
  invalid) and `WebAssembly.validate` returns true.
- Stub `.d.ts` probes (`class Foo { children: Foo[] }`,
  `class Foo { list(): Foo[] }`, generic class) all produce valid
  Wasm.
- No regressions: identical pass/fail counts vs main on the broader
  class / interface / extern / multi-file sweep (12 test files,
  100 tests).

### Note for Tier 1d

Tier 1d (`linter.js` direct compile instantiates) remains BLOCKED on
**#1289** — an unrelated `array.set` type mismatch in
`FileReport_addRuleMessage` inside ESLint's actual JS implementation.
That's a separate codegen issue and out of scope for #1287.
