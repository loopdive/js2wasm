---
id: 1383
title: "narrower typeof-gated strict-equality fix (follow-up to closed PR #272 / #1380)"
status: backlog
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: operators
goal: spec-completeness
related: [1380]
---

# #1383 — Narrower typeof-gated strict-equality fix

## Background

PR #272 (#1380 slice 1) tried to fix `null === 0` returning true by
dropping the numeric-unboxing fallback in `binary-ops.ts` after
`__host_eq` returned false. That made `null === 0` correctly return
false but caused **net -12 test262 passes** (44 improvements vs. 56
real regressions, 92 total) spread across 30+ buckets — see
`https://github.com/loopdive/js2wasm/actions/runs/25538419546`.

The fallback was load-bearing for an unexpected pattern: V8's anyref
representation of host-side primitives (booleans, undefined) doesn't
always satisfy `ref.test (ref any)` in the way the GC fast path
expects, and the numeric-coerce fallback was masking a chain of
small mismatches in unrelated tests (`isPrototypeOf` on null receiver
+ primitive arg, `Array.every` with boolean receiver, etc.).

PR #272 closed unmerged. Issue #1380 reopened back in the queue.

## Proposed approach

Don't drop the fallback wholesale. Instead, gate it on a runtime
typeof check so the unsound coerce only fires when both operands are
actually numbers (where it's sound and matches host_eq):

```ts
return [
  { op: "local.get", index: tmpLeft },
  { op: "local.get", index: tmpRight },
  { op: "call", funcIdx: hostEqIdx },
  {
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: isNeqOp ? 0 : 1 }],
    else: [
      // Only coerce-and-compare numerically if BOTH operands are
      // typeof === "number". Otherwise host_eq's false is definitive.
      { op: "local.get", index: tmpLeft },
      { op: "call", funcIdx: typeofNumIdx },
      { op: "local.get", index: tmpRight },
      { op: "call", funcIdx: typeofNumIdx },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Both numbers — numeric coerce is safe.
          { op: "local.get", index: tmpLeft },
          { op: "call", funcIdx: unboxIdx },
          { op: "local.get", index: tmpRight },
          { op: "call", funcIdx: unboxIdx },
          { op: isEqOp ? "f64.eq" : "f64.ne" },
        ],
        else: [
          // Cross-type or non-number: host_eq's result is final.
          { op: "i32.const", value: isNeqOp ? 1 : 0 },
        ],
      },
    ],
  },
];
```

This:
1. Preserves the load-bearing same-type-different-identity fallback
   for boxed numbers.
2. Fixes `null === 0` because the typeof check filters non-number
   operands.
3. Doesn't cascade — the only behavioural change is for cross-type
   comparisons, which were already wrong in the spec direction.

## Acceptance criteria (same as #1380 slice 1)

1. `language/expressions/strict-equals/S11.9.4_A8_T4.js` passes
   (null !== 0, null !== false, etc.)
2. `tests/issue-1380.test.ts` (24 cases — see PR #272's branch
   `issue-1380-equality-symbol-bigint-referror` for the test file)
   pass, transplanted into a new branch.
3. **No net-negative test262 delta**. The previous PR was -12; this
   one must be >= 0 with regressions <= 10% of improvements.

## Files

- `src/codegen/binary-ops.ts` — narrow the strict-equality fallback
  to a typeof-gated path (lines 1503–1519 of the closed PR's diff).
- `tests/issue-1383.test.ts` — adapt the 24-case test file from
  PR #272's `tests/issue-1380.test.ts`.

## Notes

The closed PR's diff is at:
`https://github.com/loopdive/js2wasm/pull/272/files`

The triage analysis is in the PR escalation message and the CI run:
`https://github.com/loopdive/js2wasm/actions/runs/25538419546`.

Likely senior-dev territory given the test262 cascade risk; mark
`reasoning_effort: high` accordingly.

## Investigation 2026-05-09 (dev-1388, PR #329 closed)

Implemented the typeof-gate exactly as specified in the issue file's
"Proposed approach" pseudocode. CI feed: `net_per_test = +2`,
`regressions_real = 49`, `improvements = 51`, ratio 96%, baseline_stale=false.
Same cascade pattern as PR #272 — net swing was barely positive but the
ratio is way over the 10% gate.

Improvements: all in `language/expressions/strict-equals/S11.9.4_*` (the
target cluster — typeof-gate correctly returns false for `null===0`,
`undefined===0`, etc.).

Regressions span 30+ unrelated buckets:
- `0.11 === JSON.parse('1.1e-1')` — f64 === f64 case where the typeof gate
  fires unexpectedly. Both are typeof "number", so the gate SHOULD allow
  the unbox compare, but something downstream still returns the wrong
  identity result. The unbox path produces `0.11 === 0.11` but the test
  also checks against `JSON.parse(...)`. The chain may be losing identity
  at a different layer (maybe the AnyValue tagged-number path doesn't
  share boxes).
- `Array.prototype.every.call(true, ...)` — boolean externref receiver.
  `Array.prototype.every.call(true)` should TypeError per spec, but we
  return false instead. The host_eq check for nullish-receiver may be
  intercepting before the receiver-TypeError fires.
- `Object.prototype.isPrototypeOf.call(null, prim)` — null receiver, prim
  arg. Should TypeError on `this`.
- `verifyProperty` descriptor identity comparisons in
  `Symbol.unscopables`, `defineProperties`, `defineProperty` — descriptor
  field-by-field equality where a sub-property is now strict-eq false
  when the runtime types differ even though the values match.

Root cause hypothesis: the typeof-gate IS doing the right thing for the
specifically-named null/undefined cluster, but the strict-eq fallback
path is also load-bearing for **boxed-number identity recovery** which
the typeof gate intercepts in many AnyValue-tagged-number contexts. The
spec direction is correct (cross-type strict eq is always false), but
the AnyValue path's boxing produces same-value-different-identity
externrefs that are typeof "number" on both sides — and ought to match.
But our test262 CI says they don't, which suggests the typeof_number
helper itself isn't matching some boxed-number variants.

Next slice should:
1. Investigate why `JSON.parse('1.1e-1')` produces an externref where
   `__typeof_number` returns 0 (or where the unbox path doesn't recover).
2. Investigate the boolean/null receiver TypeError paths separately —
   those may be unrelated to the strict-eq fix and just expose other
   pre-existing bugs that were masked by the (incorrect) cross-type
   true result.

PR #329 closed unmerged. Worktree removed. Reopening as a separate
narrower issue tracking only the receiver-TypeError + AnyValue
boxed-number cluster would unblock incremental progress.
