---
id: 1397
sprint: 52
title: "codegen: static method dispatch ignores runtime property reassignment on typed receivers"
status: done
created: 2026-05-09
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: method-calls, property-assignment
goal: spec-completeness
---
# #1397 — Static method dispatch ignores runtime reassignment on typed receivers

## Root Cause

When a receiver has a known TypeScript type (e.g. `s1: String`), the codegen statically
resolves `s1.toString()` to `String.prototype.toString` at compile time — bypassing the
normal property-access + call-ref dispatch path. This means runtime reassignments like:

```ts
var s1 = new String();
s1.toString = Number.prototype.toString;
s1.toString();  // codegen emits String.prototype.toString call, not a property lookup
```

...are silently ignored. The Number-prototype path is never reached, so the spec's
`thisNumberValue` TypeError-on-wrong-this never fires. The test gets no throw when one
is expected, producing a wrong-answer failure.

Discovered during investigation of Number.prototype.toString S15.7.4.2_A4_T01-T05 cluster
(dev-1389-2, 2026-05-09, task #51). The same underlying issue surfaces in ANY transferred-method
scenario where the receiver has a known TS type:
- `obj.valueOf = SomeOtherBuiltin.prototype.valueOf; obj.valueOf()`
- `obj.hasOwnProperty = Object.prototype.hasOwnProperty.call.bind(...); obj.hasOwnProperty(x)`
- Any `receiver.method()` where `receiver: KnownType` and method was reassigned

The 3 test262 tests in the immediate cluster (S15.7.4.2_A4_T01-T05) are the visible tip.
The underlying bug likely affects dozens of other transferred-method test patterns.

## Fix Options

**Option A — Scope-level reassignment tracking** (narrower): before emitting a static
dispatch for `receiver.method()`, check whether any assignment of the form
`receiver.method = <expr>` appears anywhere in the enclosing scope. If so, fall back to
dynamic dispatch (property-access + call_ref). Con: requires a scope pre-pass; misses
cross-scope and conditional reassignments.

**Option B — Always dynamic-dispatch for typed-receiver method calls** (safer, slower):
when a method call on a typed receiver could plausibly be reassigned, emit a property
lookup + call_ref instead of a direct function index. Con: loses the static-dispatch perf
win for all method calls on typed receivers — a significant regression.

**Option C — Hybrid**: keep static dispatch as the default, but add a `/*@dynamic*/`
annotation or a compiler flag to opt specific call sites into dynamic dispatch. Con:
requires user annotation; doesn't help test262 which doesn't annotate.

**Option D — Narrow to built-in methods only**: only apply the fix to calls on typed
built-in types (`String`, `Number`, `Array`, etc.) where the method is defined on the
`.prototype`, which are the most common transferred-method patterns. Regular user-class
methods keep static dispatch. Con: partial fix; some tests still fail.

## Recommended approach

Start with a **feasibility study**: enumerate how many test262 tests hit this pattern
(transferred built-in method on a typed receiver) and measure the perf regression from
Option B on the playground benchmark suite. If the perf cost is acceptable (<5%), Option B
is cleanest. Otherwise Option D with scope-limited tracking.

## Affected tests

Confirmed: S15.7.4.2_A4_T01-T05 (Number.prototype.toString on String receiver).
Likely also: valueOf transfer patterns, hasOwnProperty transfer, any A4_* cluster in
String/Number/Boolean prototype test sections.

## Risk

High — any change to method dispatch affects all typed-receiver calls. Must not regress
the static-dispatch fast path that drives perf advantages. Run full equivalence suite and
playground benchmark before merging.

## Files

- `src/codegen/expressions.ts` — CallExpression handler, typed-receiver method call path
- `src/codegen/property-access.ts` — static method resolution logic
