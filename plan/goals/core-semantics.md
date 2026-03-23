# Goal: core-semantics

**Basic operations produce correct values: arithmetic, comparison, assignment, control flow, function calls.**

- **Status**: Activatable
- **Phase**: 2 (after compilable reduces CEs)
- **Target**: Fix ~3,400 wrong-value failures. Estimated +2,500 tests.
- **Dependencies**: `compilable` (tests must compile to produce values)

## Why

The single biggest failure category is "returned 0 instead of expected value" (#513: 3,436 tests).
This means the code compiles and runs, but produces wrong results. Root causes include:
missing return values, incorrect type coercion, wrong control flow, broken scope resolution.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **513** | Wrong return value (returned 0) — umbrella | 3,436 FAIL | Critical |
| **737** | Undefined-handling edge cases | 276 FAIL | Medium |
| **139** | valueOf/toString coercion on arithmetic operators | — | Medium |
| **429** | Undeclared variable access — ReferenceError + immutable | 71 FAIL | High |
| **435** | Logical/conditional must preserve object identity | 16 FAIL | Medium |
| **374** | Miscellaneous small patterns | — | Low |
| **146** | Unknown identifier / scope issues | 269 CE | Medium |
| **266** | Unknown identifier — multi-variable patterns | — | Medium |
| **380** | Unknown variable/function in test scope | — | Medium |
| **684** | Any-typed variable inference from usage | Many CE | High |
| **771** | Arguments object incomplete | 617 FAIL | High |
| **701** | resolveWasmType infinite recursion | CE | High |

## Success criteria

- #513 triaged and top sub-categories fixed
- Correct return values for arithmetic, comparison, string operations
- Scope resolution handles all let/const/var/function patterns
- Pass rate ≥ 50%
