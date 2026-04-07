---
title: "Sprint 2: Eliminate remaining runtime failures and reduce compile errors"
status: done
sprint: Session
---
# Sprint 2: Eliminate remaining runtime failures and reduce compile errors

## Sprint Goal

Fix all 167 remaining test262 runtime failures (achieving ~100% pass rate on compilable tests) and reduce compile errors by ~500+, moving from 1,509 passing to ~2,000+ passing tests.

## Current Baseline (from test262-results.jsonl, 2026-03-11)

- **Pass: 1,509** | **Fail: 167** | **Compile Error: 5,700** | **Skip: 13,437**
- Pass rate of compilable tests: 90.0% (1,509 / 1,676)
- Pass rate of all non-skipped: 20.4%
- Total test files: 20,813

## Issue List

### Group A: Runtime failures (P0) -- 167 failures to zero

These tests compile and run but produce wrong results. Highest ROI since they are closest to passing.

| #   | Title | Complexity | Failures Fixed | Priority |
| --- | ----- | ---------- | -------------- | -------- |
| [214](issues/214.md) | Bug: unicode escape in member-expr-ident-name (44 fails) | S | ~44 | P0 |
| [208](issues/208.md) | Bug: comparison operators valueOf + BigInt (24 fails) | M | ~24 | P0 |
| [212](issues/212.md) | Bug: object computed property name expressions (15 fails) | M | ~15 | P0 |
| [207](issues/207.md) | Bug: class statement/expression runtime failures (14 fails) | M | ~14 | P0 |
| [209](issues/209.md) | Bug: for-loop label/function edge cases (8 fails) | S | ~8 | P0 |
| [210](issues/210.md) | Bug: for-of destructuring runtime failures (7 fails) | M | ~7 | P0 |
| [211](issues/211.md) | Bug: function statement runtime failures (7 fails) | S | ~7 | P0 |
| [177](issues/177.md) | Bug: spread operator in new expressions (6 fails) | M | ~6 | P0 |
| [141](issues/141.md) | Bug: tagged template literal failures (carryover, 6 fails) | S | ~6 | P0 |
| [175](issues/175.md) | Bug: negative zero not preserved in arithmetic (3 fails) | S | ~3 | P0 |
| [213](issues/213.md) | Bug: while/do-while loop condition edge cases (4 fails) | XS | ~4 | P0 |
| [185](issues/185.md) | Bug: unary plus on non-numeric types (2 fails) | S | ~2 | P1 |
| [186](issues/186.md) | Bug: typeof null returns wrong value (2 fails) | XS | ~2 | P1 |

**Subtotal: 13 issues, targeting all 167 runtime failures**

### Group B: High-impact compile error fixes (P1) -- unlock most new passing tests

| #   | Title | Complexity | Errors Fixed | Priority |
| --- | ----- | ---------- | ------------ | -------- |
| [203](issues/203.md) | LEB128 encoding overflow for large type indices | S | ~20 | P0 |
| [184](issues/184.md) | Function arity mismatch: missing argument padding | M | ~15 | P0 |
| [180](issues/180.md) | JS var re-declaration type mismatch | S | ~26 | P1 |
| [190](issues/190.md) | Unsupported assignment target patterns (destructuring) | L | ~136 | P1 |
| [195](issues/195.md) | Prefix/postfix increment/decrement on property access | M | ~44 | P1 |
| [182](issues/182.md) | Arrow function closure type coercion errors | M | ~12 | P1 |
| [196](issues/196.md) | Try/catch/finally: catch variable typing | M | ~40 | P1 |
| [183](issues/183.md) | Template literal type coercion wasm errors | S | ~6 | P1 |
| [193](issues/193.md) | Coalesce operator wasm type mismatch | S | ~7 | P1 |
| [200](issues/200.md) | JSON.parse/stringify compile errors | S | ~24 | P1 |
| [205](issues/205.md) | String.prototype.indexOf type coercion | S | ~5 | P2 |
| [181](issues/181.md) | new Object() constructor support | S | ~39 | P2 |

**Subtotal: 12 issues, ~374 compile errors targeted**

### Group C: Test infrastructure improvements (P1)

| #   | Title | Complexity | Tests Unlocked | Priority |
| --- | ----- | ---------- | -------------- | -------- |
| [187](issues/187.md) | String prototype methods: refine skip filter | S | ~400 | P1 |
| [191](issues/191.md) | assert not found: fix test wrapper assert replacement | S | ~40 | P1 |

**Subtotal: 2 issues, ~440 tests unlocked from skip to compilable**

### Group D: Deferred Sprint 1 carryovers (P2)

| #   | Title | Complexity | Impact | Priority |
| --- | ----- | ---------- | ------ | -------- |
| [140](issues/140.md) | Bug: object computed property names (carryover) | M | ~2 fails | P2 |
| [142](issues/142.md) | Bug: assignment destructuring (carryover) | M | ~4 fails | P2 |
| [197](issues/197.md) | Statement-level if compile errors | S | ~6 CE | P2 |

**Subtotal: 3 issues**

## Total: 30 issues

## Developer Worktree Grouping

Issues grouped by code area to minimize merge conflicts:

1. **Unicode/property resolution** (1 dev): #214, #176 (property name decoding)
2. **Comparison/coercion** (1 dev): #208, #174 (comparison operators, BigInt)
3. **Object/class codegen** (1 dev): #212, #207, #140 (computed props, class runtime)
4. **Loop/control flow** (1 dev): #209, #213, #210 (for-loop, while, for-of)
5. **Function codegen** (1 dev): #211, #184, #177, #141 (function edge cases, arity, spread, templates)
6. **Binary emitter** (1 dev): #203, #178 -- separate from codegen, safe to parallelize
7. **Assignment/operators** (1 dev): #190, #195, #142 (destructuring, increment, assignment targets)
8. **Type coercion** (1 dev): #182, #183, #193, #185, #186, #175 (wasm type mismatches)
9. **Test infrastructure** (1 dev): #187, #191 (test262-runner.ts only, no codegen conflicts)
10. **Scope/error handling** (1 dev): #180, #196, #197 (var scope, try/catch, if)
11. **Built-in methods** (1 dev): #200, #205, #181 (JSON, indexOf, Object constructor)

## Expected Impact

| Metric | Before | After (estimated) |
| ------ | ------ | ------------------ |
| Pass | 1,509 | ~2,000+ |
| Fail | 167 | ~0 |
| Compile Error | 5,700 | ~5,200 |
| Skip | 13,437 | ~13,000 |
| Pass rate (compilable) | 90.0% | ~100% |
| Pass rate (all non-skip) | 20.4% | ~26% |

The primary goal is **100% pass rate on compilable tests** by fixing all 167 runtime failures. The secondary goal is reducing compile errors by ~500 so more tests become compilable.

## Complexity Breakdown

- **XS (< 50 lines)**: 2 issues
- **S (< 150 lines)**: 15 issues
- **M (< 400 lines)**: 10 issues
- **L (> 400 lines)**: 3 issues

Estimated total effort: ~2-3 weeks with 4-5 developers working in parallel worktrees.

## Risks and Blockers

1. **Unicode escape (#214)** is the single highest-impact fix (44 failures). It should be straightforward but touches property resolution which is pervasive.
2. **Comparison valueOf coercion (#208)** requires runtime dispatch to valueOf/toString methods on object operands. The coercion infrastructure from Sprint 1 (#126, #138, #139) may need extension.
3. **Assignment target patterns (#190)** is large (136 CE, L complexity). Consider splitting into array destructuring and object destructuring sub-PRs.
4. **Try/catch (#196)** has 40 CE but the catch variable typing interacts with allowJs mode -- may conflict with other type flexibility fixes.
5. **For-of destructuring (#210)** produces TypeErrors at runtime, suggesting a fundamental issue with how destructured iteration variables are handled.

## Not in Sprint (deferred to backlog)

| # | Title | Reason |
| - | ----- | ------ |
| [130](issues/130.md) | Shape inference Phase 4 | Too large, foundational |
| [146](issues/146.md) | Unknown identifier/scope (932 CE) | Very large, needs deeper design work |
| [147](issues/147.md) | Function.name property (258+ CE) | New feature, not a bug fix |
| [149](issues/149.md) | Unsupported call expression (2,675 CE) | Broadest error, needs triage into sub-issues |
| [153](issues/153.md) | Iterator protocol for destructuring | Depends on Symbol.iterator design |
| [173](issues/173.md) | Computed property names in classes (132 CE) | Medium priority, defer |
| [179](issues/179.md) | Generator yield in module mode (56 CE) | Complex TS/module interaction |
| [188](issues/188.md) | instanceof compile errors (20 CE) | Lower priority |
| [189](issues/189.md) | new.target meta-property (7 CE) | Low impact |
| [194](issues/194.md) | Logical assignment CE (34 CE) | Many overlap with other issues |
| [198](issues/198.md) | Switch statement CE (5 CE) | Low impact |
| [199](issues/199.md) | Labeled statements CE (5 CE) | Low impact |
| [201](issues/201.md) | Object.keys/values/entries CE (24 CE) | Medium impact, defer |
| [202](issues/202.md) | Variable scope/hoisting | Overlaps with #146 |
| [204](issues/204.md) | Array literal CE (15 CE) | Lower priority |
| [206](issues/206.md) | For-loop with function declarations (113 CE) | Large, defer to Sprint 3 |
