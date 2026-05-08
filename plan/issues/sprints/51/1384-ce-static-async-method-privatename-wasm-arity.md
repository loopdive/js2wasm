---
id: 1384
sprint: 51
title: "CE: static async method with PrivateName — 'not enough arguments on the stack' (249 tests)"
status: ready
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: spec-completeness
---
# #1384 — Static async method PrivateName CE: invalid Wasm arity

## Problem

249 tests in `language/expressions/class/elements/` and
`language/statements/class/elements/` fail with a compile error:

```
CE
L*:* invalid Wasm binary (WebAssembly.instantiate(): Compiling function #*:"test"
failed: not enough arguments on the stack…
```

Representative tests:
- `language/expressions/class/elements/new-no-sc-line-method-rs-static-async-method-privatename-identifier.js`
- `language/expressions/class/elements/new-sc-line-method-rs-static-async-method-privatename-identifier.js`
- `language/expressions/class/elements/wrapped-in-sc-rs-static-async-method-privatename-identifier.js`

The tests exercise **static async methods** whose names are PrivateNames (or Unicode
identifiers). The class body looks like:

```js
class C {
  static async $(v) { return v; }
  static async _(v) { return v; }
  static async \u{6F}(v) { return v; }
  static async ℘(v) { return v; }
}
C.$(1); C._(1); // etc.
```

The error is a **Wasm validation failure** (not a TypeScript parse failure and not a
Unicode issue). The compiler successfully parses and emits Wasm, but the emitted
`call` or `call_indirect` instruction for the static async method trampoline receives
the wrong number of arguments.

**Not Unicode-related.** A TypeScript 6 upgrade would not fix this. The stack arity
mismatch happens in codegen for the `static async` method dispatch path when the
method name comes from a PrivateName or Unicode escape production.

## Hypothesis

In `src/codegen/class-bodies.ts`, the static async method emitter builds a trampoline
or wrapper that expects `(this: externref, arg0: externref, …)`. When the method name
is a PrivateName (or has a Unicode escape that causes a different code path), the
arity calculation is off by 1 — either `this` is omitted from the call site or an
extra arg is pushed.

## Steps to reproduce

```bash
npx tsx -e "
import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
const src = readFileSync(
  'test262/test/language/expressions/class/elements/new-no-sc-line-method-rs-static-async-method-privatename-identifier.js',
  'utf-8'
);
const r = compile(src, {fileName:'test.ts'});
console.log(r.success ? 'OK' : r.errors[0].message);
"
```

## Acceptance criteria

1. The three representative tests above compile without CE.
2. `C.$(1)`, `C._(1)`, `C.\u{6F}(1)` return the passed value.
3. No regression in `language/expressions/class/elements/` pass rate.
4. Net test262 improvement ≥ +200.

## Files to investigate

- `src/codegen/class-bodies.ts` — static method emitter, async wrapper
- `src/codegen/closures.ts` — async trampoline construction

## Investigation results (senior-dev, 2026-05-08)

**Root cause is NOT PrivateName / Unicode / class-bodies.** The architect's
hypothesis was misleading. After empirical bisection from the failing
test262 file, the minimum reproducer is just **6 lines**:

```ts
async function f(): Promise<any> { return 1; }
export function test(): number {
  Promise.all([f()]).then(r => r);
  return 1;
}
```

Result: `WebAssembly.instantiate(): Compiling function #N:"test" failed:
not enough arguments on the stack for call (need 2, got 0)`

### Trigger conditions (verified)

The bug fires if and only if ALL three are true:

1. **Receiver is `Promise.all([asyncCall()])`** (or any expression returning `Promise<any[]>`).
2. **`.then(callback)` callback param is UNTYPED** — `r => r` fails; `(r: any) => r` works.
3. **The async function returns `Promise<any>` / `Promise<unknown>` / `Promise<heterogeneous>`** — `Promise<number>` works.

### What does NOT fix it

Adding `flushLateImportShifts(ctx, fctx)` AFTER the callback arg compilation at `calls.ts:3647` — verified, same error. The shift mechanism IS invoked but indices remain stale.

### Workarounds

- Split into intermediate variable: `var p = Promise.all([f()]); p.then(r => r);`
- Type the callback: `Promise.all([f()]).then((r: any) => r);`
- Make the async function return `Promise<number>`.

### Reproducers

In `.tmp/` of `issue-1384-static-async-private` worktree: `probe-min9.mts`, `probe-types.mts`, `probe-instance.mts`.

---

## Architect Spec (2026-05-08)

### Updated reproducer (canonical 6-line case)

This issue's title/description started from class-element test262 fixtures, but
**senior-dev's investigation reduced the failure to a class-free reproducer**:

```ts
async function f(): Promise<any> { return 1; }
export function test(): number {
  Promise.all([f()]).then(r => r);
  return 1;
}
```

Compile error: `Compiling function #N:"test" failed: not enough arguments on the stack
for call (need 2, got 0)`.

**Trigger conditions** (verified):
1. Receiver is `Promise.all([asyncCall()])` (the 2-arg-signature aggregator).
2. `.then(cb)` callback param is **untyped** (`r => r` fails; `(r: any) => r` works).
3. Async function returns `Promise<any | unknown>` or heterogeneous union (`Promise<number>`
   does NOT trigger).

The class-element test262 fixtures fail through the same root cause: a static async
method's body returns a value of an inferred type, then a callback closure resolution
later in the same module triggers `addUnionImports` after the `Promise.all` site has
already been emitted. **Fixing the 6-line reproducer should fix the 249 class-element
tests.** Validate that hypothesis by running 1 of the 3 representative tests after
the fix (instructions below).

### Why this fires now

Background: PR #286 (`fd6a05c2d`) changed `Promise.all/race/allSettled/any` host
imports to **2 args**: `(thisArg, iter)`.

`src/codegen/expressions/calls.ts:3196-3214` now emits:

```ts
fctx.body.push({ op: "ref.null.extern" });    // thisArg
compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });  // iter
fctx.body.push({ op: "call", funcIdx });       // Promise_all
```

The **2-arg signature** matters for the symptom. The error `need 2, got 0` is
consistent with `Promise_all`'s funcIdx not being the index emitted in the `call`
instruction — i.e. a stale funcIdx that, after the unrelated index shift, points
to a *different* function with a different arity.

### Hypothesis (refined from senior-dev)

The shift driven by `addUnionImports` (`src/codegen/index.ts:4514-4694`) walks
five locations: `ctx.mod.functions[].body`, `ctx.currentFunc.body` and its
`savedBodies`, every `ctx.funcStack[].body` and their `savedBodies`, and
`ctx.parentBodiesStack[]`.

For `Promise.all([f()]).then(r => r)`, both `compileArrowAsClosure` and
`compileArrowAsCallback` push `savedFunc.body` onto **both** `parentBodiesStack`
and `funcStack` BEFORE the arrow's body runs (closures.ts:1680/1681,
closures.ts:2461/2462). So the outer `test` body should be reachable when an
addUnionImports call inside the arrow body fires.

**Therefore the bug is NOT a missing parentBodiesStack push during arrow body
compilation.** Senior-dev's hypothesis (verbatim) is too narrow. Look for one of:

1. **A code path that emits into `cbFctx.body` BEFORE the funcStack push at
   `closures.ts:2461`.** Lines 2392-2438 emit captures-extraction, and lines
   2440-2457 emit param coercion via `coerceType`. If `coerceType` triggers
   `addUnionImports` (via the externref↔ref/ref_null path at type-coercion.ts:147 or
   :537), and that fires while `ctx.currentFunc` is still the OUTER fctx, then:
   - `ctx.currentFunc.body` walks **outer** fctx.body (good — Promise_all gets shifted)
   - But `cbFctx.body` is NOT yet on `funcStack` or `parentBodiesStack`
   - cbFctx.body has just received some `coerceType`-emitted code; if any of it
     contains `call funcIdx`, that funcIdx is now stale relative to the post-shift
     index space, and when cbFctx is later attached as a function, the call site
     trips Wasm validation.
   - This is the inverse of senior-dev's hypothesis: the outer body IS walked,
     but the **arrow's own body during its setup-phase** is missed.

2. **A late-import shift triggered by the receiver compilation that runs
   between `ensureLateImport(Promise_then,...)` at `calls.ts:3553` and
   `flushLateImportShifts(ctx, fctx)` at `calls.ts:3554`.** Specifically:
   - line 3553 records `pendingLateImportShift = importsBefore` (Promise_then was
     missing, so a new import is added)
   - line 3554 flushes — but if the current main has reordered, this could be a
     race. Re-verify the order in HEAD calls.ts.

3. **The receiver compilation itself emits extra calls that reference `Promise_all`
   THROUGH a temp-body that's not on the walked stacks.** When `Promise.all([f()])`
   is compiled, `[f()]` calls `compileExpression` for the array literal. Array
   literals emit `array.new_fixed` after collecting element bytecode, which can
   use a savedBody swap pattern. If the savedBody is popped before all calls fire,
   funcIdx values inside it could be stale.

The dev needs to **instrument the shifter to confirm which body the stale
funcIdx lives in.**

### Phase 1 — Diagnostic (do this first; ~30 minutes)

Add a temporary instrumentation patch to `src/codegen/index.ts:4630-4670` (the
addUnionImports shifter) that records, for each call instruction whose funcIdx
gets shifted, **a snapshot of which body it was found in**. Tag bodies by
identity:

```ts
// TEMP DIAGNOSTIC for #1384
const bodyTag = (instrs: Instr[]): string => {
  if (instrs === ctx.currentFunc?.body) return "currentFunc.body";
  for (let i = 0; i < ctx.funcStack.length; i++) {
    if (ctx.funcStack[i]!.body === instrs) return `funcStack[${i}].body`;
  }
  for (let i = 0; i < ctx.parentBodiesStack.length; i++) {
    if (ctx.parentBodiesStack[i] === instrs) return `parentBodiesStack[${i}]`;
  }
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    if (ctx.mod.functions[i]!.body === instrs) return `mod.functions[${i}](${ctx.mod.functions[i]!.name})`;
  }
  return "<UNKNOWN BODY>";
};
// Inside shiftFuncIndices, log every shifted call:
if ((instr.op === "call" || ...) && instr.funcIdx >= importsBefore) {
  console.error(`[#1384] shift call ${instr.funcIdx}→${instr.funcIdx + delta} in ${bodyTag(instrs)}`);
  instr.funcIdx += delta;
}
```

Run the 6-line reproducer. The console output identifies:
- Which funcIdx values were shifted (and from where).
- Whether **any body returns `<UNKNOWN BODY>`** — if so, that body is the leak.

If no body returns UNKNOWN, then the bug is one of:
- A shifter that ISN'T `addUnionImports` (e.g. `addStringImports` at
  `index.ts:3340-3379` or `shiftLateImportIndices` at `late-imports.ts:19-106`)
  walking a smaller set of bodies. Apply the same diagnostic to those two
  shifters.
- A funcIdx that was captured into a closure variable (e.g. `funcIdx` in a
  closure scope) and re-emitted into the body AFTER the shift fired — the body's
  call instr is fresh, but the value used was stale. Search calls.ts for
  `funcIdx` re-uses across an `addUnionImports`/late-import boundary.

### Phase 2 — Likely fixes (apply once Phase 1 identifies the leaky body)

#### Fix candidate A — `compileArrowAsCallback` setup-phase shielding

If Phase 1 shows `cbFctx.body` is missed, restructure
`src/codegen/closures.ts:2367-2521` so all body-emission happens INSIDE the
saved-state window:

```ts
// BEFORE (current):
const cbFctx: FunctionContext = { ... body: [], ... };
// captures setup at 2392-2438 → emits into cbFctx.body
// param coercion at 2440-2457 → emits into cbFctx.body
const savedFunc = ctx.currentFunc;
if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
if (savedFunc) ctx.funcStack.push(savedFunc);
ctx.currentFunc = cbFctx;
// body compilation at 2459-2521 → emits into cbFctx.body

// AFTER:
const cbFctx: FunctionContext = { ... body: [], ... };
const savedFunc = ctx.currentFunc;
if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
if (savedFunc) ctx.funcStack.push(savedFunc);
ctx.currentFunc = cbFctx;
// MOVED: captures setup → now inside the saved-state window
// MOVED: param coercion → now inside the saved-state window
// body compilation → unchanged
```

This guarantees `ctx.currentFunc.body === cbFctx.body` for the entire emission
phase, so any addUnionImports shift walks cbFctx.body via `currentFunc.body`.

Same change in `compileArrowAsClosure` (closures.ts:1644-1663 — the
tdzFlagged-captures prologue runs BEFORE the savedFunc push at 1680).

#### Fix candidate B — record cbFctx.body explicitly on parentBodiesStack

If Fix A is too invasive, push `cbFctx.body` onto `parentBodiesStack` early:

```ts
const cbFctx: FunctionContext = { ... body: [], ... };
ctx.parentBodiesStack.push(cbFctx.body);  // ← NEW: ensure shifter sees it
// captures setup, param coercion, body compilation — unchanged
ctx.parentBodiesStack.pop();              // ← matching pop at end
```

Note: `parentBodiesStack` historically holds *parent* bodies, not the current
function's body. Adding the current body is a convention extension. Document
the invariant in a comment if you go this route.

#### Fix candidate C — universal coverage in the shifter

If the leaky body turns out to be in a different code path entirely (e.g. an
object-literal getter at `literals.ts:1119`, an accessor at `literals.ts:1215`,
an IIFE savedBody, or a constructor body at `new-super.ts:810`), the most robust
fix is to track every newly-allocated FunctionContext in a context-level
`ctx.allLiveBodies: Set<Instr[]>`, append on entry, remove on completion, and
walk it in every shifter. This is a 3-shifter change (index.ts:3340, 4631, and
late-imports.ts:31). It's broader than #1384 and has potential perf cost
(traversing dead bodies); recommend only if Fix A/B both prove insufficient.

### Phase 3 — Verification

The 6-line reproducer is the primary acceptance gate. Save it as
`.tmp/probe-1384-min.mts`:

```ts
import { compile } from "../src/index.ts";
const src = `
async function f(): Promise<any> { return 1; }
export function test(): number {
  Promise.all([f()]).then(r => r);
  return 1;
}`;
const r = compile(src, { fileName: "test.ts" });
console.log(r.success ? "PASS" : "FAIL: " + r.errors[0].message);
```

Plus full validation:

```bash
# 1. Six-line reproducer compiles AND instantiates
npx tsx .tmp/probe-1384-min.mts

# 2. The original failing class-element test262 file
npx tsx -e "
import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
const src = readFileSync(
  'test262/test/language/expressions/class/elements/new-no-sc-line-method-rs-static-async-method-privatename-identifier.js',
  'utf-8'
);
const r = compile(src, {fileName:'test.ts'});
console.log(r.success ? 'OK' : r.errors[0].message);
"

# 3. Existing Promise tests stay green
npm test -- tests/issue-1368.test.ts
npm test -- tests/issue-1312.test.ts  # async-recursion (should be unaffected)

# 4. Full equivalence
npm test -- tests/equivalence.test.ts
```

Expected outcomes:
- Probe 1: `PASS`.
- Probe 2: `OK`.
- Probe 3: all green.
- Probe 4: no new failures.

### Risks and notes

- **Don't add a thirteenth `addUnionImports` call site as a workaround.** The
  bug is in shift coverage, not in the trigger frequency.
- **Don't rebuild the shift mechanism unless Fix A/B both fail.** The shifter
  has been hardened multiple times (#998, #960, #1109); further surgery has a
  high regression cost.
- **Confirm the trigger is reproducible first.** The senior-dev session ended
  before they could re-verify on current main; re-run probe 1 on a fresh
  worktree before starting Phase 1 instrumentation.
- **Sprint 51 spec-completeness goal**: this issue is high-impact (249 tests).
  Net improvement should be ≥ +200 once landed.
