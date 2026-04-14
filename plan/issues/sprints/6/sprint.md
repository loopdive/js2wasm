# Sprint 6

**Date**: 2026-03-13
**Goal**: Test262 expansion, generator fixes, test infrastructure, equivalence tests
**Baseline**: building on Sprint 5

## Issues
- #121 — Function.prototype.apply() with array literal args
- #138, #139 — valueOf/toString coercion equivalence tests
- #141, #143, #165 — Tagged template, for-loop, function hoisting tests
- #142, #190 — Destructuring assignment patterns and array destructuring
- #146, #176 — Unknown identifier resolution, unicode escape in property names
- #147, #149 — Function.name property, additional call expression patterns
- #179 — Generator yield in module mode
- #182 — Arrow function closure type coercion
- #188, #189 — instanceof compile errors, new.target meta-property
- #194, #198, #199 — Various compile error fixes
- #201, #202 — Object.keys/values/entries, var hoisting tests
- #227, #228, #237 — BigInt comparison/equality tests, i64 boxing/unboxing
- #229, #230 — Global index corruption fix, computed property variable keys
- #232, #241 — Module-level object literal methods, yield-as-identifier
- #243, #249 — Array destructuring assignment, typeof Math constants
- #261, #267 — Class name resolution, yield diagnostics
- #279 — Module-level arrow functions with default params
- #287 — Generator function expressions and class methods
- #288 — try/catch/finally runs finally on exception
- #291 — in operator fallback with variable keys
- #300 — Struct ref in template expressions toString coercion
- #305 — ref/ref_null type mismatch resolution
- #307 — Promise.resolve/reject/new
- #309-#314 — Test262 harness expansion (new categories, profiling)
- #318 — Infer parameter types from call-site arguments
- #319 — Inline single-use function type signatures in WAT
- #320 — Dead import and type elimination

## Results
**Final numbers**: significant test262 category expansion
**Delta**: 80+ issues resolved across Sprint 5-6 session

## Notes
- Massive productivity day — largest single-day issue count
- Test262 runner expanded with negative test support, new categories, compile profiling
- Generator functions fully working after yield/return fixes

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #121 | Issue 121: Function.prototype.call/apply | low | done |
| #147 | Function.name property | medium | done |
| #176 | Bug: Unicode escape sequences in property names not resolved | low | done |
| #179 | Generator functions: yield in module mode errors | low | done |
| #182 | Arrow function closure type coercion errors | low | done |
| #188 | `instanceof` operator: 20 compile errors | low | done |
| #189 | `new.target` meta-property: 7 compile errors | low | done |
| #194 | Logical assignment operators compile errors | low | done |
| #198 | Switch statement compile errors and failures | low | done |
| #199 | Labeled statements: 5 compile errors | low | done |
| #201 | Object.keys/values/entries: 24 compile errors | low | done |
| #314 | Issue #314: Performance -- compile time profiling and optimization | low | done |
| #320 | [ts2wasm] Codegen: Dead import and type elimination | medium | done |
| #812 | - Test262Error 'no dependency provided for extern class' (801 tests) | critical | done |
| #813 | - gen.next is not a function (1,164 tests) | critical | done |
| #814 | - ArrayBuffer 'no dependency provided for extern class' (413 tests) | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->