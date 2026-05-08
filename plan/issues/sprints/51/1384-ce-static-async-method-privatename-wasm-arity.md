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
