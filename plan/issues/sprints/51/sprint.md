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

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1358 | spec gap: Array.prototype.{filter,map,every,some,forEach,reduce} on array-like (.call) receivers — ~452 assertion_fail | high | ready |
| #1359 | spec gap: Array.prototype.{splice,slice,concat,toSpliced,toReversed} — @@species, sparse handling, IsConcatSpreadable (~150 fails) | high | ready |
| #1360 | spec gap: Array.prototype.{indexOf,lastIndexOf,includes} — SameValueZero, sparse, fromIndex coercion (~210 fails) | high | ready |
| #1361 | spec gap: Array.prototype.sort — comparator validation, stability, ToString fallback (~46 fails) | medium | ready |
| #1362 | spec gap: Object.defineProperties — apply full descriptor map (332 fails) | high | ready |
| #1363 | spec gap: class dstr — 'Cannot destructure null/undefined' in method default-binding (~700 runtime_errors) | high | ready |
| #1364 | spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails) | high | ready |
| #1365 | spec gap: class private fields, methods, accessors and brand checks (~97 fails in elements/private-*) | medium | ready |
| #1366 | spec gap: class subclass + subclass-builtins prototype chain (~154 fails) | medium | ready |
| #1367 | spec gap: Iterator.prototype helpers — get-next-once, non-constructible, return-on-throw (~244 fails) | high | ready |
| #1368 | spec gap: Promise.{all,allSettled,any,race} — resolver-element semantics, ctor type-check (~109 fails) | medium | ready |
| #1369 | spec gap: String.prototype.{split,replace,replaceAll,match,matchAll} — limit, @@split/@@replace/@@match protocol (~150 fails) | medium | ready |
| #1370 | IR: claim class methods and constructors (largest legacy bypass) | high | ready |
| #1371 | IR: expand external-call whitelist to stop rejecting host imports and Math.* | high | ready |
| #1372 | IR: support destructuring params (removes param-shape-rejected bypass) | high | ready |
| #1373 | IR: claim async functions (async/await through IR path) | medium | ready |
| #1374 | IR: string for-of and for-in through IR (removes legacy fallback for string iteration) | medium | ready |
| #1375 | IR: full optional-chain support (?. and ?.[]) without resolver fallback | medium | ready |
| #1376 | IR: fallback telemetry gate — CI fails when unintended legacy bypasses exceed threshold | high | ready |
| #1377 | spec gap: Array.prototype.{push,pop,shift,unshift,fill,copyWithin,reverse} — mutation on array-like + length writes (~80 fails) | medium | ready |
| #1378 | spec gap: try/catch/finally — error type fidelity, finally completion override, dstr-binding (~85 fails) | medium | ready |
| #1380 | spec gap: equality (==, !=, ===, !==) — Symbol/BigInt coercion + ReferenceError propagation (~55 fails) | medium | ready |
| #1381 | spec gap: String.prototype.{substring,slice,indexOf,search,charAt,charCodeAt,codePointAt,at,includes,startsWith,endsWith,trim,concat} edge cases (~128 fails) | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1379 | spec gap: prefix/postfix ++/-- on null/undefined/string operands — ToNumeric coercion (~40 fails) | medium | in-progress |

<!-- GENERATED_ISSUE_TABLES_END -->
