---
title: "Harvest summary — post-Sprint-40-merge 2026-04-11"
author: harvester-post-sprint-40-merge
baseline_commit: 1b7bd9ec4766be88b89988f9bac6734acfad94f4
---

# Harvest summary 2026-04-11 (post Sprint 40 merge wave)

## Inputs

- Baseline: `1b7bd9ec` (post Sprint 40 merge wave, 8 PRs landed)
- JSONL file: `benchmarks/results/test262-current.jsonl` (43,164 records)
- Pass/fail distribution:
  - **pass**: 21,190
  - **fail**: 19,298
  - **compile_error**: 1,325
  - **compile_timeout**: 12
  - **skip**: 1,339
- Total failures considered for clustering: ~20,635 (fail + compile_error + compile_timeout)

## Results

- Buckets identified (>=50 occurrences, fail-producing): ~20 gross
- Already-tracked via existing issues or in-progress tasks (deduped): 9
- **New issues filed: 11** (#1047–#1057)
- Sub-threshold patterns noted but not filed: 4
- False-positive / harness-only: 3

### New issues filed

| # | Count | Title |
|---|-------|-------|
| [1047](../issues/ready/1047.md) | 246 | Private class elements leak onto prototype (hasOwnProperty check fails) |
| [1048](../issues/ready/1048.md) | 75 | async-generator destructuring: illegal cast inside `__closure_N` |
| [1049](../issues/ready/1049.md) | 176 | Destructuring default init fn-name-cover: wrong `.name` on covered function |
| [1050](../issues/ready/1050.md) | 110 | annexB: Extension not observed when variable binding would produce early error |
| [1051](../issues/ready/1051.md) | 88 | Private static class methods: wrong return value via private-name dispatch |
| [1052](../issues/ready/1052.md) | 80 | Array destructuring ignores user-overridden `Array.prototype[Symbol.iterator]` |
| [1053](../issues/ready/1053.md) | 133 | `arguments.length` wrong in class methods with trailing-comma call sites |
| [1054](../issues/ready/1054.md) | 122 | Derived class indirect-eval supercall does not throw SyntaxError |
| [1055](../issues/ready/1055.md) | 77 | RegExp pattern modifiers: SyntaxError not thrown for invalid modifier syntax |
| [1056](../issues/ready/1056.md) | 89 | `DataView` `setUintN` / `setIntN` / `setFloatN` instance methods missing |
| [1057](../issues/ready/1057.md) | 68 | `String.prototype.split` result `constructor !== Array` |

**Total directly attributable: ~1,264 FAIL**, plus indirect unblocking (notably #1056 for downstream DataView getters that need setters to set up fixtures).

## Summary table

| Count | Status | Normalized pattern | Top path | Action |
|-------|--------|-------------------|----------|--------|
| 460 | skip | `ESN: SharedArrayBuffer (requires shared Wasm memory)` | `built-ins/Atomics/*` | **skip, tracked** (#674 — not a failure) |
| 429 | skip | `ESN: dynamic import()` | `language/expressions/dynamic-import/*` | **skip, tracked** — skip filter |
| 389 | wasm_compile | `invalid Wasm binary ... call[0] expected type externref` | `class/dstr`, `Array/prototype/reduce` | **covered**: #1040 (Array reduce/map invalid Wasm regression from #1030) |
| 386 | skip | `with statement (strict mode disallowed)` | — | **skip, tracked** — skip filter |
| 385 | wasm_compile | `object is not a function` | `Array/prototype/reduce`, `map` | **covered**: task #2 / #1030 (Array long-tail dispatch) in progress |
| 307 | assertion_fail | `returned N — assert #N (found 0 asserts in source)` | `language/*` | **harness false-positive** — do not file |
| 263 | negative_test_fail | `expected parse/early SyntaxError but compiled and instantiated` | `module-code`, `class/elements` | **covered**: #990 (early-error gaps) |
| **246** | assertion_fail | `hasOwnProperty.call(C.prototype, "foo") doesn't appear` | `class/elements` | **NEW → #1047** |
| 227 | null_deref | `dereferencing a null pointer [in test()]` | `class/dstr` | **covered**: #1024 / #1025 (dstr null-guard audit) |
| 176 | assertion_fail | `xCover.name !== xCover` | `class/dstr` | **NEW → #1049** |
| 156 | type_error | `Object.getOwnPropertyDescriptor returns data desc for functions on built-ins` | `Object/getOwnPropertyDescriptor` | **covered**: #1018 |
| 153 | illegal_cast | `illegal cast [in __closure_N()]` (class dstr mix) | `class/dstr` | partially covered by #1025; **NEW → #1048** (async-gen slice only) |
| 152 | other | `unexpected undefined AST node in compileExpression` | `class/elements` | **covered**: #984 (done) — recount suggests residuals, monitor |
| 143 | wasm_compile | `invalid Wasm binary ... __closure_N i64.mul type mismatch` | `class/async-gen-private-method yield-star` | **sub-threshold after dedupe** — noted, not filed (overlaps with #984) |
| 135 | type_error | `BindingElement with array binding pattern and initializer` | `class/dstr` | **covered**: #1025 (in progress) |
| **133** | assertion_fail | `arguments.length trailing-comma mismatch` | `language/arguments-object` | **NEW → #1053** |
| 132 | assertion_fail | `sameValue(z, ''); sameValue(initCount, 0)` | `class/dstr` | **covered**: #1024 (dstr defaults init skipped) |
| **122** | assertion_fail | `throws(SyntaxError, () => new C()) — derived class eval super` | `class/elements` | **NEW → #1054** |
| 130 | runtime_error | `Cannot convert object to primitive value` | `Array/prototype/indexOf/lastIndexOf/map` | **sub-threshold after dedupe** — overlaps with #1030, noted not filed |
| **110** | type_error | `Extension not observed when creation of variable binding would produce early error` | `annexB/eval-code` | **NEW → #1050** |
| 125 | assertion_fail | `sameValue(x,4); sameValue(y,5); sameValue(z,6)` | `class/dstr` | **covered**: #1024/#1025 |
| 124 | illegal_cast | `illegal cast [in test()]` | `Array/indexOf/lastIndexOf`, `class/dstr` | **covered**: #1030 / #820 umbrella |
| 111 | other | `L76:3 ` (empty message) | `class/dstr` | **sub-threshold** — unclear cluster, noted not filed |
| 108 | null_deref | `null deref in assert_throws()` eval-code | `language/eval-code/direct` | **covered**: #858 / #919 |
| **89** | wasm_compile | `setUint8 is not a function` | `DataView/prototype/*` | **NEW → #1056** (#969 was done but `set*` never installed) |
| **88** | assertion_fail | `sameValue(C.$(1), 1)` private static methods | `class/elements` | **NEW → #1051** |
| **80** | type_error | `Array destructuring uses overriden Array.prototype[Symbol.iterator]` | `class/dstr`, `arrow-function/dstr` | **NEW → #1052** |
| **77** | assertion_fail | `throws(SyntaxError, RegExp("(?s-s:a)"))` | `built-ins/RegExp/early-err-modifiers-*` | **NEW → #1055** |
| **75** | illegal_cast | `illegal cast [in __closure_N()] (async-gen dstr)` | `async-generator/dstr` | **NEW → #1048** |
| **68** | assertion_fail | `__split.constructor !== Array` | `String/prototype/split` | **NEW → #1057** |
| 69 | wasm_compile | `bind is not a function` | `Function/prototype/bind` | **covered**: #1038 (done) |
| 67 | other | `Expected TypeError, got Test262Error` defineProperties | `Object/defineProperties` | **covered**: #929 / #739 |
| 63 | assertion_fail | `afterDeleted, false` defineProperty | `Object/defineProperty` | **covered**: #929 / #739 |

## Observations

**Biggest surprise**: the ~9,400 "grindable assertion failures" mentioned in the brief did not materialize as a single giant bucket. They are instead distributed across dozens of sub-clusters, each in the 50–250 range, most of which are already touched by existing umbrella issues (#779, #786, #820, #846, #1024, #1025, #1030). The post-Sprint-40 queue looks healthier than expected: of the top 35 buckets, only 11 are genuinely unaddressed and above threshold.

**Two hot spots dominate the new filings**: (1) **class elements / private names** (#1047 at 246, #1051 at 88, #1054 at 122 = ~456 FAIL) — Sprint 40 closed several class-private issues but the prototype-visibility and static-dispatch corners are still wrong. (2) **destructuring fn-name-cover** (#1049 at 176) — a narrow but very uniform miscompilation affecting most `class/dstr` fn-name-cover tests at once. Both are high-leverage Sprint 41 candidates.

**New category not previously tracked**: annexB B.3.2 extension-suppression (#1050, 110 FAIL). Clean cluster, entirely in `annexB/eval-code/*`, and it plugs into the early-error infrastructure from #990. Likely a one-shot fix.

**Sprint 41 focus recommendation**: prioritize #1047 (private class elements hasOwn) and #1049 (fn-name-cover) for highest single-fix yield. Pair #1056 (DataView setters) with a scan for downstream getter tests that should flip once setters exist. Consider treating #1054 as a gate for further `eval`/early-error work since it hinges on the same infrastructure.

**Sub-threshold clusters worth keeping an eye on**: 143-count `async-gen private yield-star i64.mul wasm mismatch` and the 111-count empty-message class/dstr bucket. Neither has a clean signature yet, but both will likely crystallize into filings after Sprint 41 lands destructuring audits.
