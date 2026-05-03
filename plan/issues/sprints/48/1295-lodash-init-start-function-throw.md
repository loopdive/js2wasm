---
id: 1295
sprint: 48
title: "lodash transitive init: start-function throws WebAssembly.Exception during instantiate (clamp/add)"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: module-init, top-level-side-effects, host-globals
goal: npm-library-support
related: [1291, 1276]
---
# #1295 — lodash transitive init throws during instantiate

## Background

Surfaced while investigating #1291 (lodash Tier 1b execution-level assertions).

`compileProject("node_modules/lodash-es/clamp.js", { allowJs: true })` and
`compileProject("node_modules/lodash-es/add.js", { allowJs: true })` both
produce Wasm modules whose:

- Validation succeeds (`new WebAssembly.Module(binary)` does not throw)
- All Wasm imports are satisfied by `buildImports(...)` — verified for both
  modules (88 imports for clamp, 77 for add) with explicit per-import name
  lookup, none missing
- Function exports include `clamp`/`default` (clamp) and globals `add`/`default`
  (add — closure refs from #1276)

However, `WebAssembly.instantiate(...)` throws a `WebAssembly.Exception` (NOT
a `LinkError`) — the throw originates from inside the start function, which
runs the lodash transitive top-level init code.

## Reproducer

`tests/stress/lodash-tier1.test.ts` already exercises this via the two
"start function throws" assertions added in #1291. To reproduce manually:

```ts
import { compileProject } from "src/index.js";
import { buildImports } from "src/runtime.ts";

const r = compileProject("node_modules/lodash-es/clamp.js", { allowJs: true });
const imports = buildImports(r.imports, undefined, r.stringPool);
await WebAssembly.instantiate(r.binary, imports);  // throws WebAssembly.Exception
```

## Suspected cause

The lodash dep chain runs feature-detection idioms at top-level:

```js
// _freeGlobal.js
var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;

// _root.js
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;
var root = freeGlobal || freeSelf || Function('return this')();

// _Symbol.js
var Symbol = root.Symbol;
```

Hypotheses (need confirmation):

1. The compiler's null-check protection on `global.Object`, `self.Object`,
   `root.Symbol` etc. fires unconditionally because the host-globals (`global`,
   `self`) are resolved via `__get_builtin` / `__extern_get` and one of them
   yields a value that the property-access guard treats as null/undefined even
   when JS would short-circuit via `&&` first.

2. `Function('return this')()` is the dynamic-eval branch of the `||` chain.
   The compiler likely cannot compile `Function(...)` as a constructor and may
   emit a hard throw for that branch — which fires only if both prior branches
   short-circuit to falsy, which suggests #1 is upstream.

3. The `||` short-circuit over an expression containing the inner `&&` chain
   may not propagate the side-effect-free truthy from `freeGlobal` correctly —
   so the `Function('return this')()` branch always runs.

## Investigation steps

1. Generate WAT for `clamp.js` (`compileProject(..., { emitWat: true })`) and
   inspect the start function's `throw 0` sites. Already written: `function
   index 80 = __module_init`.
2. Use a binaryen `wasm2js` round-trip or a Wasm trap inspector to find the
   exact `throw` instruction reached, and back-map to the `_root.js` /
   `_Symbol.js` / `_freeGlobal.js` line via the source map.
3. Build a minimal repro: a hand-written `.js` containing only the freeGlobal
   /root pattern, compile, instantiate, observe the throw. This isolates the
   bug from the rest of lodash.
4. Once the failing pattern is isolated, decide between:
   - Fixing the `||` short-circuit + null-guard interaction
   - Special-casing `typeof X == 'object' && X && X.Y` as a known-safe pattern
   - Providing host bindings for `global` and `self` that resolve correctly
   - Static folding of `Function('return this')()` to the extern-host root

## Acceptance criteria

1. `WebAssembly.instantiate(clampBinary, buildImports(...))` does not throw.
   `instance.exports.clamp(-10, -5, 5) === -5`.
2. `WebAssembly.instantiate(addBinary, buildImports(...))` does not throw.
   (Calling `exports.add(2,3) === 5` is gated on a separate closure-export
   surface task — `add` and `default` are currently global refs.)
3. `tests/stress/lodash-tier1.test.ts` updated to call the actual functions
   instead of asserting the start-function throw.

## Files

- `src/codegen/expressions.ts` — null-guard generation for member access
- `src/codegen/index.ts` — start-function emission, `__get_builtin` /
  `__extern_get` handling
- `src/codegen/statements.ts` — `||` short-circuit for `var` initializers
- `tests/stress/lodash-tier1.test.ts` — upgrade after fix
