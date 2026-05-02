---
id: 987
title: "Object-literal spread/object-shape fallbacks still fail in generator and spread call sites (40 CE)"
status: done
created: 2026-04-07
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
reasoning_effort: high
goal: iterator-protocol
test262_ce: 40
---
# #987 -- Object-literal spread/object-shape fallbacks still fail in generator and spread call sites (40 CE)

## Problem

The latest full recheck (`benchmarks/results/test262-results-20260407-111308.jsonl`)
still has **40 compile errors** across two closely related messages:

```text
Cannot determine struct type for object literal
Object literal type not mapped to struct
```

These overlap conceptually with earlier object-literal issues (#113, #845), but
the remaining bucket is narrower and now source-localized.

## Breakdown

- `Cannot determine struct type for object literal` — 24 tests
- `Object literal type not mapped to struct` — 16 tests

## Representative samples

### Generator / yield-spread object literals

- `test/language/expressions/generators/named-yield-identifier-spread-non-strict.js` — `L29:9`
- `test/language/expressions/generators/yield-identifier-spread-non-strict.js` — `L29:9`
- `test/language/statements/class/gen-method/yield-spread-obj.js` — `L34:11`
- `test/language/statements/async-generator/yield-spread-obj.js` — `L30:9`

### Call/new/array spread over ad-hoc object literals

- `test/language/expressions/array/spread-err-sngl-err-obj-unresolvable.js` — `L37:4`
- `test/language/expressions/array/spread-obj-null.js` — `L41:16`
- `test/language/expressions/call/spread-obj-undefined.js` — `L39:3`
- `test/language/expressions/new/spread-err-mult-err-obj-unresolvable.js` — `L34:21`

## ECMAScript spec reference

- [§13.2.5.5 Runtime Semantics: PropertyDefinitionEvaluation — SpreadElement](https://tc39.es/ecma262/#sec-runtime-semantics-propertydefinitionevaluation) — CopyDataProperties from source
- [§7.3.25 CopyDataProperties](https://tc39.es/ecma262/#sec-copydataproperties) — copies all enumerable own properties from source to target


## Root cause

The remaining failures are not generic anonymous-object support gaps anymore.
They cluster around ad-hoc object literals used as spread sources or generator
yield operands, where the compiler still expects a pre-registered struct shape
instead of using an array-like / iterable / dynamic-object fallback.

## Suggested fix

1. Trace the two throw sites in `src/codegen/literals.ts`
2. Split handling between:
   - object literals that need real struct lowering
   - object literals used only as spread/iteration sources
3. For the spread/iteration cases, route through a dynamic-object fallback
   instead of hard-requiring a mapped struct
4. Add regression tests for:
   - `yield-spread-obj` generator cases
   - call/new/array spread with `{0: 'a', 1: 'b', length: 2}`-style objects

## Acceptance criteria

- >=28 of 40 object-literal spread/shape compile errors eliminated
- both message forms are substantially reduced in the next full recheck
