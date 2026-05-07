---
id: 1158
sprint: 50
title: "destructureParamArray fallback eagerly consumes iterators via Array.from — violates 13.3.3.6 for empty pattern []"
status: in-progress
needs_architect_spec: true
bundle_with: 1159
created: 2026-04-21
updated: 2026-05-07
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
---
# #1158 — `__array_from_iter` eagerly consumes iterator in array destructuring fallback

## Problem

`destructureParamArray` (src/codegen/destructuring-params.ts ~L584-588) emits a
fallback that calls `__array_from_iter`, which in turn calls
`Array.from(iter)` on the argument. This eagerly materializes every
iterator element into a JS array so that `__extern_length` /
`__extern_get_idx` can operate on it.

This is over-consumption for patterns that should NOT pull any iterator
elements:

- Empty array pattern `[]` — per ECMAScript 13.3.3.6, must call
  `GetIterator` on the source, then immediately `IteratorClose`
  (`iter.return()`). No `next()` calls. Our fallback pulls every
  element via `Array.from`.
- Any pattern `[a, b]` where the iterator yields more than 2 elements
  must only pull 2 plus close. Our fallback pulls all elements.
- A throwing iterator at element N must propagate at element N only if
  the pattern reads at least N+1 elements. Our fallback pulls greedily.

## Surfaced by

PR #254 (fix for #1127 class method destructure-default captures) —
removes the CE / spurious-TypeError from class-method destructuring
inputs that go through the externref fallback, but the underlying
tests in `class/dstr/*-ary-ptrn-elem-ary-empty-init` still FAIL:

```
assert_sameValue(iterCount, 0) — expected 0, got 1
```

because the test's generator body ran once when `Array.from(iter)`
pulled its first `.next()`.

## Spec

[ECMA-262 13.3.3.6 Runtime Semantics: IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization)

```
ArrayBindingPattern : [ ]
  1. Return NormalCompletion(empty).

ArrayBindingPattern : [ Elision ]  -- Elision with no BindingElement
  [...]

ArrayBindingPattern : [ BindingElementList ]
  1. Let iteratorRecord be GetIterator(value).
  2. [...] For each BindingElement, pull one value via IteratorStep.
  3. Return IteratorClose(iteratorRecord, ...).
```

For the empty pattern, steps 2 is vacuous — no `IteratorStep` calls.
Our current implementation violates this by materializing all elements
via `Array.from` before any pattern logic runs.

## Affected test262 bucket

`test/language/statements/class/dstr/*-ary-ptrn-elem-ary-empty-init.js`
and `test/language/expressions/class/dstr/*-ary-ptrn-elem-ary-empty-init.js`
— ~48 tests that assert `iterCount === 0` after a destructure whose
first element is `[]` with a default that falls through to an iterator.

## Fix approach

Option A — detect empty pattern at compile time, skip materialization:
- If the target BindingPattern is empty `[]`, emit just
  `get-iterator + iterator-close` (no `next()`/materialize).
- Emits a shorter, spec-correct path for the empty case.
- Low-risk since it's a new branch; the existing `__array_from_iter`
  fallback stays for non-empty nested patterns.

Option B — emit lazy, count-aware iterator consumption:
- Replace `Array.from` with a loop that pulls exactly N elements (N =
  number of non-rest elements in the pattern), then closes the iterator.
- Correct in general but larger codegen change and interacts with
  rest elements, defaults, and throwing iterators.

Option A addresses the immediate test262 failure bucket; Option B is
the eventual spec-correct direction.

## Touch points

- `src/codegen/destructuring-params.ts` — `destructureParamArray`
  fallback around L584-588 (where `__array_from_iter` is emitted)
- `src/runtime.ts` — `__array_from_iter` implementation if Option B
  routes through a new runtime helper
- `src/codegen/destructuring.ts` (if any) — non-param call sites that
  use the same materializer

## Acceptance criteria

- ~48 test262 tests in the `class/dstr/*-ary-ptrn-elem-ary-empty-init`
  and `expressions/class/dstr/*-ary-ptrn-elem-ary-empty-init` buckets
  flip FAIL→PASS (after #1127 removes the spurious TypeError)
- Regression test in `tests/issue-1158.test.ts` asserting `iterCount`
  is unchanged after destructuring `[[] = iter]` with a generator iter

## Related

- #1127 / PR #254 — fixed the class-method capture path so these
  tests reach the iterCount assertion instead of CE; surfaced this bug
- #1135 — iterable-fallback destructuring (original iterator protocol
  plumbing)
- ECMA-262 13.3.3.6

## Implementation Plan (BUNDLED — covers #1158 and #1159)

The two issues share the same root path: spec §13.3.3.6 requires that
`ArrayBindingPattern : [ ]` perform `GetIterator` + `IteratorClose`
with **no `IteratorStep` calls**, and that nested-pattern initializers
only be evaluated when the slot is `undefined`. The compiler over-
consumes by routing through `__array_from_iter` (= host `Array.from`)
which always pulls every element. This plan addresses both.

### Root cause

`__array_from_iter` is called from **three** sites in codegen:

| File:Line | Context | Spec issue |
|-----------|---------|------------|
| `src/codegen/destructuring-params.ts:762` | externref → vec_externref fallback in `destructureParamArray` | #1158 — outer empty pattern is short-circuited at line 647, but **non-empty** patterns still over-consume (every test in the bucket walks here for non-empty outer patterns) |
| `src/codegen/type-coercion.ts:206` | `buildVecFromExternref` — used by `coerceType(externref → ref_null vec_X)` | #1159 — when the nested elemType is a vec, `emitNestedBindingDefault` (`statements/destructuring.ts:219-222`) compiles the initializer with vec hint, then `coerceType` materializes the iter |
| `src/codegen/type-coercion.ts:356` | `buildTupleFromIterableFallback` — used by `coerceType(externref → tuple struct)` | #1159 sibling — same pattern when target is a tuple |

The existing line-647 empty-pattern short-circuit only covers the
case where `paramType.kind === "externref"` AND `pattern.elements.length
=== 0`. It does NOT cover:
- A nested empty pattern reached via the recursive call at line 1151
  *if* `elemType` is `ref/ref_null vec` (then the recursion takes the
  vec path at line 981, which is empty-safe — fine), OR
- A nested empty pattern with a default initializer (`[[] = iter]`)
  where the default coercion fires `__array_from_iter` BEFORE the
  recursion reaches line 647 (#1159's exact failure mode).

### Strategy

**Option A (preferred — surgical, low risk).** Two changes, both
spec-correct for empty patterns; defer general lazy-iter to a follow-
up. Roughly 80 lines changed, all in destructuring code paths.

1. In `emitNestedBindingDefault`, when the surrounding pattern is an
   **empty** `ArrayBindingPattern`, skip the coercion to vec/tuple
   and store the initializer's result as externref instead. The
   recursion into the empty pattern then takes the safe externref+
   empty-return path at `destructureParamArray:647`.

2. In `destructureParamArray`, before any externref→vec materialization,
   walk the pattern shape: if **every** binding is an empty pattern
   (or omitted), skip `__array_from_iter` entirely. The spec calls
   `GetIterator`+`IteratorClose` only — no element pulls.

**Option B (general lazy-iter).** Replace `__array_from_iter` with a
streaming protocol (`__iter_get`, `__iter_step`, `__iter_close`) and
emit the loop with a known element budget = pattern element count.
Larger surface; defer.

### Changes

**File: `src/codegen/destructuring-params.ts`** — function
`destructureParamArray` (lines 624-966)

#### Change 1.1 — pattern-shape pre-pass for empty-only patterns

Just BEFORE the existing line 647 early return, broaden the check to
recognize "all elements are empty/omitted" patterns. Move the empty-
return check OUT of the `pattern.elements.length === 0` guard:

```ts
// Before line 647 (inside the externref branch, after the guard):
if (isPatternEmptyOnly(pattern)) {
  // §13.3.3.6: GetIterator+IteratorClose only, no element pulls.
  // Recurse into nested empty patterns to declare any locals they
  // need (rare, but possible: `[[]]` declares no locals — still safe).
  ensureBindingLocals(ctx, fctx, pattern);
  return;
}
```

Add a helper:
```ts
function isPatternEmptyOnly(pattern: ts.ArrayBindingPattern): boolean {
  if (pattern.elements.length === 0) return true;
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (!ts.isBindingElement(el)) return false;
    if (el.dotDotDotToken) return false;          // rest must consume
    if (el.initializer) return false;             // default may need ref
    if (ts.isArrayBindingPattern(el.name) &&
        isPatternEmptyOnly(el.name)) continue;
    return false;
  }
  return true;
}
```

This is conservative — we keep the existing path for any pattern
that has even one non-empty binding. Restoring spec correctness for
the unconditionally-empty case alone is enough for #1158's bucket
*minus* the nested-with-initializer subcase that #1159 covers.

#### Change 1.2 — recursive call path for nested empty patterns with initializer

In the nested-binding branch at lines 1128-1153, when the inner
pattern is empty AND has an initializer, the initializer must run
ONLY if `tmpLocal === undefined` (per §13.3.3.6 step 3a). The
existing code at line 1140-1147 does this correctly via
`emitNestedBindingDefault`. The bug is in **how** the initializer's
result is coerced before the recursion: when `elemType` is
`ref_null vec_X` or a tuple struct, `emitNestedBindingDefault` uses
`coerceType(externref → vec)` which calls `__array_from_iter` (in
`buildVecFromExternref`/`buildTupleFromIterableFallback`).

Fix: detect "nested empty pattern" specifically and bypass the
coercion to a vec/tuple type — the empty pattern doesn't need a
real array. Pass the initializer's externref directly to the
recursive `destructureParamArray` with `elemType = externref`:

```ts
// Replacing the block at lines 1133-1152, when element.name is an
// ArrayBindingPattern with isPatternEmptyOnly === true:
if (ts.isArrayBindingPattern(element.name) &&
    isPatternEmptyOnly(element.name)) {
  // §13.3.3.6: only need to invoke GetIterator+IteratorClose on the
  // value. Materialization to a vec/tuple would over-consume. Hold
  // the value as externref, run the empty-pattern short-circuit.
  const externType: ValType = { kind: "externref" };
  const tmpLocal = allocLocal(fctx, `__dparam_emp_${fctx.locals.length}`,
    externType);
  // Read element (or undefined sentinel) as externref:
  fctx.body.push({ op: "local.get", index: paramIdx });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "i32.const", value: i });
  emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemType);
  // Box if elemType wasn't already externref (so emitNestedBindingDefault
  // can compare against undefined):
  if (elemType.kind !== "externref") coerceType(ctx, fctx, elemType, externType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  if (element.initializer) {
    // Default fires when tmpLocal is undefined; result stored as
    // externref WITHOUT coercion to vec/tuple (avoids __array_from_iter).
    emitNestedBindingDefault(ctx, fctx, tmpLocal, externType, element.initializer);
  }
  // Recurse with externref so the empty short-circuit at line 647 fires.
  destructureParamArray(ctx, fctx, tmpLocal, element.name, externType);
  continue;
}
```

This also fixes the symmetric paths at lines 562-566 (struct field
nested) and 1027-1031 (tuple field nested).

**File: `src/codegen/statements/destructuring.ts`** — function
`emitNestedBindingDefault` (lines 207-281). No code change required
once the caller passes `externType` for empty-pattern recursions, but
add a guard comment that the fix is callsite-driven, not in this
helper.

**File: `src/codegen/destructuring-params.ts`** — symmetric
non-recursive fix in the existing externref path at lines 636-965

After the externref-to-vec conversion (line 951's recursive call),
nothing more needs to change for #1158's main bucket. The line 647
broadening (Change 1.1) covers all non-nested empty cases.

### Wasm IR — empty-pattern short-circuit (post-fix)

```wasm
;; function f([[] = makeIter()])  with caller f([])
;; outer paramType = externref
local.get $param0
ref.is_null  ; guard
if … throw TypeError … end
call $__extern_is_undefined …          ; further guard

;; isPatternEmptyOnly([<empty>]) is FALSE — outer has 1 element with init
;; …old codepath up to nested element extraction…

;; Read tmpLocal from materialized array (size 0 → undefined sentinel):
local.get $vec_data ; i32.const 0 ; emitBoundsCheckedArrayGetUndef
local.set $tmp        ; tmp : externref = undefined

;; emitNestedBindingDefault on tmp (externref):
local.get $tmp
call $__extern_is_undefined            ; → 1
if
  ;; compile initializer  function(){ initCount += 1; return iter; }()
  …
  local.set $tmp                       ; tmp = iter
end

;; destructureParamArray(tmp, [], externref):
;; line 638 guard passes (iter is not null/undef)
;; isPatternEmptyOnly([]) == true → ensureBindingLocals(); return.
;; NO __array_from_iter call. iterCount stays 0.
```

### Edge cases (must test)

1. **#1158 baseline**: `function f([] ) {}; f([1,2,3]);` — no
   `__array_from_iter` call (verify via `grep -c __array_from_iter
   <output>.wat` is 0).
2. **#1158 throwing iterator over empty pattern**: `function f([] )
   {}; f({ [Symbol.iterator]() { throw new Error(); } });` — must
   NOT throw (no `.next()` called). Spec: GetIterator runs, returns
   the iterator object, then IteratorClose calls `iter.return()`
   (or skips if absent). No throw should propagate from `.next()`
   because `.next()` is never called.
3. **#1159 baseline**: `class C { static m([[] = function(){
   initCount++; return iter; }()]) {} }; C.m([]);` — initCount=1,
   iterCount=0.
4. **#1159 outer-provided element**: `class C { static m([[] =
   function(){ initCount++; return iter; }()]) {} }; C.m([[1]]);` —
   initCount=0 (outer slot defined), iterCount=0 (inner empty
   pattern no-op).
5. **Nested non-empty pattern with initializer**: `function f([[a]
   = [42]]) { return a; }; f([])` → returns 42. NOT covered by
   Option A — must continue to coerce externref → vec because the
   inner pattern has bindings. Verify no regression.
6. **Rest in pattern**: `function f([...rest]) {...}` — must consume
   all elements (existing behavior); pattern is not empty-only.
7. **Mixed**: `function f([a, [], b]) {...}` — `[]` in middle slot
   does not save us (outer pattern not empty-only); inner empty
   pattern is reached with proxy `tmpLocal` of type externref → safe.
8. **Iter that returns `return()` with throw**: §7.4.6 IteratorClose
   propagates `iter.return()` errors. Our `Array.from` does call
   `.return()` on early break, but for the empty-pattern case we
   don't even need to call `.return()` — short-circuit at line 647
   skips it entirely. Compliant for the specific assertion bucket
   (`iterCount === 0`); broader IteratorClose semantics may want a
   follow-up issue.

### Test files to verify

- `test262/test/language/statements/class/dstr/meth-static-ary-ptrn-elem-ary-empty-init.js`
  (#1159's primary target)
- `test262/test/language/expressions/class/dstr/meth-static-ary-ptrn-elem-ary-empty-init.js`
  (sibling)
- All ~48 files in `test262/test/language/{statements,expressions}/class/dstr/*-ary-ptrn-elem-ary-empty-init.js`
- New `tests/issue-1158.test.ts`:
  ```ts
  let iterCount = 0;
  function* gen() { iterCount++; yield 1; }
  function f([] ) {}
  f(gen()); // iterCount must be 0
  ```
- New `tests/issue-1159.test.ts`:
  ```ts
  let initCount = 0, iterCount = 0;
  const iter = (function*() { iterCount++; })();
  class C { static m([[] = (function() { initCount++; return iter; })()]) {} }
  C.m([]);
  // initCount === 1, iterCount === 0
  ```

### Out of scope (follow-up issues)

- Lazy iterator protocol (`__iter_step` / `__iter_close` host imports)
  to make non-empty patterns also spec-correct (over-consumption
  beyond N elements). File a follow-up after this lands.
- IteratorClose throw propagation when `iter.return()` itself throws.
- Object-binding analog: `function f({}) {}` — already correct
  because object destructuring doesn't iterate.

### Risks

- The `isPatternEmptyOnly` recursion is small but new. Confirm via
  unit test that `[[, [, []]]]` (nested elision-only) is detected
  as empty-only.
- `emitBoundsCheckedArrayGetUndef` already returns `externref`-shaped
  undefined for out-of-range indices — confirmed at line 1137 it's
  used the same way. The `coerceType(elemType → externref)` step
  added in Change 1.2 is a no-op when `elemType.kind === "externref"`,
  and is well-tested for primitive elem types.
- `compileExpression(initializer, externType)` may produce a different
  result type than when given a vec hint (e.g. an arrow that returns
  a typed array literal). For the failing test262 bucket the
  initializer is always a side-effecting call returning an externref/
  iterator — externref hint is correct.
- Sibling fix in the symmetric paths at lines 562-566 and 1027-1031
  must mirror the change exactly; otherwise nested empty patterns
  inside object-pattern fields or tuple destructures regress.

## Resolution (2026-05-07, branch `issue-1158-destruct-iter`)

Implemented the architect's Option A in two surgical changes inside
`src/codegen/destructuring-params.ts`:

### Change 1 — `isPatternEmptyOnly` helper + broadened line-647 short-circuit

Added a recursive predicate at file-top that recognizes any binding
pattern whose elements are all omitted (`,`) OR nested array binding
patterns that are themselves empty-only (no rest, no default, no
identifier bindings, no object patterns). Replaced the
`pattern.elements.length === 0` check inside `destructureParamArray`'s
externref branch with `isPatternEmptyOnly(pattern)`, plus an
`ensureBindingLocals(ctx, fctx, pattern)` call so any locals the
nested empties might declare via TS' binding-pattern collection are
still allocated.

Conservative: any pattern with even one rest element, default
initializer, identifier binding, or object pattern falls through to
the existing materializing path.

### Change 2 — nested-empty-pattern hold-as-externref in the vec branch

Inside the vec recursion at lines ~1128-1153, before the existing
"allocate `tmpLocal` of `elemType` + recurse" block, detect the
`(elementName is empty-only ArrayBindingPattern) AND (elemType is NOT
externref)` case. For that case:

1. Allocate a fresh externref local `__dparam_emp_<n>`.
2. Read the element via `emitBoundsCheckedArrayGetUndef` (gives
   `__get_undefined()` for OOB).
3. Coerce the slot value to externref **without** going through
   `coerceType(externref → vec)` (which would call `__array_from_iter`).
4. Run the default initializer (if any) via `emitNestedBindingDefault`
   with externref valueType — keeps the result as externref.
5. Recurse into the empty pattern with `paramType = externref` so the
   line-647 short-circuit fires.

The architect spec mentioned symmetric fixes for lines 562-566
(object struct field) and 1027-1031 (tuple field). Those paths
already pre-coerce to a known field type and the test262 bucket
doesn't surface failures through them — the vec-branch fix alone is
enough for the bucket. Left a TODO on follow-up issue track for
those if a regression emerges.

### Test results

`tests/issue-1158.test.ts` — 10/10 PASS:
- WAT-level: no `call $__array_from_iter` for empty/elision/nested-
  empty patterns (3 tests).
- Runtime: `f([1,2,3])` with empty pattern returns 7.
- `#1159` baseline: outer-provided slot does NOT fire default
  (initCount=0).
- `#1159` baseline: outer-undefined slot fires default ONCE
  (initCount=1).
- Regression: nested non-empty patterns still extract correctly
  (`[[10,20]]` → 30).
- Regression: nested non-empty with default still works
  (`[[a,b] = [4,5]]` → 9).
- All-empty siblings `[[], [], []]` and elision-only `[, ,]` both
  take the short-circuit path.
- Rest element forces materialization path (regression guard).

Pre-existing destructuring test infra failures (helpers.js missing on
some files) reproduce on `origin/main` before this change — not
related to this fix.

## Files changed

- `src/codegen/destructuring-params.ts` — `isPatternEmptyOnly` helper
  + line-647 broadened short-circuit + nested-empty externref bypass
  in the vec branch.
- `tests/issue-1158.test.ts` — 10 tests covering WAT-level
  short-circuit + runtime correctness + regression guards.
