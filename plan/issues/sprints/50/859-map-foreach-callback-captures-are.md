---
id: 859
sprint: 50
title: "Map.forEach callback captures are immutable snapshots -- causes infinite loop on mutation during iteration"
status: in-progress
created: 2026-03-28
updated: 2026-05-07
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
test262_fail: 1
---
# #859 -- Map.forEach callback captures are immutable snapshots -- causes infinite loop on mutation during iteration

## Problem

The test `test/built-ins/Map/prototype/forEach/iterates-values-deleted-then-readded.js` hangs at runtime (not compile-time). The test deletes and re-adds a Map key inside a `forEach` callback, guarded by `if (count === 0)`. Per the ES spec, the re-added key is visited again, so `forEach` iterates 3 times total.

However, the `count` variable is captured by the `__make_callback` path as an **immutable snapshot** (value copy). The callback's `count++` only modifies a local copy inside the `__cb_N` function. On each invocation, the capture struct is re-read and `count` is always 0. Since the `if (count === 0)` guard is always true, `map.delete` + `map.set` executes on every iteration, endlessly re-adding the key and causing `forEach` to never terminate.

### Test source (key lines)

```javascript
var map = new Map();
map.set('foo', 0);
map.set('bar', 1);
var count = 0;

map.forEach(function(value, key) {
  if (count === 0) {       // <-- always true because count is snapshot
    map.delete('foo');
    map.set('foo', 'baz');  // re-adds 'foo' to end of iteration order
  }
  count++;                  // <-- only modifies callback-local copy
});

assert.sameValue(count, 3);  // expected 3 iterations
```

### Reproduction

Even without the delete/re-add, a simple `map.forEach` callback that increments a captured variable fails to propagate the increment back:

```typescript
var count = 0;
map.forEach(function(value, key) { count++; });
// count is still 0 after forEach
```

## ECMAScript spec reference

- [§24.1.3.5 Map.prototype.forEach](https://tc39.es/ecma262/#sec-map.prototype.foreach) — step 5: entries added during forEach are visited; deleted entries are skipped
- [§24.1.2 The Map Constructor](https://tc39.es/ecma262/#sec-map-constructor) — Map uses ordered insertion; iteration reflects current live state


## Root cause

**File**: `src/codegen/closures.ts`, function `compileArrowAsCallback`, line ~1560.

The capture struct fields are declared with `mutable: false`:

```typescript
const fields: FieldDef[] = captures.map((cap) => ({
  name: cap.name,
  type: cap.type,
  mutable: false, // captures are immutable snapshots  <-- THIS
}));
```

At the start of each `__cb_N` invocation, captures are extracted from the struct into fresh locals (lines 1630-1656). Since the struct is immutable and never updated, mutations to the local copies are lost between calls.

The closure path (`compileArrowAsClosure`) handles this correctly via ref cells -- mutable captures are boxed in `struct (field $value (mut T))` so that mutations propagate. But the `__make_callback` path does not use ref cells for mutable captures.

## Affected scope

This affects ALL `__make_callback` callbacks that mutate captured outer variables, not just Map.forEach. Any host callback (array forEach/map/filter/reduce, Promise.then callbacks, event handlers, etc.) that mutates a captured variable will silently lose the mutation.

## Suggested fix

Two options:

### Option A: Ref cells for mutable captures in callbacks (recommended)

When a captured variable is mutated inside the callback body (or could be mutated -- conservative analysis), use a ref cell pattern:

1. At callback creation site: allocate a `struct (field $value (mut T))` ref cell for the mutable capture
2. Store the current value into the ref cell
3. Pass the ref cell (as externref) in the capture struct
4. In `__cb_N`, read/write through the ref cell instead of a plain local
5. After `map.forEach` returns, read the ref cell back into the outer local

This mirrors what `compileArrowAsClosure` already does for mutable captures via `boxedCaptures`.

### Option B: Global-based capture for mutable variables

Store mutable captures in Wasm globals instead of the capture struct. The callback reads/writes the global directly. Less clean but simpler to implement.

## Complexity: M (<400 lines)

The ref cell infrastructure already exists in closures.ts for the closure path. The main work is:
- Detect which captures are mutated in the callback body
- Allocate ref cells for those captures
- Emit ref cell read/write in `__cb_N` instead of plain local.get/local.set
- Emit ref cell writeback after the host call returns

## Acceptance criteria

- [x] `map.forEach(function(v, k) { count++; })` correctly increments the outer `count`
- [x] The test `Map/prototype/forEach/iterates-values-deleted-then-readded.js` passes (3 iterations, then stops)
- [x] Remove `Map/forEach` entry from HANGING_TESTS in `tests/test262-runner.ts`
- [x] Array.forEach, Array.map, Array.filter, etc. callbacks also propagate mutable captures

## Resolution (2026-05-07, branch `issue-859-foreach-capture-mutation`)

The codegen fix (Option A — ref cells for mutable captures) was already
landed in `src/codegen/closures.ts`'s `compileArrowAsCallback`. What was
missing was test coverage and the HANGING_TESTS removal.

### Verified mechanism (already present in `compileArrowAsCallback`)

`compileArrowAsCallback` analyses captures via `collectWrittenIdentifiers`
to mark which referenced names the callback body writes. For each
mutable capture it:

1. **Capture struct field**: declared as `(ref null $ref_cell_T)` instead
   of plain `T` (line ~2244).
2. **Read inside `__cb_N`**: cast captures externref → struct ref → `struct.get`
   the ref-cell field, store in local; register the local in
   `cbFctx.boxedCaptures` so identifier reads/writes inside the body
   route through the cell (lines ~2358-2386).
3. **Construction at call site**: emit `struct.new $ref_cell` over the
   current outer-local value, `local.tee` into a fresh `__cb_rc_<name>_<id>`
   local (kept for the writeback), then push that ref into the capture
   struct (lines ~2511-2530).
4. **Writeback**: queue `local.get $rc → ref.as_non_null → struct.get $ref_cell.value
   → local.set $outer` instructions in `pendingCallbackWritebacks`. After
   `compileCallExpression` returns, `compileExpressionInner` flushes
   them so the outer local sees the cell's post-callback value
   (lines ~2538-2554, plus `expressions.ts:720-722`).

Reads inside the callback body go through `compileIdentifier`'s
`boxedCaptures` branch (`expressions/identifiers.ts:351`), which emits
the ref-cell `struct.get`. Writes go through
`compileAssignmentExpression`'s `boxedCaptures` branch
(`expressions/assignment.ts:119`), which emits a null-guarded
`struct.set` on the cell.

Postfix `count++` is handled by `compilePostfixUnary`'s
`boxedCaptures` branch (`expressions/unary.ts:1053`).

### Tests added (`tests/issue-859.test.ts`)

8/8 PASS:
- function-expression callback `count = count + 1` propagates
- arrow callback propagates
- postfix `count++` propagates
- direct assignment `count = 7` propagates
- `Set.forEach` callback mutation propagates
- `Array.forEach` regression guard (inline path)
- test262 spec scenario: delete + re-add, count = 3 (not infinite loop)
- two captured locals propagate independently

All tests run with `setExports(instance.exports)` called before invoking
the export. Without `setExports`, the runtime's `callback_maker`
short-circuits on `exports?.[`__cb_${id}`]?.()` and the callback never
actually runs (the JS-side wrapper still resolves and returns
undefined). That was an easy diagnosis trap during this work — leaving
this note for the next dev who tries to reproduce the bug.

### HANGING_TESTS update (`tests/test262-runner.ts`)

Removed `test/built-ins/Map/prototype/forEach/iterates-values-deleted-then-readded.js`
from the hang-skip set. Replaced the line with a comment explaining
the historical pre-fix behaviour and pointing to the ref-cell fix.

### Files changed

- `tests/test262-runner.ts` — drop the Map/forEach hang entry, add
  explanatory comment.
- `tests/issue-859.test.ts` — 8 new tests (Map/Set/Array forEach,
  postfix `++`, direct assignment, multi-capture, the test262 spec
  scenario).
