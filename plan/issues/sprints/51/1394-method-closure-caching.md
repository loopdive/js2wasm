---
id: 1394
sprint: 51
title: "class method-closure caching: C.prototype.method returns stable singleton closure"
status: ready
created: 2026-05-09
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: class, closures
goal: spec-completeness
depends_on: [1388]
---
# #1394 — Class method-closure caching

## Background

PR #305 (regression fix for #1388) deliberately reverted the per-access closure
allocation for `ClassName.prototype.<method>` property access. The original handler
emitted a freshly-allocated closure on every access, breaking method identity:
`c.m === C.prototype.m` returned false (each side returned a different closure ref).
478 tests under `language/{expressions,statements}/class/elements/*` exercise this
via `verifyProperty` and turned pass→fail. The handler was intentionally omitted
at `src/codegen/property-access.ts:1305-1313`, leaving `C.prototype.<method>` to
fall through to the legacy generic externref path (returns null).

## Problem caused by the tradeoff

With `C.prototype.method` returning null, any test that calls:
```ts
const method: any = C.prototype.method;
method([]);          // ← null invocation → silent failure, wrong error
method.call(c, []); // ← via 'this' receiver → may work differently
```
…silently fails instead of throwing the expected TypeError. This affects ~190
class/dstr tests (async-gen, gen, regular method variants) that test TypeError
propagation through method destructuring parameters.

Investigation by dev-1389-2 (2026-05-09): the async-gen destructuring code itself
is correct — `method.call(undefined, [])` throws correctly. The null comes from
`C.prototype.method` returning null, not from any destructuring bug.

## Fix

Implement per-class × per-method singleton closure caching:

1. **Cache structure**: a per-class table (likely a WasmGC array or a
   `struct { ref $closure_N }` allocated once at class-definition time) that maps
   method index → singleton closure ref.

2. **Emission**: when a class is defined, emit `struct.new $MethodN_closure` for
   each method and store in the cache. The cache lives on the class object or a
   parallel module-level GC slot.

3. **Property-access path**: restore the `ClassName.prototype.<method>` handler at
   `src/codegen/property-access.ts:1305-1313` to read from the cache table instead
   of allocating a new closure. This gives stable identity: every access returns the
   same cached ref.

4. **Identity invariant**: `c.m === C.prototype.m` must hold — both sides go through
   the same cache entry (the instance-method fast path can share the cache with the
   prototype path, or the instance path can delegate through the prototype).

5. **Scope**: regular methods, generator methods, async generator methods. Async
   methods also need this — `C.prototype.asyncMeth` has the same identity issue.

## Risk

High — touches class definition codegen and property-access dispatch. Must not
regress the 478 wins from #1388. Run `npm test -- tests/equivalence.test.ts` and
targeted class/elements tests before pushing.

## Expected impact

~190 class/dstr tests (currently failing due to null invocation). Possibly also
unlocks some class/elements descriptor tests that depend on stable prototype method refs.

## Files

- `src/codegen/index.ts` — class definition emission, add cache table allocation
- `src/codegen/property-access.ts` — restore handler at line ~1305, read from cache
- `src/codegen/expressions.ts` — instance method access may also need cache read

## Investigation

Filed from dev-1389-2 investigation of task #41 (2026-05-09). Worktree
`issue-class-dstr-element-null` has .tmp/ probes only, no source changes — can be
reused or discarded for this senior-dev handoff.
