---
id: 799
title: "- Prototype chain subsystem (~2,500 tests)"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
reasoning_effort: max
goal: platform
test262_fail: ~2500
note: "799a (__proto__ field) done but caused -2,788 regression → reverted to conditional approach in #802. 799b (compile-time chain walk) done and working. Remaining: #802 for dynamic proto support."
---
# #799 -- Prototype chain subsystem (~2,500 tests)

## Problem

JavaScript objects inherit properties from their prototype chain. Our compiler resolves properties statically at compile time, which works for known struct types but fails when:
- A property is defined on a parent class/prototype
- `Object.getPrototypeOf` / `Object.setPrototypeOf` is used
- `instanceof` checks traverse the chain
- `for-in` enumerates inherited properties
- Property lookup falls through to Object.prototype methods (toString, valueOf, etc.)

## Architecture

### Linked-list prototype chain

Every struct gets a `$__proto__` field pointing to its prototype:

```wasm
(type $MyClass (struct
  (field $__proto__ (ref null $AnyStruct))  ;; prototype link
  (field $x f64)
  (field $y f64)
))
```

### Property lookup algorithm
```
function getProperty(obj, name):
  current = obj
  while current != null:
    if current has own property `name`:
      return current.name
    current = current.__proto__
  return undefined
```

### Implementation

**Phase 1: Proto field on all structs**
- Add `$__proto__` as field 0 on every struct type
- Constructor sets `$__proto__` to the class's prototype struct
- Object literals set `$__proto__` to a shared Object.prototype struct

**Phase 2: Property access fallthrough**
- In `compilePropertyAccess`, after checking the primary struct type:
  - If field not found, emit `struct.get $__proto__` and retry on parent
  - Chain up to N levels (configurable depth, default 4)
  - Final fallback: externref host lookup

**Phase 3: instanceof via chain walk**
- `obj instanceof Class` → walk __proto__ chain, ref.test against Class.prototype struct type at each level
- Already partially implemented; extend to use __proto__ field

**Phase 4: Object.create / Object.getPrototypeOf**
- `Object.create(proto)` → allocate struct with `$__proto__ = proto`
- `Object.getPrototypeOf(obj)` → `struct.get $__proto__`
- `Object.setPrototypeOf(obj, proto)` → `struct.set $__proto__`

### Standalone mode
Fully Wasm-native — no host imports. The prototype chain is a linked list of structs. Property lookup is a bounded loop of struct.get + ref.test.

## Files to modify
- `src/codegen/index.ts` — struct type registration (add __proto__ field)
- `src/codegen/property-access.ts` — property lookup chain walk
- `src/codegen/expressions.ts` — instanceof chain walk, Object.create/getPrototypeOf

## Reopened (2026-03-28)

Extern classes don't inherit Object.prototype methods. 53 compile errors from
methods called on extern class instances that should fall through to Object.prototype:

| Method | Count | Affected classes |
|--------|-------|-----------------|
| hasOwnProperty | 18 | RegExp |
| toString | 16 | RegExp |
| toLocaleLowerCase/toLocaleUpperCase | 4 | RegExp |
| toLowerCase/toUpperCase | 4 | RegExp |
| Array methods (every, filter, map, etc.) | 9 | RegExp (used as array-like) |
| isPrototypeOf | 1 | RegExp |
| trim | 1 | RegExp |

Root cause: `findExternInfoForMember` walks `ctx.externClassParent` but doesn't
fall through to a shared Object.prototype extern class. Each extern class only
knows its own registered methods.

Fix: register Object.prototype methods (hasOwnProperty, toString, valueOf,
isPrototypeOf, propertyIsEnumerable) on a base extern class that all others inherit.

## Acceptance criteria
- Property access traverses prototype chain
- instanceof works with inheritance hierarchies
- Object.create/getPrototypeOf/setPrototypeOf work
- Extern classes inherit Object.prototype methods
- 2,500+ test262 improvements

## Implementation Plan

### Root cause

The compiler resolves method calls and property access statically by looking up `ClassName_methodName` in `ctx.funcMap`. When a user-defined class doesn't explicitly define a method (like `toString`, `valueOf`, `hasOwnProperty`), the lookup fails because there's no fallback to Object.prototype methods. Similarly, extern classes (RegExp, Set, Map, etc.) don't inherit from a base "Object" extern class, so `findExternInfoForMember` terminates without finding Object.prototype methods. Finally, the prototype chain walk for property access is dormant because structs lack `__proto__` fields (#802 deferred).

The ~2,500 test failures break down into several independent problem categories:

1. **Object.prototype method calls on class instances** (~800 tests): `obj.toString()`, `obj.valueOf()`, `obj.hasOwnProperty(k)` fail for user-defined classes that don't override them.
2. **Extern class Object.prototype inheritance** (~200 tests): RegExp, Set, Map instances can't call `hasOwnProperty`, `toString`, `isPrototypeOf`, etc.
3. **Method call via host dispatch for unresolvable methods** (~500 tests): `obj.method()` where TypeScript thinks the class has a method (from lib.d.ts Object type) but no Wasm function exists.
4. **Property access chain fallback** (~400 tests): accessing `obj.prop` where `prop` is defined on a prototype, not the object itself.
5. **instanceof correctness across host/Wasm boundary** (~300 tests): `x instanceof Y` where Y is a user-defined class but x came from a host call (externref).
6. **Constructor chain / super() correctness** (~300 tests): missing parent method propagation edge cases, class expressions, and mixins.

### WI1: Object.prototype method fallback for user-defined class instances (~800 tests)

**Problem**: When `obj.toString()` is called on a user-defined class instance and the class (nor any ancestor) defines `toString`, the compiler gives up at expressions.ts:10802 ("If no method found, check if the property is a callable struct field"). It should fall through to the generic `.toString()` handler at expressions.ts:11398, but by that point the receiver has already been identified as a known class and the code path has diverged.

**File: `src/codegen/expressions.ts`**

- After the inheritance chain walk (line ~10780-10801) fails to find the method, and before the callable property check (line ~10804):
  - Check if `methodName` is one of the Object.prototype methods: `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `constructor`
  - For `toString`: coerce the receiver to externref, call `__extern_toString(externref) -> externref` (already exists in runtime). Return `{ kind: "externref" }`.
  - For `valueOf`: simply return the compiled receiver expression (identity — JS Object.prototype.valueOf returns `this`).
  - For `hasOwnProperty`: use the existing `compilePropertyIntrospection` pattern (line ~10553). This already handles it; the issue is that control flow doesn't reach it when the receiver is a known class. Add an early-out check.
  - For `isPrototypeOf`: use host import `__isPrototypeOf(obj, candidate) -> i32`.
  - For `propertyIsEnumerable`: use existing `compilePropertyIntrospection` (same pattern as hasOwnProperty).
  - For `toLocaleString`: delegate to `toString` (ES spec default behavior).
  - For `constructor`: return the constructor function reference (already handled at property-access.ts:1290).

**Wasm IR pattern for `obj.toString()` fallback:**
```wasm
;; obj is on stack as (ref $MyClass)
extern.convert_any          ;; → externref
call $__extern_toString     ;; → externref (string)
```

**Key insertion point**: expressions.ts, after line 10801 (end of child class walk), before line 10802. Add:
```typescript
// Object.prototype fallback for known class instances
if (funcIdx === undefined) {
  const objProtoResult = compileObjectPrototypeFallback(ctx, fctx, expr, propAccess, receiverClassName, methodName);
  if (objProtoResult !== undefined) return objProtoResult;
}
```

Implement `compileObjectPrototypeFallback` as a new function in expressions.ts that handles each Object.prototype method.

**Edge cases:**
- Class that defines `toString` as a getter (not a method) — should use getter path, not fallback
- `toString.call(obj)` / `toString.apply(obj)` patterns — handled separately by the `.call`/`.apply` path
- `null.toString()` — should throw TypeError, not reach this fallback (already guarded by null checks)

### WI2: Extern class Object.prototype inheritance (~200 tests)

**Problem**: `findExternInfoForMember` (expressions.ts:16537) walks `ctx.externClassParent` but most extern classes have no parent set. When the chain terminates, Object.prototype methods like `hasOwnProperty`, `toString` aren't found.

**File: `src/codegen/index.ts`**

- Function `registerBuiltinExternClasses` (line ~9389): After registering Set, Map, WeakMap, WeakSet, add a base "Object" extern class registration if not already present:
  ```typescript
  if (!ctx.externClasses.has("Object")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("hasOwnProperty", externMethod(1));
    methods.set("isPrototypeOf", externMethod(1));
    methods.set("propertyIsEnumerable", externMethod(1));
    methods.set("toString", externMethod(0));
    methods.set("valueOf", externMethod(0));
    methods.set("toLocaleString", externMethod(0));
    ctx.externClasses.set("Object", {
      importPrefix: "Object",
      namespacePath: [],
      className: "Object",
      constructorParams: [],
      methods,
      properties: new Map([["constructor", { type: { kind: "externref" }, readonly: true }]]),
    });
  }
  ```

- After all extern class registrations, set "Object" as the terminal parent for any extern class that has no parent:
  ```typescript
  for (const [className] of ctx.externClasses) {
    if (className !== "Object" && !ctx.externClassParent.has(className)) {
      ctx.externClassParent.set(className, "Object");
    }
  }
  ```

**File: `src/codegen/expressions.ts`**

- Function `findExternInfoForMember` (line ~16537): No changes needed — it already walks `externClassParent`, so once "Object" is set as the terminal parent, it will find Object.prototype methods automatically.

- Function `collectUsedExternImports` (line ~9856): The `resolveExtern` helper already walks `externClassParent`, so Object methods will be collected when used. However, we need to register the host imports for `Object_hasOwnProperty`, `Object_toString`, etc.

**File: `src/runtime.ts`**

- Add host imports for Object.prototype methods via the extern class pattern:
  ```typescript
  if (name === "Object_hasOwnProperty")
    return (obj: any, key: any) => Object.prototype.hasOwnProperty.call(obj, key) ? 1 : 0;
  if (name === "Object_toString")
    return (obj: any) => Object.prototype.toString.call(obj);
  if (name === "Object_valueOf")
    return (obj: any) => Object.prototype.valueOf.call(obj);
  if (name === "Object_isPrototypeOf")
    return (obj: any, candidate: any) => Object.prototype.isPrototypeOf.call(obj, candidate) ? 1 : 0;
  if (name === "Object_propertyIsEnumerable")
    return (obj: any, key: any) => Object.prototype.propertyIsEnumerable.call(obj, key) ? 1 : 0;
  if (name === "Object_toLocaleString")
    return (obj: any) => Object.prototype.toLocaleString.call(obj);
  ```

**Important**: The existing `hasOwnProperty` / `propertyIsEnumerable` early-out at expressions.ts:10553 handles these generically for all types. WI2 is specifically for the extern class dispatch path that runs AFTER line 10557 (`isExternalDeclaredClass`). The early-out catches these before extern dispatch, but not all callers go through that path. The Object extern class ensures any remaining paths resolve correctly.

**Edge cases:**
- `Object.create(null)` results have no prototype — these are externref objects where `hasOwnProperty` should still work via the host import
- Extern classes that explicitly define `toString` (like Date) should shadow the Object version — already handled by `findExternInfoForMember` walking the chain top-down

### WI3: Host-delegated method calls for unresolvable methods (~500 tests)

**Problem**: When a method call like `obj.method()` can't be resolved to any Wasm function, the compiler falls through to the final `any/externref` fallback at expressions.ts:11455. This path only handles specific methods (next, return, throw for generators). For other methods, it falls further into generic patterns that often produce wrong results.

**File: `src/codegen/expressions.ts`**

- After line ~11545 (end of generator protocol handlers in the any/externref fallback), add a generic `__extern_method_call` host import dispatch:
  ```typescript
  // Generic method call on externref: delegate to host
  const externCallIdx = ensureLateImport(ctx, "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],  // obj, methodName, argsArray
    [{ kind: "externref" }]);
  ```

- Compile: push receiver as externref, push method name as string constant, build a JS array of arguments via `__js_array_new` + `__js_array_push` (already exist), call `__extern_method_call`.

**File: `src/runtime.ts`**

- Add the host import:
  ```typescript
  if (name === "__extern_method_call")
    return (obj: any, method: string, args: any[]) => {
      if (obj == null) throw new TypeError("Cannot read properties of null");
      const fn = obj[method];
      if (typeof fn !== "function") throw new TypeError(`${method} is not a function`);
      return fn.apply(obj, args ?? []);
    };
  ```

**Key decision**: This is the "escape hatch" for any method call that can't be statically resolved. It's intentionally broad — covers `obj.toString()`, `obj.valueOf()`, `obj.hasOwnProperty(k)`, and any other method. WI1 and WI2 provide faster static paths for common cases; WI3 is the general fallback.

**Edge cases:**
- Method returns a primitive (number, boolean) — the externref return needs to be unboxed at the call site if the TS return type is f64/i32
- Method returns void — caller should handle null externref result
- Method throws — exception propagation works naturally through the host boundary

### WI4: Property access chain fallback via host import (~400 tests)

**Problem**: Property access on class instances fails when the property is not a direct struct field. The #799b code at property-access.ts:1368 has a prototype chain walk, but it requires `__proto__` fields which don't exist. However, the `__extern_get` host import IS available and works for externref objects.

**File: `src/codegen/property-access.ts`**

- At the end of `compilePropertyAccess` (around line ~1460, after the #799b chain walk), when field is not found on the struct AND there's no `__proto__` field, add a direct `__extern_get` fallback:
  - Coerce the object to externref (via `extern.convert_any`)
  - Call `__extern_get(obj_extern, propName_string) -> externref`
  - Unbox the result if needed (f64/i32)

- This is simpler than the #799b chain walk code because it delegates to the host, which handles the full prototype chain natively.

**Current state**: The #799b code at line 1373 checks `protoFieldIdx !== -1` — since no structs have `__proto__`, this condition is always false. The fallback below it (line ~1460+) either returns a default value or falls through to other handlers. The fix is to add the `__extern_get` path when `protoFieldIdx === -1`.

**Wasm IR pattern:**
```wasm
;; obj is (ref $MyClass) on stack
extern.convert_any          ;; → externref
global.get $str_propName    ;; → externref (string constant)
call $__extern_get          ;; → externref (property value)
;; optionally: call $__unbox_number if f64 expected
```

**Key insertion point**: After line 1366 (`return fieldType;`), when `fieldIdx === -1` and `protoFieldIdx === -1`:
```typescript
// No field found, no __proto__ field — use host import fallback
const getIdx = ensureLateImport(ctx, "__extern_get",
  [{ kind: "externref" }, { kind: "externref" }],
  [{ kind: "externref" }]);
flushLateImportShifts(ctx, fctx);
if (getIdx !== undefined) {
  compileExpression(ctx, fctx, expr.expression);
  // coerce to externref...
  addStringConstantGlobal(ctx, propName);
  // call __extern_get...
  return { kind: "externref" };
}
```

**Edge cases:**
- Property access on `null` — should throw TypeError, need null check before `extern.convert_any`
- Property returns undefined — externref null is fine
- Computed property access (`obj[expr]`) — different code path, not affected by this WI

### WI5: instanceof robustness for host/Wasm boundary (~300 tests)

**Problem**: `x instanceof MyClass` works when `x` is a known struct ref, but fails when `x` is externref (came from a host call, was stored as any, etc.). The externref path at typeof-delete.ts:296 converts to anyref and does `ref.test`, but this fails for objects that are genuinely externref JS objects representing Wasm struct instances (round-tripped through host).

**File: `src/codegen/typeof-delete.ts`**

- Function `compileInstanceOf` (line ~252): The externref path (line 301) does `any.convert_extern` + `ref.test`. This IS correct for Wasm structs that were exported as externref. The issue is more subtle:

  1. When both sides are known classes, the __tag comparison works. ✓
  2. When LHS is externref and RHS is a known class, the `any.convert_extern` + `ref.test` + `__tag` check works if the externref wraps a Wasm struct. ✓
  3. When RHS is NOT a known class, it falls through to `compileHostInstanceOf` which uses `__instanceof(value, ctorName)`. ✓
  4. **Missing**: When LHS is a Wasm struct ref but RHS is ambiguous (could be a known class via class expression, or could be a host class), the compiler may incorrectly resolve or fail to resolve the RHS.

- The main fix: Improve `resolveInstanceOfRHS` (expressions.ts:1706) to also check `ctx.classExprNameMap` more aggressively and to handle cases where the RHS is a variable holding a class reference.

- Secondary fix: In `compileInstanceOf`, when the tag comparison returns false (tags don't match), instead of returning false immediately, also try the host `__instanceof` as a secondary check. This handles cases where the Wasm struct was created by a different compilation unit or where the class hierarchy is incomplete.

**File: `src/codegen/expressions.ts`**

- Function `resolveInstanceOfRHS` (line ~1706): After checking `ctx.classTagMap` and `ctx.classExprNameMap`, also check if the RHS identifier resolves to a known extern class. If so, use `compileHostInstanceOf` instead of the struct tag path.

**Wasm IR pattern (fallback for ambiguous instanceof):**
```wasm
;; After tag comparison returns false:
local.get $lhs
extern.convert_any              ;; → externref
global.get $str_className       ;; → externref  
call $__instanceof              ;; → i32
local.get $tag_result
i32.or                          ;; combine struct check with host check
```

**Edge cases:**
- `null instanceof X` → false (already handled)
- `primitive instanceof X` → false (already handled at line 360)
- `x instanceof function() {}` → compileHostInstanceOf handles this

### WI6: Method inheritance propagation completeness (~300 tests)

**Problem**: The method propagation at index.ts:10540-10570 copies parent methods to child class funcMap entries. However, several edge cases are missed:

1. Methods with underscores in names are only inherited if `classMethodSet.has(key)` (line 10562), which may not be set for the parent.
2. Accessor inheritance (getters/setters) only checks `ownAccessorNames` but not nested accessors.
3. Class expressions assigned to variables don't always propagate methods correctly.

**File: `src/codegen/index.ts`**

- Function `registerClassType` method inheritance section (line ~10510-10570):
  - Remove the special-casing for underscore-containing method names (line 10552-10565). Treat all methods uniformly: if the parent has `funcMap[ParentClass_method]` and the child doesn't have `funcMap[ChildClass_method]`, inherit it.
  - Current code:
    ```typescript
    } else if (!suffix.includes("_")) {
      // Regular method (no underscores in method name)
      ...
    } else {
      // Method name contains underscore — still inherit it
      ...classMethodSet.has(key)...
    }
    ```
  - Simplified to:
    ```typescript
    } else {
      // Regular method — inherit from parent
      const childFullName = `${className}_${suffix}`;
      if (!ownMethodNames.has(suffix) && !ctx.funcMap.has(childFullName)) {
        ctx.funcMap.set(childFullName, funcIdx);
        ctx.classMethodSet.add(childFullName);
      }
    }
    ```

- Additionally, ensure `classMethodSet` is populated for ALL instance methods during registration (not just the first branch). Currently line 10362 adds to `classMethodSet` only during method declaration processing. But inherited methods may not get added if the parent wasn't processed first. The inheritance loop should always add to `classMethodSet`.

**Edge cases:**
- Diamond inheritance (via mixins) — not supported in ES classes, but TypeScript allows it via declaration merging. Stick with single-parent chain.
- Method override with different signature — child's override should shadow parent. Already handled by `!ownMethodNames.has(suffix)` check.
- Abstract methods — should NOT be inherited (no body). Already skipped at line 10349.

### Test files to verify

Each WI can be verified with targeted test262 categories:

- **WI1**: `test/built-in/Object/prototype/toString/`, `test/built-in/Object/prototype/valueOf/`, `test/built-in/Object/prototype/hasOwnProperty/`
- **WI2**: `test/built-in/RegExp/prototype/`, `test/built-in/Set/prototype/`, `test/built-in/Map/prototype/`
- **WI3**: Generic method calls — `test/language/expressions/call/`
- **WI4**: Property access — `test/language/expressions/property-accessors/`, `test/built-in/Object/getPrototypeOf/`
- **WI5**: `test/language/expressions/instanceof/`
- **WI6**: `test/language/statements/class/subclass/`

### Risks and conflicts

- **#797 conflict**: WI4 (property access fallback) touches property-access.ts which #797 also modifies for property descriptors. Coordinate: WI4's changes are in `compilePropertyAccess` around line 1366, while #797 touches `buildShapePropFlagsTable` and `__getOwnPropertyDescriptor` — no direct overlap, but need to merge carefully.
- **#802 overlap**: WI4 provides a host-import fallback for prototype property access that partially overlaps with #802's planned `__proto__` field approach. This is intentional — the host-import fallback works NOW, and #802 can later add the pure-Wasm fast path.
- **Regression risk**: WI1 adds a new fallback in the method call path for known classes. Must ensure it only fires when no other path handles the method (toString, valueOf). The existing toString/valueOf handlers at expressions.ts:11398/11451 should be checked — they may duplicate the WI1 fallback. WI1 should be placed BEFORE line 10802 (callable property check) but AFTER the inheritance walk, and should use `return` to prevent double-handling.
- **Performance**: WI3's `__extern_method_call` is a heavy host import (builds JS array for args). This is acceptable as a last-resort fallback. Hot paths (WI1, WI2) use cheaper single-purpose host imports.

### Implementation order

**WI6 → WI1 → WI2 → WI4 → WI5 → WI3**

- WI6 (method inheritance) is safest and most self-contained — fix the propagation logic first
- WI1 (Object.prototype fallback) gives the biggest test improvement
- WI2 (extern class inheritance) builds on WI1's patterns
- WI4 (property access) is independent but higher risk (touches hot path)
- WI5 (instanceof) is independent and moderate risk
- WI3 (generic host dispatch) is the catch-all and should be done last

## Suspended Work

- **Branch**: `issue-799-prototype-chain`
- **Worktree**: `/workspace/.claude/worktrees/issue-799`
- **Commit**: `514d9b91` (merged main)
- **Status**: WI1, WI2, WI3, WI4, WI6 implemented and committed. WI5 (instanceof robustness) NOT implemented. Zero equivalence test regressions (29 failed / 137 passed — same as main). All 5 issue-799-specific tests pass. Branch ready for test-and-merge.
- **Resume steps**: Enter worktree, optionally implement WI5 (instanceof in typeof-delete.ts), or proceed directly to test-and-merge.
