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

1. **Receiver is `Promise.all([asyncCall()])`** (or any expression returning
   `Promise<any[]>`).
2. **`.then(callback)` callback param is UNTYPED** — `r => r` fails;
   `(r: any) => r` works.
3. **The async function returns `Promise<any>` / `Promise<unknown>` /
   `Promise<heterogeneous>`** — `Promise<number>` works.

So the contextual type for the callback param is a heterogeneous union
that triggers `addUnionImports` during the arrow body's compilation.
That late import addition shifts funcIdx values, but the receiver's
already-emitted Promise.all call bytes have stale indices.

### What does NOT fix it

- Adding `flushLateImportShifts(ctx, fctx)` AFTER the callback arg
  compilation in `src/codegen/expressions/calls.ts:3647` (just before
  the call emission). Verified — same error.
  - This implies the shift mechanism IS being invoked, and the bytes
    ARE being walked, but the resulting indices are still wrong.

### Workarounds (verified to compile cleanly)

- Split into intermediate variable: `var p = Promise.all([f()]); p.then(r => r);`
- Cast the Promise: `(Promise.all([f()]) as Promise<any>).then(r => r);`
- Type the callback: `Promise.all([f()]).then((r: any) => r);`
- Make the async function return a non-heterogeneous type: `Promise<number>`.

### Next investigation steps

1. Dump the Wasm binary at the failing offset (~475) — binaryen rejects
   but a manual hex dump may reveal which call is malformed.
2. Check whether `ctx.parentBodiesStack` is actually populated when the
   arrow body is compiled — `shiftLateImportIndices` walks it at
   `late-imports.ts:65`, but if it's empty during arrow compilation the
   outer `.then()` call site's bytes wouldn't be shifted.
3. Audit `compileArrowAsCallback` for any path that emits instructions
   into a body that ISN'T tracked by the shift walker.
4. Check whether `coerceType` (line 3635 in `calls.ts`) can trigger an
   addUnionImports without running through `flushLateImportShifts`.

### Reproducers (all in `.tmp/` of `issue-1384-static-async-private` worktree)

- `.tmp/probe-min9.mts` — 6-line minimum
- `.tmp/probe-types.mts` — confirms Promise<any|unknown|union> trigger,
  Promise<number> works
- `.tmp/probe-instance.mts` — runs the original failing test262 file
  through `wrapTest` and instantiates

### Estimated impact (revised)

249 CE tests currently failing. Fixing this single index-shift bug
should unblock most of them. Estimate +150–250 net test262.

### Status

**Investigation complete, fix attempt unsuccessful.** Reverted the
naïve `flushLateImportShifts` insertion. The real fix likely needs to
walk the right body (which one? — probably an outer body that's not
in `ctx.funcStack` during arrow compilation), or fix the order in
which the receiver's call bytes get emitted vs. when the union
imports are added.

Returning to TaskList — needs a fresh deeper investigation pass.
