---
id: 1395
sprint: 51
title: "class static method descriptors: class identifier resolves to string_constant, not constructor object"
status: ready
created: 2026-05-09
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: class, static methods, property descriptors
goal: spec-completeness
depends_on: []
---
# #1395 — Static class identifier as constructor object

## Background

Filed from dev-1390-2 investigation of task #44 (2026-05-09).

`Object.getOwnPropertyDescriptor(C, "m")` for static method `m` on class `C` returns `null`
in the current compiler. Root cause: the class identifier `C` resolves to a string_constants
import (not a real constructor object), so the descriptor lookup has nothing to inspect.

WAT evidence (from dev-1390-2 probe):
```wat
(import "string_constants" "C" (global $C externref))
(func $getC (result externref) global.get 1 return)
```

## Current state

Instance method descriptors (`verifyProperty(c, "m", ...)`) work — the instance uses the
prototype chain and `_prototypeMethodNames` registry. Static method descriptors
(`verifyProperty(C, "m", ...)`) fail because `C` is a string import, not a real object.

## Required fix

1. **Class identifier as real object**: When a class `C` is defined, emit a proper
   constructor-object (not just the string name) that can be passed to host APIs.
   The constructor object must carry static method descriptors.

2. **Static method registry**: Analogous to `_prototypeMethodNames` for instance methods,
   introduce a `_staticMethodNames` registry keyed on the class constructor object.
   `__getOwnPropertyDescriptor` queries it when receiver is a recognized class object.

3. **Class reference resolution**: When `C` appears as an expression (not just a string),
   resolve to the constructor object, not the string_constants import.

## Scope relationship

- Distinct from #1394 (method-closure caching) which handles `C.prototype.m` identity.
- Both are about class boundary representation. Can proceed in parallel.
- This issue covers static methods. Instance method descriptor fidelity was mostly fixed
  in PR #310 (#1364) — but static descriptors are still broken.

## Test cluster

`test/language/statements/class/elements/after-same-line-*` tests using
`verifyProperty(C, "m", { value: ..., writable: true, configurable: true, enumerable: false })`.
~70 tests in this cluster.

## Files

- `src/codegen/index.ts` — class definition emission, emit constructor object + static method registry
- `src/runtime.ts` — `_staticMethodNames` registry + `__getOwnPropertyDescriptor` extension
- `src/codegen/expressions.ts` / `src/codegen/identifiers.ts` — resolve class identifier to object

## Investigation

Filed from dev-1390-2 (task #44, 2026-05-09). Two root causes for the 136-failure cluster:
1. This issue (static method descriptors) — ~70 fails
2. #1394 (method-closure caching, generator method identity) — remaining ~66 fails

## Implementation Plan (added 2026-05-09 by dev-1390-2 / task #46)

### Current behaviour (verified by WAT inspection, commit 9dd3e427)

`class C { static m() { return 42; } }` compiles to:
- A `$C` WasmGC struct type with just `__tag` (no static-method storage).
- A `__proto_C` mutable externref module global (the prototype singleton, lazily
  initialized in `emitLazyProtoGet`, registered in `ctx.protoGlobals` from
  `class-bodies.ts:222`).
- A `C_m` Wasm function (the static method body, function index in `funcMap`).
- A `__fn_tramp_C_m_1` trampoline that dispatches to `C_m`.

Resolution paths for class-name identifiers:
- **`C.m` as call/property access** → `compilePropertyAccess` recognizes the
  static-method shape and emits a closure-wrap around the trampoline (works).
- **`C` as a bare expression** → `compileIdentifier` (`expressions/identifiers.ts:325`)
  falls through every named path (no local, no module global, no captured global,
  no funcMap entry — class names are NOT in funcMap) to the **graceful default at
  line 548**, which emits `ref.null.extern`. So `C` evaluates to `null`.
- Consequence: `Object.getOwnPropertyDescriptor(C, "m")` is
  `Object.getOwnPropertyDescriptor(null, "m")` → returns `null` instead of a
  method descriptor.

The `string_constants "C"` import in WAT comes from the export-name pool, not
from class-identifier resolution. Confirmed by WAT inspection: `getC` body is
`ref.null.extern; return`, no `global.get`.

### Three sub-problems

#### 1. Class identifier emits a real object, not `ref.null.extern`

Today `C` as a bare expression has no representation. We need a singleton
class-object global per class (analogous to the existing `__proto_C` global
established by #1047), lazily initialized.

- Add `ctx.classObjectGlobals: Map<className, globalIdx>` to CodegenContext
  (mirrors `protoGlobals` at `context/types.ts`).
- In `class-bodies.ts` near line 214 where `protoGlobals` is registered, also
  emit a `__class_${className}` mutable externref module global initialized
  to `ref.null.extern`.
- Reuse the same `$C` struct type for the class object — the existing `__tag`
  field already distinguishes classes via the global tag space
  (`ctx.classTagMap`). Class objects can use the same tag as instances; they're
  distinguished by *which* singleton global holds them (`__class_C` vs an
  instance) and by the `_staticMethodNames` registry being populated only on
  the class-object global.
- In `compileIdentifier`, before the symbol-fallback path at line 502, check
  `ctx.classObjectGlobals.has(name)` and, if present, emit a lazy-init pattern
  (mirror `emitLazyProtoGet` from `expressions/extern.ts:115`):
  ```
  global.get $__class_C
  ref.is_null
  if then
    i32.const <classTag>            ;; reuse the same tag as instances
    struct.new $C
    extern.convert_any
    global.set $__class_C
    global.get $__class_C
    global.get <csv-of-static-method-names>
    call $__register_class_object   ;; new host import (Phase 1)
  end
  global.get $__class_C
  ```
- Emit the lazy-init helper as a new function in
  `src/codegen/expressions/extern.ts` named `emitLazyClassObjectGet` (parallels
  the existing `emitLazyProtoGet`).

#### 2. Static method registry (analog to `_prototypeMethodNames`)

In `src/runtime.ts`:
- Add `const _staticMethodNames = new WeakMap<object, string[]>();` near the
  existing `_prototypeMethodNames` declaration at line 1147.
- Add a `__register_class_object` host import handler (mirrors
  `__register_prototype` at `runtime.ts:2412-2419`):
  ```ts
  if (name === "__register_class_object")
    return (classObj: any, csv: any): void => {
      if (classObj == null || typeof classObj !== "object") return;
      const names = typeof csv === "string" && csv.length > 0 ? csv.split(",") : [];
      _staticMethodNames.set(classObj, names);
    };
  ```
- Extend the `__getOwnPropertyDescriptor` host import (the registered-prototype
  arm at `runtime.ts:3071-3079`) with a parallel arm for class objects:
  ```ts
  const staticMethods = _staticMethodNames.get(obj);
  if (staticMethods !== undefined && staticMethods.includes(propStr)) {
    return {
      value: _getClassMethodBridge(obj, propStr),
      writable: true,
      enumerable: false,
      configurable: true,
    };
  }
  ```
- Add `_classMethodBridges: WeakMap<object, Map<string, Function>>` and
  `_getClassMethodBridge` helper, mirroring the existing
  `_prototypeMethodBridges` + `_getProtoMethodBridge` pair.
- Extend `__getOwnPropertyNames` (`runtime.ts:3094`) to surface static-method
  names when the receiver is in `_staticMethodNames`. Mirror the
  prototype-allowlist arm just above.
- **Spec note:** per ECMA-262 §15.7.1, static methods on classes are
  `{enumerable: false, configurable: true, writable: true}` — same flags as
  instance methods. So the descriptor shape is identical to the prototype arm;
  only the storage map differs.

#### 3. Class identifier resolution in identifiers.ts

In `compileIdentifier` (`src/codegen/expressions/identifiers.ts`), insert
between the existing module-global path (line 442) and the declared-globals
path (line 444) a new branch:
```ts
// (#1395) Class identifier as a value — emit lazy-initialized class-object
// singleton, register static methods via _staticMethodNames so
// Object.getOwnPropertyDescriptor(C, "m") returns the spec descriptor.
if (ctx.classObjectGlobals?.has(name)) {
  emitLazyClassObjectGet(ctx, fctx, name);
  return { kind: "externref" };
}
```
Order: AFTER `localMap` (function locals), `capturedGlobals`, `moduleGlobals`,
and `declaredGlobals` so user shadowing (`var C = ...`) takes precedence.
AFTER the funcMap-funcref path (line 480) so a function named `C` would also
win (rare). BEFORE the symbol fallback so we beat `ref.null.extern`.

### Phase plan

#### Phase 1 — class object emission + static-method descriptor (this PR, ~150 LOC)

Lands all three sub-problems together. They're tightly coupled — without the
class-object global there's no receiver for the descriptor to fire on, so a
narrower slice doesn't actually fix any test.

Sub-tasks:
1. CodegenContext: add `classObjectGlobals: Map<string, number>` and
   `classStaticMethodNames: Map<string, string[]>` (mirror `protoGlobals` and
   `classMethodNames`).
2. `class-bodies.ts:200-225` window: also register `__class_${className}`
   global, populate `classObjectGlobals`. Then collect static-method names
   from `decl.members` (existing prototype loop at lines 519-538 has the
   inverse condition `if (hasStaticModifier(member)) continue;` — write a
   parallel loop with `if (!hasStaticModifier(member)) continue;`) and stash
   in `ctx.classStaticMethodNames`.
3. `runtime.ts`: add `_staticMethodNames` + `_classMethodBridges` +
   `_getClassMethodBridge`, add `__register_class_object` host import, extend
   the `__getOwnPropertyDescriptor` arm + `__getOwnPropertyNames` arm.
4. `expressions/extern.ts`: add `emitLazyClassObjectGet` helper paralleling
   `emitLazyProtoGet`. Differences: pushes the static-method-names CSV global
   instead of the instance-method-names CSV global; calls
   `__register_class_object` instead of `__register_prototype`.
5. `expressions/identifiers.ts`: detect class-identifier reads at line 442
   and emit lazy-init pattern.
6. Test: `tests/issue-1395-phase1.test.ts` — covers
   `Object.getOwnPropertyDescriptor(C, "m")` returns the spec-correct
   descriptor for a class with one static method, plus a regression check
   that instance method descriptors still work, plus the
   `assert.sameValue(C.m, C.m)` cached-bridge identity assertion.

Estimated diff: ~150 LOC. Much of the structure mirrors existing code paths,
so the per-line review surface is small.

#### Phase 2 — `typeof C === 'function'` (deferred; separate cluster)

The Phase 1 class-object struct will report `typeof === "object"` since it's
a WasmGC struct. JS spec says class constructors have `typeof === "function"`.
Fix surface lives in the typeof handler (`src/codegen/typeof-delete.ts`); a
class-object can be detected via the class-tag check already used by
`instanceof` in #1325. Defer to a follow-up issue once the failures cluster.

#### Phase 3 — `C.prototype` identity

Already implemented (#1047). No work needed in this issue.

### Edge cases enumerated before implementation

- **Class expressions** (`var C = class { static m() {} }`) — `decl.name` may
  be undefined. The existing `protoGlobals` registration uses the synthetic
  `classExprNameMap` lookup. Phase 1 must mirror that path for
  `classObjectGlobals`. If both are skipped for unnameable inline class
  expressions (e.g. `(class { static m() {} }).m`), tests that exercise
  inline-class static descriptors fail; defer to a follow-up.
- **Inherited static methods** (`class B extends A`) — should
  `Object.getOwnPropertyDescriptor(B, "staticInherited")` return a descriptor?
  Per spec, no — `getOwnPropertyDescriptor` returns descriptors only for OWN
  properties. So inherited statics are excluded from `_staticMethodNames` for
  B. Phase 1's collection loop must NOT walk the parent chain for static
  methods (different from instance-method storage which walks parents for
  field initializer copying).
- **Static + instance methods with the same name** — `class C { m() {} static
  m() {} }` is legal JS; they have separate descriptors on different
  receivers. Phase 1's separate registries (`_prototypeMethodNames` +
  `_staticMethodNames`) handle this naturally — no special case needed.
- **Subclass of host-constructible builtin** (`class MyError extends Error`,
  per #1366a) — these are externref-backed and don't have a `$C` struct. The
  class-object emission must be gated on
  `!ctx.classBuiltinParentMap.has(className)`. For #1366a subclasses, defer
  to a follow-up — they'd need a host-side constructor object representation
  (the JS `MyError.prototype.constructor` already exists for them).
- **Static accessors** (`class C { static get m() { return 42; } }`) — Phase 1
  excludes accessors from `_staticMethodNames` (mirror line 526: only
  `MethodDeclaration`, not `GetAccessorDeclaration` or
  `SetAccessorDeclaration`, in the static collection loop). Accessor
  descriptors have a different shape (`get`/`set` instead of
  `value`/`writable`) and are out of scope.
- **Static fields** (`class C { static x = 42; }`) — already stored as module
  globals by the existing `staticProps` path (`class-bodies.ts:541`). Phase 1
  doesn't disturb that. Static-field descriptors are a separate slice (out of
  scope here).

### Risk assessment

- **Low for instance-method tests** — the new arm only fires when the receiver
  is in `_staticMethodNames`; instance-method receivers are unchanged.
- **Medium for property access** — the new identifier-resolution arm could
  shadow user code that defines `var C = ...` after the class. Order matters:
  function-local locals first (existing), then captured globals (existing),
  then module globals (existing), then class objects (NEW), then funcMap
  function refs (existing), then fallback. User shadowing via `var C = ...`
  registers in `moduleGlobals` and wins.
- **Low test262 baseline impact for non-class tests** — the change is gated
  on class-name identifiers and the `_staticMethodNames` allowlist; nothing
  fires for object literals or non-class types.

### Related issues

- **#1394** (method-closure caching, generator method identity) — separate
  axis. After Phase 1 here lands, generator-method tests still need #1394
  to pass `assert.sameValue(c.m, C.prototype.m)`.
- **#1366a** (host-constructible builtin subclassing) — gates the
  class-object emission for `class MyError extends Error` etc.
- **#1364** (instance method descriptor fidelity) — already on main; this
  issue is the static-method analog using the same registry pattern.
