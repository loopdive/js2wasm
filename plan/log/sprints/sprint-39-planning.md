# Sprint 39 Planning Discussion

**Date**: 2026-04-06
**PO**: Product Owner agent
**Participants**: PO, Tech Lead

## Validation of Candidate Issues

### Smoke Tests Performed

| Issue | Sample Test | Result | Verdict |
|-------|-----------|--------|---------|
| #848 (class computed property) | `accessor-name-inst/computed.js` | FAIL — "returned 3 — assert #2 at L40" | **Still reproduces** |
| #846 (assert.throws) | `Object/defineProperty/15.2.3.6-1-1.js` | **PASS** (now fixed) | **Stale for this sample** — needs recount |
| #847 (for-of destructuring) | `for-await-of/async-func-decl-dstr-array-elem-init-assignment.js` | FAIL — null_deref at L30 | **Still reproduces** |
| #928 (unknown failures) | `arrow-function/dstr/dflt-ary-ptrn-elision-step-err.js` | Compiles, needs runner verification | **Likely still reproduces** |

### Current Baseline Analysis (from latest test262 run)

```
Total:  43,120
Pass:   18,408 (42.7%)
Fail:   21,652
Skip:    1,313
```

**Failure breakdown:**
| Category | Count | Top Pattern |
|----------|-------|-------------|
| assertion_fail | 8,662 | Wrong values in class/destructuring/built-ins |
| type_error | 6,368 | null/undefined property access |
| wasm_compile | 2,973 | "p.then is not a function" (1,442), "object is not a function" (629) |
| other | 1,377 | Misc runtime errors |
| null_deref | 604 | Null pointer in assert_throws |
| negative_test_fail | 577 | Expected SyntaxError but compiled |
| runtime_error | 560 | Misc traps |
| illegal_cast | 416 | ref.cast wrong type |

### Key Findings

1. **Promise .then() CEs dominate wasm_compile** — 1,648 of 2,973 CEs (55%) are "p.then is not a function" or "then is not a function". Sprint 38 attempted this 3 times (#855, #960, #961, #964) with partial success but regressions. HIGH VALUE, HIGH RISK.

2. **Array "object is not a function"** (#827) — 629 CEs, all in built-ins/Array. Straightforward: Array callback methods need proper function import registration.

3. **Class computed properties** (#848) — 1,015 FAIL. Computed property name evaluation doesn't store accessors by computed key.

4. **for-of destructuring** (#847) — 660 FAIL. Destructuring defaults not properly applied for holes/undefined.

5. **Several issues have stale data** — #846 sample now passes (some patterns fixed by sprint 38 work). #850 is `fixed-by-866`. #857 is `fixed-by-827`. These need housekeeping.

## Feasibility Assessment

| Issue | Feasibility | Needs Architect? | Risk |
|-------|-------------|-----------------|------|
| Promise .then() CE | Hard | **YES** — 3 prior attempts failed | HIGH — regression risk |
| #848 class computed | Medium | No — clear codegen fix | LOW |
| #827 Array callbacks | Medium | No — import registration fix | LOW |
| #847 for-of destructuring | Medium | Maybe — complex destructuring paths | MEDIUM |
| #971 mixed assertions | Hard | No — analysis first | MEDIUM |
| #928 unknown failures | Medium | No — investigation | LOW |
| #864 WeakMap/WeakSet | Easy | No | LOW |
| #830 DisposableStack | Easy | No — stub extern class | LOW |
| #929 ODP on non-object | Medium | No | LOW |

## Priority Ranking (by value × achievability)

1. **#827** — 629 CE, medium effort, low risk. Best CE/effort ratio.
2. **#848** — 1,015 FAIL, medium effort, low risk. Highest FAIL reduction.
3. **#847** — 660 FAIL, medium effort, medium risk.
4. **Promise .then()** — 1,648 CE potential but HIGH risk. Gate behind architect spec.
5. **#971** — 180 FAIL, needs analysis first.
6. **#928** — 209 FAIL, investigation + fix.
7. **#864** — 45 FAIL, easy quick win.
8. **#830** — 39 CE, easy stub.
9. **#929** — 53 FAIL, medium.

## Decisions

- **Promise .then() included as Phase 1 with architect gate** — will not dispatch to dev without architect spec. If architect says too risky, swap for #973 (compiler state leak, 400 false CEs).
- **Max 3 devs** to keep RAM headroom for test262.
- **Phase 1 goes first**, Phase 3 only if sprint has capacity.
- **#846 needs recount** — some patterns fixed in sprint 38. Will create updated issue after sprint starts.
- **Housekeeping**: move #850, #857 to done/ (both marked fixed-by-other-issue).
