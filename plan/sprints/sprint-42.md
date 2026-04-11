---
title: "Sprint 42 — Next pass-rate push: null-safety, error semantics, and stress-test follow-ups"
status: planning
sprint: Sprint-42
---

# Sprint 42 — Next pass-rate push: null-safety, error semantics, and stress-test follow-ups

**Planned start**: after Sprint 41 closes
**Starting baseline (projected)**: ~21,862+ pass / 43,164 total (50.65%+ after Sprint 40 merge wave crossed 50%)
**Theme**: Drive the second big pass-rate jump after crossing 50% — focus on the *narrow, medium-sized* error buckets that were too concentrated for the Sprint 40 umbrellas and on the stress-test follow-ups Sprint 41 surfaces.
**Harvest-driven queue (new)**: the post-Sprint-40 test262 harvest filed 11 new narrow issues (`#1047`–`#1057`) covering ~1,264 FAIL across concentrated sub-clusters. These are the core of Sprint 42's Phase 6 — all above the 50-occurrence threshold, all unaddressed by existing umbrellas, all dedup-checked before filing.

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

### Phase 6 — Harvester-filed narrow buckets (post-Sprint-40 test262 harvest)

The `harvester-post-sprint-40-merge` agent ran against the post-merge Sprint 40 baseline on 2026-04-11 and filed 11 new narrow issues (`#1047`–`#1057`) covering ~1,264 directly attributable FAIL across concentrated sub-clusters. Each one is a clean, actionable Sprint 42 candidate — all are above the 50-occurrence threshold, all are un-covered by existing umbrellas, and all were dedup-checked against `ready/` / `done/` / `backlog/` before filing.

Per the harvester's Sprint 41 focus recommendation, the highest-leverage pairs are **#1047 private class elements hasOwn + #1049 fn-name-cover** (~422 combined, both large concentrated fixes in one area). But since Sprint 41 is deliberately non-error-focused, these land in Sprint 42.

| Order | Issue | Count | Title | Harvester verdict |
|-------|-------|-------|-------|-------------------|
| 12 | **#1047** | 246 | Private class elements leak onto `C.prototype` (`hasOwnProperty` returns wrong result) | **Highest single-fix yield.** Sprint 40 touched class code but left prototype-visibility and private-name-slot dispatch wrong. |
| 13 | **#1049** | 176 | Destructuring default init: wrong `.name` on fn-name-covered function | **Narrow and uniform** — one root cause likely covers most of the 176 tests. |
| 14 | **#1053** | 133 | `arguments.length` wrong in class methods with trailing-comma call sites | Small isolated codegen bug — quick win. |
| 15 | **#1054** | 122 | Derived class indirect-eval supercall does not throw SyntaxError | **Gate for #990 follow-ups** — hinges on same early-error infrastructure. |
| 16 | **#1050** | 110 | annexB: Extension not observed when variable binding would early-error | **One-shot fix** — clean cluster in `annexB/eval-code/*`, plugs into `#990`. |
| 17 | **#1056** | 89 | `DataView` `setUintN` / `setIntN` / `setFloatN` instance methods missing | **Pair with a scan** for downstream getter tests that should flip once setters exist. `#969` was done but `set*` never installed. |
| 18 | **#1051** | 88 | Private static class methods: wrong return value via private-name dispatch | **Pair with #1047** — same class-private-slot code path. |
| 19 | **#1052** | 80 | Array destructuring ignores user-overridden `Array.prototype[Symbol.iterator]` | Iterator protocol respect — overlaps with #1016 area but distinct root cause. |
| 20 | **#1055** | 77 | RegExp pattern modifiers: SyntaxError missing for invalid modifier syntax | Small parser / early-error fix. |
| 21 | **#1048** | 75 | async-generator destructuring: illegal cast in `__closure_N` | Narrow slice of the illegal-cast family. |
| 22 | **#1057** | 68 | `String.prototype.split` result `constructor !== Array` | Built-in species-constructor semantics — small fix. |

**Combined direct yield: ~1,264 pass** (plus indirect unblocking, notably #1056 for downstream DataView getters).

**Harvester's observation on the bigger picture** (from `plan/architecture/harvest-2026-04-11-post-sprint-40.md`): the expected "giant 9,400-test assertion-failure bucket" did not materialize. Post-Sprint-40 failures are distributed across dozens of 50–250-count sub-clusters, of which only 11 were unaddressed above threshold. The umbrella issues from Sprint 40 are doing their job — Sprint 42 work is genuinely narrow, single-fix-sized items.

### Phase 7 — Reserved for Sprint 41 stress-test follow-ups

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
