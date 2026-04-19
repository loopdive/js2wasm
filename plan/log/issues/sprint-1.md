---
title: "Sprint 1: Fix test262 failures and reduce compile errors"
status: done
sprint: 0
---
# Sprint 1: Fix test262 failures and reduce compile errors

## Sprint Goal

Eliminate the 146 test262 runtime failures (achieving 100% pass rate on compilable tests) and reduce compile errors by ~700, moving overall pass count from ~1,021 toward ~1,700+.

## Current Baseline (from live test262 run, ~66% through categories)

- **Pass: 1,021** | **Fail: 146** | **Compile Error: 3,317** | **Skip: 6,250**
- Pass rate of compilable tests: 87.5% (1,021 / 1,167)
- Pass rate of all non-skipped: 9.5%

## Issue List

### Priority 1: Bug fixes (test failures) — highest impact on reliability

| #   | Title | Complexity | Failures Fixed | Priority |
| --- | ----- | ---------- | -------------- | -------- |
| [142](issues/142.md) | Bug: assignment destructuring failures | M | ~48 | P0 |
| [138](issues/138.md) | Bug: valueOf/toString coercion on comparison operators | S | ~20 | P0 |
| [140](issues/140.md) | Bug: object computed property names runtime | M | ~15 | P0 |
| [139](issues/139.md) | Bug: valueOf/toString coercion on arithmetic operators | S | ~8 | P0 |
| [143](issues/143.md) | Bug: for-loop edge cases | S | ~8 | P0 |
| [165](issues/165.md) | Bug: function statement hoisting and edge cases | S | ~7 | P0 |
| [141](issues/141.md) | Bug: tagged template literal runtime failures | S | ~6 | P0 |
| [144](issues/144.md) | Bug: new expression with class expressions | M | ~6 | P0 |
| [166](issues/166.md) | Bug: `in` operator runtime failures | S | ~4 | P1 |
| [154](issues/154.md) | Bug: while/do-while loop condition evaluation | XS | ~4 | P1 |
| [160](issues/160.md) | Bug: Math method edge cases | XS | ~3 | P1 |
| [161](issues/161.md) | Bug: compound assignment edge cases | XS | ~3 | P1 |
| [159](issues/159.md) | Bug: call expression edge cases | S | ~3 | P1 |
| [170](issues/170.md) | Bug: class expression/declaration edge cases | S | ~3 | P1 |
| [167](issues/167.md) | Bug: typeof edge cases | XS | ~2 | P1 |
| [155](issues/155.md) | Bug: logical-and/logical-or short-circuit | XS | ~2 | P1 |
| [168](issues/168.md) | Bug: equality operators with null/undefined | XS | ~2 | P1 |
| [171](issues/171.md) | Bug: Boolean() edge cases | XS | ~2 | P1 |
| [158](issues/158.md) | Bug: concatenation with non-string operands | XS | ~1 | P2 |
| [156](issues/156.md) | Bug: conditional (ternary) expression evaluation | XS | ~1 | P2 |
| [157](issues/157.md) | Bug: void expression returns wrong value | XS | ~1 | P2 |
| [162](issues/162.md) | Bug: switch statement matching | XS | ~1 | P2 |
| [163](issues/163.md) | Bug: return statement edge cases | XS | ~1 | P2 |
| [164](issues/164.md) | Bug: variable declaration edge cases | XS | ~1 | P2 |
| [169](issues/169.md) | Bug: arrow function edge case | XS | ~1 | P2 |
| [172](issues/172.md) | Bug: Array.isArray edge case | XS | ~1 | P2 |

**Subtotal: 26 issues, ~154 failures fixed**

### Priority 2: Compile error reduction — unlocks new passing tests

| #   | Title | Complexity | Errors Fixed | Priority |
| --- | ----- | ---------- | ------------ | -------- |
| [145](issues/145.md) | allowJs type flexibility: boolean/string/void as number | M | ~497 | P0 |
| [148](issues/148.md) | Element access (bracket notation) on struct types | S | ~96 | P1 |
| [150](issues/150.md) | ClassDeclaration in expression positions | S | ~41 | P1 |
| [152](issues/152.md) | Setter return value error in allowJs mode | XS | ~28 | P2 |
| [151](issues/151.md) | `this` keyword in class methods for test262 | S | ~35 | P1 |

**Subtotal: 5 issues, ~697 compile errors resolved**

## Total: 31 issues

## Expected Impact

| Metric | Before | After (estimated) |
| ------ | ------ | ------------------ |
| Pass | ~1,021 | ~1,700+ |
| Fail | ~146 | ~0 |
| Compile Error | ~3,317 | ~2,620 |
| Pass rate (compilable) | 87.5% | ~100% |
| Pass rate (all non-skip) | 9.5% | ~16% |

The primary goal is **100% pass rate on compilable tests** by fixing all 146 runtime failures. The secondary goal is reducing compile errors by ~700 so that more tests become compilable (and many of those should pass immediately).

## Complexity Breakdown

- **XS (< 50 lines)**: 14 issues — quick wins, 1-2 hours each
- **S (< 150 lines)**: 12 issues — half-day each
- **M (< 400 lines)**: 5 issues — 1-2 days each

Estimated total effort: ~2-3 weeks for one developer, or ~1 week with 2-3 developers.

## Risks and Blockers

1. **Assignment destructuring (#142)** is the largest failure bucket (48 tests). Root cause analysis is needed — it may turn out to be multiple sub-issues.
2. **allowJs type flexibility (#145)** is the highest-impact compile error fix but requires careful design to avoid breaking TypeScript strict mode.
3. **valueOf/toString coercion (#138, #139)** touches the core expression codegen and may require refactoring how operand types are resolved.
4. **Tester agent issues**: The tester agent is creating additional issues (138+) concurrently. Some may overlap with issues created here. Dedup needed when tester completes.
5. **Test run incomplete**: The test262 run was only ~66% complete when this analysis was done. The remaining 34% (built-ins/String, Map, Set, Promise, JSON) may reveal additional failures, but those categories are likely dominated by skips.

## Not in Sprint (deferred to backlog)

| # | Title | Reason |
| - | ----- | ------ |
| [130](issues/130.md) | Shape inference Phase 4 | Too large (XL), do after sprint 1 |
| [146](issues/146.md) | Unknown identifier / scope issues | 269 errors, but complex root cause analysis needed |
| [147](issues/147.md) | Function.name property | 258 errors, but new feature rather than bug fix |
| [149](issues/149.md) | Unsupported call expression patterns | 637 errors, but very broad — needs triage first |
| [153](issues/153.md) | Iterator protocol for destructuring | 67 errors, depends on Symbol.iterator design |
| [173](issues/173.md) | Computed property names in classes | 44 errors, needs design work |
