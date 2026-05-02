---
id: 1223
title: "TDZ async/gen: writer+reader fn-decl sharing via destructure-assign path (#1205 follow-up)"
status: blocked
created: 2026-05-01
updated: 2026-05-01
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: closures
goal: crash-free
depends_on: [1177, 1205]
es_edition: ES2017+
related: [1205, 1177, 1169f]
origin: "Surfaced during #1205 fix (2026-05-01). Force-boxing the value capture causes null_deref when the write reaches the capture via destructure-assign LHS — the destructure-assign emit path does direct local.set bypassing boxedCaptures. #1205 reverted force-boxing to avoid this, sacrificing the writer+reader sharing case."
---
# #1223 — TDZ: writer+reader fn-decl sharing via destructure-assign (#1205 follow-up)

## Problem

Issue #1205 reverted `isMutable = writtenInBody.has(name) || hasTdzFlag` to just
`isMutable = writtenInBody.has(name)` to fix the for-await-of null_deref cluster.
This was correct — the force-boxing caused null_deref when destructure-assign paths
bypassed `boxedCaptures` with a raw `local.set`.

However, the deferred capability is: when a `let`/`const` binding is **both**
read and written across a fn-decl closure boundary, the value capture should be
force-boxed so the writer's mutations are visible to the reader.

Example:
```js
let x = 0;
async function writer() { for await ([x] of [[1]]) {} }
function reader() { return x; }
await writer();
return reader(); // should return 1
```

This requires:
1. `collectWrittenIdentifiers` recognizes destructure-assign LHS (`[x] of ...`)
   as a write to `x` — so `writtenInBody.has('x') = true`
2. The destructure-assign emit path (`compileForOfAssignDestructuringExternref`,
   `loops.ts:1430`) uses `emitBoxedCaptureSet` instead of direct `local.set` when
   the capture is force-boxed
3. Stage 1 of #1177 (capture-index correction) must also be live for the fn-decl
   path to find the correct capture slot

## Root cause of the deferred case

`collectWrittenIdentifiers` in `closures.ts` collects writes via:
- `=`, `+=`, `-=`, `++`, `--` (assignment operators)
- NOT: destructure-assign LHS (`[x] = ...`, `({x} = ...)`, `for ([x] of ...)`)

So `writtenInBody.has('x') = false` for the destructure-assign write, and the
force-box doesn't trigger, and the writer's mutation is invisible to the reader
(capture is a snapshot copy, not a ref-cell).

## Fix plan

### Part A: Extend `collectWrittenIdentifiers`

In `src/codegen/closures.ts`, extend the tree walk to recognize:
- `ArrayBindingPattern` / `ObjectBindingPattern` in for-of/for-await-of LHS
- `DestructuringAssignment` LHS identifiers
- All names found in destructure LHS positions → add to `writtenNames`

### Part B: Make destructure-assign emit boxed-capture-aware

In `src/codegen/loops.ts:compileForOfAssignDestructuringExternref` (and the
equivalent statements.ts path), when the target local is a boxed capture
(i.e., its `localIdx` maps to a `struct.get`/`struct.set` in `boxedCaptures`),
emit via `emitBoxedCaptureSet` instead of direct `local.set`.

This is the same fix needed for #1177 Stage 2/3 in the for-of context.

### Part C: Gate on Stage 1 of #1177

`isMutable` force-boxing only kicks in when Stage 1's capture-index correction
(`fctx.localMap.get(cap.name) ?? cap.outerLocalIdx`) is also live. Otherwise
the force-boxed ref-cell has the wrong slot index and reads stale.

## Acceptance criteria

1. `issue-1223.test.ts` case: async fn-decl that writes `x` via destructure-assign
   (`for await ([x] of ...)`) is visible to a reader fn-decl → `return reader() === 1`
2. All `language/statements/for-await-of/async-{func,gen}-decl-dstr-*` tests pass
3. No regression on #1205's acceptance criteria (the no-close / flag-box tests)
4. `collectWrittenIdentifiers` correctly identifies destructure-assign LHS writes

## Blocked by

- #1177 Stage 1 (capture-index correction) must land first — it corrects the
  slot index that the force-boxed ref-cell reads from
- #1205 must be merged first (provides the FNDECL-A2..A5 plumbing)
