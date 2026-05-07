---
id: 1223
sprint: backlog
title: "TDZ async/gen: writer+reader fn-decl sharing via destructure-assign path (#1205 follow-up)"
status: wont-fix
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

## Wont-fix rationale (2026-05-07)

Closed as wont-fix after fourth consecutive deferral (S47 → S48 → S49 → S50 decision point).

**Reasons:**

1. **Heavy dependency chain**: requires #1177 Stage 1 (capture-index correction) + #1205 (FNDECL-A2..A5 plumbing) to land first. Both are substantial, unscheduled pieces of work.

2. **No test262 leverage**: cited in every deferral. The failing pattern (`for await ([x] of ...)` destructure-assign writer visible to reader fn-decl) covers a narrow async generator usage. No measurable conformance gain.

3. **Complexity/value ratio**: the issue's three-part fix (Parts A+B+C) UNDER-states the actual scope (see senior-dev findings below).

4. **Sprint 50 was the explicit decision point**: sprint 50 goals stated "Pull only if capacity surplus. Decide: commit or backlog after S50." Capacity was used on higher-value issues. Decision: wont-fix.

### Senior-dev investigation findings (2026-05-07)

I built a 10-case probe (`.tmp/probe-1223.mts`) and ran it against current main
(commit `e08854705`). **The issue still reproduces** in 3 of 10 cases — all the
function-scoped `let x` + nested gen/async writer + separate reader fn-decl
pattern. Module-level `let x` and same-function nested readers already work
correctly today.

**The fix scope is ~3× larger than the issue file describes.** The issue's
Parts A+B+C are necessary but not sufficient. Two additional gaps surface
when Part A is applied in isolation (failure mode shifts from stale-read to
the same `RuntimeError: dereferencing a null pointer` that broke 48+ tests
in PR #98 R3):

- **Part D (NEW)** — `src/codegen/expressions/calls.ts:5425`: the non-mutable
  cap-prepend reads `cap.outerLocalIdx` directly. After a mutable
  cap-prepend (e.g. writer's first call) boxes the outer local via
  `localMap[x] := __boxed_x`, the reader's `cap.outerLocalIdx` still points
  to the *original* f64 slot which holds the initial value (never updated
  through the cell). Reader reads stale. ~40 LoC.

- **Part E (NEW)** — the issue's Part B references
  `compileForOfAssignDestructuringExternref` (loops.ts:1503), which is
  already box-aware (#1258 added that, line 1643). But `for ([x] of [[1]])`
  with vec/struct elements does NOT flow through the externref path —
  it flows through `compileForOfAssignDestructuring` (loops.ts:1111), which
  does direct `local.set targetLocal` (line 1385) with NO `boxedCaptures`
  handling. ~80–150 LoC. Multiple parallel destructure-assign emit sites
  (object-pattern, nested array, bare `[x] = arr` outside for-of) likely
  need the same parallel fix.

Total fix scope: **~250–350 LoC across 3–4 files** (closures.ts, calls.ts,
loops.ts, possibly nested-declarations.ts and expressions.ts) with HIGH
regression risk on a code path that has historically broken 48+ test262
tests on similar attempts.

**Trivial workaround exists**: replace `for ([x] of arr)` with
`for (const pair of arr) { x = pair[0]; }` — works today.

Estimated fix yield: 5–15 additional test262 passes on the
`async-{func,gen}-decl-dstr-*` cluster (174/267 passing today).
Real-world frequency: lodash, hono, day.js corpora don't hit it.

### Decision

The cost-benefit (~300 LoC + high risk + small yield + trivial workaround)
does not justify the work. Recommended close, with a "known limitation"
note added to spec-completeness docs pointing users to the workaround.

Re-opening triggers: any future change that converges the multiple
destructure-assign emit sites into a unified `emitDestructureAssignTarget`
helper (e.g. via the IR-side Slice 14 abstraction) — at that point
parts A+D+E collapse to a single helper change and become tractable.
