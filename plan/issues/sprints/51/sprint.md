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
  begin_tag_pushed: false
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
| #1358 | Array callback methods on array-like receivers | high | in_progress |
| #1359 | Array.splice/slice/concat species and sparse | high | ready |
| #1360 | Array.indexOf/lastIndexOf/includes strict equality | high | in_progress |
| #1361 | Array.sort comparator stability | medium | ready |
| #1362 | Object.defineProperties property descriptor map | medium | ready |
| #1363 | Class dstr — cannot-destructure-null | high | in_progress |
| #1364 | Class elements method/field descriptor fidelity | medium | ready |
| #1365 | Class private fields and brand checks | medium | ready |
| #1366 | Class subclass builtins + prototype chain | medium | ready |
| #1367 | Iterator helpers protocol invariants | medium | ready |
| #1368 | Promise.all/allSettled/any/race resolver-element | medium | ready |
| #1369 | String split/replace/replaceAll Symbol-protocol | medium | ready |
| #1370 | IR: class methods and constructors | high | ready |
| #1371 | IR: external call whitelist | high | ready |
| #1372 | IR: destructuring params | high | ready |
| #1373 | IR: async functions | high | ready |
| #1374 | IR: string for-of and for-in | high | ready |
| #1375 | IR: full optional-chain support | medium | ready |
| #1376 | IR: fallback telemetry gate | high | ready |
| #1377 | Array mutating methods length-overflow + receiver | medium | ready |
| #1378 | try/catch/finally completion override + error fidelity | medium | ready |
| #1379 | ++/-- ToNumeric on null/undefined/string | high | in_progress |
| #1380 | Equality Symbol/BigInt + ReferenceError propagation | medium | ready |
| #1381 | String.prototype substring/slice/indexOf/charAt/at | medium | ready |
| #1382 | Wasm closures not JS-callable from host imports | high | ready |

<!-- GENERATED_ISSUE_TABLES_END -->
