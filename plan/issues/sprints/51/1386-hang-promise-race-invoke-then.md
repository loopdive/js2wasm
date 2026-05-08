---
id: 1386
sprint: 51
title: "HANG: Promise/race/invoke-then.js — compilation or runtime infinite loop"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: promise
goal: spec-completeness
related: 860
---
# #1386 — Promise.race invoke-then hang

## Problem

`test/built-ins/Promise/race/invoke-then.js` is in HANGING_TESTS. The test hangs —
either during compilation or at runtime.

Per the backlog note in #860: the test previously hung at runtime (Promise.race loop),
but may now error instead of hang. Needs fresh investigation to determine current
behavior.

## Investigation steps

```bash
npx tsx -e "
import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
const src = readFileSync(
  'test262/test/built-ins/Promise/race/invoke-then.js', 'utf-8'
);
const t0 = Date.now();
const r = compile(src, {fileName:'test.ts'});
console.log('compile:', Date.now() - t0, 'ms');
if (!r.success) { console.log('CE:', r.errors[0].message); process.exit(0); }
const timeout = setTimeout(() => { console.log('HANG at runtime'); process.exit(1); }, 5000);
const {instance} = await WebAssembly.instantiate(r.binary, {});
clearTimeout(timeout);
instance.exports.test?.();
console.log('PASS/FAIL — no hang');
" 2>&1
```

## Expected outcome

If compile hang: trace the recursive compilation path causing unbounded recursion.
If runtime hang: trace the Promise.race iteration that never terminates.

## Acceptance criteria

1. Test terminates within 5 seconds (pass, fail, or CE — no hang).
2. Remove the HANGING_TESTS entry for `test/built-ins/Promise/race/invoke-then.js`.
3. No regression in Promise.race suite.
