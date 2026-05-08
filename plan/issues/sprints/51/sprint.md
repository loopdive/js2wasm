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
| #1343 | Boolean wrapper + Symbol coercion TypeErrors | medium | pending |
| #1344 | Date.prototype string formatters and parsers | medium | pending |
| #1347 | for-of IteratorClose on non-callable return | medium | **done** — PR #265 |
| #1348 | for-of IteratorClose on abrupt body completion | medium | in_progress |
| #1358 | Array callback methods on array-like receivers | high | **done** — PR #268 |
| #1359 | Array.splice/slice/concat species and sparse | high | **done** — PR #277 |
| #1360 | Array.indexOf/lastIndexOf/includes strict equality | high | **done** — PR #274 +50 |
| #1361 | Array.sort comparator stability | medium | **done** — PR #280 +40 |
| #1362 | Object.defineProperties property descriptor map | medium | **done** — PR #282 |
| #1363 | Class dstr — cannot-destructure-null | high | **done** — merged |
| #1364 | Class elements method/field descriptor fidelity | medium | **in_progress** — PR #310 (dev-1390, #1364a slice) |
| #1365 | Class private fields and brand checks | medium | pending |
| #1366 | Class subclass builtins + prototype chain | medium | pending |
| #1366a | Class extends Error/TypeError builtin subclassing | high | **done** — PR #307 |
| #1367 | Iterator helpers protocol invariants | medium | **done** — PR #287 +89 |
| #1368 | Promise.all/allSettled/any/race resolver-element | medium | **done** — PR #286 +37 |
| #1369 | String split/replace/replaceAll Symbol-protocol | medium | **done** — merged |
| #1370 | IR: class methods and constructors | high | **done** — PRs #293 (Phase A), #295 (Phase B) |
| #1371 | IR: external call whitelist | high | **done** — PR #300 |
| #1372 | IR: destructuring params | high | **done** — PR #301 |
| #1373 | IR: async functions | high | pending |
| #1374 | IR: string for-of and for-in | high | **done** — PR #306 |
| #1375 | IR: full optional-chain support | medium | **in_progress** — dev-1389 (task #19) |
| #1376 | IR: fallback telemetry gate | high | **done** — PR #285 |
| #1377 | Array mutating methods length-overflow + receiver | medium | partial — Slices A+B done (PRs #289, #299) |
| #1378 | try/catch/finally completion override + error fidelity | medium | **done** — merged |
| #1379 | ++/-- ToNumeric on null/undefined/string | medium | **done** — merged |
| #1380 | Equality Symbol/BigInt + ReferenceError propagation | medium | **done** — PR #302 +141 |
| #1381 | String.prototype substring/slice/indexOf/charAt/at | medium | **done** — PR #279 |
| #1382 | Wasm closures not JS-callable from host imports | high | pending |
| #1384 | CE: async chain+try/catch arity (Promise.all+untyped cb) | high | pending — architect spec ready |
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

## Session results (2026-05-08)

**PRs merged**: 20+ across two sessions today.

**Baseline**: 27567/43160 = **63.9%** (committed; local run ~64%)

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

## Remaining work

**In progress:**
- #1364a instance method descriptors — PR #310 in CI (dev-1390)
- #1375 IR optional chain — dev-1389 implementing (task #19)
- #309 docs PR (string position escalation) — pending CI merge

**Pending (no active dev):**
- #1373 IR async functions
- #1343 Boolean/Symbol TypeErrors
- #1344 Date.prototype formatters
- #1348 for-of IteratorClose abrupt body
- #1365 class private fields
- #1382 Wasm closures not JS-callable
- #1384 async chain arity (architect spec ready)
- #1366 class subclass builtins (needs architect for full scope)

**Blocked:**
- #1377 Slices C+ → externref identity bug
- #1366 (full) → architect spec for super() forwarding
