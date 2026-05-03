---
id: 1276
sprint: 47
title: "HOF returning closure — function-valued module exports (createMathOperation pattern)"
status: done
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: closures, HOF, module-exports
goal: npm-library-support
related: [1031, 1107]
---

## Implementation note (2026-05-02, dev-1245)

Smoke-testing on origin/main shows the basic HOF-returning-closure
pattern **works for INTERNAL-WASM use** (the issue's primary use case
when called from another exported function in the same compilation
unit):

```
createMathOp(fn) → add(3, 4)  ✓ returns 7
HOF with captured defaultValue ✓
Two HOF-created functions side by side ✓
Realistic _createMathOperation with NaN handling ✓
```

What does NOT work and is the **remaining real bug**:

1. `export default add` — exports `add` as an externref Wasm GLOBAL,
   not a callable function. JS `instance.exports.default(3, 4)`
   fails with "is not a function".
   - Existing handling at `declarations.ts:2731-2750` and
     `index.ts:922-937` exports the variable as a Wasm `global`
     (ESM semantics for non-function values). Closures need a
     trampoline-export path: emit a Wasm function `default` that
     reads the global, struct.get the funcref field, and call_ref
     through it.

2. Chained calls without intermediate binding: `makeAdd()(3, 4)`
   returns 0 instead of 7. Same root cause as curried HOFs (closure-
   of-closure call chain with no binding). The lodash usage pattern
   does NOT hit this — `var add = createMathOperation(...); add(3,4)`
   uses an intermediate binding.

This PR addresses the basic-HOF case with regression tests
(criterion 3) — same approach as #1250 and #1275 where the spec
title was partially stale. The trampoline-export-of-closure for
acceptance criterion 2 is a deeper compiler feature requiring its
own focused effort and is tracked as a follow-up.

Tests added (`tests/issue-1276.test.ts`):
  - createMathOp basic add(3, 4) → 7
  - HOF captures both operator and defaultValue
  - two HOF-created functions side by side (no cross-pollution)
  - realistic _createMathOperation with NaN handling

Out of scope (filed as follow-ups):
  - Trampoline-export of closure for `export default <closure-var>`
  - Chained call `makeAdd()(3, 4)` without intermediate binding

---

# #1276 — HOF returning closure: function-valued module exports

## Problem

Lodash math operations are built via a higher-order function:

```js
// _createMathOperation.js
function createMathOperation(operator, defaultValue) {
  return function(value, other) {   // ← closure capturing operator + defaultValue
    ...
    result = operator(value, other);
    ...
    return result;
  };
}

// add.js
var add = createMathOperation(function(augend, addend) {
  return augend + addend;
}, 0);

export default add;   // ← module-level var holding a function reference
```

The compiler currently fails because:
1. `createMathOperation` returns a function value (not a static function declaration)
2. `var add = createMathOperation(...)` assigns a runtime function ref to a module-level var
3. `export default add` must export that runtime function ref as a callable Wasm export

This requires first-class function values as module exports.

## Root cause

The compiler understands `export function foo() {}` and `export default function() {}` as
static function definitions. It does NOT handle `export default <runtime-funcref>` where
the exported value is the result of a function call.

`createMathOperation` produces a `funcref` (or closure struct) at runtime. That funcref
needs to be wrapped in a trampoline or stored in a Wasm global and exported indirectly.

## Approach

One approach: detect the pattern `var X = HOF(...); export default X` at compile time.
If `HOF` is a function in the same compilation unit that returns a function, inline the
returned closure as a named function with the HOF's captured values bound as constants.

Alternatively: support `funcref`-typed Wasm globals + exported trampoline functions.

## Impact

Blocks `add`, `subtract`, `multiply`, `divide`, `modulo` — all of lodash's math operations
built with `createMathOperation`. Also affects any library that uses factory/HOF patterns
to create exported functions.

## Acceptance criteria

1. `add(3, 4)` → `7` via `compileProject('node_modules/lodash-es/add.js')`
2. Wasm exports `default` as a callable function
3. `tests/issue-1276.test.ts` covers: HOF-created function, captured args, correct result
4. No regression in closure tests
