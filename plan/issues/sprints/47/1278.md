---
id: 1278
title: "Update stale lodash-tier1 stress test — resolver fixed, clamp/add behavior changed"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: low
feasibility: easy
reasoning_effort: low
task_type: test
area: tests
language_feature: none
goal: npm-library-support
related: [1031, 1275, 1276, 1277]
---
# #1278 — Update stale lodash-tier1 stress test

## Problem

`tests/stress/lodash-tier1.test.ts` asserts *old broken behavior* that no longer exists.
5/6 tests now fail because the behavior they document has changed:

- **Tests 4, 5** (ModuleResolver @types, resolveAllImports @types): The resolver was fixed
  — it now prefers real `.js` bodies over `@types/.d.ts` declarations. The tests assert
  the broken behavior (`anyTypeDecl: true`, `anyRealJs: false`) which is now inverted.

- **Tests 2, 3** (clamp Wasm validation, add undeclared-ref): Both tests assert that
  `new WebAssembly.Module(result.binary)` throws a specific error. The actual behavior has
  drifted — they no longer throw the same error (either validates now or throws differently).

- **Test 1** (CJS no exports): Also now failing — behavior changed.

## Fix

For each failing test, determine the *current* actual behavior and update the assertion to
match it. Tests documenting progress (fixed gaps) should flip to assert the correct behavior.
Tests documenting remaining gaps (clamp, add) should be updated with the current error message
or marked `.skip` with a comment pointing to the relevant issue (#1275, #1276).

## Acceptance criteria

1. `npm test -- tests/stress/lodash-tier1.test.ts` passes (all 6 tests)
2. Tests 4, 5 assert the fixed resolver behavior (real .js resolved, not @types)
3. Tests 2, 3 either assert new current error or are `.skip`-ped with issue refs
4. No new logic added — test-only change
