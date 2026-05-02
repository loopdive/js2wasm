---
id: 1259
title: "async-gen yield-star sync-fallback leaks unboxed ref-cell into iter capture"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: async-generators, iterator-protocol
goal: async-model
related: [1177, 1245, 1205]
depends_on: []
test262_fail: 50
---

## Implementation note (2026-05-02, dev-1245)

The 50 failing async-gen-yield-star tests described in the issue body are
**latent on main today** — the bug only manifests when #1177 Stage 1 (the
`localMap.get(cap.name) ?? cap.outerLocalIdx` substitution) is applied.
On main today, all 50/56 async-gen-yield-star tests pass because the
cap-prepend reads from `cap.outerLocalIdx` (the stale-slot path) which
points at the original value local — never a boxed ref-cell-ref — so
the double-wrap doesn't fire.

This PR therefore implements Option B (type-check guard) as a **defensive
precondition** for the eventual #1177 Stage 1 re-attempt:

- Probe `localMap.get(cap.name)`'s type before entering the fresh-box
  branch.
- If the candidate slot is already a `ref __ref_cell_T` matching the
  expected value type, treat as already-boxed and pass the ref through
  directly (skip the redundant `struct.new`).
- Backfill `boxedCaptures[cap.name]` so subsequent reads/writes through
  helper paths (e.g. #1258 box-aware destructure-assign) detect the
  boxed state correctly.

Expected CI impact today: **net 0** (the path isn't reached on main).
Expected CI impact when Stage 1 re-lands: removes the ~50 async-gen
yield-star regressions from the count.

Tests added (`tests/issue-1259.test.ts`):

- normal mutable capture round-trip (sanity)
- two consecutive calls share the same ref cell (no double-wrap on second call)
- multiple mutable captures across nested calls (no cross-pollution)
- mutating capture across many invocations aggregates correctly

The "arrow-wraps-fn-decl with mutable capture" test that exposes the
Stage-1 underlying bug is documented as a comment but not asserted —
that's #1177 Stage 1's job, not #1259's.

---

# #1259 — `yield*` async sync-fallback unboxes a ref-cell as the original value type

## Background

This issue was identified during the #1245 investigation of why PR#125 / PR#155
landed with 81 real regressions. It is **the second-largest blocking cluster**
for re-landing #1177 Stage 1, and the only one rooted in async-generator
codegen.

## Problem

`yield* obj` inside an async generator goes through the iterator-protocol
fallback specified in §27.6.3.7 / §7.4.1 (`GetIterator`):

1. Look up `obj[@@asyncIterator]`. If undefined,
2. Look up `obj[@@iterator]` (the SYNC iterator).
3. Wrap the sync iterator in a CreateAsyncFromSyncIterator adapter.

In our codegen, the fallback wraps the iter in a closure-style trampoline
that captures the iter via the call-site cap-prepend (calls.ts:5089–5148). When
the captured iter has been re-aimed in `fctx.localMap` to a **boxed ref cell**
(because some earlier closure forced boxing of the value), the cap-prepend
mutable-branch struct-news the boxed ref as if it were the value:

```ts
const sourceLocalIdx = fctx.localMap.get(cap.name) ?? cap.outerLocalIdx;
fctx.body.push({ op: "local.get", index: sourceLocalIdx });   // ref cell ref
fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx }); // wraps the ref-cell-ref
```

The lifted iter trampoline then unwraps the outer cell and reads its content
as the original value type — but the content is itself a `ref __ref_cell_T`
ref, not the underlying value. The cast emitted to the original type
produces null, and the next op `null.iter.next()` traps with "dereferencing
a null pointer".

## Canonical reproduction

From test262
`language/expressions/object/method-definition/async-gen-yield-star-getiter-async-undefined-sync-get-abrupt.js`:

```js
var calls = 0;
var reason = {};
var obj = {
  get [Symbol.iterator]() { throw reason; },
  get [Symbol.asyncIterator]() { calls += 1; return undefined; },
};
var gen = { async *method() { yield* obj; throw new Test262Error('…'); } }.method;
gen().next().then(() => { /* fail */ }, v => {
  assert.sameValue(v, reason, 'reject reason');
  assert.sameValue(calls, 1);
  /* … */
});
```

After Stage 1 reads the correct (boxed) slot for the captured iter, the
sync-fallback codegen receives a ref-cell ref where it expects a value, and
the trampoline body deref's null on first `.next()`.

## test262 impact

The CI runs of PR#125 and PR#155 both showed ~50 tests fail with the
"dereferencing a null pointer" signature in the
`async-gen-yield-star-*` cluster. The full set is in
`/tmp/pr125-detail.txt` (cherry-picked into worktree investigation). Sample
paths:

- `async-gen-yield-star-getiter-async-undefined-sync-get-abrupt.js`
- `async-gen-yield-star-getiter-async-returns-{abrupt,boolean,null,number,string,symbol,undefined}-throw.js`
- `async-gen-yield-star-getiter-sync-returns-{number,string,symbol,undefined}-throw.js`
- `async-gen-yield-star-next-then-non-callable-{boolean,null,number,object,string,symbol,undefined}-fulfillpromise.js`

## Fix sketch

The cap-prepend mutable branch in `compileCallExpression` (calls.ts:5089ff)
currently has two cases:

```ts
if (fctx.boxedCaptures?.has(cap.name)) {
  // Already a ref cell — pass the ref cell reference directly
} else {
  // Fresh box: read value, struct.new ref cell
}
```

The bug is that when `localMap` was re-aimed at a boxed local *but
`fctx.boxedCaptures` was not synchronously updated* (e.g., the boxing happened
in a sibling lifted scope whose `boxedCaptures` map was discarded), we hit
the `else` branch and double-wrap.

Fix options:

- **A.** Audit every site that re-aims `fctx.localMap.set(name, boxedLocal)`
  to also `fctx.boxedCaptures.set(name, …)` in lockstep.
- **B.** Detect double-wrap by checking `getLocalType(fctx, sourceLocalIdx)`
  against `cap.valType`: if the local is a `ref __ref_cell_T` and `cap.valType`
  is `T`, the entry is already boxed — pass the ref directly without
  struct.new'ing again.
- **C.** Make the async-gen yield-star trampoline body box-aware: emit a
  conditional unwrap based on the runtime type tag.

Recommend **(B)**: it's a localised fix at the cap-prepend site that handles
the synchronisation gap without auditing every re-aim site. Type-check the
candidate slot — if it's `ref __ref_cell_T` and `cap.valType` is `T`,
treat it as `boxedCaptures.has(cap.name) === true` and skip the fresh-box
struct.new.

## Acceptance criteria

1. The 6 named test262 cases pass.
2. The full `async-gen-yield-star-*` cluster shows ≥ 30 net improvements.
3. No regressions in `language/expressions/await/*` or
   `language/statements/for-await-of/*`.
4. Equivalence test added: `tests/issue-1259.test.ts` reproducing the
   "yield* with sync-iter fallback through a captured iter" pattern.
5. After this AND #1258 land, #1177 Stage 1 should re-land with net ≥ +90.

## Out-of-scope

- Native `Symbol.asyncIterator` codegen (the fallback path is what we fix
  here). Tracked separately.
- Async-iterator return-on-abrupt-completion (§27.6.3.7 step 7.b) — already
  in #1219.

## Related

- #1177 — TDZ propagation (Stage 1 blocked on this)
- #1245 — Investigation finding
- #1205 — TDZ async-gen infrastructure (already landed)
- #1219 — Async iterator close on abrupt completion
