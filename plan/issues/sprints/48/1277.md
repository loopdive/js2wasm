---
id: 1277
title: "CJS module.exports → Wasm export mapping in compileProject"
status: ready
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
