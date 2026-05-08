---
id: 1388
sprint: ~
title: "runtime: null.next — yield* / async-generator iterator construction returns null in class methods (316 fails)"
status: ready
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators, async-generators, classes
goal: spec-completeness
---
# #1388 — `null.next`: iterator construction returns null in class-method async generators

## Problem

316 tests fail with:

```
L*:* Cannot read properties of null (reading 'next') [in test()]
```

The call to `.next()` is made on `null` — meaning the iterator object returned from
`getIterator` (the `Symbol.asyncIterator` / `Symbol.iterator` call) is null rather than a
`{next, return, throw}` object.

### Distribution (from test262-current.jsonl)

| count | category |
|------:|----------|
| 148   | language/expressions/class (async-gen-method-static, async-gen-method) |
| 125   | language/statements/class (same) |
|  12   | language/expressions/object |
|  10   | language/expressions/async-generator |
|  10   | built-ins/Iterator/prototype |
|   5   | language/expressions/generators |
|   3   | built-ins/Temporal/PlainDateTime |
|   3   | built-ins/AsyncGeneratorFunction |

273 of 316 (86%) are in class async-generator or generator methods. This strongly
suggests the root cause is in how generator/async-generator **class methods** construct
the inner iterator for `yield*` — not in standalone generators.

### Representative failing tests

```
language/expressions/class/async-gen-method-static/yield-spread-arr-single.js
language/expressions/class/async-gen-method-static/yield-star-getiter-async-returns-number-throw.js
language/expressions/class/async-gen-method-static/yield-star-getiter-sync-returns-symbol-throw.js
language/statements/class/...  (similar patterns)
```

The test names follow the pattern `yield-star-getiter-{async,sync}-returns-{type}-{throw,next}`,
which means they exercise the spec's `GetIterator` abstract operation with edge-case inputs
(returning a number, returning a symbol, etc.) and then calling `.next()` / `.throw()` on the result.

## Hypothesis

When compiling a `yield*` delegation in a class-method async generator, the code that calls
`Symbol.asyncIterator` (or `Symbol.iterator`) on the delegate expression either:

1. **Returns the raw return value of `Symbol.asyncIterator` without wrapping** — if the
   callable returns null/number/symbol, `.next` is then called on that raw value.
2. **Calls the wrong method** — e.g., calls the sync `Symbol.iterator` instead of
   `Symbol.asyncIterator` for async generators, getting back something unexpected.
3. **Class-method specific path** — standalone async generators work correctly but the
   class-method emitter has a different code path for `yield*` that misses the
   `CreateIteratorFromClosure` / iterator-wrapper step.

The fact that standalone async generators (`language/expressions/async-generator`, only 10 fails)
are mostly fine while class async generators (273 fails) are broken strongly implicates a
class-method-specific code path.

## Files to investigate

- `src/codegen/statements.ts` — `yield*` desugaring
- `src/codegen/class-bodies.ts` — async generator method emitter
- Look for differences between how `yield*` is handled in `FunctionDeclaration` async generators
  vs. `MethodDeclaration` async generators

## Acceptance criteria

1. `language/expressions/class/async-gen-method-static/yield-spread-arr-single.js` passes.
2. `language/expressions/class/async-gen-method-static/yield-star-getiter-async-returns-number-throw.js` passes.
3. Net improvement ≥ 200 tests (most of the 316 should be the same root cause).
4. No regression in standalone async generator tests.

## Estimated yield

~250–300 net (most of the 316 share the same class-method `yield*` path).
