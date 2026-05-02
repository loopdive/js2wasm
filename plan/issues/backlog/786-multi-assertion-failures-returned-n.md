---
id: 786
title: "- Multi-assertion failures: returned N > 2 (~1,183 tests)"
status: ready
created: 2026-03-25
updated: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: high
goal: core-semantics
parent: 779
test262_fail: 2142
---
# #786 -- Multi-assertion failures: returned N > 2 (~1,183 tests)

## Problem

Tests fail at assertion #2 or later (returned 3, 4, 5, ...), meaning the first assertion passed but subsequent ones failed. This indicates partial correctness — the basic operation works but edge cases, side effects, or follow-up checks fail.

These are often the "easiest wins" because the core functionality is already working and only specific behaviors need fixing.

## Breakdown by category

| Category | Count |
|---------|-------|
| language/statements | 926 → ~400 (after dstr removed) |
| language/expressions | 832 → ~350 (after dstr removed) |
| built-ins/Object | 163 |
| built-ins/Array | 136 |
| built-ins/Date | 108 |
| built-ins/Set | 70 |
| built-ins/WeakMap | 42 |
| built-ins/RegExp | 42 |
| built-ins/Map | 36 |
| built-ins/WeakSet | 30 |
| Other | ~250 |

## Common sub-patterns

- **Property enumeration order** (~200): `for-in`, `Object.keys` return properties in wrong order
- **Object.defineProperty side effects** (~150): property attributes (writable, configurable, enumerable) not tracked
- **Collection iteration order** (~100): Set/Map/WeakMap iteration in wrong order or missing entries
- **Date method accuracy** (~108): `getUTCHours()`, `toISOString()` return wrong values
- **Multiple return value checks** (~150): function returns correct type but wrong value for second/third test
- **Prototype chain traversal** (~100): `hasOwnProperty` vs prototype lookup produces wrong results at deeper levels
- **RegExp exec result** (~42): match groups/indices partially correct

## Sample test files

- `test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-1.js` — mapped arguments with defineProperty
- `test/language/expressions/class/elements/multiple-stacked-definitions-rs-private-getter.js` — private getter stacking
- `test/language/expressions/less-than/bigint-and-number-extremes.js` — bigint/number comparison edge cases
- `test/language/statements/const/syntax/const-outer-inner-let-bindings.js` — const/let scope interaction
- `test/built-ins/Array/prototype/some/15.4.4.17-7-b-8.js` — Array.some with sparse holes
- `test/built-ins/Object/defineProperties/15.2.3.7-5-b-239.js` — defineProperties edge case
- `test/built-ins/Proxy/has/call-in-prototype-index.js` — Proxy has trap in prototype
- `test/built-ins/Set/prototype/forEach/iterates-values.js` — Set forEach iteration

## Fix approach

1. **Property enumeration order** — ensure insertion-order property enumeration for own properties, prototype chain order for `for-in`
2. **Property attributes** — track writable/configurable/enumerable bits in the property descriptor struct
3. **Date arithmetic** — audit Date built-in methods for correct UTC/local time conversion
4. **Collection ordering** — ensure Map/Set maintain insertion order
5. **Sparse array handling** — distinguish between `undefined` and "hole" (missing index) in array methods

## Files to modify

- `src/codegen/expressions.ts` — property enumeration, comparison operators
- `src/codegen/index.ts` — property descriptor struct, built-in method implementations
- `src/codegen/statements.ts` — for-in enumeration order

## Implementation notes (partial fix: block scope)

### Root cause: let/const shadowing in nested blocks

The compiler mapped all `let`/`const` declarations with the same name to the same
Wasm local, regardless of block scope. When an inner block declared `let x`, it
overwrote the outer `x` in `fctx.localMap`, and the outer mapping was never restored
when the block exited.

**Three scoping bugs fixed:**

1. **Block statement let/const shadowing** (`statements.ts` Block handler):
   - Added `saveBlockScopedShadows()` / `restoreBlockScopedShadows()` around block
     compilation. Before entering a block, saves localMap entries for any let/const
     names declared in the block that shadow existing variables, and removes them
     from localMap so `compileVariableStatement` allocates fresh locals. Restores
     the outer mappings when the block exits.

2. **Catch parameter scoping** (`statements.ts` try/catch handler):
   - `catch (e)` creates a block-scoped binding for `e`. `allocLocal` was called
     for the catch variable without saving the previous localMap entry. Added
     save/restore of the catch variable's localMap entry around the catch clause.

3. **For-loop let/const initializer scoping** (`statements.ts` compileForStatement):
   - `for (let x = ...; ...)` creates a scope that ends after the loop. The
     initializer's `let`/`const` declarations now save/restore localMap entries
     to avoid leaking into outer scope.

### Tests added
- `tests/issue-786.test.ts`: 6 tests covering basic shadowing, nested shadowing,
  inner value access, var non-scoping, for-loop scope, and catch parameter scope.

### Test262 impact
- All 15 `block-scope/shadowing/` tests now pass (previously several failed)
- All `block-scope/leave/` tests with let shadowing now pass
- Estimated impact: fixes a portion of the ~1,183 multi-assertion failures where
  the first assertion passes but later assertions fail because outer-scope variables
  were corrupted by inner block declarations

## Implementation notes (closure capture fix for methods)

### Root cause: object/class methods missing captured variable promotion

The dominant pattern in multi-assertion failures (1,332 out of 1,504 tests involving
`callCount` checks) is that **object literal methods and class methods** compiled as
separate Wasm functions cannot read/write variables from the enclosing function scope.

**Two bugs found and fixed:**

1. **Object literal method closures** (`literals.ts`):
   - `compileObjectLiteral` called `promoteAccessorCapturesToGlobals` for getter/setter
     accessors (lines 659, 740) but NOT for regular method declarations.
   - Fix: added `promoteAccessorCapturesToGlobals(ctx, fctx, prop.body)` before
     compiling method bodies.

2. **Nested class method closures** (`statements.ts` + `index.ts`):
   - Classes inside function bodies had their method bodies compiled eagerly during
     the top-level `compileClassesFromStatements` pass, BEFORE the enclosing function's
     local map existed. Variable references silently auto-allocated separate locals
     (via the fallback in `compileExpression`), breaking the capture link.
   - Fix: `compileClassesFromStatements` now takes an `insideFunction` flag. When true,
     class body compilation is deferred (class name added to `ctx.deferredClassBodies`).
     `compileNestedClassDeclaration` (called during enclosing function's body compilation)
     detects deferred classes, promotes captures via `promoteAccessorCapturesToGlobals`,
     then compiles the bodies with the enclosing function's locals available.

### Mechanism: `promoteAccessorCapturesToGlobals`
- Scans method body for referenced identifiers
- For each name matching an enclosing local, creates a mutable Wasm global
- Copies local value into global (`local.get` + `global.set`)
- Removes name from enclosing `localMap` so all subsequent code (both enclosing
  function and method body) uses `global.get`/`global.set`
- This creates a shared-state two-way link between the enclosing function and method

### Test262 impact
- 1,332 tests fail on `callCount` assertion (the method body increments `callCount`
  but the outer scope never sees the update)
- Top categories fixed: `class/dstr` (524 tests), `object/dstr` (166), `function/dstr` (51),
  `generators/dstr` (55), `arrow-function/dstr` (30), `async-generator/dstr` (81)
- Estimated total fix: ~900+ tests (those where callCount is the only failing assertion)
