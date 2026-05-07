---
id: 1239
sprint: 50
title: "object literals with GetAccessor/SetAccessor — route to __defineProperty_accessor + force-externref var tagging"
status: ready
needs_architect_spec: true
created: 2026-05-02
updated: 2026-05-07
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: ci-hardening
related: [1234, 1207, 1227]
es_edition: ES5
origin: "Surfaced during #1234. Tech-lead suggested path-2 (object-literal accessor fallback to plain JS host objects). Prototyped on the #1234 branch then reverted because it requires editing additional codegen files beyond #1234's scope."
---
# #1239 — Object literals with `get`/`set` accessors should compile to a JS host object

## Problem

Object literal expressions of the form

```js
var o = {
  get x() { throw new StopErr(); },
  "9007199254740987": "value",
  length: 2 ** 53 - 2,
};
```

currently route through `compileObjectLiteralForStruct` (in
`src/codegen/literals.ts`). The struct emit registers an `i32` (or
similar default-typed) field for each accessor key — completely
dropping the accessor body. At runtime, V8 reads `Get(o, "x")` via
the wasmGC struct's `__sget_x` export and gets the field's default
value (`0` / `null`), never invoking the throw.

This causes:

- `#1234` target test
  `test/built-ins/Array/prototype/unshift/length-near-integer-limit.js`
  to `fail` (instead of pass — V8's native unshift never sees the
  throw, so the loop runs to completion with wrong outputs).
- An unknown number of other test262 tests that use `get`/`set`
  accessor declarations on object literals to enforce specific
  behaviours.

## Implementation plan (path-2 from #1234)

Tech-lead's directive on #1234 was: detect `GetAccessorDeclaration` /
`SetAccessorDeclaration` in `compileObjectLiteralExpression` and route
to a JS-host object via `__new_plain_object` + `__defineProperty_accessor`
+ `__extern_set` for value props.

I prototyped this on the #1234 branch and confirmed the host-side
wiring works: `Object.getOwnPropertyDescriptor(o, "x")` returns the
correct accessor descriptor with `get: <function>`. The blocker is
that subsequent property access on the receiving variable still goes
through the struct-field path because TS's type checker resolves the
var's type to the inferred object literal type.

### Sub-task 1 — `compileObjectLiteralWithAccessors`

Already prototyped (in `src/codegen/literals.ts`):

```ts
if (expr.properties.some((p) =>
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) {
  return compileObjectLiteralWithAccessors(ctx, fctx, expr);
}
```

The new function uses `__new_plain_object`, `__extern_set` for value
properties, `__defineProperty_accessor` for getter/setter pairs, and
`__object_assign` for spreads. `compileArrowAsCallback(getter, { needsThis: true })`
+ `__make_getter_callback` import (gated via `state.getterCallbackFound`)
provides the closure.

This sub-task is well-scoped (one new function, ~150 lines) and the
prototype on the #1234 branch passed type-checking.

### Sub-task 2 — force-externref tag for receiving variables

Add a context field `externrefAccessorVars: Set<string>`. Populate it
in `compileObjectLiteralWithAccessors` when the parent (after
unwrapping ParenthesizedExpression / AsExpression) is a
`VariableDeclaration` with an `Identifier` name.

Then **every** call site that resolves a struct name from an
expression's TypeScript type must consult this set first and bail out
to the externref path when present. The known sites that need
threading:

- `src/codegen/property-access.ts:resolveStructNameForExpr` (already
  has the override hook; works for simple `.length` reads)
- `src/codegen/property-access.ts:745` and `:2571` —
  `resolveStructName(ctx, tsObjType)` direct calls
- `src/codegen/expressions/unary.ts:61, 1213, 1407` — same pattern in
  unary `delete` / `typeof` / etc.
- `src/codegen/expressions/assignment.ts:2125, 2393` —
  `resolveStructName` calls during property assignment lowering
- `src/codegen/expressions/calls.ts:1063, 1706, 2021, 3245, 3546, 5637`
  — six call sites that infer struct name during method dispatch
- `src/codegen/expressions/calls-optional.ts:103` — optional chain
  property access

Each site needs the same `if (ts.isIdentifier(expression) && ctx.externrefAccessorVars.has(expression.text)) return undefined;`
guard. Most are read-only accesses where the bail-out is safe.

### Sub-task 3 — verify the two #1234 CT targets pass

After both sub-tasks:

- `test/built-ins/Array/prototype/unshift/length-near-integer-limit.js`
- `test/built-ins/Array/prototype/reverse/length-exceeding-integer-limit-with-object.js`

Should flip from `fail` (#1234's current outcome — CT noise removed but
getter throw lost) to `pass` (V8's native unshift sees the getter
throw on first read, unwinds correctly).

The forEach 5.3s outlier is independent — uses `compileArrayLikePrototypeCall`
(inline-Wasm codegen path), tracked separately.

### Sub-task 4 — measure broader test262 impact

Likely improves any test262 test that uses `{ get x() { ... } }` /
`{ set x(v) { ... } }` literals. Run baseline diff after sub-task 3
to count newly-passing tests. Likely 5-30 additional passes; report
in the PR.

## Acceptance criteria

1. `compileObjectLiteralExpression` routes accessor-bearing literals to
   the new path
2. `__defineProperty_accessor` is invoked with the correct getter /
   setter callbacks for each `GetAccessorDeclaration` / `SetAccessorDeclaration`
3. The two #1234 CT target tests now `pass` (not just no-CT)
4. No regressions in `tests/equivalence/` or `tests/array-methods.test.ts`
5. Net test262 delta ≥ 0; pass count rises by at least 5

## Out of scope

- Method declarations on object literals (the non-accessor `m()` form)
  — these go through a separate path (`emitObjectMethodAsClosure`).
- Computed-key accessor patterns (`get [computedExpr]()`) where the
  key isn't statically resolvable.
- Sub-task 2's threading effort can be reduced if a single helper
  `resolveEffectiveStructName(ctx, expression, fallbackType)` is
  introduced and replaces all the `resolveStructName(ctx, type)` direct
  calls. That refactor is recommended but not required.

## Related

- #1234 — the issue that surfaced this (path-1 runtime fast path was
  shipped as an interim CT-removal fix)
- #1207 — original `compile_timeout` cluster analysis
- #1227 — pool dispatch-time-timer fix

## Implementation Plan

### Root cause

`compileObjectLiteral` in `src/codegen/literals.ts` always routes to
`compileObjectLiteralForStruct` when the TS checker can resolve a
struct name (lines 240-242, 257-259, 269-271). The struct path emits
`get_<prop>` / `set_<prop>` Wasm functions and registers them in
`ctx.classAccessorSet` (literals.ts:836-911), but those names are
private to the WasmGC struct dispatch path. When V8 walks the object
via the iterator protocol or via `__extern_get_idx` / `Object.keys` /
`Get(o, "x")` (e.g., the `Array.prototype.unshift` length-near-integer
test calls `obj.length` and `Get(obj, "9007199254740987")` through the
externref bridge), it sees a struct field whose stored value is the
i32/f64/externref default — never invoking the getter body.

The fix is two-part:
1. Emit a real JS host object via `__new_plain_object` +
   `__defineProperty_accessor` whenever the literal carries a
   `GetAccessor` / `SetAccessor`.
2. Tag the receiving variable so that **all** subsequent
   `resolveStructName(ctx, type)` lookups against its TS type return
   `undefined`, forcing every read/write through the externref host
   path (which *does* honor the JS accessor).

The reverted prototype on #1234 already proved that step 1 is wired
correctly (host returns the right descriptor); it failed because step
2 wasn't applied uniformly across the ~15 call sites that resolve a
struct name from a TS type.

### Changes

**File: `src/codegen/context/types.ts`** (~line 486, beside
`widenedVarStructMap`)

Add a new field:
```ts
/** Variables initialised by an object literal with get/set accessors —
 *  must be treated as externref everywhere, never as a struct ref.
 *  Populated in compileObjectLiteralWithAccessors; read by
 *  resolveStructNameForExpr and the new resolveEffectiveStructName. */
externrefAccessorVars: Set<string>;
```

Initialize to `new Set()` wherever the context is constructed (search
for `widenedVarStructMap: new Map()` — the same constructor sites need
the new field). One known site in `src/codegen/index.ts` (the
top-level codegen entry); confirm by `grep -n "widenedVarStructMap:
new Map" src/codegen/`.

**File: `src/codegen/literals.ts`** (around line 188-280,
`compileObjectLiteral`)

Add the accessor-detection short-circuit at the very top of
`compileObjectLiteral`, **before** any contextual-type or struct
resolution. This must run before the empty-object special case at
line 196 so plain `{}` is unaffected:

```ts
if (expr.properties.some(
  (p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p),
)) {
  return compileObjectLiteralWithAccessors(ctx, fctx, expr);
}
```

**File: `src/codegen/literals.ts`** — new function
`compileObjectLiteralWithAccessors`. The shape, derived from the
existing `compileObjectLiteralAsExternref` (lines 128-186) plus the
accessor emit pattern from `object-ops.ts:1904-1970`:

```ts
function compileObjectLiteralWithAccessors(
  ctx: CodegenContext, fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  // 1. Tag the receiving variable, if any, BEFORE recursing into
  //    initializers (so that nested literals — e.g. spread sources —
  //    don't accidentally consult a stale tag).
  const parent = unwrapParenAs(expr.parent);
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    ctx.externrefAccessorVars.add(parent.name.text);
  }

  // 2. Create plain object
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [],
    [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  const objLocal = allocLocal(fctx, `__objlit_acc_${fctx.locals.length}`,
    { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // 3. Walk properties IN SOURCE ORDER (JS spec — last write wins for
  //    duplicate keys, accessor pairs are merged).
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // Reuse the __object_assign pattern from compileObjectLiteralAsExternref
      // (lines 144-176). objLocal stays the target.
      emitSpreadInto(ctx, fctx, objLocal, prop);
    } else if (ts.isPropertyAssignment(prop) ||
               ts.isShorthandPropertyAssignment(prop)) {
      // __extern_set(obj, key, value)
      emitExternSet(ctx, fctx, objLocal, prop);
    } else if (ts.isMethodDeclaration(prop)) {
      // Compile method as a callback closure, then __extern_set
      emitMethodAsClosureAndSet(ctx, fctx, objLocal, prop);
    } else if (ts.isGetAccessorDeclaration(prop) ||
               ts.isSetAccessorDeclaration(prop)) {
      // Pair up matching get/set with the same name in a single
      //   __defineProperty_accessor call.
      // Use a local Map<name, {get?, set?}> built in a pre-pass so
      // we emit one call per name even when get and set are split.
      // Skip if this name was already emitted by an earlier pass entry.
    }
  }

  // 4. Emit one __defineProperty_accessor call per accessor pair.
  // For each (name, {get?, set?}):
  //   push objLocal
  //   push name (string literal via compileStringLiteral)
  //   push getter callback or ref.null.extern
  //   push setter callback or ref.null.extern
  //   push f64 flags  (enumerable=true, configurable=true → 0x66 — see
  //     computeRuntimeFlags in object-ops.ts; default writable bits NOT
  //     set for accessor descriptors)
  //   call __defineProperty_accessor; drop result (it returns the obj)
  // Use compileArrowAsCallback(getter, { needsThis: true }) — same as
  // object-ops.ts:1912 — and emit __make_getter_callback (already gated
  // by closures.ts:2497).

  fctx.body.push({ op: "local.get", index: objLocal });
  return { kind: "externref" };
}
```

`unwrapParenAs(node)` is a small helper that strips
`ParenthesizedExpression` and `AsExpression` wrappers — see
`src/codegen/expressions/unary.ts` for an existing implementation; if
none is exported, inline a 5-line walker.

**File: `src/codegen/property-access.ts`** — extend
`resolveStructNameForExpr` (lines 99-113) to consult the new set:

```ts
export function resolveStructNameForExpr(
  ctx: CodegenContext, fctx: FunctionContext, expression: ts.Expression,
): string | undefined {
  // NEW: variables holding accessor-bearing literals are always externref.
  if (ts.isIdentifier(expression) &&
      ctx.externrefAccessorVars.has(expression.text)) {
    return undefined;
  }
  const objType = ctx.checker.getTypeAtLocation(expression);
  let typeName = resolveStructName(ctx, objType);
  // …rest unchanged
}
```

This handles the call sites at `property-access.ts:1667` and any
other `resolveStructNameForExpr` user automatically.

**File: `src/codegen/property-access.ts` (and the other 13 sites)** —
replace bare `resolveStructName(ctx, type)` calls that infer from a
*subject expression* with `resolveStructNameForExpr(ctx, fctx, expr)`
where the expression is available. The known sites (from the issue's
existing list) need the *same* identifier guard threaded in:

| File | Line | Current call |
|------|------|--------------|
| `expressions/unary.ts` | 61 | `resolveStructName(ctx, objType)` |
| `expressions/unary.ts` | 1213 | `resolveStructName(ctx, objType)` |
| `expressions/unary.ts` | 1407 | `resolveStructName(ctx, objType)` |
| `expressions/assignment.ts` | 2146 | `resolveStructName(ctx, objTsType)` |
| `expressions/assignment.ts` | 2414 | `resolveStructName(ctx, objTsType)` |
| `expressions/calls.ts` | 1336 | `resolveStructName(ctx, objType)` |
| `expressions/calls.ts` | 1979 | `resolveStructName(ctx, argTsType)` |
| `expressions/calls.ts` | 2294 | `resolveStructName(ctx, arg0TsType)` |
| `expressions/calls.ts` | 3518 | `resolveStructName(ctx, receiverType)` |
| `expressions/calls.ts` | 3876 | `resolveStructName(ctx, receiverType)` |
| `expressions/calls-optional.ts` | 103 | `resolveStructName(ctx, tsReceiverType)` |
| `property-access.ts` | 737 | `resolveStructName(ctx, tsObjType)` |
| `property-access.ts` | 2590 | `resolveStructName(ctx, objTsType)` |
| `typeof-delete.ts` | 94, 120 | `resolveStructName(ctx, objType)` |
| `object-ops.ts` | 467, 491, 1203, 1224, 1621, 2069 | varies |

**Recommended refactor (strongly preferred, see "Out of scope" #3 in
the original spec):** introduce a single helper

```ts
// property-access.ts, alongside resolveStructNameForExpr
export function resolveEffectiveStructName(
  ctx: CodegenContext, fctx: FunctionContext,
  expression: ts.Expression | undefined, fallbackType: ts.Type,
): string | undefined {
  if (expression && ts.isIdentifier(expression) &&
      ctx.externrefAccessorVars.has(expression.text)) {
    return undefined;
  }
  return resolveStructName(ctx, fallbackType);
}
```

Then replace each of the 16 call sites with
`resolveEffectiveStructName(ctx, fctx, subjectExpr, type)`. This
makes the threading mechanical and trivially reviewable — a single
new test exercises every site at once.

Sites where `expression` is unavailable (e.g., a synthesized type
argument) keep using `resolveStructName` directly — those can't
involve an accessor-tagged variable by construction.

### Wasm IR pattern (one accessor pair)

```wasm
;; var o = { get x() { … }, set x(v) { … } };
call $__new_plain_object              ;; → externref
local.set $obj_local

;; — define the get/set pair —
local.get $obj_local
;; "x" — string literal via compileStringLiteral
…
;; getter: compileArrowAsCallback(getterDecl, { needsThis: true })
;;   emits  i32.const <cbId>  +  struct.new (captures)  +  extern.convert_any
;;          + call $__make_getter_callback
…
;; setter: same pattern
…
;; flags = enumerable_set | enumerable_value | configurable_set | configurable_value
;;        = (1<<4) | (1<<1) | (1<<5) | (1<<2)  — mirrors computeRuntimeFlags
f64.const 0x36
call $__defineProperty_accessor
drop                                   ;; returns the same externref

;; — also emit value/method properties via __extern_set — order matters
local.get $obj_local
```

### Edge cases

1. **`{ a: 1, get x() {…}, b: 2 }`** — value properties must be set in
   source order, interleaved with accessor definitions. Spec §B.3.1
   PropertyDefinitionEvaluation runs in source order; later writes to
   the same key can shadow accessors (don't dedupe between value and
   accessor).
2. **`{ get x() {…}, set x(v) {…} }`** — split get/set on the same
   name must be merged into a single `__defineProperty_accessor` call
   so the descriptor has both `get` and `set` slots populated. The
   pre-pass `Map<name, {get?, set?}>` handles this.
3. **Spread + accessors: `{ ...src, get x() {…} }`** — emit
   `__object_assign(target, [src])` first, then the accessor; defining
   an accessor over a value property correctly replaces it (V8 native
   semantics; runtime-side behavior preserved by JS host).
4. **Computed accessor names: `{ get [k]() {…} }`** — out of scope
   (already in original "Out of scope" list); detect and fall through
   to the existing struct path with a comment, since the struct path
   is already broken for these but no worse than today.
5. **`prop.body` is `undefined`** (interface-style accessor signatures
   without bodies) — should not appear in object literals; assert and
   fall back to `ref.null.extern` for the callback.
6. **`needsArrayDestructure` callers**: an
   `externrefAccessorVars`-tagged var that's later destructured (e.g.
   `var [a] = o`) hits `destructureParamArray` which already handles
   externref correctly via the iter-fallback path.
7. **Re-assignment: `o = { /* no accessors */ }`** — not handled.
   Once tagged in the Set, the var stays externref for its scope. Add
   a comment in the spec — JS allows reassignment, but compile-time
   tagging is conservative and matches the existing `widenedVar`
   pattern. If a reassignment regresses anything, the dev should not
   *untag* but rather widen the tagged path to cover both cases.
8. **Function-parameter use: `function f(o) { return o.x; }` then
   `f({ get x() {…} })`** — out of scope for this fix. The literal
   is rvalue-only (no var to tag); the struct path already fires.
   Existing tests that need this are tracked separately.

### Test files to verify

- `test262/test/built-ins/Array/prototype/unshift/length-near-integer-limit.js`
  (the #1234 driver — flips fail → pass)
- `test262/test/built-ins/Array/prototype/reverse/length-exceeding-integer-limit-with-object.js`
  (companion #1234 test)
- New `tests/issue-1239.test.ts`:
  - `var o = { get x() { return 42 }, set x(v){this._x=v} }; o.x = 1; assert(o.x === 42)`
  - `var o = { _v: 0, get v() { return this._v }, set v(x) { this._v = x*2 } }; o.v = 5; assert(o.v === 10)`
  - `var o = { ...src, get x() { throw new Error() } }; assert.throws(()=>o.x)`
  - Object.getOwnPropertyDescriptor returns {get, set, enumerable:true, configurable:true}

### Risks

- The 16-site threading is the highest-risk part. The
  `resolveEffectiveStructName` refactor reduces it to mechanical
  search-and-replace; without the refactor, missed sites manifest as
  silent struct-path fallthroughs that V8 won't observe but unit
  tests will.
- `compileArrowAsCallback(getter, { needsThis: true })` allocates a
  closure ID and capture struct — running this inside an object
  literal compile may shift function indices via late imports
  (`addUnionImports`). Confirm `flushLateImportShifts(ctx, fctx)` is
  called after each `compileArrowAsCallback` call site to prevent
  index drift in the parent function.
- The runtime import `__defineProperty_accessor` already exists with
  the correct signature `(externref, externref, externref, externref,
  f64) -> externref` (`runtime.ts:2541-2589`) — no runtime changes
  needed.
