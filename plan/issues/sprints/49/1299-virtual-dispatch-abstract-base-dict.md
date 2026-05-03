---
id: 1299
sprint: 49
title: "Virtual dispatch through abstract-base-typed dict values returns first stored subclass's method"
status: ready
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
