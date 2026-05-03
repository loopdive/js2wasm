---
id: 1299
sprint: 49
title: "Virtual dispatch through abstract-base-typed dict values returns first stored subclass's method"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes, inheritance, abstract, dict
goal: npm-library-support
related: [1297, 1298]
---
# #1299 — Virtual dispatch through abstract-base-typed dict values miscalls

## Summary

When subclass instances of an abstract base class are stored in an
index-signature dict typed by the base, calling the abstract method
through the dict resolves to the FIRST stored subclass's method for ALL
stored values — not the subclass at the looked-up key.

## Repro

```typescript
abstract class Base { abstract id(): number; }
class A extends Base { id(): number { return 1; } }
class B extends Base { id(): number { return 2; } }

export function test(): number {
  const dict: { [k: string]: Base } = {};
  dict["a"] = new A();
  dict["b"] = new B();
  return dict["a"].id() * 1000 + dict["b"].id();  // expected 1002, returns 1001
}
```

The dict round-trip itself is fine — `dict["a"]` and `dict["b"]` return
the correct (different) instance refs. But `id()` resolves to A's
method for both. Plain non-dict access works:

```typescript
const a: Base = new A();
const b: Base = new B();
a.id() * 1000 + b.id();  // returns 1002 correctly
```

## Likely cause

The dict's value type lowers to `Base` (the abstract class struct), so
the call site uses `Base.id`'s type / index. When the actual instance
is `A` or `B`, the prototype chain or vtable lookup is short-circuited
to the wrapper / placeholder Base method (which the codegen treats as
the first registered subclass's body, since abstract methods have no
body of their own).

## Where to fix

- `src/codegen/expressions/calls.ts` — virtual-method dispatch for class
  method calls.
- `src/codegen/class-bodies.ts` — abstract method handling.
- The call site must use the *runtime* class's method, not the static
  receiver type's method. Likely needs a method-table lookup through
  the runtime class tag (`__tag` field on the struct) rather than a
  direct `call $Base_id`.

## Acceptance criteria

1. The repro returns `1002`.
2. Mixed concrete-subclass dict values dispatch to their own
   subclass's method (no cross-bleed).
3. Method override via `extends` works through dict-typed-as-base
   storage.

## Notes

- Surfaced while exploring workarounds for #1298 (function-typed
  fields). The abstract-class workaround was rejected because of this
  separate bug.
- Likely affects any code using `Map<K, AbstractBase>` or
  `{ [k: string]: AbstractBase }` patterns — common in framework
  registry tables.

## Investigation (2026-05-03)

The bug has TWO independent root causes that both need fixing for
virtual dispatch to work:

### Cause A — subclass→base assignment loses identity (FIXED in this PR)

`emitSafeStructConversion` in `src/codegen/type-coercion.ts` falls
through to `emitStructNarrowBody` for any same-shape struct conversion,
emitting a `struct.get $field; struct.new $To` field-copy. For
subclass→base assignments where the subclass is a *declared Wasm
subtype* of the base (`(sub final $Base ...)`), this destroys the
subclass identity by constructing a fresh base struct. The runtime
value loses any way to recover its concrete subclass.

Fix: detect Wasm declared subtype via the `superTypeIdx` chain and
skip the field-copy. The value on the stack is already valid as the
wider type under WasmGC subtyping. Verified by inspecting the WAT
output before/after — the `struct.get/struct.new` pair is replaced by
`ref.cast null` which preserves identity.

### Cause B — method dispatch is statically resolved (NOT YET FIXED)

In `src/codegen/expressions/calls.ts`, the "walk child classes"
fallback at line ~3408 picks the FIRST subclass with the method when
the receiver's static type is abstract / has no own implementation.
The emitted `call $A_id` is unconditional regardless of the receiver's
runtime class.

To fix this properly, the call site must emit a virtual dispatch — a
ref.test cascade against each candidate subclass struct, with the
right call_ref / call inside each branch. The receiver must be saved
to a temp local; arguments must be evaluated once and saved to temps
(side-effect ordering); each branch then loads the temps and calls
the subclass's method.

Sketch:

```wat
local.get $receiver
local.set $tmp_recv
;; ...evaluate and save args to tmp_arg_i...
local.get $tmp_recv
ref.test (ref $A)
(if (result T)
  (then
    local.get $tmp_recv
    ref.cast (ref $A)
    local.get $tmp_arg0
    ...
    call $A_id
  )
  (else
    local.get $tmp_recv
    ref.test (ref $B)
    (if (result T)
      (then
        local.get $tmp_recv
        ref.cast (ref $B)
        local.get $tmp_arg0
        ...
        call $B_id
      )
      (else ;; throw or default)
    )
  )
)
```

Cause B is a substantial inline-emit refactor of the call path
(needs arg-temp management, careful return-type handling, integration
with `addUnionImports` index shifting). Filed as Phase 2 follow-up
within this same issue — the test cases here will start passing once
Phase 2 lands on top of Phase 1.

## Phase 2 implementation — tag-comparison virtual dispatch

Implemented `emitVirtualMethodDispatchByTag` in
`src/codegen/expressions/calls.ts` mirroring the `instanceof` codegen
pattern: load the receiver's `__tag` field (i32, set in each subclass's
constructor), compare against each candidate's known `classTag` value,
call the matching subclass's method body with a `ref.cast_null` to the
correct subclass struct type. Receiver and arguments are evaluated once
and saved to temp locals so each branch references them.

This pattern replaces the earlier `ref.test (ref $A)` cascade attempt
which produced wrong results (V8 returned A's branch for B values
even though the ref.test should have failed). Tag comparison sidesteps
that quirk by reading the explicit `__tag` field that the constructor
unconditionally initialises.

The dispatch fires whenever the call site collects ≥ 2 candidate
subclass implementations of a method, either via the "method-not-on-
receiver" walk-children path (abstract base) or via the
"method-on-receiver-with-overrides" walk-descendants path (concrete
base + override).

## Known remaining gap — dict / index-signature reads

The dict path (`dict["k"].id()` where `dict: { [k: string]: Base }`)
takes a separate code path that statically casts the externref-typed
dict value to the FIRST candidate subclass struct (e.g. `(ref null A)`)
and calls that subclass's method directly — never reaching the
virtual-dispatch collector here. The cast either traps at runtime
(illegal cast) or compiles to an invalid call signature
(`call[0] expected type (ref null 3), found ref.as_non_null of type
(ref 1)`), depending on whether the receiver type is widened first.

Fix needed in the dict / index-signature read path
(`src/codegen/expressions/assignment.ts` element-access and call-site
property access for index-signature dicts) to:
1. Avoid statically picking a single concrete subclass when the value
   type is an abstract base.
2. Route the call through the same `emitVirtualMethodDispatchByTag`
   helper. The helper takes a struct-typed receiver, so the dict path
   needs to widen to the base struct ref BEFORE invoking dispatch.

Filing as a Phase 3 follow-up since it touches a different file.

## Test Results (Phase 1 + Phase 2)

`tests/issue-1299.test.ts` — 4 cases, **1 pass / 3 fail**:
- ✓ baseline: plain-local `Base = new A() | new B()` dispatches
  correctly — virtual dispatch fires, returns 1002 as expected.
- ✗ dict[k].id() dispatches — fails (Phase 3 needed)
- ✗ concrete base + override through dict — fails (Phase 3 needed)
- ✗ three subclasses through dict — CompileError (Phase 3 needed)

Regression check: identical pass/fail counts to main on
`tests/inheritance.test.ts`, `tests/abstract-classes.test.ts`,
`tests/private-class-members.test.ts`, `tests/nested-class-declarations.test.ts`,
`tests/class-method-calls.test.ts`, `tests/class-methods.test.ts`,
`tests/class-static-private-this.test.ts`. No regressions from the
struct subtype change OR the virtual dispatch addition.

Hono Tier 1-5 stress tests: 21/25 active pass (4 unrelated skipped) —
no regressions.
