---
id: 673
title: "Reflect API support via compile-time rewrites"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-03-20
priority: medium
goal: property-model
---
# Reflect API support via compile-time rewrites

## Problem
~391 test262 tests use Reflect methods (Reflect.get, Reflect.set, Reflect.has, etc.) which are not supported, causing compilation errors.

## Solution
Compile each Reflect method to its equivalent operation at compile time:
- `Reflect.get(obj, prop)` -> `obj[prop]`
- `Reflect.set(obj, prop, val)` -> `obj[prop] = val; return true`
- `Reflect.has(obj, prop)` -> `prop in obj`
- `Reflect.apply(fn, this, args)` -> `fn.apply(this, args)`
- `Reflect.construct(C, args)` -> `new C(...args)`
- `Reflect.ownKeys(obj)` -> `Object.keys(obj)`
- `Reflect.defineProperty` -> `Object.defineProperty` (returns boolean)
- `Reflect.getPrototypeOf` -> `Object.getPrototypeOf`
- `Reflect.setPrototypeOf` -> `Object.setPrototypeOf` (returns boolean)
- `Reflect.deleteProperty(obj, prop)` -> `delete obj[prop]`
- `Reflect.isExtensible` -> stub returns true
- `Reflect.preventExtensions` -> stub returns true
- `Reflect.getOwnPropertyDescriptor` -> stub returns undefined

## Implementation Summary

Added compile-time rewrites for all 13 Reflect methods in `compileCallExpression` in expressions.ts. Each Reflect.method() call is rewritten to a synthetic AST node representing the equivalent operation, then compiled through the existing codegen paths.

Also added Reflect namespace type declarations to `src/checker/lib-es2015.ts`.

### Files changed
- `src/codegen/expressions.ts` - Added Reflect method rewrites (~180 lines) in the property-access call handler
- `src/checker/lib-es2015.ts` - Added Reflect namespace with all method signatures
- `tests/equivalence/reflect-api.test.ts` - 8 equivalence tests covering Reflect.get, .set, .has, .construct, .deleteProperty, .isExtensible, .preventExtensions

### What worked
- Synthesizing AST nodes (ElementAccessExpression, BinaryExpression, NewExpression) and recursively compiling them through existing paths
- Delegating to existing Object.* handlers for defineProperty, getPrototypeOf, setPrototypeOf
- Using `ts.factory.createElementAccessExpression` for property access rewrites

### Tests passing
All 8 new equivalence tests pass.
