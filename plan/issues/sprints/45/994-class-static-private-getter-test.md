---
id: 994
title: "Class static-private-getter test hits 30s compiler timeout"
status: done
created: 2026-04-07
updated: 2026-04-27
completed: 2026-04-27
priority: medium
feasibility: medium
reasoning_effort: medium
goal: compilable
resolved_by: "#1085 (iterative bodyUsesArguments, PR #127)"
test262_ct: 1
---
# #994 -- Class static-private-getter test hits 30s compiler timeout

## Problem

The latest full recheck (`benchmarks/results/test262-results-20260407-005506.jsonl`)
contains a dedicated **30s compile timeout** for:

- `test/language/statements/class/elements/static-private-getter.js`

This likely points to a class/private-element lowering path that is still
pathological even after earlier class/private-member fixes.

## Existing context

Related class/private issues have already been fixed in earlier sprints, but
this specific test is still expensive enough to exhaust the compile timeout
instead of failing quickly.

## ECMAScript spec reference

- [§15.7.14 Runtime Semantics: ClassDefinitionEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation) — step 22: static private methods installed on constructor
- [§7.3.31 PrivateGet](https://tc39.es/ecma262/#sec-privateget) — accessor: calls getter function with object as receiver


## Suggested fix

1. Reproduce the file in isolation
2. Compare generated lowering against nearby passing private getter/setter tests
3. Fix the slow path in static private accessor lowering or helper emission

## Acceptance criteria

- `static-private-getter.js` compiles in <5s locally
- no `compile_timeout` remains for this test in a full recheck

## Test Results

After PR #20 (sprint 45) and the #995/#996 follow-up:
- `class/elements/static-private-getter.js` — compiles in 801 ms, runs in 3 ms (returns 3 — assertion fail, NOT a compile_timeout). The `compile_timeout` symptom from the original baseline was caused by other compile-timeout root causes that have since been addressed. The test currently lands in the `assertion_fail` bucket, not `compile_timeout`.

Acceptance criteria met:
- compiles in <5s locally ✓
- no compile_timeout in baseline ✓ (already a regular `fail`)

The remaining `assertion_fail` (returned 3 — assert #2 expected `C.access.call({})` to throw TypeError) is a separate concern about static private member brand checks and is tracked elsewhere.
