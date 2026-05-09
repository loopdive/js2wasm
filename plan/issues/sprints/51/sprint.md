---
id: 51
status: active
created: 2026-05-08
started: 2026-05-08
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 51

**Planned**: 2026-05-08
**Started**: 2026-05-08

## Theme

> **Spec-completeness wave + IR retirement gate** — close the largest ECMAScript
> conformance gaps (class dstr, array callbacks, string methods, equality,
> iterator helpers) and build the IR fallback telemetry gate that enforces
> the path to retiring legacy emitters.

Two parallel tracks:

1. **Spec-gap issues** (#1358–#1369, #1377–#1382): 17+ targeted fixes covering
   §23.1 Array, §15.7 Class, §27.1 Iterator, §22.1 String, §13 expressions, §14 try.
   Estimated +1,500–1,800 net passes. Identified via architect-s51 audit.

2. **IR retirement track** (#1370–#1376): fallback telemetry gate, external call
   whitelist, destructuring params, string for-of, optional chain, class methods,
   async functions. Gate (#1376) first; remaining in dependency order.

## Issues

| ID | Title | Priority | Status |
|----|-------|----------|--------|
| #1312 | Async recursion fix (pre-registration) | high | **done** — PR #283 +135 |
| #1334 | Object.defineProperty descriptor attribute fidelity | high | **done** — PR #304 |
| #1343 | Boolean wrapper + Symbol coercion TypeErrors | medium | **done** — PR #312 +77 |
| #1344 | Date.prototype string formatters and parsers | medium | **done** — PR #318 |
| #1347 | for-of IteratorClose on non-callable return | medium | **done** — PR #265 |
| #1348 | for-of IteratorClose on abrupt body completion | medium | **done** — PR #314 +58 |
| #1358 | Array callback methods on array-like receivers | high | **done** — PR #268 |
| #1359 | Array.splice/slice/concat species and sparse | high | **done** — PR #277 |
| #1360 | Array.indexOf/lastIndexOf/includes strict equality | high | **done** — PR #274 +50 |
| #1361 | Array.sort comparator stability | medium | **done** — PR #280 +40 |
| #1362 | Object.defineProperties property descriptor map | medium | **done** — PR #282 |
| #1363 | Class dstr — cannot-destructure-null | high | **done** — merged |
| #1364 | Class elements method/field descriptor fidelity | medium | **done** — PR #310 |
| #1365 | Class private fields and brand checks | medium | **done** — PR #313 +23 |
| #1366 | Class subclass builtins + prototype chain | medium | **done** — PR #315 +44 |
| #1366a | Class extends Error/TypeError builtin subclassing | high | **done** — PR #307 |
| #1367 | Iterator helpers protocol invariants | medium | **done** — PR #287 +89 |
| #1368 | Promise.all/allSettled/any/race resolver-element | medium | **done** — PR #286 +37 |
| #1369 | String split/replace/replaceAll Symbol-protocol | medium | **done** — merged |
| #1370 | IR: class methods and constructors | high | **done** — PRs #293 (Phase A), #295 (Phase B) |
| #1371 | IR: external call whitelist | high | **done** — PR #300 |
| #1372 | IR: destructuring params | high | **done** — PR #301 |
| #1373 | IR: async functions | high | pending |
| #1374 | IR: string for-of and for-in | high | **done** — PR #306 |
| #1375 | IR: full optional-chain support | medium | **in_progress** — PR #311 Slice A merged; dev-1389 continuing |
| #1376 | IR: fallback telemetry gate | high | **done** — PR #285 |
| #1377 | Array mutating methods length-overflow + receiver | medium | partial — Slices A+B done (PRs #289, #299) |
| #1378 | try/catch/finally completion override + error fidelity | medium | **done** — merged |
| #1379 | ++/-- ToNumeric on null/undefined/string | medium | **done** — merged |
| #1380 | Equality Symbol/BigInt + ReferenceError propagation | medium | **done** — PR #302 +141 |
| #1381 | String.prototype substring/slice/indexOf/charAt/at | medium | **done** — PR #279 |
| #1382 | Wasm closures not JS-callable from host imports | high | in_progress — task #29 (senior-dev-1370) |
| #1384 | CE: async chain+try/catch arity (Promise.all+untyped cb) | high | **done** — PR #298 |
| #1385 | HANG: Temporal Duration.from infinite loop | medium | **done** — PR #291 |
| #1386 | HANG: Promise.race invoke-then hang | medium | **done** — PR #288 +41 |
| #1388 | null.next: yield* async-gen class method iterator null | high | **done** — PR #294 +478 (regression fix PR #305) |
| #1389 | false CE: var+function-declaration same-name top-level | medium | **done** — PR #296 |
| #1390 | import-defer proposal tests fail as CE | low | **done** — PR #297 |
| #1391 | CI feed baseline staleness detection | high | **done** — PR #308 |

## Mid-sprint additions

- **#1384**: async chain + try/catch arity bug (249 CE). Root cause: chained
  `Promise.all([asyncFn()]).then(untyped cb)` — late import shift misses outer call bytes.
  Architect spec in issue file. Needs fresh senior-dev.
- **#1387**: `with` statement architect exploration (backlog).
- **#1388**: null.next in yield* class async-gen methods (316 fails). Done; regression from
  prototype-method handler fixed in PR #305.
- **#1389**: false CE var+function same name. Done PR #296.
- **#1390**: import-defer proposal CE. Done PR #297.
- **#1391**: CI feed baseline staleness. Done PR #308.
- **#1334**: Object.defineProperty descriptor fidelity (sprint 50 carry-over). Done PR #304.
- **#1366a**: Error subclassing slice. Done PR #307.
- **#1343**: Boolean/Symbol coercion TypeErrors. Done PR #312 +77.
- **#1348**: for-of IteratorClose abrupt body. Done PR #314 +58.
- **#1352**: Set new methods set-like — Done PR #317 (task #27). GATE_BYPASS approved (8 scatter regressions, unrelated buckets).
- **#1365**: Class private fields and brand checks. Done PR #313 +23.
- **#1366**: Class subclass builtins — Done PR #315 +44 (task #25).
- **#1344**: Date.prototype formatters — Done PR #318 (task #24).
- **#1392**: IR null-safe primitives. Done PR #316 +38; unblocked #1375 (dev-1389 on Slice B).
- **#1393**: CI content-hash cache + merge queue. Done: content-hash already in
  `test262-differential.yml`; merge queue via GitHub Ruleset #16153215 attempted then
  ROLLED BACK — personal repos cannot bypass `github-actions[bot]` pushes. See issue file.
  `dev-self-merge.md` reverted to `--admin --merge`.
- **#1134**: Loose equality cross-tag coercion (null==undefined, bool==number). Done PR #322 GATE_BYPASS (+35 net_per_test, 9/44=20% ratio but 9 absolute is small, correctness fix).
- **dev-self-merge skill fix (2026-05-09)**: CI feed writes pr-N.json to origin/main, not local. Added `git fetch origin && git show origin/main:.claude/ci-status/pr-N.json` polling pattern to skill. Devs no longer need tech-lead to `git merge origin/main` before they can see CI results.

## Session results (2026-05-08)

**PRs merged**: 20+ across two sessions today.

**Baseline**: 27721/43160 = **64.2%** (committed; refreshed after PR #315 merge)

| PR | Issue | Net | Note |
|----|-------|----:|------|
| #262 | #1322 Math.random WASI | +34 | |
| #265 | #1347 for-of IteratorClose | +36 | |
| #274 | #1360 indexOf/includes | +50 | |
| #277 | #1359 splice/slice/concat | — | |
| #279 | #1381 String accessors | — | |
| #280 | #1361 sort | +40 | |
| #281 | #1342 JSON replacer | — | |
| #282 | #1362 defineProperties | — | |
| #283 | #1312 async recursion | +135 | |
| #285 | #1376 IR gate | +0 | |
| #286 | #1368 Promise aggregators | +37 | |
| #287 | #1367 Iterator helpers | +89 | |
| #288 | #1386 Promise.race | +41 | |
| #289 | #1377-A pop/shift undefined | +29 | |
| #293 | #1370 Phase A IR class selector | — | |
| #294 | #1388 null.next fix | +478 | net includes regression fix |
| #295 | #1370 Phase B IR integration | — | |
| #296 | #1389 var+fn same name | — | |
| #297 | #1390 import-defer skip | — | |
| #298 | #1384 late import shift fix | — | |
| #299 | #1377-B fill/copyWithin | — | |
| #300 | #1371 IR Math whitelist | — | |
| #301 | #1372 IR dstr params | — | |
| #302 | #1380 equality/Symbol/RefErr | +141 | GATE_BYPASS (WAT-identical) |
| #304 | #1334 defineProperty descriptors | — | |
| #305 | #1388-regression revert handler | — | |
| #306 | #1374 IR string for-of | — | |
| #307 | #1366a Error subclassing | — | |
| #308 | #1391 CI staleness detection | — | |
| #310 | #1364 class method descriptors | — | |
| #312 | #1343 Boolean/Symbol coercion | +77 | |
| #313 | #1365 class private fields | +23 | |
| #314 | #1348 for-of IteratorClose abrupt | +58 | |
| #311 | #1375 IR optional-chain Slice A | — | partial, dev-1389 continuing |
| #315 | #1366 class subclass builtins | +44 | |
| #316 | #1392 IR null-safe primitives | +38 | |
| #317 | #1352 Set new methods set-like | — | GATE_BYPASS (scatter regressions) |
| #318 | #1344 Date.prototype formatters | — | |

## Remaining work

**In progress (2026-05-09):**
- #1373 IR async functions — senior-dev (task #20), unblocked by #1326 Phase 1B
- #1154 Array.prototype poisoning CE — dev-idx (task #30)
- #1382 Phase 2 (wire __make_js_callable) — senior-dev-1370 (task #38)
- #1104 Phase 2 (Error .message/.name) — dev-1390-2 (task #39), PR #326 in CI
- #1383 typeof-gated strict equality — dev-1388 (task #40)
- class/dstr element null/undefined — dev-1389-2 (task #41)
- class/elements _yield in static gen methods — dev-1389 (task #42)

**Blocked:**
- #1377 Slices C+ → externref identity bug
- #1373 Phase B/C — blocked on #1326 Phase 1C (microtask queue, not yet assigned)

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1373b | IR async Phase C: CPS lowering for await + async-return + async-throw | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1326c | Async standalone Phase 1C: microtask queue + Promise.then chained-resolution (follow-up to #1326 Phase 1B) | medium | ready |
| #1373 | IR: claim async functions (async/await through IR path) | medium | ready |
| #1382 | structural: Wasm closures not JS-callable from host imports — bridge gap | high | ready |
| #1387 | feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies | medium | ready |
| #1394 | class method-closure caching: C.prototype.method returns stable singleton closure | high | ready |
| #1395 | class static method descriptors: class identifier resolves to string_constant, not constructor object | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1364 | spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails) | high | in-progress |
| #1375 | IR: full optional-chain support (?. and ?.[]) without resolver fallback | medium | in-progress |
| #1378 | spec gap: try/catch/finally — error type fidelity, finally completion override, dstr-binding (~85 fails) | medium | in-progress |
| #1381 | spec gap: String.prototype.{substring,slice,indexOf,search,charAt,charCodeAt,codePointAt,at,includes,startsWith,endsWith,trim,concat} edge cases (~128 fails) | medium | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1358 | spec gap: Array.prototype.{filter,map,every,some,forEach,reduce} on array-like (.call) receivers — ~452 assertion_fail | high | done |
| #1359 | spec gap: Array.prototype.{splice,slice,concat,toSpliced,toReversed} — @@species, sparse handling, IsConcatSpreadable (~150 fails) | high | done |
| #1360 | spec gap: Array.prototype.{indexOf,lastIndexOf,includes} — SameValueZero, sparse, fromIndex coercion (~210 fails) | high | done |
| #1361 | spec gap: Array.prototype.sort — comparator validation, stability, ToString fallback (~46 fails) | medium | done |
| #1362 | spec gap: Object.defineProperties — apply full descriptor map (332 fails) | high | done |
| #1363 | spec gap: class dstr — 'Cannot destructure null/undefined' in method default-binding (~700 runtime_errors) | high | done |
| #1365 | spec gap: class private fields, methods, accessors and brand checks (~97 fails in elements/private-*) | medium | done |
| #1366 | spec gap: class subclass + subclass-builtins prototype chain (~154 fails) | medium | done |
| #1366a | spec gap: class extends Error/TypeError/RangeError — builtin subclassing via existing host imports (+40-60 passes) | high | done |
| #1367 | spec gap: Iterator.prototype helpers — get-next-once, non-constructible, return-on-throw (~244 fails) | high | done |
| #1368 | spec gap: Promise.{all,allSettled,any,race} — resolver-element semantics, ctor type-check (~109 fails) | medium | done |
| #1369 | spec gap: String.prototype.{split,replace,replaceAll,match,matchAll} — limit, @@split/@@replace/@@match protocol (~150 fails) | medium | done |
| #1370 | IR: claim class methods and constructors (largest legacy bypass) | high | done |
| #1371 | IR: expand external-call whitelist to stop rejecting host imports and Math.* | high | done |
| #1372 | IR: support destructuring params (removes param-shape-rejected bypass) | high | done |
| #1374 | IR: string for-of and for-in through IR (removes legacy fallback for string iteration) | medium | done |
| #1376 | IR: fallback telemetry gate — CI fails when unintended legacy bypasses exceed threshold | high | done |
| #1377 | spec gap: Array.prototype.{push,pop,shift,unshift,fill,copyWithin,reverse} — mutation on array-like + length writes (~80 fails) | medium | done |
| #1379 | spec gap: prefix/postfix ++/-- on null/undefined/string operands — ToNumeric coercion (~40 fails) | medium | done |
| #1380 | spec gap: equality (==, !=, ===, !==) — Symbol/BigInt coercion + ReferenceError propagation (~55 fails) | medium | done |
| #1384 | CE: static async method with PrivateName — 'not enough arguments on the stack' (249 tests) | high | done |
| #1385 | HANG: Temporal/Duration/from/argument-non-string.js — infinite runtime loop | medium | done |
| #1386 | HANG: Promise/race/invoke-then.js — compilation or runtime infinite loop | medium | done |
| #1388 | runtime: null.next — yield* / async-generator iterator construction returns null in class methods (316 fails) | high | done |
| #1389 | fix: false CE — var + function-declaration same name at top-level scope | medium | done |
| #1390 | fix: import-defer proposal tests fail as CE (no test export) when TEST262_INCLUDE_PROPOSALS=1 | low | done |
| #1391 | infra: CI feed baseline staleness detection — warn when baseline_sha diverges from current main | high | done |
| #1392 | IR: null-safe access primitives — ref.is_null IrUnop + value-producing if/else IR node | high | done |
| #1393 | infra: content-hash CI cache + GitHub Merge Queue — eliminate baseline drift and redundant re-runs | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
