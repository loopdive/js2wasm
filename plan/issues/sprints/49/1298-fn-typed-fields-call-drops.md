---
id: 1298
sprint: 49
title: "Calling a function-typed value stored in a field/array/Map drops the call and returns null"
status: ready
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
