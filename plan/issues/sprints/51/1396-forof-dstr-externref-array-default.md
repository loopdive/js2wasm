---
id: 1396
sprint: 51
title: "for-of/dstr + assignment/dstr default initializers don't fire on OOB extenref-array reads"
status: ready
created: 2026-05-09
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, iteration
goal: spec-completeness
---
# #1396 — Destructuring defaults skipped for OOB extern-array reads

## Problem

Destructuring with default initializers (`[x = 23]` / `[a, b = 99]`) does
not fire the default for out-of-bounds reads when the source is an
`any[]`/extern-typed array. The default fires correctly for typed
`number[]` arrays.

Affects ~320 test262 fails in `language/statements/for-of/dstr/` (the
canonical bucket triaged for task #50) and is the same root cause for
~171 additional `language/expressions/assignment/dstr/` fails.

Sample failing test pattern (sourced from
`var-ary-ptrn-elem-id-init-exhausted.js`):

```js
var iterCount = 0;
for (var [x = 23] of [[]]) {
  assert.sameValue(x, 23);   // FAILS — x is null/0, not 23
  iterCount += 1;
}
assert.sameValue(iterCount, 1);
```

Direct-destructuring reproducer (no for-of involved):

```ts
const arr: any[] = [];
const [x = 23] = arr;   // x ends up `0` (the f64 default), not `23`
```

## Root cause

`emitBoundsCheckedArrayGet`
(`src/codegen/array-methods.ts:180`) emits a Wasm `if` that pushes
`defaultValueInstrs(elementType)` on the OOB else branch. For
externref arrays this is `ref.null.extern` — i.e. **JS `null`**.

The destructuring-default check
(`emitExternrefDefaultCheck`,
`src/codegen/statements/destructuring.ts:185`) then routes through the
`__extern_is_undefined` host import, which is implemented as
`(v) => v === undefined ? 1 : 0` (`src/runtime.ts:2343`). Per spec
§13.7.5.5, destructuring defaults fire **only** when the value is
`undefined`, not when it is `null`. The runtime helper is correct;
however, the OOB sentinel emitted by `emitBoundsCheckedArrayGet` should
represent the spec's "absent" state (JS `undefined`), not a JS `null`
value.

A targeted reproducer compiles to (relevant slice from generated WAT):

```wasm
i32.const 0
local.get $boundsArr  ;; data array, len=0
array.len             ;; -> 0
i32.lt_u              ;; idx < len? -> 0 (false)
(if (result externref)
  (then
    local.get $boundsArr
    i32.const 0
    array.get 0
  )
  (else
    ref.null extern   ;; <-- BUG: should be JS undefined, not JS null
  )
)
local.tee $tmp
call $__extern_is_undefined  ;; null != undefined → returns 0
(if
  (then  ;; default branch: x = 23
    f64.const 23
    call $__box_number
    local.set $x
  )
  (else  ;; existing-value branch: x = null
    local.get $tmp
    local.set $x
  )
)
```

The `__extern_is_undefined` returns 0 for the `ref.null.extern` sentinel
and the default branch never fires.

## Acceptance criteria

1. `const [x = 23]: any[] = []` produces `x === 23`.
2. `for (const [x = 23] of [[]] as any[][]) { ... }` produces `x === 23`
   and runs the body once.
3. `for (const [a, b = 99] of [[1]] as any[][]) { ... }` produces
   `a === 1` and `b === 99`.
4. Object destructuring on missing keys still triggers defaults
   (`const {a = 1}: {a?: number} = {}` → `a === 1`).
5. `null` values continue to bypass defaults
   (`const [x = 23] = [null]` → `x === null`, NOT 23) — spec §13.7.5.5.
6. No regression in existing array-methods tests that depend on the
   current `defaultValueInstrs(externref) === ref.null.extern` shape.

## Implementation plan

Two code paths to fix:

### Path A — `emitBoundsCheckedArrayGet` (most general)

Add an optional `ctx` parameter; when present AND `elementType` is
`externref`/`ref_extern`, emit a `call $__get_undefined` for the OOB
else-branch instead of `ref.null.extern`. `ensureGetUndefined` already
exists in `src/codegen/expressions/late-imports.ts:173`.

```ts
export function emitBoundsCheckedArrayGet(
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  ctx?: CodegenContext,
): void {
  // ... existing setup ...
  let elseInstrs: Instr[];
  if (ctx && (elementType.kind === "externref" || elementType.kind === "ref_extern")) {
    const undefIdx = ensureGetUndefined(ctx);
    elseInstrs = undefIdx !== undefined
      ? [{ op: "call", funcIdx: undefIdx } as Instr]
      : defaultValueInstrs(elementType);
  } else {
    elseInstrs = defaultValueInstrs(elementType);
  }
  // ... rest unchanged ...
}
```

Then update the four call sites in `src/codegen/statements/loops.ts`
(for-of array destructuring at lines ~1017, ~1090) and
`src/codegen/statements/destructuring.ts` (plain array destructuring +
externref-array path) to pass `ctx`.

Other call sites (`array-methods.ts` non-destructuring uses) leave
`ctx` undefined and keep current behavior.

### Path B (alternative) — runtime fix

Change `__extern_is_undefined` to also return 1 for `null`. Spec-wrong
but matches the failing pattern. **Not recommended** — would break
spec compliance for `[x = 23] = [null]`.

### Path A is preferred

It targets the OOB sentinel at the source, leaves runtime
spec-compliant, and doesn't change behavior for non-OOB null-valued
elements.

## Test plan

Tests to add in `tests/issue-1396.test.ts`:
- `const [x = 23]: any[] = []` → `x === 23`
- `const arr: any[] = []; const [x = 23] = arr` → `x === 23`
- `for (const [x = 23] of [[]] as any[][])` → `x === 23`, iterates once
- `for (const [a, b = 99] of [[1]] as any[][])` → `a === 1, b === 99`
- Regression: `const [x = 23] = [null] as any[]` → `x === null` (spec)
- Regression: `const [x = 23] = [42] as any[]` → `x === 42`

Then re-run for-of/dstr cluster: target +200 to +320 passes.

## Files to modify

- `src/codegen/array-methods.ts` (line ~180) — add optional `ctx` parameter
- `src/codegen/statements/loops.ts` (lines ~1017, ~1090) — pass `ctx`
- `src/codegen/statements/destructuring.ts` (any direct call sites for
  `emitBoundsCheckedArrayGet` in destructuring paths) — pass `ctx`

## Estimated impact

- ~320 fails in `language/statements/for-of/dstr/` (task #50)
- ~171 fails in `language/expressions/assignment/dstr/` (related cluster)
- Possibly more in `for-await-of/dstr` (~similar pattern)

Combined: 400-500 net test262 passes if all extern-array OOB cases
share this root cause.
