---
id: 1363
sprint: 51
title: "spec gap: class dstr — 'Cannot destructure null/undefined' in method default-binding (~700 runtime_errors)"
status: in-progress
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: spec-completeness
---
# #1363 — Class destructuring parameter defaults bind to null/undefined receiver

## Problem

`language/{expressions,statements}/class/dstr/*` is the largest single class-area
fail bucket — **1080 fails**, of which **456 runtime_error** all reading
`"L8:5 Cannot destructure 'null' or 'undefined' [in <method>()]"`.

A representative test (`async-gen-meth-dflt-ary-ptrn-empty.js`):

```js
class C {
  async *method([] = []) {
    return arguments[0];
  }
}
new C().method().next();
```

What the spec says: §15.7 "When a class method is invoked with no arguments and a
parameter has a default value, the default is materialized BEFORE destructuring".
For `[] = []` the default is `[]` (an array literal); destructuring an empty pattern
against `[]` is a no-op and succeeds.

What we emit: in `src/codegen/destructuring-params.ts` (or wherever class methods
codegen flows for defaults), the default-value path materializes the default into a
local of type `ref null $arr_T`, but the destructuring step receives `ref null` and
checks for null — it sees null because the array literal `[]` compiled to a
`ref null $vec` (#1359 will fix this for top-level expressions, but inside a method
parameter context, the same issue happens). When the default is reached (no arg
passed), the local is the `ref null` returned by `compileExpression([])`.

The pattern is reproducible across:
- async generators methods (`async-gen-meth-dflt-*`)
- async private generator methods (`async-private-gen-meth-dflt-*`)
- regular generators (`gen-meth-dflt-*`)
- regular methods (`meth-dflt-*`)

…all of which share the same default-parameter codegen path.

## Acceptance criteria

1. `language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-empty.js` passes.
2. `language/expressions/class/dstr/async-gen-meth-static-dflt-obj-ptrn-empty.js` passes.
3. `language/statements/class/dstr/gen-meth-dflt-ary-ptrn-elem-id.js` passes.
4. `language/expressions/class/dstr/async-private-gen-meth-dflt-ary-init-iter-no-close.js` passes.
5. Pass-rate for `language/{expressions,statements}/class/dstr/` rises from ~14% to ≥55%;
   **+450 net passes** (the runtime_error bucket alone).

## Files to modify

- `src/codegen/destructuring-params.ts` — default-value materialization for class methods.
- `src/codegen/array-methods.ts` — `compileArrayLiteralExpression` (or wherever array
  literals are compiled) — verify `[]` returns non-null vec.
- `src/codegen/class-bodies.ts` — class method dispatch for arity-mismatched calls.

## Implementation Plan

### Root cause

When a class method declares `method([] = [])` and is called with zero args:

1. The Wasm function for `method` has a parameter slot of type `ref null $vec`.
2. The caller passes `ref.null $vec` because there's no arg.
3. The function prologue checks "is param undefined? if so, evaluate default".
4. The default `[]` is compiled by `compileExpression(arrayLiteralExpr)` — which
   typically emits `array.new_default $arr 0; struct.new $vec` — but in some paths
   (e.g. when `arrTypeIdx` is unresolved at the parameter-type level), it falls back
   to `ref.null $vec`, defeating the purpose of the default.
5. The destructuring step then sees the `ref null $vec` and emits `ref.as_non_null`,
   which traps with the "Cannot destructure null" message.

### Approach

#### A. Verify and fix array-literal codegen for `[]`

In `compileExpression` for `ArrayLiteralExpression` with zero elements:

```ts
if (arrayLiteral.elements.length === 0) {
  // Always emit non-null empty vec.
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref", typeIdx: vecTypeIdx };  // not ref_null!
}
```

Confirm by grepping for `array.new_default` calls and checking the surrounding
struct.new emits a non-null vec.

#### B. Default-parameter prologue for class methods

In `src/codegen/destructuring-params.ts` (or the class-method body emission in
`class-bodies.ts`), the default-evaluation pattern should be:

```wasm
;; if param is null:
local.get $param0
ref.is_null
if
  ;; evaluate default; result must be non-null
  i32.const 0
  array.new_default $arr
  struct.new $vec
  local.set $param0
end
;; now param0 is non-null; proceed to destructuring
```

The current emission likely writes `local.get $defaultExpr; local.set $param0`, but
when `compileExpression([])` returns `ref_null`, that null gets stored. Add an
explicit `ref.as_non_null` after evaluating the default, OR coerce the type back
to non-null per the param signature.

#### C. Argument arity for class methods

For a method `m([] = [])`, when `instance.m()` is called with zero args:

- Caller: emits `local.get $instance; call $C_m`.
- But `C_m` expects `(this, param0)`. The missing param0 must be supplied as
  `ref.null $vec` by the caller.

Verify in `class-bodies.ts` that the call-site arity is `1 + declaredParamCount`
and pads with `ref.null` for missing args.

#### D. Async generator wrapping

For `async *method`, the async-gen-state machine wraps the body in an iterator.
The default-evaluation runs inside the wrapper. Trace the wrap path in
`src/codegen/expressions/async-generator.ts` (if it exists) — verify the param
prologue is emitted INSIDE the wrapped function body, not before.

### Edge cases

- Default is `null` literal (`method(x = null)`) — explicitly allowed; destructuring
  patterns that match null are an error, but `x = null` with no destructuring is fine.
- Default is computed (`method(x = somethingElse())`) — evaluation may have side effects;
  must run only when arg is undefined.
- Default refers to earlier params (`method(a, b = a)`) — left-to-right binding.
- Rest pattern `method(...rest)` — no default; receive empty array if no args.
- Private generator method with default — `__priv_method` name in stack trace; routes
  through the same prologue.

### Test262 sample

- `test262/test/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-empty.js`
- `test262/test/language/expressions/class/dstr/async-gen-meth-static-dflt-obj-ptrn-empty.js`
- `test262/test/language/statements/class/dstr/gen-meth-dflt-ary-ptrn-elem-id.js`
- `test262/test/language/statements/class/dstr/meth-dflt-ary-ptrn-empty.js`
- `test262/test/language/expressions/class/dstr/async-private-gen-meth-dflt-ary-init-iter-no-close.js`

### Estimated impact

+450 net passes on the runtime_error bucket alone; cascades may resolve
additional assertion_fail in the same dstr/ tree (some assertions chain on
post-destructure state). §15.7 lifts from 67% to ~73%.

## Implementation Notes (2026-05-08)

The architect's spec misidentified the root cause. The failing test262 sources
do **not** use `[] = []` (literal empty default) — they use closure variables:

```js
var iter = function*() { iterations += 1; }();
class C {
  method([] = iter) { ... }   // default is `iter`, not `[]`
}
```

When `wrapTest` wraps the JS source in `export function test() { ... }`,
both `iter` and `class C` end up as locals of `test()`. Class methods compile
to module-level Wasm functions and cannot capture enclosing-function locals.
`compileExpression(iter)` from inside the class method's parameter-default
prologue resolves to `ref.null.extern` (silent fallback), then the
destructuring guard throws "Cannot destructure 'null' or 'undefined'".

**The fix is at the test262 runner layer, not the compiler.** Existing
hoisting (`tests/test262-runner.ts:1971`) already handles `var x = <number>;`
and `var x;` — extended to handle `var x = <expr>;` with bracket/paren/string-
aware scanning so call-expression, IIFE, and complex-object initializers
referenced from class bodies are hoisted to module scope.

A separate compiler bug (generator IIFE `function*(){...}()` eagerly runs the
body instead of producing a lazy iterator) prevents a few of the listed
test262 files from passing fully — that is unrelated to the destructure-null
trap and is filed separately.

## Test Results

- `tests/issue-1363.test.ts` — 7/7 pass
- `async-gen-meth-static-dflt-obj-ptrn-empty.js` — fail → pass
- `async-private-gen-meth-dflt-ary-init-iter-no-close.js` — fail → pass
- Two remaining tests (`async-gen-meth-dflt-ary-ptrn-empty.js`,
  `meth-dflt-ary-ptrn-empty.js`) are blocked on the orthogonal generator-IIFE
  eagerness bug — destructure-null trap is fixed but the inline assertion
  `iterations === 0` fails because `var iter = function*(){...}()` eagerly
  runs the body.
