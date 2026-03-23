# Goal: builtin-methods

**All built-in methods on Array, String, Number, Math, RegExp, Date produce correct results.**

- **Status**: Blocked
- **Phase**: 3 (after core-semantics + error-model)
- **Target**: Built-in method edge cases fixed. Estimated +1,000 tests.
- **Dependencies**: `core-semantics`, `error-model`

## Why

Built-in methods are the bread and butter of test262. Array.map, String.slice,
Number.toFixed, RegExp.exec — there are thousands of tests for edge cases in
these methods. Getting them right requires both correct return values
(core-semantics) and correct error throwing (error-model).

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **734** | Array method correctness (edge cases) | 343 FAIL | High |
| **763** | RegExp runtime methods (exec, match, replace, split) | ~400 FAIL | High |
| **731** | Function/class .name property | 558 FAIL | Medium |
| **738** | instanceof correctness | 276 FAIL | Medium |
| **385** | Array method argument count errors | — | Medium |
| **421** | Array.reduce requires callback and initial value | 23 CE | Medium |
| **312** | Test262 category expansion — Number methods | — | Low |
| **767** | Equivalence test coverage gaps (RegExp, Promise, async) | — | Medium |
| **661** | Temporal API | — | Medium |

## Success criteria

- Array methods handle sparse arrays, negative indices, type coercion
- RegExp .exec()/.test() and String regex methods work
- Function.name correct for all declaration forms
- instanceof works with class hierarchies and Symbol.hasInstance
