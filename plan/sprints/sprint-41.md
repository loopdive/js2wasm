---
title: "Sprint 41 — Pass-rate push: 51.4% → 55%"
status: planning
sprint: Sprint-41
---

# Sprint 41 — Pass-rate push: 51.4% → 55%

**Planned start**: 2026-04-12
**Starting baseline**: 22,185 / 43,171 pass = **51.40%**
**Target**: 23,700+ / 43,171 = **~55%** (+1,500 tests)
**Duration**: 1 sprint (~3 dev-days of capacity with 3 devs)

## Scope change from original plan

The original Sprint 41 was scoped as "non-error work" (stress tests, perf, infra). That scope is **deferred to Sprint 42**. Sprint 41 is now a **pass-rate push sprint** — every issue must directly flip tests from fail to pass.

Rationale: at 51.4%, there's a massive concentration of medium-effort issues in the 70-180 FAIL range that can each be shipped independently. Shipping 10-12 of these in one sprint is the fastest path to 55%.

## Sprint 40 carry-over (promoted into Sprint 41)

These were Sprint 40 issues that didn't get worked but have direct pass-rate impact:

| # | Title | Impact | Effort |
|---|-------|--------|--------|
| **#997** | BigInt ToPrimitive i64→externref wrapper | 55 CE | M |
| **#990** | Early-error gaps (reserved words, module grammar, using) | 327 FAIL | H |
| **#983** | WasmGC opaque object leak | 1,087 FAIL | H — deferred, needs architect |

## Phase 1: Quick wins (ship first — 1 dev-day)

Issues that are small, self-contained, and flip meaningful test counts.

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 1 | **#1056** | DataView set methods missing | **89 FAIL** | Easy | Just wire up set* methods mirroring existing get* — fast, mechanical |
| 2 | **#997** | BigInt ToPrimitive i64→externref CE | **55 CE** | M | Carry-over from Sprint 40, well-scoped |
| 3 | **#1057** | String.prototype.split constructor !== Array | **68 FAIL** | S | Reverted in PR #114 — 9-LOC `__extern_get` short-circuit reapply. Must verify no interaction with #1053/#1064 first |

**Phase 1 estimated impact: +150-200 tests**

## Phase 2: Medium-effort core (3-4 dev-days, main body of sprint)

These are the M-effort issues that form the bulk of the pass-rate push. Ordered by impact descending.

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 4 | **#1049** | Destructuring fn-name-cover: IsAnonymousFunctionDefinition guard | **176 FAIL** | M | Missing cover-call guard in NamedEvaluation. Well-isolated |
| 5 | **#1090** | ToPrimitive "Cannot convert object to primitive value" | **161 FAIL** | M | Full ToPrimitive algorithm per §7.1.1 — valueOf/toString fallback chain |
| 6 | **#1018** | Object.getOwnPropertyDescriptor returns null | **160 FAIL** | M | Host import returns descriptor as externref; accessor/missing case broken |
| 7 | **#1053** | arguments.length wrong (class methods, trailing-comma) | **133 FAIL** | M | Reverted — needs #1085 fix first (bodyUsesArguments iterative) then clean reapply |
| 8 | **#1054** | Derived class eval supercall SyntaxError | **122 FAIL** | M | Early-error propagation through eval for `super` references |
| 9 | **#1091** | Early error detection gap (strict mode, labels, etc.) | **94 FAIL** | M | 5-8 distinct early-error rules, each 5-15 LOC |
| 10 | **#1056** already in Phase 1 | — | — | — | — |
| 10 | **#1051** | Private static class methods wrong return value | **88 FAIL** | M | Private-name slot dispatch to wrong table |
| 11 | **#1052** | Array destructuring ignores overridden Symbol.iterator | **80 FAIL** | M | Fast-path dstr bypasses GetIterator — needs spec-correct path |
| 12 | **#1055** | RegExp pattern modifiers SyntaxError missing | **77 FAIL** | M | Validate modifier segment per spec error conditions |
| 13 | **#1092** | Wrong error type (Test262Error instead of TypeError) | **69 FAIL** | M | Missing runtime type checks: non-callable, frozen obj writes, new-callable |
| 14 | **#1024** | Destructuring rest/holes null vs undefined | **~60 FAIL** | M | ref.is_null conflating null and missing — audit rest + elision paths |

**Phase 2 estimated impact: +700-1,000 tests** (not all 176+161+... since some tests share root causes and some fixes won't reach 100% of their bucket)

## Phase 3: High-impact hard issues (stretch — only if Phase 1-2 ship cleanly)

These have the biggest absolute impact but are Hard/risky. Only attempt if Phase 2 is landing well.

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 15 | **#1016** | Iterator protocol null access | **500+ FAIL** | H | Reverted PR #59 — must split into #1016a (class dstr, +60) and #1016b (function param dstr). Do NOT attempt monolithic fix again |
| 16 | **#1006** + **#1073** | Eval host import + scope injection | **107+ pass** from #1073 alone | M+H | #1006 is prerequisite, already partially shipped. #1073 needs JS-side harness shim |
| 17 | **#990** | Early-error residuals (reserved words, module grammar) | **327 FAIL** | H | Overlaps with #1091 — do #1091 first, then attack remaining gaps |

**Phase 3 estimated impact: +300-500 tests** (only if 1-2 of these land)

## Dependency ordering

```
#1085 (bodyUsesArguments iterative) ──→ #1053 (arguments.length reapply)
#1006 (eval host import) ──→ #1073 (eval scope injection)
#1091 (early errors) ──→ #990 (remaining early-error gaps — reduces residual)
#1057 reapply ──→ verify no interaction with #1053/#1064 first
```

All other issues are independent and can run in parallel.

## Prerequisite: CI interaction bisect resolution

Before reapplying #1053 and #1057, the Sprint 40 revert interaction (#96 + #100 + #107) must be resolved. PR #116 (reapplying #107 alone) is the first probe. If #107 reapplies cleanly:
1. Reapply #1057 (#100) next — 9 LOC, low risk
2. Then #1053 (#96) — 501 LOC, needs #1085 fix first

If the interaction bisect isn't resolved by sprint start, skip #1053/#1057 reapply and focus on the independent issues.

## Deferred to Sprint 42 (non-pass-rate work)

All original Sprint 41 non-error work moves to Sprint 42:

### Stress tests & preconditions
- #1031 lodash, #1032 axios, #1033 react, #1034 prettier follow-ups
- #1043 process.env.NODE_ENV DCE, #1044 Node builtin imports, #1045 DOM globals
- #1058 TypeScript self-hosting stress test
- #1060-#1063, #1074, #1075 lodash follow-up chain

### Performance & benchmarks
- #1001 counted push-loop, #1004 string concat, #1005 cold-start benchmark
- #1009 report-page outliers, #1011 offline-first benchmarks

### Infrastructure & refactor
- #1013 codegen/index.ts split (14K line monolith)
- #1000, #1003 issue metadata normalization
- #1007 historical checkpoint re-run
- #1008 mobile playground
- #824 timeout umbrella doc cleanup
- #1035 WASI hello-fs

### CI hardening (keep 1, defer rest)
- **KEEP #1085** — bodyUsesArguments iterative rewrite (blocks #1053 reapply, critical for CI stability)
- DEFER: #1076, #1077, #1078, #1079, #1080, #1081, #1082, #1083, #1084, #1086, #1087

### Investigation
- #1093 Systematic ECMAScript spec conformance audit — valuable but produces issues, not fixes. Run in Sprint 42 to seed Sprint 43.
- #1088 Assertion location diagnostic — improves triage UX, doesn't flip tests

### Blocked / needs architect
- #983 WasmGC opaque objects (1,087 FAIL) — Hard, needs architect spec for the Proxy/wrapping redesign
- #821 BindingElement null guard (537 FAIL) — investigation showed root cause is iterator protocol (#1016), not null guard. Subsumes into #1016.
- #1047 Instance fields leak onto prototype (246 FAIL) — Hard, needs `_wrapForHost` prototype distinction redesign

## Dev assignment strategy

With 3 devs and ~12 shippable issues:

**Dev A** (quick wins + easy M): #1056 → #1057 reapply → #1055 → #1092
**Dev B** (medium core): #1049 → #1090 → #1018 → #1052
**Dev C** (medium + hard prep): #1091 → #1054 → #1085 → #1053 reapply

If any dev finishes early, pick from: #1051, #1024, #997, #1016a (class dstr slice only).

## Pass-rate projection

| Scenario | Tests gained | New total | Percentage |
|----------|-------------|-----------|------------|
| **Conservative** (Phase 1 + 50% of Phase 2) | +550 | 22,735 | 52.7% |
| **Realistic** (Phase 1 + Phase 2) | +1,000 | 23,185 | 53.7% |
| **Optimistic** (Phase 1 + 2 + partial Phase 3) | +1,400 | 23,585 | 54.6% |
| **Stretch** (everything lands) | +1,700 | 23,885 | 55.3% |

## Acceptance criteria

- [ ] **Baseline at sprint close**: ≥23,000 pass (53.3%) — MUST
- [ ] **Phase 1 shipped**: #1056, #997, and #1057 all merged with positive delta
- [ ] **Phase 2 shipped**: ≥6 of the 10 Phase 2 issues merged
- [ ] **No net regressions**: each merged PR has delta ≥ 0 on sharded CI
- [ ] **Reverted work resolved**: interaction bisect complete; at least #1057 reapplied
- [ ] **#1085 landed**: bodyUsesArguments iterative rewrite merged (unblocks #1053)

## Non-goals

- Stress tests, perf work, infra, refactoring — all Sprint 42
- Full iterator protocol rewrite — only attempt the class-dstr slice (#1016a) as stretch
- Architect-level redesigns (#983, #1047) — Sprint 42+ after spec
- CI hardening beyond #1085 — Sprint 42

## Risks

1. **Revert interaction unresolved**: if #107/#100/#96 interaction isn't identified, #1053 and #1057 stay blocked. Mitigation: focus on the 10 independent issues instead.
2. **Hard issues don't land**: #1016 and #990 have reverted/stalled history. Mitigation: they're Phase 3 stretch — sprint succeeds without them.
3. **Regression cascades**: multiple codegen changes in one sprint could interact. Mitigation: ship one PR at a time, run sharded CI between each merge.
4. **Dev capacity**: some M-effort issues may turn out to be harder than estimated. Mitigation: devs skip to next issue if blocked >2 hours; file a sub-issue for the hard part.

## Planning discussion (2026-04-12)

**Decision**: repurpose Sprint 41 from non-error work to pass-rate push. Rationale: 21,014 tests still failing, with a dense cluster of M-effort issues in the 70-180 FAIL range. Each one is independently shippable. The original stress test / perf / infra work doesn't move the pass rate — it can wait one more sprint.

**Issue validation**: all candidate issues checked against current main baseline (22,185 pass). Key findings:
- #821 (537 FAIL) is actually an iterator protocol problem, not a null guard problem — subsumes into #1016
- #1088 (273 tests) only improves diagnostics, not pass rate — deferred
- #1093 (investigation) produces issues, not fixes — deferred to seed Sprint 43
- #983 (1,087 FAIL) needs architect-level Proxy/wrapping redesign — deferred
- Sprint 40 carry-over items #990, #997 still valid and promoted

**Prioritization**: ranked by (test_count × feasibility). M-effort issues dominating because they're most likely to actually land. Hard issues in stretch only.
