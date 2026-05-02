---
id: 628
title: "Yield expression outside generator (283 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: generator-model
required_by: [657]
---
# Yield expression outside generator (283 CE)

## Problem

283 test262 tests fail with compilation error "yield expression outside of generator function".

The check in `compileYieldExpression` uses `ctx.generatorFunctions.has(fctx.name)` to verify yield is inside a generator. This fails when:

1. The name registered in `ctx.generatorFunctions` doesn't match `fctx.name` due to naming inconsistencies
2. Arrow functions inside generators (the arrow's fctx.name differs from the generator's)
3. Method shorthand in generator objects
4. Computed method names in generator classes

## Fix

Add `isGenerator?: boolean` flag to `FunctionContext` interface. Set it to `true` wherever `ctx.generatorFunctions.add(name)` is called. Check `fctx.isGenerator` instead of the name-based lookup.
