---
id: 1385
sprint: 51
title: "HANG: Temporal/Duration/from/argument-non-string.js — infinite runtime loop"
status: in-progress
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: temporal
goal: spec-completeness
---
# #1385 — Temporal Duration.from hang: compiled Wasm runs forever

## Problem

`test/built-ins/Temporal/Duration/from/argument-non-string.js` is in HANGING_TESTS.
The compiled Wasm does not terminate — the test worker hangs indefinitely and must be
killed. This blocks the entire test shard.

## Background

The test exercises `Temporal.Duration.from(value)` where `value` is a non-string
(object, number, etc.). The spec algorithm involves iterating over duration field names
and coercing them. Our compiled output likely enters an infinite loop because:

- A loop counter or termination condition is not correctly mutated (captured variable
  treated as immutable snapshot — ref-cell pattern not applied).
- Or a Temporal polyfill internal iterator never terminates in our Wasm runtime.

## Investigation steps

1. Compile the test file and run with a 5-second Wasm timeout to capture partial
   output:
   ```bash
   npx tsx -e "
   import {compile} from './src/index.ts';
   import {readFileSync} from 'fs';
   const src = readFileSync(
     'test262/test/built-ins/Temporal/Duration/from/argument-non-string.js', 'utf-8'
   );
   const r = compile(src, {fileName:'test.ts'});
   if (!r.success) { console.log('CE:', r.errors[0].message); process.exit(0); }
   const timeout = setTimeout(() => { console.log('HANG confirmed'); process.exit(1); }, 5000);
   const {instance} = await WebAssembly.instantiate(r.binary, {});
   clearTimeout(timeout);
   instance.exports.test?.();
   "
   ```
2. Identify the loop in the compiled source — look for `while`/`for` loops in the
   Temporal Duration.from implementation path.
3. Check if the loop variable is a mutable capture that needs a ref cell.

## Fix

Apply the appropriate fix:
- If a loop variable is immutable capture: add ref-cell wrapping.
- If the loop relies on a property (`length`, `.done`) that we don't propagate
  correctly: fix the property access in the loop condition.

## Acceptance criteria

1. The test compiles and terminates within 5 seconds (pass or fail — no hang).
2. Remove the HANGING_TESTS entry for `test/built-ins/Temporal/Duration/from/argument-non-string.js`.
3. No regression in other Temporal tests.
