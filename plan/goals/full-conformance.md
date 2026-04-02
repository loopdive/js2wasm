# Goal: full-conformance

**100% test262 pass rate.**

- **Status**: Blocked
- **Phase**: 6 (final — after spec-completeness)
- **Target**: 48,102 / 48,102 pass.
- **Dependencies**: `spec-completeness`

## Why

This is the north star. Full ECMAScript conformance means js2wasm can compile
any valid JavaScript/TypeScript and produce correct results, making it a
production-grade compiler.

## What remains (estimated after spec-completeness)

- Tail-end edge cases in every built-in
- Cross-realm behavior
- Annex B (legacy web) compatibility
- Module-specific tests (import/export edge cases)
- Intl (internationalization) if in scope

## Success criteria

- 48,102 / 48,102 tests pass (or equivalent if test count grows)
- Zero compile errors
- Zero runtime crashes
- All skip filters removed
