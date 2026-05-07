---
id: 1298
sprint: 50
title: "Calling a function-typed value stored in a field/array/Map drops the call and returns null"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures, functions, classes, maps
goal: npm-library-support
related: [1297]
---
# #1298 — Function-typed fields/array elements/Map values null-deref on call

## Summary

When a function reference is stored in any indexed container (struct
field, vec element, `Map<K, Fn>` value), retrieving it and calling it
silently emits a `drop ; ref.null extern` instead of `call_ref` /
`call_indirect`. The result of the "call" is always `null`.

## Repro

```typescript
class Holder {
  fn: ((s: string) => string) | null = null;
  call(s: string): string {
    if (this.fn == null) return "no";
    return this.fn!(s);
  }
}

export function test(): string {
  const h = new Holder();
  h.fn = (s: string) => s + "!";
  return h.call("hi");           // returns null, expected "hi!"
}
```

Same pattern fails for `Fn[]` (`fns[0]("hi")`) and
`Map<string, Fn>` (`map.get("k")("hi")`).

A function passed as a *parameter* and called inside the receiving
function works correctly — only stored-then-called fails.

## Root cause (from WAT inspection)

The compiler creates a `__fn_wrap_N_struct (sub final (struct (field $func funcref)))`
when the function is assigned to the field — wrapping the funcref in a
struct + boxing as externref. The set side correctly emits:

```
ref.func 5
struct.new 7      ; __fn_wrap_1_struct
extern.convert_any
struct.set 2 1    ; Holder.fn
```

But the call side does NOT unbox + dispatch:

```
local.get 4
struct.get 2 1    ; load externref
drop              ; <-- WRONG: should ref.cast back to __fn_wrap struct,
                  ;     load $func field, call_ref with env+args
ref.null extern   ; <-- WRONG: should be the call_ref result
return
```

The call-site compiler doesn't recognize that the loaded externref is a
boxed function that needs unwrapping before invocation.

## Where to fix

- `src/codegen/expressions/calls.ts` — `compileCallExpression` (or whichever
  function compiles `expr(args)` where `expr` is a property access /
  array index / Map.get).
- The call site needs to detect that the callee value is an externref
  carrying a `__fn_wrap_N_struct` and emit:
  1. `any.convert_extern`
  2. `ref.cast (ref __fn_wrap_N_struct)`
  3. `struct.get __fn_wrap_N_struct $func` (yields funcref)
  4. Push args (with closure env if needed)
  5. `call_ref $type` for the function signature

## Acceptance criteria

1. The repro above returns `"hi!"`.
2. `const fns: ((s: string) => string)[] = [(s) => s + "!"]; fns[0]("hi")`
   returns `"hi!"`.
3. Map with function values: `Map<string, Fn>` retrieve + call works.
4. `tests/stress/hono-tier5.test.ts` — Tier 5a / 5d / 5d-closure tests
   (currently `it.skip` with `#1298` reference) all pass.

## Notes

- This blocks idiomatic Hono usage (`app.get("/path", c => c.text(...))`)
  and any user code that registers callbacks via maps/arrays.
- Tier 5 currently uses a parallel-array + numeric-ID workaround
  (`tests/stress/hono-tier5.test.ts` lower describe block) to validate
  the dispatch contract end-to-end without storing fn refs.

## Implementation Results

Class-field dispatch (the headline repro) now works end-to-end. Concrete
changes in this PR:

- **`src/codegen/expressions/calls-closures.ts`** (`compileCallablePropertyCall`):
  strip `Fn | null` / `Fn | undefined` via `getNonNullableType` before reading
  call signatures. Previously bailed out on any nullable union.
- **`src/codegen/expressions/calls.ts`** (`compileCallExpression`): added a
  `NonNullExpression` unwrap right after the existing `ParenthesizedExpression`
  unwrap. The inner expression (PropertyAccess / Identifier / etc.) gets a
  synthetic `CallExpression` and recurses, so non-null-asserted callable
  callees (`this.fn!(s)`, `obj.fn!(...)`) reach the dispatch they would have
  hit without the assertion.
- **`src/codegen/expressions/calls.ts`** (identifier-callable-param path
  ~line 5043): added the same `getNonNullableType` fallback for Identifier
  callees of nullable function type (e.g. `const fn = m.get("k"); fn!("hi")`).
- **`src/codegen/expressions/calls.ts`** (call-as-callee path ~line 6588):
  same nullable-type fallback so `m.get("k")(...)` reads call sigs correctly
  when Map.get returns `Fn | undefined`.
- **`src/codegen/expressions/calls.ts`** (generic call-as-callee fallback
  ~line 6710): replaced the closureInfoByTypeIdx scan-only logic with the
  eager-create + alternative-return-type-variant pattern from line 5061.
  Mirrors the identifier-callable path so order-independence holds for all
  expression-shaped callees, plus multi-funcref-candidate dispatch via
  ref.test chain (covariant return types).

### Tests

`tests/issue-1298.test.ts` — 9 passing scenarios covering the headline
class-field case, non-null assertions (direct, nested, parens-wrapped),
nullable variants (`| null`, `| undefined`, `| null | undefined`),
multi-arg callable fields, closure-capture round-trip, and TypeError on
calling a null field.

### Deferred (out of scope for this PR)

Two acceptance criteria still need follow-up work and are skipped with
explicit pointers in the test file:

- **`Fn[]` array-index call (`fns[0]("hi")`)** — routes through the
  ElementAccess fallback at calls.ts:6404. Tracked under #1306, which fixes
  the parallel `mws[idx](c, next)` path in the same file.
- **`Map<string, Fn>.get(...)(...)`** — the storage side of Hono's
  `routes.set(path, handler)` runs through `__make_callback`
  (`closures.ts:1100`, host-callback path) which produces a JS-wrapped
  externref. On retrieval the closure-struct cast fails because the value
  isn't a wasm GC closure. Fixing requires either (a) teaching
  `isHostCallbackArgument` that args to callable-typed parameters of
  user-class methods stored as Map fields shouldn't use the host callback
  path, or (b) a host bridge that lets Wasm `call_ref` a JS-wrapped
  externref. Out of scope here — needs follow-up issue. The three
  `it.skip("Tier 5a/d ... #1298")` tests in `tests/stress/hono-tier5.test.ts`
  remain skipped with a comment pointing to the storage-side issue.

## Test Results

- `npx vitest run tests/issue-1298.test.ts` — 9 passed, 2 skipped (the
  array/Map deferred cases).
- `npx vitest run tests/stress/hono-tier5.test.ts` — 10 passed, 4 skipped
  (unchanged from main; the three `#1298`-tagged Tier 5 skips remain blocked
  by the Map storage-side issue documented above, plus one #1301 skip).
- Closure-related test files (`tests/optional-direct-closure-call.test.ts`,
  `tests/fn-variable-call.test.ts`,
  `tests/illegal-cast-closures-585.test.ts`,
  `tests/flatmap-closure.test.ts`) — same pass/fail counts as main, no
  regression.
