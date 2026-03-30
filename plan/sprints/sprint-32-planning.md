# Sprint 32 — Planning Notes

**Date**: 2026-03-29
**Participants**: PO (planning), Tech Lead (dispatch)
**Baseline**: 18,599 pass / 48,088 total (38.7%) — sprint 31 still in progress

## Goal

Cross 40% pass rate (need ~637 more passes above baseline). Sprint 31 in-progress work (#826, #854, #851, #862) should get us close; sprint 32 aims to push solidly past 40% and toward 42-43%.

## Issue validation (PO smoke-tested against current main)

| Issue | Sample test | Result | Verdict |
|-------|------------|--------|---------|
| #840 (31 CE) | concat/S15.4.4.4_A1_T3.js | RT: undefined (crash) | **REAL** — concat 0-arg still broken |
| #829 (141 CE) | assignment/target-assignment.js | PASS | **LIKELY FIXED** — 4/4 samples compile OK |
| #849 (200 FAIL) | arguments-object/mapped-arguments-nonconfigurable-2.js | CE: type mismatch | **REAL** — CE at instantiate |
| #854 (126 FAIL) | for-of/Array.prototype.entries.js | FAIL(2) | **REAL** — in sprint 31 |
| #856 (136 FAIL) | Object/defineProperties/15.2.3.7-6-a-12.js | RT: opaque | **REAL** — opaque object issue |
| #844 (85 CE) | AggregateError/cause-property.js | RT: not iterable | **REAL** — CE at new expression |
| #822 (907 CE) | class/dstr/async-gen-meth-dflt-obj-ptrn-prop-obj.js | CE: not enough args struct.new | **REAL** — still ~907 CE |
| #826 (~489 FAIL) | destructuring/initialization-returns-normal-completion.js | PASS | **PARTIAL** — some fixed, others still fail (826b: CE, 826c: illegal cast) |
| #858 (182 FAIL) | eval-code/direct/arrow-fn-...arguments-assign.js | RT: null deref | **REAL** — null pointer in eval |
| #851 (147 FAIL) | async-generator/named-yield-star-getiter-async-get-abrupt.js | PASS | **PARTIAL** — some sync paths fixed, async-gen may still fail (in sprint 31) |
| #845 (340 CE) | array/spread-err-mult-err-obj-unresolvable.js | CE: type mismatch | **REAL** — misc CE |
| #855 (210 FAIL) | Promise/all/S25.4.4.1_A1.1_T1.js | PASS (simple cases) | **PARTIAL** — simple Promise tests pass, complex async likely still fail |

## Issues to close (already fixed)

- **#829** (141 CE): All 4 sample tests compile and pass. Recommend closing with verification run.

## Prioritization rationale

**Strategy**: Focus on medium-difficulty, high-impact issues. #822 (907 CE) is the elephant but needs architect — park it for sprint 33. Stack easy/medium wins to build momentum.

**Sprint 32 picks** (ordered by value):

1. **#845** (340 CE, hard) — misc CE, multiple sub-patterns. Biggest bang. **Needs architect spec** — too many sub-patterns for a dev to triage solo.
2. **#858** (182 FAIL, medium) — eval null deref. Clear root cause (scope chain not initialized). Dev-ready.
3. **#849** (200 FAIL, medium) — mapped arguments. CE at instantiation. Clear root cause. Dev-ready but complex semantics.
4. **#856** (136 FAIL, medium) — wrong error type. Property descriptor validation. Dev-ready, coordinates with #797.
5. **#844** (85 CE, medium) — new AggregateError + primitive wrappers. Dev-ready, clear scope.
6. **#840** (31 CE, easy) — concat/push/splice 0-arg. Quick win. Dev-ready.
7. **#831** (242 FAIL, medium) — negative test gaps. SyntaxError detection. Dev-ready.
8. **#863** (70 FAIL, medium) — decodeURI failures. Clear scope.

**Total estimated impact**: ~1,200+ tests (CE + FAIL reduction)

## Feasibility assessment

| Issue | Feasibility | Needs architect? | Files touched |
|-------|------------|------------------|---------------|
| #845 | hard | **YES** — too many sub-patterns | expressions.ts, statements.ts, index.ts |
| #858 | medium | No — clear root cause | expressions.ts (eval scope chain) |
| #849 | medium | Recommended | index.ts, statements.ts (mapped arguments) |
| #856 | medium | No — descriptor validation | expressions.ts (defineProperty) |
| #844 | medium | No — add new cases | expressions.ts (NewExpression) |
| #840 | easy | No | expressions.ts (array methods) |
| #831 | medium | No — AST checks | index.ts (early error detection) |
| #863 | medium | No | runtime.ts (URI encoding) |

## Decisions

| Proposal | Decision | Rationale |
|----------|----------|-----------|
| #822 in sprint 32 | **Deferred to 33** | Still ~907 CE but repair-pass approach already failed once (+6K regression). Needs fresh architect analysis. |
| #845 needs architect | **Accepted** | 6+ sub-patterns in different codegen areas — dev needs a roadmap |
| #849 needs architect | **Recommended** | Mapped arguments is tricky (bidirectional sync, defineProperty interaction) |
| #829 close | **Accepted** | 4/4 samples pass, likely fixed by prior destructuring work |
| #855 defer | **Deferred** | Promise/async is hard, partial fixes already landed; complex remaining cases need architect |
| Max 3 dev tasks for sprint | **Accepted** | Maintain 1-task-per-dev discipline from sprint 31 |

## Task queue (2 devs)

**Dev-1 path**: #858 → #844 → #840
**Dev-2 path**: #856 → #831 → #863
**Architect**: Spec #845, then spec #849 — devs pick these up after initial tasks

| Order | Issue | Impact | Dev | Depends on | Files |
|-------|-------|--------|-----|------------|-------|
| 1 | #858 | 182 FAIL | dev-1 | — | expressions.ts |
| 2 | #856 | 136 FAIL | dev-2 | — | expressions.ts (defineProperty) |
| 3 | #844 | 85 CE | dev-1 | #858 done | expressions.ts (NewExpression) |
| 4 | #831 | 242 FAIL | dev-2 | #856 done | index.ts |
| 5 | #840 | 31 CE | dev-1 | #844 done | expressions.ts (array methods) |
| 6 | #863 | 70 FAIL | dev-2 | #831 done | runtime.ts |
| 7 | #845 | 340 CE | next avail | architect spec | expressions.ts, statements.ts |
| 8 | #849 | 200 FAIL | next avail | architect spec | index.ts, statements.ts |

## Expected impact

| Issue | Type | Est. tests fixed |
|-------|------|------------------|
| #858 | FAIL | ~120 |
| #856 | FAIL | ~100 |
| #844 | CE | ~35 |
| #831 | FAIL | ~150 |
| #840 | CE | ~31 |
| #863 | FAIL | ~50 |
| #845 (if architect specs) | CE | ~200 |
| #849 (if architect specs) | FAIL | ~150 |
| **Committed (1-6)** | | **~486 tests** |
| **Stretch (7-8)** | | **+350 tests** |
