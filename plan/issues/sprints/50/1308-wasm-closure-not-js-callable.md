---
id: 1308
sprint: 50
title: "Wasm closure struct returned to JS host is not JS-callable"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: closures, externref, js-interop
goal: npm-library-support
related: [1292, 1304]
---
# #1308 — Wasm closure struct returned to JS host is not JS-callable

## Background

Surfaced as the residual gap behind `tests/stress/lodash-tier2.test.ts`
"Tier 2d negate(jsFn)" after #1304 fixed the upstream `typeof predicate`
guard. Calling lodash's `negate` from JS now returns *something*, but
that something is the raw Wasm closure struct rather than a JS-callable
function:

```ts
const negated = exports.negate(isEven);
typeof negated      // "object"
negated             // [Object: null prototype] {}
negated(2)          // TypeError: negated is not a function
```

The closure struct (`__closure_N_struct` in the compiled module) holds
the funcref and the captured predicate externref. To invoke it from JS,
the host needs:
1. A way to discover the call sig of the closure (so it can build a
   JS proxy with the right arity), and
2. A trampoline import that forwards JS args to `call_ref` against the
   closure's funcref.

Today neither exists for closures returned through a JS export
boundary — only `__call_fn_N` helpers for closures stored in the host's
`functions[]` registry under known IDs.

## Reproducer

```ts
import { compileProject } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

const r = compileProject("node_modules/lodash-es/negate.js", { allowJs: true });
const imps = buildImports(r.imports, undefined, r.stringPool);
const { instance } = await WebAssembly.instantiate(r.binary, imps);
const negated = (instance.exports.negate as Function)((n: number) => n % 2 === 0);
console.log(typeof negated);   // "object" — should be "function"
console.log(negated(2));       // TypeError — should be `false`
```

## Fix sketch

Two candidate approaches:

### A. Auto-wrap exported closure-typed returns

In `runtime.ts`'s `setExports` / export-wrapping path, detect when an
exported function's return type is a `__closure_N_struct` (or any
`__fn_wrap_N_struct`). Wrap the raw return in a JS Proxy/closure that:
- Captures the closure-struct externref
- On `apply`, calls the corresponding `__call_fn_N` import (or a
  generic `__call_extern_closure(closure, args)` runtime helper) with
  the captured externref + the JS args
- Coerces args to/from externref using existing boxing helpers

This requires emitting metadata about exported function return types
(extend `result.imports` / `result.exports` with a return-type tag).

### B. Emit a generic `__call_extern_closure` runtime helper

Add a host function `__call_extern_closure(closure: externref, ...args)`
that:
- Reads the funcref from the closure struct (via a Wasm-side dispatcher
  exported as `__dispatch_closure_call`)
- Forwards args, returns the result

Then wrap returned externrefs in JS with `(...args) => __call_extern_closure(ref, ...args)`.

Approach B is simpler but has overhead per call. Approach A is
faster once landed.

## Acceptance criteria

1. `exports.negate(jsFn)(2)` invokes the underlying predicate via the
   returned closure and yields `false`/`true`.
2. `typeof exports.negate(jsFn) === "function"` from the JS host.
3. Lodash Tier 2d-call test (`tests/stress/lodash-tier2.test.ts`)
   asserts the predicate is actually flipped, not just that
   `typeof === "object"`.
4. No regression in `tests/stress/hono-tier*.test.ts` (which already
   exercise host→Wasm closure calls in the other direction).

## Files

- `src/runtime.ts` — export wrapper / `setExports` path.
- `src/codegen/index.ts` — emit return-type metadata for exports
  whose return type is a registered closure struct.
- `tests/stress/lodash-tier2.test.ts` — flip 2d-call assertion from
  documenting the gap to validating the fix.

## Why this matters

Almost any JS library that returns a closure (lodash's `_.partial`,
`_.curry`, `_.memoize`, `_.negate`, `_.flow`, etc.) hits this gap. The
JS host can hand callbacks INTO Wasm (#1304 fixed the `typeof`
classification) but cannot consume callbacks Wasm hands back. That's a
hard limit on the npm-library-support goal.
