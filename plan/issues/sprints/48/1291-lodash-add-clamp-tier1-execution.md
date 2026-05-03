---
id: 1291
sprint: 48
title: "lodash Tier 1b — upgrade add/clamp stress tests to execution-level assertions"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: npm-package-imports, closures
goal: npm-library-support
depends_on: [1276, 1277, 1279]
related: [1278, 1295]
---
# #1291 — lodash Tier 1b: upgrade add/clamp to execution-level assertions

## Background

`tests/stress/lodash-tier1.test.ts` currently has two partial tests:

1. **`add.js`** — only asserts `WebAssembly.Module(binary)` doesn't throw (Wasm
   validates). Comment says "tracked under #1276 (HOF returning closure pattern)".
   #1276 has since landed (S47). The test was never upgraded.

2. **`clamp.js`** — only asserts the module validates. Comment says
   "instantiation still fails on a missing import". The missing import has not
   been investigated.

## Goal

Bring both tests to the same level as the `identity` test: compile → instantiate
→ call → assert correct return value.

## Task breakdown

### Part A — `add.js` (HOF pattern, #1276 landed)

`lodash-es/add.js` re-exports `createMathOperation(fn, 0)` where `fn = (a,b)=>a+b`.
Since #1276 fixed function-valued module exports (HOF returning closure), `add`
should now be callable from the Wasm module.

1. Attempt full instantiation of the compiled `add.js` module.
2. Call `exports.add(2, 3)` and assert `5`.
3. If it fails: document the specific error and file a child issue.

### Part B — `clamp.js` (missing import investigation)

`lodash-es/clamp.js` imports `toNumber` which uses `_baseTrim`, `isObject`,
`isSymbol` — a chain of lodash utilities. The missing import at instantiation
time is likely one of these.

1. Build the import object manually, identify which import slot is missing.
2. If the missing import is a standard builtin (`Math.min/max`, `isNaN`, etc.):
   check whether the compiler should be resolving it statically instead of
   emitting a host import.
3. If the missing import is a lodash utility that should have been inlined: file
   a child issue for the inlining gap.
4. Document findings in this issue file.

## Acceptance criteria

1. `add` test upgraded: `exports.add(2, 3) === 5` passes (or blocker documented)
2. `clamp` missing import identified by name; either fixed or child issue filed
3. `clamp` test upgraded to instantiation-level if import gap is closed
4. No regression in existing lodash Tier 1 tests (identity, resolver tests)

## Files

- `tests/stress/lodash-tier1.test.ts` — upgrade test bodies
- `plan/issues/sprints/48/1291-lodash-add-clamp-tier1-execution.md` — this file

## Findings (2026-05-03)

Both `add.js` and `clamp.js` were probed end-to-end. The "missing import" theory
in the original write-up was **incorrect**.

### Part B — `clamp.js` import resolution

`clamp.js` compiles to a Wasm module with **88 imports**. After
`buildImports(result.imports, undefined, result.stringPool)`, **all 88 imports
are satisfied**. There is no missing import. The `clamp` and `default` exports
are emitted as `function` exports (not globals). Despite this, instantiation
throws a `WebAssembly.Exception` (not a `LinkError`) — the throw originates
from inside the start function (function index 80, `__module_init`), which
runs the lodash transitive top-level init code.

### Part A — `add.js` import resolution

`add.js` compiles to a Wasm module with **77 imports**. All imports satisfied.
But `add` and `default` are emitted as **`global` exports** (closure references)
because `createMathOperation(fn, 0)` is an HOF returning a closure. #1276 fixed
the closure compilation but the call-site surface for the resulting closure is
not exposed as a Wasm function export — calling `exports.add(2,3)` is therefore
not directly possible even if instantiation succeeded. Like clamp, instantiation
also throws a `WebAssembly.Exception` from the start function before we can
test the closure call.

### Real root cause — start-function throw during lodash transitive init

The lodash dep chain runs feature-detection idioms at top-level:

- `_freeGlobal.js`: `var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;`
- `_root.js`: `var root = freeGlobal || freeSelf || Function('return this')();`
- `_Symbol.js`: `var Symbol = root.Symbol;` etc.

When compiled, the chain of short-circuiting `||` over property accesses on
host-resolved globals interacts badly with the compiler's null-check protection
on member accesses. The result is a `throw 0` somewhere in the start function
that fires unconditionally during `WebAssembly.instantiate`.

Tracked under child issue **#1295** (filed in this sprint).

### Test changes

`tests/stress/lodash-tier1.test.ts` is updated so both `add.js` and `clamp.js`
tests now:

1. Assert all Wasm imports are satisfied (proves "no missing import")
2. Assert instantiation throws `WebAssembly.Exception` (not `LinkError`)
3. Document the start-function gap with #1291 + #1295 references

This locks in the current honest state: the modules validate, the imports
resolve, the start-function throws. When #1295 lands, these tests can be
upgraded to call `exports.clamp(-10, -5, 5) === -5` and (separately for `add`,
once the closure-export surface is added) `exports.add(2, 3) === 5`.

## Acceptance criteria — status

1. `add` test upgraded — **DONE (blocker documented)**: now asserts no missing
   imports + WebAssembly.Exception class. Execution-level assertion gated on
   #1295 + closure-export surface.
2. `clamp` "missing import" investigated — **DONE**: there is no missing
   import; child issue #1295 filed for the actual root cause.
3. `clamp` test upgraded — **DONE (partial)**: upgraded to instantiation-attempt
   level; full execution gated on #1295.
4. No regression in existing lodash Tier 1 tests — **DONE**: identity tests
   still pass; the two updated tests now also pass against current main.
