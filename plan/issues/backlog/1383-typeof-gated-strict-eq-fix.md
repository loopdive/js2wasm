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
