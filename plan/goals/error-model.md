# Goal: error-model

**All spec-required errors are thrown: TypeError, RangeError, SyntaxError, ReferenceError.**

- **Status**: Activatable
- **Target**: ~45% pass rate (many tests only check that errors are thrown).
- **Dependencies**: `compilable`

## Why

Thousands of test262 tests verify that operations throw the correct error type.
Currently many of these silently succeed or throw the wrong error. This goal
makes the error paths spec-compliant.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **730** | Missing exception paths (Test262Error throws) | 708 FAIL | High |
| **736** | SyntaxError detection at compile time | 316 FAIL | Medium |
| **733** | RangeError validation in built-ins | 442 FAIL | Medium |
| **723** | TDZ violations: throw ReferenceError before let/const init | 230 FAIL | High |
| **402** | Negative tests: expected SyntaxError not raised | 434 FAIL | High |
| **443** | Expected ReferenceError but succeeded | 6 FAIL | Low |
| **774** | Early error checks — tests expect SyntaxError but compile | 2,657 FAIL | High |

## Success criteria

- All negative tests (expecting parse errors) pass
- TypeError thrown for null/undefined property access
- RangeError thrown for out-of-range arguments to built-ins
- ReferenceError thrown for TDZ violations
- SyntaxError raised at compile time for spec-invalid syntax
