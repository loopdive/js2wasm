---
id: 1169l
title: "IR Phase 4 Slice 10 step D — Date / Error / Map / Set through IR"
status: done
created: 2026-04-28
updated: 2026-04-30
completed: 2026-05-01
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: compiler-internals
goal: error-model
depends_on: [1169i]
---
## Implementation status (2026-04-30, dev-2)

The IR scaffolding from step A (#1169i) — `KNOWN_EXTERN_CLASSES`,
`extern.new`, `extern.call`, `extern.prop`, `extern.propSet` — is
sufficient to handle Date / Error / Map / Set construction +
instance methods + size getter without code changes. Step D is
purely test coverage.

**13 equivalence test cases across 3 files** (each compiles its
source twice — `experimentalIR: true` and `experimentalIR: false` —
and asserts identical observable behaviour):

- `tests/equivalence/ir-slice10-date.test.ts` (3 tests):
  `new Date(0)`, `new Date(1000)`, `new Date(arbitrary).getTime()`.
- `tests/equivalence/ir-slice10-error.test.ts` (5 tests):
  `new Error('msg').message`, `new TypeError(...)`, `new RangeError(...)`,
  `new Error()` with no arg, `try { throw new Error(...) } catch (e)
  { return e.message }` — the slice-9 composition test.
- `tests/equivalence/ir-slice10-map-set.test.ts` (5 tests):
  `new Map().size`, Map `set/has/size`, `new Set().size`, Set
  `add/has/size`.

`Date.now()` (a STATIC method, see issue notes) is not covered —
the current IR layer only handles instance method calls. Static
method dispatch is deferred to a future slice (the dev-1169i
context flagged this as a known limitation).

The existing slice-10 step A test file
(`ir-slice10-extern-regexp.test.ts`) still passes (5/5), so step A
is not regressed.

# #1169l — IR Slice 10 step D: Date / Error / Map / Set through IR

## Goal

Extend the IR path's extern-class support (#1169i scaffolding) to
cover **Date**, **Error** (and TypeError, RangeError, etc.), **Map**,
**Set**, **WeakMap**, **WeakSet** construction and method calls.

This is **Step D of #1169i**'s staging plan. The IR's extern-class
scaffolding (#1169i) already handles these classes structurally —
they're all in `KNOWN_EXTERN_CLASSES`. Step D's work is
verification + equivalence tests.

## Acceptance criteria

1. `new Date()`, `new Date(ms)`, `Date.now()` (caveat: static method
   — may need separate handling) compile through IR.
2. `new Error("msg")`, `new TypeError("msg")` etc. — verifies that
   throw composition with slice 9 works (`throw new Error(...)`
   compiles end-to-end through IR).
3. `new Map()`, `m.set("k", 1)`, `m.get("k")`, `m.has("k")`,
   `m.size` compile through IR.
4. `new Set()`, `s.add(x)`, `s.has(x)`, `s.size` compile through IR.
5. Equivalence test files (one per class family):
   - `tests/equivalence/ir-slice10-date.test.ts`
   - `tests/equivalence/ir-slice10-error.test.ts`
   - `tests/equivalence/ir-slice10-map-set.test.ts`
6. Test262 categories `built-ins/Date/`, `built-ins/Error/`,
   `built-ins/Map/`, `built-ins/Set/` non-regressing.

## Implementation notes

- All classes already in `KNOWN_EXTERN_CLASSES` (#1169i).
- `Date.now()` is a STATIC method call — the current IR layer only
  handles INSTANCE method calls (`recv.method(...)`). May need a
  separate path for static method dispatch (or defer to a later
  follow-up).
- `m.size` is a getter — the IR's `extern.prop` arm handles this
  via the legacy `<className>_get_size` import.

## Composition with slice 9

This step is the natural validation point for the `throw new Error(...)`
pattern. Slice 9 (#1169h) added try/throw/catch IR support; slice
10 step D adds `new Error(...)` IR support; together they enable a
full `try { JSON.parse(s); } catch (e) { ... }` IR claim.

Add a dedicated equivalence test for the composition:
`tests/equivalence/ir-slice10-throw-extern.test.ts`.

## Sub-issue of

\#1169 — IR Phase 4: full compiler migration  
\#1169i — Slice 10 (parent)
