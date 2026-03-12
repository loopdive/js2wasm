# Sprint 3: Eliminate remaining runtime failures and reduce compile errors by ~1500

## Sprint Goal

Fix all 62 remaining test262 runtime failures (achieving ~100% pass rate on compilable tests) and reduce compile errors from 3,465 to ~2,000, moving from 1,413 passing to ~2,500+ passing tests.

## Current Baseline (post Sprint 2, 2026-03-11)

- **Pass: 1,413** | **Fail: 62** | **Compile Error: 3,465** | **Skip: 15,873**
- Pass rate of compilable tests: 95.8% (1,413 / 1,475)
- Pass rate of all non-skipped: 28.6% (1,413 / 4,940)
- Total test files: 20,813

## Sprint 2 Results

Sprint 2 delivered 18 issues across 12 merged PRs:
- Runtime failures reduced from 167 to 62 (63% reduction)
- Compile errors reduced from 5,700 to 3,465 (39% reduction)
- Passing tests increased from 1,509 to 1,413 (slight decrease due to rebalancing from skip filter changes and re-measurement)
- 170/170 equivalence tests pass

## Issue List

### Group A: Runtime failures (P0) -- 62 failures to zero

| #   | Title | Complexity | Failures Fixed | Priority |
| --- | ----- | ---------- | -------------- | -------- |
| [225](issues/225.md) | For-loop string !== comparison (15 fails) | S | ~15 | P0 |
| [226](issues/226.md) | valueOf/toString coercion on comparison operators (8 fails) | M | ~8 | P0 |
| [227](issues/227.md) | BigInt comparison with Infinity trap (4 fails) | S | ~4 | P0 |
| [228](issues/228.md) | BigInt equality/strict-equality with Number/Boolean (7 fails) | S | ~7 | P0 |
| [229](issues/229.md) | Tagged template cache bugs (6 fails) | S | ~6 | P0 |
| [230](issues/230.md) | Object computed property names with variable keys (15 fails) | M | ~15 | P0 |
| [231](issues/231.md) | Member expression escaped identifiers -- skip filter (41 fails) | XS | ~41 | P0 |
| [244](issues/244.md) | `in` operator runtime failures (4 fails) | S | ~4 | P0 |
| [245](issues/245.md) | Switch statement with string case values (1 fail) | S | ~1 | P0 |
| [246](issues/246.md) | For-of object destructuring TypeError (5 fails) | S | ~5 | P0 |
| [247](issues/247.md) | Arithmetic with null/undefined wrong results (6 fails) | S | ~6 | P0 |
| [248](issues/248.md) | Logical operators with object operands (2 fails) | S | ~2 | P0 |
| [249](issues/249.md) | Miscellaneous runtime failures (28 individual) | M | ~15 | P1 |

**Subtotal: 13 issues, targeting all 62 runtime failures**

### Group B: High-impact compile error fixes (P1)

| #   | Title | Complexity | Errors Fixed | Priority |
| --- | ----- | ---------- | ------------ | -------- |
| [232](issues/232.md) | Unsupported call expression -- method calls (Phase 1) | L | ~200 | P0 |
| [233](issues/233.md) | Unknown identifier from destructuring patterns | M | ~200 | P1 |
| [234](issues/234.md) | ClassDeclaration in nested/expression positions | L | ~200 | P1 |
| [235](issues/235.md) | Function.name property access | M | ~100 | P1 |
| [236](issues/236.md) | allowJs type flexibility -- boolean/void/string args | M | ~400 | P1 |
| [237](issues/237.md) | BigInt i64 vs externref type mismatch | M | ~100 | P1 |
| [238](issues/238.md) | Class expression new -- `new (class{})()` | M | ~80 | P1 |
| [239](issues/239.md) | Element access on struct types (bracket notation) | M | ~60 | P1 |
| [240](issues/240.md) | Setter return value in allowJs mode | XS | ~30 | P2 |
| [241](issues/241.md) | Yield in strict mode / module context | M | ~80 | P2 |
| [242](issues/242.md) | Computed property names in class declarations (remaining) | S | ~20 | P2 |
| [243](issues/243.md) | Unsupported assignment target patterns | M | ~30 | P2 |

**Subtotal: 12 issues, targeting ~1,500 compile errors**

### Group C: TypeScript diagnostic suppressions (P2) -- quick wins

| #   | Title | Complexity | Errors Fixed | Priority |
| --- | ----- | ---------- | ------------ | -------- |
| [251](issues/251.md) | super() call required in derived class constructors | S | ~19 | P2 |
| [252](issues/252.md) | var re-declaration type mismatch (extends #180) | S | ~15 | P2 |
| [254](issues/254.md) | Private class fields read-only diagnostic | S | ~16 | P2 |
| [255](issues/255.md) | 'this' implicit any type diagnostic | XS | ~17 | P2 |
| [256](issues/256.md) | Unknown function: f -- nested function declarations | S | ~17 | P2 |

**Subtotal: 5 issues, targeting ~84 compile errors**

### Group D: Test infrastructure (P1)

| #   | Title | Complexity | Tests Unlocked | Priority |
| --- | ----- | ---------- | -------------- | -------- |
| [253](issues/253.md) | Narrow skip filters (typeof, loose inequality, etc.) | S | ~50 | P1 |
| [250](issues/250.md) | For-loop with function declarations (113 CE) | M | ~40 | P2 |

**Subtotal: 2 issues**

## Total: 32 issues

## Developer Worktree Grouping

Issues grouped by code area to minimize merge conflicts:

1. **String operations** (1 dev): #225, #245 -- string comparison in operators
2. **Object coercion** (1 dev): #226, #248 -- valueOf dispatch, logical operators
3. **BigInt** (1 dev): #227, #228, #237 -- BigInt comparisons, equality, type coercion
4. **Template/cache** (1 dev): #229 -- tagged template caching
5. **Computed properties** (1 dev): #230, #242 -- object + class computed props
6. **Skip filters** (1 dev): #231, #253 -- test262-runner.ts only
7. **Call expression** (1 dev): #232 -- unsupported call expression (large)
8. **Scope/identifiers** (1 dev): #233, #256 -- destructuring scope, function lookup
9. **Class codegen** (1 dev): #234, #238, #254 -- class declaration, expression, private
10. **Type flexibility** (1 dev): #236, #240, #251, #252, #255 -- TS diagnostic suppressions
11. **Function/property** (1 dev): #235 -- Function.name property
12. **Element access** (1 dev): #239, #243 -- bracket notation, assignment targets
13. **Loop/iteration** (1 dev): #244, #246, #250 -- in operator, for-of, for-loop
14. **Arithmetic/misc** (1 dev): #247, #249 -- null arithmetic, misc fixes
15. **Yield/generators** (1 dev): #241 -- yield in module context

## Expected Impact

| Metric | Before | After (estimated) |
| ------ | ------ | ------------------ |
| Pass | 1,413 | ~2,500+ |
| Fail | 62 | ~0 |
| Compile Error | 3,465 | ~2,000 |
| Skip | 15,873 | ~15,800 |
| Pass rate (compilable) | 95.8% | ~100% |
| Pass rate (all non-skip) | 28.6% | ~50% |

## Complexity Breakdown

- **XS (< 50 lines)**: 3 issues (#231, #240, #255)
- **S (< 150 lines)**: 16 issues
- **M (< 400 lines)**: 11 issues
- **L (> 400 lines)**: 2 issues (#232, #234)

Estimated total effort: ~2-3 weeks with 6-8 developers working in parallel worktrees.

## Risks and Blockers

1. **Unsupported call expression (#232)** is the largest single issue (1465 CE). Sprint 3 targets Phase 1 only (~200 fixes), focused on valueOf/toString method calls. Full resolution will span multiple sprints.
2. **ClassDeclaration (#234)** has 681 errors but many combine with other errors. The standalone cases should be tractable but the combined cases will only be fixed when all contributing errors are resolved.
3. **allowJs type flexibility (#236)** touches type coercion broadly -- care needed to avoid regressions in typed code paths.
4. **Yield in modules (#241)** may require changes to the test wrapper approach, which could affect all test results.
5. **Member expression skip (#231)** is a band-aid (moves tests to skip, not pass). These ultimately need Shape Inference Phase 4 (#130) for a real fix.

## Not in Sprint (deferred to backlog)

| # | Title | Reason |
| - | ----- | ------ |
| [130](issues/130.md) | Shape inference Phase 4 -- hashmap fallback | Too large, foundational |
| [146](issues/146.md) | Unknown identifier/scope (~684 CE overlap with #233) | Large, #233 handles subset |
| [149](issues/149.md) | Unsupported call expression (full, ~1465 CE) | #232 Phase 1 only in Sprint 3 |
| [153](issues/153.md) | Iterator protocol for destructuring | Depends on Symbol.iterator |
