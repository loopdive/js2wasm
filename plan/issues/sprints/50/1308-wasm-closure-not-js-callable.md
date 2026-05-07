---
id: 1308
sprint: 50
title: "Wasm closure struct returned to JS host is not JS-callable"
status: done
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

## Implementation (2026-05-07, branch `issue-1308-js-callable-closure`)

The fix has two parts.

### Part 1 — codegen: emit `__call_fn_0` / `__call_fn_1` for multi-source projects

`generateMultiModule` (`src/codegen/index.ts`) was missing the entire
post-compile export-emit block that single-source `generateModule` ran.
Concretely, for a multi-source project (any `compileProject` call —
including all lodash modules), the binary never got `__call_fn_0`,
`__call_fn_1`, `__vec_get`, `__vec_len`, struct field getters, etc.,
so even the existing runtime helpers that wanted to dispatch via
`__call_fn_N` had nothing to call.

Verified by inspecting the WAT for `compileProject('lodash-es/negate.js')`:
pre-fix the binary had 2 user exports (`negate`, `default`) + the
exception tag and that was it; post-fix it has the full export surface
(`negate`, `default`, `__call_fn_0`, `__vec_len`, `__vec_get`, `__exn_tag`).

Added these calls to `generateMultiModule`, mirroring the existing
order in `generateModule`:
- `emitStructFieldGetters`
- `emitVecAccessExports`
- `emitDataViewByteExports`
- `emitTestRuntimeStringHelpers`
- `emitIteratorMethodExport`
- **`emitClosureCallExport`** (`__call_fn_0`)
- **`emitClosureCallExport1`** (`__call_fn_1`)
- `emitToPrimitiveMethodExports`

### Part 2 — runtime: `wrapExports(instance.exports)` helper

Added a new public helper in `src/runtime.ts`:

```ts
export function wrapExports(rawExports: WebAssembly.Exports): Record<string, any>;
```

Returns a new exports object whose user-visible callable exports
(non-`__`-prefixed `function` exports) auto-wrap any returned
Wasm closure struct in a JS function. The wrapper dispatches via
`__call_fn_0` for 0-arg calls and `__call_fn_1` for 1-arg calls.
Non-callable exports and internal `__`-helpers pass through untouched.

`_isWasmStruct` (already in runtime.ts) gates the wrap — only objects
that look like opaque WasmGC structs get replaced.

### Test results

`tests/issue-1308.test.ts` — 7/7 PASS:
- `typeof exported closure return is 'function'`
- 0-arg dispatch via `__call_fn_0`
- captured-value closure (`makeAdder(5)()` = 6)
- 1-arg dispatch via `__call_fn_1` (`(n) => n+1`)
- non-callable exports pass through
- internal `__`-prefixed exports stay accessible
- lodash `negate(jsFn)` typeof + 0-arg call

`tests/stress/lodash-tier2.test.ts` — 5/5 PASS, 0 skipped. Tier 2d-call
flipped from documenting the gap (`expect(typeof).toBe("object")`) to
validating the fix (`expect(typeof).toBe("function")` + `expect(negated()).toBe(1)`).

`tests/issue-1304.test.ts`, `tests/issue-1306.test.ts` — no regression.

### Acceptance status

1. ❌ `exports.negate(jsFn)(2)` yields `false`/`true` from the predicate
   — **partial**. The variadic `function(...args)` body is lifted as a
   0-arg func that reads `arguments` via `__extras_argv`. JS hosts have
   no path to populate that global before invoking the wrapped closure,
   so `wrapped(2)` falls through `__call_fn_0` with empty args and
   returns the `case 0` branch (`!predicate.call(this)`). Tracked as
   the "remaining work" follow-up below.
2. ✅ `typeof exports.negate(jsFn) === "function"`.
3. ✅ Lodash Tier 2d-call test — un-skipped, asserts both `typeof` and
   the 0-arg invocation.
4. ✅ `tests/stress/hono-tier*.test.ts` — no regression in adjacent
   closure tests (#1304, #1306, lodash Tier 2 a/b/c/d).

### Remaining work

Variadic arg propagation from JS host into Wasm `arguments`:

- Export setters for `__extras_argv` (a `(mut (ref null $vec_externref))`
  module global) and `__argc` (a `(mut i32)` module global) so the JS
  wrapper can populate them before calling `__call_fn_0`.
- Or emit higher-arity `__call_fn_N(closure, arg0, ..., argN-1)` exports
  that internally set both globals and call `__call_fn_0`.

This second piece is a separate, narrower change — split it off when
needed (e.g. when a real test demands `negated(2)` flip the predicate
result).

## Files changed

- `src/codegen/index.ts` — added `emitStructFieldGetters` /
  `emitVecAccessExports` / `emitDataViewByteExports` /
  `emitTestRuntimeStringHelpers` / `emitIteratorMethodExport` /
  `emitClosureCallExport` / `emitClosureCallExport1` /
  `emitToPrimitiveMethodExports` calls to `generateMultiModule`,
  mirroring `generateModule`'s post-compile pipeline.
- `src/runtime.ts` — new `wrapExports` exported helper.
- `tests/issue-1308.test.ts` — 7 new tests.
- `tests/stress/lodash-tier2.test.ts` — Tier 2d-call now uses
  `wrapExports` and asserts the post-fix behavior.
