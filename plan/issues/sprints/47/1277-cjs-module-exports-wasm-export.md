---
id: 1277
sprint: 47
title: "CJS module.exports → Wasm export mapping in compileProject"
status: done
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: CommonJS, module-exports
goal: npm-library-support
related: [1031, 1074]
---
# #1277 — CJS `module.exports` → Wasm export mapping

## Problem

When `compileProject` compiles a CommonJS module like `node_modules/lodash/identity.js`:

```js
// lodash/identity.js (CJS)
function identity(value) {
  return value;
}
module.exports = identity;
```

The compilation succeeds (`result.success: true`) but the resulting Wasm binary has zero
function exports. `module.exports = identity` is not understood as an ESM-style export.

## Root cause

The compiler's export discovery only handles:
- `export function foo() {}`
- `export default ...`
- `export { foo }`

It does not handle:
- `module.exports = fn`
- `module.exports.foo = fn`
- `exports.foo = fn`

## Approach

In the module pre-pass, detect CJS export patterns and rewrite them to ESM-equivalent
export edges:
- `module.exports = X` → `export default X`
- `module.exports.foo = X` → `export { X as foo }`
- `exports.foo = X` → `export { X as foo }`

This rewriting should happen in the import resolver / module pre-pass before codegen.

## Scope note

This is needed for the plain `lodash` package (CJS only). `lodash-es` already uses ESM
and does not have this problem. Priority: lodash-es first, CJS as follow-up.

## Acceptance criteria

1. `compileProject('node_modules/lodash/identity.js', { allowJs: true })` emits a `default`
   or `identity` Wasm function export
2. `exports.default(42)` → `42` when instantiated
3. `tests/issue-1277.test.ts` covers `module.exports = fn` and `module.exports.foo = fn`
4. No regression in ESM import/export tests

## Resolution

The problem-statement assumption is partially out of date — the existing CJS handler
at `src/codegen/declarations.ts:2382` (added in #1075) already covers
`module.exports = <ident>`, `module.exports = function() {}`, `module.exports.foo = X`,
and `exports.foo = X` shapes. Empirical probes against `lodash/identity.js` show those
already produce both `identity` and `default` Wasm exports.

Two real gaps remained:

1. **Object-literal RHS** — `module.exports = { a, b: c }` (a common pattern in
   barrel/aggregator modules) was not recognized. Added a Pattern 1c branch to the
   existing CJS handler that walks shorthand and named-with-identifier properties
   and emits each as a Wasm export under the property key, looking up the local
   binding by name in `ctx.funcMap`. Computed keys, methods, spreads, and
   non-identifier values are skipped (a future enhancement could route generic
   expressions through a synthetic global).

2. **ESM `export { foo, bar as baz };`** — pure-ESM named-export declarations
   (without a `from` specifier) were not recognized either. Added a parallel
   walker in the same file that resolves `propertyName ?? name` to a local
   binding and emits the function under the exported alias. Re-exports
   (`export { x } from "spec"`) are intentionally skipped — those need import
   resolution + re-export wiring outside this scope.

The CJS rewriter approach proposed in the issue body would have been redundant
(and actively broke `exports.foo = X` by rewriting it to `export { X };` before the
existing CJS handler ran); both gaps are filled by extending the export-discovery
walker directly.

## Test Results

- `tests/issue-1277.test.ts`: 13/13 pass — covers all required acceptance shapes.
- `tests/issue-1075.test.ts` (CJS module.exports regression guard): 8/8 pass.
- `tests/issue-1074.test.ts` (export default regression guard): 5/5 pass.
- `tests/issue-1279.test.ts` (CJS require() regression guard): 18/18 pass.
- `tests/equivalence/import-meta.test.ts`: 4/4 pass.
