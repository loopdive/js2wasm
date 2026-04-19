# Phase 3 Spec Conformance Audit — §7.3 Operations on Objects

**Date**: 2026-04-17
**Auditor**: dev-A
**Scope**: ECMAScript §7.3 Abstract Operations on Objects vs ts2wasm codegen
**Files audited**: `property-access.ts`, `typeof-delete.ts`, `expressions/calls.ts`, `expressions/new-super.ts`, `array-methods.ts`, `type-coercion.ts`, `closures.ts`, `runtime.ts`

---

## §7.3.2 Get(O, P) — Property access on objects

**Spec**: `Get(O, P)` requires O to be an Object. Returns O.\[\[Get\]\](P, O).

**Our implementation**: Compile-time struct field lookup (`struct.get`) with multi-struct dispatch fallback, plus `__extern_get` host import for dynamic property access on externref values.

**Conformance**: ✅ Largely correct for the static compilation model.

**Notes**:
- Struct field access correctly handles null checks with TypeError throws (`emitNullCheckThrow`, `typeErrorThrowInstrs` in `property-access.ts:251-311`)
- Multi-struct dispatch (`findAlternateStructsForField`, `property-access.ts:321-336`) provides correct fallback when runtime object type differs from static type
- `__extern_get` host fallback delegates to JS for dynamic property access on genuine JS objects

**No issues filed.**

---

## §7.3.3 GetV(V, P) — Property access on any value (including primitives)

**Spec**: `GetV(V, P)` works on any ECMAScript value V (not just objects). Steps:
1. Let O = ToObject(V) — converts primitives to wrapper objects
2. Return O.\[\[Get\]\](P, O)

**Our implementation**: TypeScript's type system resolves primitive property access at compile time:
- `string.length` → `wasm:js-string length` or `$AnyString` struct field 0 (`property-access.ts:1392-1404`)
- String methods (`.charAt`, `.slice`, etc.) → dedicated compilation in `string-ops.ts`
- Number methods (`.toString`, `.toFixed`) → dedicated host imports
- `__proto_method_call` runtime bridges `Type.prototype.method.call(receiver, args)` correctly with ToObject wrapping (`runtime.ts:2087-2100`)

**Conformance**: ✅ Correct — primitive property access is handled by type-specialized paths.

**Minor gap**: Property access on a primitive typed as `any` goes through externref → host fallback, which correctly auto-boxes via JS semantics. No deviation.

**No issues filed.**

---

## §7.3.4 GetMethod(V, P) — Method lookup

**Spec**: `GetMethod(V, P)` steps:
1. Let func = GetV(V, P)
2. If func is undefined or null, return undefined (don't throw)
3. If IsCallable(func) is false, throw TypeError
4. Return func

**Our implementation**: Method calls are resolved at compile time via TypeScript's type checker. The compiler knows statically whether a property is a method and emits direct `call` or `call_ref` instructions.

**Conformance**: ⚠️ Partial

**Findings**:

### Finding 1: No IsCallable check for dynamically-resolved methods (LOW)
When a method is called through the externref path (dynamic dispatch), the compiler trusts that the value is callable. If a non-function property is called, the JS host will throw naturally — but the error message may differ from spec ("X is not a function" from V8 vs our custom TypeError messages).

**Impact**: Low — TypeScript's type system prevents most IsCallable violations at compile time. The externref fallback path delegates to JS which throws correctly.

### Finding 2: GetMethod on null/undefined — TypeError vs undefined (MEDIUM)
Per spec, `GetMethod(null, P)` should return undefined (step 2), not throw. But `GetV(null, P)` (step 1) calls `ToObject(null)` which throws TypeError. So the net effect is a TypeError, which our `emitNullCheckThrow` correctly produces.

Actually, re-reading: `GetMethod` calls `GetV` which calls `ToObject`. `ToObject(null)` throws TypeError. So our null-check-throw is correct. ✅

**No issues filed.**

---

## §7.3.14 Call(F, V, argumentsList) — Function invocation

**Spec**: `Call(F, V, argumentsList)` steps:
1. If argumentsList not provided, set to empty list
2. If IsCallable(F) is false, throw TypeError
3. Return F.\[\[Call\]\](V, argumentsList)

**Our implementation**: Function calls are compiled to:
- Direct `call` for known functions
- `call_ref` for closure dispatch (via funcref from closure struct)
- `__proto_method_call` for `Type.prototype.method.call()` pattern
- Host fallback for externref callees

**Conformance**: ⚠️ Partial

### Finding 3: No TypeError for calling non-callable values (MEDIUM)
When a variable typed as `any` is called, the compiler emits externref-based dispatch. If the value is not actually a function, the behavior depends on the host:
- JS host mode: JS throws `TypeError: X is not a function` — correct
- Standalone mode: Wasm trap (unreachable) — not a TypeError, but a trap

This is acceptable for the dual-mode architecture — standalone mode cannot throw JS TypeErrors.

### Finding 4: Missing `this` binding for function calls (LOW)
Per spec, `Call(F, V, args)` passes `V` as the `this` value. Our compiler handles `this` correctly for:
- Method calls on objects (struct ref passed as first arg)
- `.call()` / `.apply()` / `.bind()` via host imports
- Arrow functions (lexical `this` capture)

Gap: When calling a function stored in a variable (not as a method), `this` should be `undefined` (strict mode) or `globalThis` (sloppy mode). Our compiler doesn't pass a `this` argument for plain function calls — the callee's `this` parameter is absent.

**Impact**: Low for TypeScript (which is always strict-mode semantically). Could affect test262 sloppy-mode tests.

**No issues filed** — this is a known architectural limitation.

---

## §7.3.15 Construct(F, argumentsList, newTarget) — Object construction

**Spec**: `Construct(F, args, newTarget)` steps:
1. If newTarget not provided, set to F
2. If IsConstructor(F) is false, throw TypeError
3. Return F.\[\[Construct\]\](args, newTarget)

**Our implementation** (`expressions/new-super.ts`):
- `new ClassName(args)` compiles to struct allocation + constructor call
- Constructor is `ClassName_constructor` function that initializes fields
- `super(args)` in derived classes calls parent constructor
- `new.target` → `typeof new.target` returns "function" in constructors, "undefined" outside (`typeof-delete.ts:573`)

**Conformance**: ⚠️ Partial

### Finding 5: No IsConstructor check for `new` on non-constructors (LOW)
Per spec, `new nonConstructor()` should throw TypeError. Our compiler resolves the constructor at compile time via TypeScript's type checker. If the class is unknown, it falls back to:
- Graceful struct allocation if struct type can be resolved
- Host import fallback for extern classes

TypeScript catches `new` on non-constructors at type-check time, so this rarely affects valid code. Test262 sloppy-mode tests may exercise this.

### Finding 6: new.target is simplified (LOW)
Our `new.target` support is minimal:
- `typeof new.target === "function"` is hardcoded to true in constructors
- Full `new.target` value (the actual constructor function reference) is not passed through the call chain

**Impact**: Low — `new.target` is used primarily for abstract class enforcement and subclass detection, both of which work through our class tag system.

**No issues filed** — architectural limitation, not a simple fix.

---

## §7.3.20 Invoke(V, P, argumentsList) — Method invocation

**Spec**: `Invoke(V, P, args)` steps:
1. Let func = GetV(V, P)  — get the method
2. Return Call(func, V, args) — call with V as this

**Our implementation**: Method calls compile to either:
- Direct `call` with struct ref as first arg (known method)
- `call_ref` with closure struct (closure methods)
- Host bridge via `__proto_method_call` or `__extern_call_method`

**Conformance**: ✅ Correct for the compilation model.

The `Invoke` pattern is the fundamental method-call primitive and our compiler's method-call compilation correctly:
1. Resolves the method (via struct fields, funcMap, or host lookup)
2. Passes the receiver as the first argument (or `this`)

**No issues filed.**

---

## §7.3.22 OrdinaryHasInstance(C, O) — instanceof

**Spec**: `OrdinaryHasInstance(C, O)` steps:
1. If IsCallable(C) is false, return false
2. If C has \[\[BoundTargetFunction\]\], follow the bind chain
3. If O is not an Object, return false
4. Let P = Get(C, "prototype")
5. If P is not an Object, throw TypeError
6. Loop: O = O.\[\[GetPrototypeOf\]\](), if O is null return false, if SameValue(P, O) return true

**Our implementation** (`typeof-delete.ts:249-477`):
- Uses compile-time class tag system, NOT runtime prototype chain walking
- Each class gets a unique `__tag` i32 field at index 0
- `instanceof` reads the `__tag` field and compares against the class's tag and all descendant class tags
- `collectInstanceOfTags` recursively collects tags for class + all subclasses
- Handles: externref left operand, nullable refs, primitives (always false), multi-tag comparison

**Conformance**: ⚠️ Significant deviation — correct for static class hierarchies, incorrect for dynamic prototype manipulation

### Finding 7: instanceof uses compile-time tags, not prototype chain (KNOWN LIMITATION)
Our `instanceof` checks a compile-time tag value, not the runtime prototype chain. This means:
- ✅ `new Derived() instanceof Base` — works (tag inclusion)
- ✅ `null instanceof X` — returns false (null check at line 389-448)
- ✅ Primitives instanceof X — returns false (line 360-366)
- ❌ Dynamic prototype reassignment breaks: `Object.setPrototypeOf(obj, NewProto)` won't affect instanceof
- ❌ `Symbol.hasInstance` is not consulted (only used as a constant i32 for well-known symbol encoding)
- ❌ Cross-realm instanceof (different global constructors) — not applicable to Wasm

**Impact**: Medium — this is a fundamental architectural decision. The tag-based approach is correct for static TypeScript class hierarchies and avoids runtime prototype chain walking overhead. Dynamic prototype manipulation is rare in TypeScript code.

### Finding 8: instanceof on unresolved class returns false silently (LOW)
When the right operand of `instanceof` can't be resolved to a known class (`resolveInstanceOfClassName` returns undefined, line 261), the compiler emits `i32.const 0` (false) instead of the spec-required behavior which would involve runtime prototype chain lookup.

**Impact**: Low — TypeScript's type system ensures the right operand is a constructor. Only affects untyped/`any` code.

**No issues filed** — these are known architectural trade-offs documented in the class system design.

---

## Summary

| Operation | Conformance | Notes |
|-----------|-------------|-------|
| §7.3.2 Get(O, P) | ✅ Correct | Struct-based with null checks |
| §7.3.3 GetV(V, P) | ✅ Correct | Type-specialized paths for primitives |
| §7.3.4 GetMethod(V, P) | ✅ Correct | Null-throws via ToObject, host fallback for dynamic |
| §7.3.14 Call(F, V, args) | ⚠️ Partial | No IsCallable check; standalone mode traps instead of TypeError |
| §7.3.15 Construct(F, args, newTarget) | ⚠️ Partial | new.target simplified; no IsConstructor check |
| §7.3.20 Invoke(V, P, args) | ✅ Correct | Method call = Get + Call pattern |
| §7.3.22 OrdinaryHasInstance | ⚠️ Significant | Tag-based, not prototype chain; correct for static hierarchies |

## Issues Filed

No new issues filed from this audit. All findings are either:
1. **Correct within the static compilation model** — TypeScript's type checker prevents the spec-violation scenarios
2. **Known architectural limitations** — tag-based instanceof, simplified new.target, standalone mode TypeError vs trap
3. **Low impact** — only affects untyped/`any`/sloppy-mode code paths that are rare in TypeScript

## Comparison with Phase 1 & Phase 2

| Phase | Scope | Issues Found | Fixes |
|-------|-------|-------------|-------|
| Phase 1 | §7.1 Type Conversion | OrdinaryToPrimitive gap (#1128) | Implemented |
| Phase 2 | §7.2 Testing/Comparison | String identity (#1133), cross-tag loose eq (#1134), SameValue (#1127), -0 literal (#1132) | All implemented |
| Phase 3 | §7.3 Object Operations | No new actionable issues — deviations are architectural | N/A |

Phase 3 confirms that the §7.3 object operations are well-implemented within the constraints of a static AOT compiler. The main deviations (prototype chain walking, dynamic IsCallable checks) are inherent to the compilation model and not simple code fixes.
