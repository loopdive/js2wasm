---
title: "Sprint 42 — Next pass-rate push: null-safety, error semantics, and stress-test follow-ups"
status: planning
sprint: Sprint-42
---

# Sprint 42 — Next pass-rate push: null-safety, error semantics, and stress-test follow-ups

**Planned start**: after Sprint 41 closes
**Starting baseline (projected)**: ~21,500+ pass / 43,164 total (>50%, depends on Sprint 40 + 41 outcomes)
**Theme**: Drive the second big pass-rate jump after crossing 50% — focus on the *narrow, medium-sized* error buckets that were too concentrated for the Sprint 40 umbrellas and on the stress-test follow-ups Sprint 41 surfaces.

## Context

Sprint 40 was the "push to 50%" sprint. It attacked the biggest umbrellas
(`#820` nullish, `#779` asserts, `#983` host-boundary, `#929` ODP) and landed a
merge wave of +479 pass in one session. Remaining work in those umbrellas is
now concentrated in narrower sub-buckets that are actionable individually.

Sprint 41 is deliberately *not* a pass-rate sprint — it runs real-world stress
tests (lodash, axios, react, prettier) and builds perf/infra. Those stress
tests are expected to file 12+ new error-pattern issues. Sprint 42 is the
natural home for the highest-signal of those follow-ups plus the medium error
buckets that Sprint 40 could not absorb.

Sprint 42 has three tracks:

1. **Narrow error-bucket closers** — sub-issues of the Sprint-40 umbrellas and
   the DisposableStack/Symbol cluster, each small enough to dispatch
   individually and land cleanly.
2. **Semantic compile-away wins** — TDZ and init-guard elimination, which
   reduce emitted code *and* unlock correct behavior for tests that hit
   module-init edge cases.
3. **Test-infrastructure correctness** — `#973` alone could recover ~400 tests
   by fixing the incremental-compiler state leak; it is the highest-leverage
   single fix in the backlog right now.

Slots are also reserved for the top follow-up issues that Sprint 41's
real-world stress tests will file (#1031–#1034). Those are *not* pre-listed
here — this sprint should be re-groomed once the stress-test error reports
land.

## Phased task queue

### Phase 1 — Test infra unlock (run first, high leverage)

| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 1 | **#973** | Incremental compiler state leak — CompilerPool fork produces ~400 false CEs | **~400 CE recoverable** | Hard |

#973 is the single highest-leverage move in the sprint. The root cause is
identified: `createIncrementalCompiler()` shares an `IncrementalLanguageService`
across compilations and accumulates stale type info between tests. A correct
fix (fresh context per test, or proper reset) recovers ~400 tests that already
pass standalone. Land this first so the rest of the sprint's deltas are not
polluted by false CEs.

### Phase 2 — Null-safety sub-buckets (carved out of #820 umbrella)

| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 2 | **#821** | BindingElement null guard over-triggering | **537 FAIL** | Medium |
| 3 | **#825** | Null dereference failures (sub of #820) | **2,295 FAIL** | Medium |
| 4 | **#826** | Illegal cast failures (sub of #820) | **1,276 FAIL** | Medium |

All three already hold `status: review` from prior investigation and have
concrete reproducers. Scope each narrowly — Sprint 40's lessons (`#1025`,
`#1026` close-and-reopen) showed that blanket `ref.is_null` rewrites regress
more than they fix. Per-site justification is required before any codegen
rewrite lands.

### Phase 3 — Error-semantics buckets

| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 5 | **#854** | Iterator protocol null next/return/throw methods | **126 FAIL** | Medium |
| 6 | **#856** | Expected TypeError but got wrong error type | **136 FAIL** | Medium |
| 7 | **#862** | Empty error message failures (iterator/destructuring step-err) | **212 FAIL** | Medium |

These three form a coherent cluster: tests that *throw*, but throw the wrong
thing, at the wrong time, or with the wrong message. All three need the same
infrastructure — correct synthesis of `TypeError`/iterator-step errors at
compile-time-known failure points.

### Phase 4 — Wrapper / disposable / symbol cluster

| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 8 | **#123** | Wrapper object constructors `new Number/String/Boolean` | **648 tests** | Medium |
| 9 | **#1037** | Symbol.dispose / Symbol.asyncDispose not accessible | **30 FAIL** | Medium |

#123 is the largest "one feature unlocks a lot" item still unassigned. A
proper wrapper-object struct (with `__is_wrapper` tag) also enables correct
`typeof` for boxed primitives, which Sprint 40's `#1026` follow-ups found
relevant. #1037 pairs with #1036 (already being worked) and #1038 (bind,
already in flight) to close the explicit-resource-management cluster.

### Phase 5 — Semantic compile-aways

| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 10 | **#906** | Compile away TDZ tracking for definite-assignment top-level numeric locals | Perf + correctness | Medium |
| 11 | **#907** | Replace `__init_done` runtime guards with start/init entry semantics | Startup + correctness | Medium |

These two are the "compile away, don't emulate" pieces carried over from the
goal `runtime-simplicity` / `performance` tracks. They are not direct
pass-rate fixes but they eliminate runtime guards that sometimes interact
badly with module-init edge cases and make cold-start benchmarks (Sprint 41
`#1005`) honest.

### Phase 6 — Reserved for Sprint 41 stress-test follow-ups

**Do not pre-fill.** After Sprint 41's four stress tests (`#1031` lodash,
`#1032` axios, `#1033` react, `#1034` prettier) land their error-bucket
reports, re-groom Sprint 42 by pulling the top 3-4 follow-up issues into this
queue. Stress-test follow-ups tend to be narrower and higher-signal than
random backlog items, so they take priority over anything else in the backlog
at re-groom time.

## Acceptance criteria

- [ ] **#973** lands: CompilerPool no longer shares stale type state; target
      is ≥ 300 of the ~400 false CEs recovered (≥75%).
- [ ] At least **two of #821 / #825 / #826** land cleanly without regressing
      any already-passing test. No blanket `ref.is_null` rewrites.
- [ ] At least **two of #854 / #856 / #862** land with correct error
      synthesis at the failing sites.
- [ ] **#123** lands or is substantially scoped (≥200 of the 648 tests
      passing) with a wrapper-object struct backing `new Number/String/Boolean`.
- [ ] **#1037** (Symbol.dispose) lands — closes the explicit-resource-management
      cluster once paired with #1036 and #1038 from Sprint 40.
- [ ] At least one of **#906 / #907** lands with a measurable code-size and/or
      startup-time improvement on the Sprint 41 `#1005` cold-start benchmark.
- [ ] **Stress-test follow-ups:** ≥ 3 issues filed by Sprint 41 stress tests
      are pulled into Phase 6 and land during the sprint.
- [ ] **Sprint goal:** net delta ≥ +1,200 pass from Sprint 41 end baseline.

## Non-goals

- **Umbrella-wide rewrites.** `#820`, `#779`, and `#846` stay as umbrellas;
  this sprint only touches the enumerated sub-issues.
- **Perf work beyond #906/#907.** Perf belongs to Sprint 41's remaining
  queue; only the semantic compile-aways carry over here.
- **New refactors.** `#1013` (codegen/index.ts split) and the `#688` extract
  family stay in Sprint 41 / future sprints — Sprint 42 is pass-rate-focused.
- **typescript-go migration (#1029)** remains blocked upstream; do not touch.
- **Dashboard / landing-page UI work.** UI issues stay in Sprint 41's phase 3
  queue.

## Notes for the PO / tech lead starting Sprint 42

- **Re-groom first.** Before dispatching, re-read the Sprint 41 stress-test
  error reports and pull the highest-signal follow-ups into Phase 6.
- **Validate before dispatch.** Sprint 40's retro noted that `#984` was
  already fixed before dispatch — burn a smoke-test pass on each Phase 2 / 3
  issue before handing it to a dev.
- **Narrow PRs over broad rewrites.** Both `#1025` and `#1026` first attempts
  failed in Sprint 40 because they were too broad. Require per-site
  justification in PRs that touch null-guard codegen.
- **#973 first.** Until the incremental-compiler leak is fixed, every delta
  measurement is noisier than it should be. Land #973 before Phase 2 starts.

## Issue assignment summary

**11 issues assigned** (+ reserved slots for stress-test follow-ups):

| # | Title | Phase |
|---|-------|-------|
| #973 | CompilerPool incremental state leak | 1 |
| #821 | BindingElement null guard over-triggering | 2 |
| #825 | Null dereference failures | 2 |
| #826 | Illegal cast failures | 2 |
| #854 | Iterator protocol null methods | 3 |
| #856 | Expected TypeError wrong type | 3 |
| #862 | Empty error messages (iterator/destructuring) | 3 |
| #123 | Wrapper object constructors | 4 |
| #1037 | Symbol.dispose accessibility | 4 |
| #906 | Compile away TDZ for top-level locals | 5 |
| #907 | Replace __init_done with start/init semantics | 5 |
