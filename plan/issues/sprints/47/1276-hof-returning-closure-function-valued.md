---
id: 1276
title: "HOF returning closure — function-valued module exports (createMathOperation pattern)"
status: ready
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
