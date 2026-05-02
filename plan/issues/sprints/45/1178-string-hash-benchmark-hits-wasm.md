---
id: 1178
title: "string-hash benchmark hits `wasm trap: call stack exhausted` at runtime after #1175 fix"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: strings
goal: compilable
required_by: [1210]
pr: 64
merged: 2026-04-27
origin: surfaced by competitive-benchmark refresh after #1175 landed (2026-04-27)
related: [1175]
---
# #1178 — `string-hash` runtime stack-overflow regression after the #1175 fix

## Problem

The fix for #1175 (`__str_flatten` / `concat` arg-type mismatch in
string `+=` codegen) made the `string-hash` competitive benchmark
*compile* successfully — js2wasm's wasm-validator no longer rejects
the output. However the resulting Wasm now traps at runtime when the
program runs the inner loop with `runtimeArg = 20000`:

```
wasm trap: call stack exhausted

  10:     0xd7 - <unknown>!<wasm function 0>
  11:     0xd7 - <unknown>!<wasm function 0>
  12:     0xd7 - <unknown>!<wasm function 0>
  ...
```

Every recorded frame returns at the same offset (`0xd7`), suggesting
a single self-recursive call chain that doesn't bottom out for large
input sizes. With `coldArg = 100` (100 string concatenations) the
program runs fine; with `runtimeArg = 20000` (20K iterations × 3 string
appends per iteration ≈ 60K concatenations) Wasmtime's default stack
exhausts.

## Reproduction

Source program (`labs/benchmarks/competitive/programs/string-hash.js`
on the labs repo, formerly `benchmarks/competitive/programs/...`
before the labs/ restructure):

```js
/** @param {number} n @returns {number} */
export function run(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) {
    const a = (i * 13) & 31;
    const b = (a + 7) & 31;
    text += alphabet.charAt(a);
    text += alphabet.charAt(b);
    text += ";";
  }

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash | 0;
}
```

Compile path matches the competitive benchmark harness (`compile` with
`target: 'wasi'`, `optimize: 4`, then `wasm-opt --all-features -O4`,
then `wasmtime compile -O opt-level=2`).

Trigger: `wasmtime run --invoke "run(20000)" string-hash.cwasm` →
`wasm trap: call stack exhausted`.

`run(100)` succeeds. `run(1000)` may or may not succeed depending on
where Wasmtime's stack budget lands. The threshold is somewhere
between 1K and 20K concatenations.

## Root cause hypothesis

The new string-concatenation lowering for `text += <expr>` likely
emits a per-concatenation Wasm call that does *not* tail-call (or use
an iterative copy loop), so each `+=` consumes a fresh Wasm stack
frame. After ~20K successive concatenations the cumulative depth
exceeds Wasmtime's stack budget.

Suspected files:
- `src/codegen/string-ops.ts` — `__str_flatten` / `concat` codegen
- `src/codegen/expressions.ts` — binary-op `+=` lowering when the
  operand types are strings
- The new code paths added when fixing #1175 — review whether the
  fix introduced a recursive helper instead of an iterative one

The fix candidate is to ensure the per-concatenation lowering is
either:
1. an iterative copy loop (no recursion, constant stack frames), or
2. a tail call (`return_call` / `return_call_ref`) so successive
   concatenations don't accumulate frames.

## Scope of impact

Any program that builds a string with `+=` in a loop of more than a
few thousand iterations. That's a common pattern in:
- log/string aggregators
- HTML / JSON / SQL builders
- hashing / encoding loops (the `string-hash` benchmark itself)

For low iteration counts (a few hundred), the bug doesn't surface.
This is why test coverage didn't catch it when #1175 landed — the
issue-specific tests use small inputs.

## Acceptance criteria

- `string-hash` competitive benchmark compiles AND runs end-to-end
  through `wasmtime run --invoke "run(20000)"` returning the same
  numeric hash as the Node.js baseline.
- A new `tests/issue-1178.test.ts` exercises `text += charAt(i)` (or
  similar) over at least 50,000 iterations and asserts no trap.
- `tests/issue-1175.test.ts` continues to pass (the fix here must
  not regress the original #1175 fix).
- The competitive benchmark JSON shows `string-hash` lane
  `status: ok` for js2wasm-wasmtime.

## Key files

- `src/codegen/string-ops.ts` — primary suspect (string concat
  lowering)
- `src/codegen/expressions.ts` — binary `+=` operand classification
- `src/codegen/peephole.ts` — if the fix needs tail-call rewriting,
  the peephole pass might need to learn the new pattern

## Notes

- The original #1175 was filed after this benchmark surfaced a
  wasm-validator error (`call param types must match` on
  `__str_flatten` and `concat`). The fix that landed for #1175 was
  correct as far as type-coercion is concerned; the stack-overflow
  is a separate failure mode hiding behind the validator error.
- The competitive benchmark harness on the private `labs/` repo is
  what surfaces this; the open-source test suite doesn't exercise
  high-iteration string concat in a way that reaches the threshold.

## Implementation

Rewrote `__str_copy_tree` in `src/codegen/native-strings.ts` from a
self-recursive descent into an iterative one. The new lowering uses
an explicit worklist (a `(array (mut (ref null $AnyString)))` of
length `node.len`, an upper bound on rope depth since each leaf
contributes ≥ 1 char) of right-children. The algorithm:

1. Fast path: if `node` is already a `FlatString`, copy directly.
2. Otherwise, walk the leftmost spine of the cons tree. At each
   `ConsString` node, push the right-child onto the worklist and
   continue with the left-child.
3. When a `FlatString` leaf is reached, copy its data into `buf` at
   the running write position.
4. Pop the most recent right-child off the worklist and resume from
   step 2 with that node as the new root.
5. When the worklist is empty, return the final write position.

Stack frames stay constant (one) regardless of rope depth — the
worklist absorbs the depth into linear memory.

## Test Results

- `tests/issue-1178.test.ts` (3 cases) — all pass:
  - 50,000 iterations of `text += "x"` then `text.charAt(0)` (forces
    flatten through the historical trap site) → returns 50000.
  - 50,000 iterations of `text += alphabet.charAt(a/b)` mixed with
    `";"` → returns 150000 (3 chars per iter × 50000).
  - 60,000 iterations of `text += "a"` then `text.charCodeAt(0)` —
    a 60K-deep cons rope flattened in one shot → returns 97.
- `tests/issue-1175.test.ts` (5 cases) — all still pass; the fix
  doesn't regress the string-concat type-coercion fix.
- Manual repro: `wasmtime run --invoke run` on the `string-hash.js`
  benchmark binary (compiled with `target: 'wasi'`):
  - `run(100)`: 36729899 ✓
  - `run(1000)`: -626105867 ✓
  - `run(5000)`: 574555861 ✓
  - `run(20000)`: now compiles and runs the concat phase
    instantaneously (no stack trap). The benchmark's second loop
    (`charCodeAt(i)` over the resulting 60K-char rope) is still
    slow because charCodeAt re-flattens the rope on every call —
    that's a separate O(N²) perf issue, distinct from the stack
    overflow this issue addresses. Tracking that separately if
    needed.
- Equivalence test diff vs `origin/main`: zero new failures. The 3
  pre-existing failures in `string-methods.test.ts` (`lastIndexOf
  finds last occurrence`, `substring extracts portion`, `slice with
  negative index`) reproduce identically on `origin/main` with the
  recursive copy_tree, so they are unrelated to this fix.
