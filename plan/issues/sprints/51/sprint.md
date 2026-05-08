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
| #1343 | Boolean wrapper + Symbol coercion TypeErrors | medium | pending |
| #1344 | Date.prototype string formatters and parsers | medium | pending |
| #1347 | for-of IteratorClose on non-callable return | medium | **done** — PR #265 |
| #1348 | for-of IteratorClose on abrupt body completion | medium | in_progress |
| #1358 | Array callback methods on array-like receivers | high | in_progress — PR #268 v2 in CI |
| #1359 | Array.splice/slice/concat species and sparse | high | **done** — PR #277 |
| #1360 | Array.indexOf/lastIndexOf/includes strict equality | high | **done** — PR #274 +50 |
| #1361 | Array.sort comparator stability | medium | **done** — PR #280 +40 |
| #1362 | Object.defineProperties property descriptor map | medium | **done** — PR #282 |
| #1363 | Class dstr — cannot-destructure-null | high | **done** — merged |
| #1364 | Class elements method/field descriptor fidelity | medium | blocked (#1334) |
| #1365 | Class private fields and brand checks | medium | pending |
| #1366 | Class subclass builtins + prototype chain | medium | pending |
| #1367 | Iterator helpers protocol invariants | medium | **done** — PR #287 +89 |
| #1368 | Promise.all/allSettled/any/race resolver-element | medium | **done** — PR #286 +37 |
| #1369 | String split/replace/replaceAll Symbol-protocol | medium | **done** — merged |
| #1370 | IR: class methods and constructors | high | in_progress — architect spec ready |
| #1371 | IR: external call whitelist | high | pending |
| #1372 | IR: destructuring params | high | pending |
| #1373 | IR: async functions | high | pending |
| #1374 | IR: string for-of and for-in | high | pending |
| #1375 | IR: full optional-chain support | medium | pending |
| #1376 | IR: fallback telemetry gate | high | **done** — PR #285 |
| #1377 | Array mutating methods length-overflow + receiver | medium | partial — Slice A done (PR #289 +29); Slices B+ blocked on externref identity |
| #1378 | try/catch/finally completion override + error fidelity | medium | **done** — merged |
| #1379 | ++/-- ToNumeric on null/undefined/string | medium | **done** — merged |
| #1380 | Equality Symbol/BigInt + ReferenceError propagation | medium | pending (feasibility: hard — needs re-spec) |
| #1381 | String.prototype substring/slice/indexOf/charAt/at | medium | **done** — PR #279 |
| #1382 | Wasm closures not JS-callable from host imports | high | pending |
| #1384 | CE: async chain+try/catch arity (Promise.all+untyped cb) | high | pending — architect spec ready |
| #1385 | HANG: Temporal Duration.from infinite loop | medium | **done** — PR #291 in CI |
| #1386 | HANG: Promise.race invoke-then hang | medium | **done** — PR #288 +41 |
| #1388 | null.next: yield* async-gen class method iterator null (316 fails) | high | in_progress |

## Mid-sprint additions

- **#1384**: async chain + try/catch arity bug (249 CE). Root cause: chained
  `Promise.all([asyncFn()]).then(untyped cb)` — late import shift misses outer call bytes.
  Architect spec in issue file. Needs fresh senior-dev.
- **#1387**: `with` statement architect exploration (backlog).
- **#1388**: null.next in yield* class async-gen methods (316 fails, ~250–300 net potential).
  Newly filed; in_progress.

## Session results (2026-05-08)

**PRs merged**: 15+ across senior-dev, dev-idx, dev-dstr, dev-a waves.

**Net test262**: estimated +500–600 net across the session
(senior-dev alone: +331 net across 5 PRs).

| PR | Issue | Net | Agent |
|----|-------|----:|-------|
| #262 | #1322 Math.random WASI | +34 | dev-a |
| #265 | #1347 for-of IteratorClose | +36 | dev-a |
| #274 | #1360 indexOf/includes | +50 | dev-idx |
| #277 | #1359 splice/slice/concat | — | dev-dstr |
| #279 | #1381 String accessors | — | dev-dstr |
| #280 | #1361 sort | +40 | dev-idx |
| #281 | #1342 JSON.stringify replacer | — | dev-dstr |
| #282 | #1362 defineProperties | — | dev-dstr |
| #283 | #1312 async recursion | +135 | senior-dev |
| #285 | #1376 IR telemetry gate | +0 | dev-dstr |
| #286 | #1368 Promise aggregators | +37 | senior-dev |
| #287 | #1367 Iterator helpers | +89 | senior-dev |
| #288 | #1386 Promise.race reclassify | +41 | senior-dev |
| #289 | #1377-A pop/shift undefined | +29 | senior-dev |

**In CI**: PR #268 (#1358 array callbacks +43), PR #291 (#1385 Temporal hang).

## Remaining work

**High priority:**
- #1370 IR class methods (architect spec ready — largest IR bypass)
- #1388 null.next yield* async-gen class methods (316 fails)
- #1358 merging (PR #268 CI complete)
- #1384 async chain arity (architect spec ready)

**Pending (no active dev):**
- #1371 IR external call whitelist
- #1372 IR destructuring params
- #1373 IR async functions
- #1374 IR string for-of/for-in
- #1343 Boolean/Symbol TypeErrors
- #1344 Date.prototype formatters
- #1348 for-of IteratorClose abrupt body
- #1365 class private fields

**Blocked:**
- #1364, #1337 → blocked on #1334 (Object.defineProperty descriptor fidelity — hard)
- #1377 Slices B+ → blocked on externref identity bug
- #1380 → needs re-spec (feasibility: hard)
