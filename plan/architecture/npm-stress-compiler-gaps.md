---
title: "npm stress-test compiler capability gaps"
author: arch-npm-stress
date: 2026-04-11
baseline_commit: 07ac0224
related_issues: [1031, 1032, 1033, 1034, 1035]
---

# npm stress-test compiler gaps

## Summary

**prettier** is the stress test closest to compiling today, because it is pure compute with no host boundary and the compiler already handles most of what its doc-builder / printer uses (classes, large switches, try/catch, string methods, closures, Map/Set via extern classes). **react** is the second most tractable: hooks map cleanly onto our existing mutable ref-cell closure model and module-level `let` globals, so `useState`/`useReducer` are feasible once DOM is routed as host imports. **axios** is the furthest from working — not because of language features but because it is async/IO-heavy and `AwaitExpression` is currently compiled as a no-op (the operand is returned unchanged with no suspension). **lodash** is somewhere in the middle: Tier 1/2 pure-arithmetic modules should compile today after the Array long-tail fixes (#1022/#1030/#1040), but any module that relies on `Symbol.iterator` protocol semantics, `Object.defineProperty` getters, or `cloneDeep`-style generic traversal will hit soft spots.

The **single biggest blocker across all four stress tests is the same**: the compiler has no real module resolver. `preprocessImports` (src/import-resolver.ts:23) rewrites every `import` into `declare const X: any`, so multi-file npm packages cannot be compiled as a graph — you either bundle to a single file first or every cross-module reference becomes an opaque externref. Until a module resolver lands, all four stress tests must be run on pre-bundled source.

The second biggest blocker is the **async story**: `ts.isAwaitExpression` at src/codegen/expressions.ts:790 just recurses into the operand. There is no actual Promise suspension, no microtask scheduling, no generator-state-machine lowering of `async` functions. Any stress test that exercises real I/O completion (axios, react effects, prettier's plugin loader) observes synchronous resolution only — fine for the happy path of a trivial Promise.resolve, wrong for anything with real backpressure.

## Capability envelope (as of commit 07ac0224)

| Axis | Status | Source of truth | Notes / blocking issues |
|---|---|---|---|
| **Module / import graph** | 🔴 missing | src/import-resolver.ts:23 | `preprocessImports` rewrites all `import` → `declare const X: any`. No module graph, no symbol resolution across files. Blocks all four stress tests from running natively; pre-bundling is a workaround. |
| **Node builtin imports** (`node:http`, `node:fs`, ...) | 🔴 missing | — | No `NODE_HOST_IMPORT_MODULES` set. #1035 (WASI hello-fs) proposes compile-time routing for `node:fs`; #1032 requires it for `node:http`, `node:stream`, `node:buffer`, `node:zlib`, `node:events`. |
| **DOM host imports** (`document`, `window`, `HTMLElement`) | 🔴 missing | — | No `DOM_HOST_GLOBALS` set. `Window` / `Document` currently reach the compiler as unresolved globals. Blocks #1033 Tier 4. |
| **`async function` / `await`** | 🔴 broken | src/codegen/expressions.ts:790 | `AwaitExpression` compiles to its operand; no suspension, no Promise integration. `async function` headers parse but have no state-machine lowering. Blocks axios real-GET and React effect flushing. |
| **Generators (`function*`, `yield`, `yield*`)** | 🟡 partial | context/types.ts `isGenerator`; #862, #1017 | Sync generators work for common cases. `yield*` Pattern 3 marginal (#1017 closed stale). Not a blocker for the stress tests directly but React's children iteration uses Symbol.iterator, which is OK. |
| **Closures capturing mutable refs** | ✅ supported | src/codegen/closures.ts:971-1131 | Ref-cell struct lowering is in place (`getOrRegisterRefCellType`). First-class support for `useState`-style cells. |
| **Module-level mutable state** | ✅ supported | top-level `let` → Wasm global | Works for React's `ReactCurrentDispatcher.current` swap pattern via top-level `let`. |
| **Symbols** (`Symbol.for`, `Symbol.iterator`, well-knowns) | 🟡 partial | src/runtime.ts:380-403, 1009, 1618 | `Symbol.iterator` has a sidecar indirection (`@@iterator` stringification) and `_symbolIdToKeys` mapping. `Symbol.for` wired via `__symbol_for`. Symbol identity **flows through the host**, so standalone mode is not covered. |
| **`Object.freeze` / `Object.seal`** | 🟡 partial | src/runtime.ts:38-42 | `WeakSet`-backed sidecar tracking in JS-host mode only. React's dev-mode freeze compiles but does nothing structural. |
| **`Object.defineProperty` getter/setter** | ✅ supported (wrapper classes) | runtime.ts:1323-1446 + recent #929 fix | Sidecar `__get_/__set_` keys. Recently extended for String/Number/Boolean wrappers (#1026). Still JS-host-only. |
| **`Object.create`, `Object.setPrototypeOf`** | 🟡 partial | object-ops.ts | Works through extern dispatch; structural prototype chain changes post-construction are host-only. |
| **`WeakMap`, `WeakSet`, `WeakRef`** | 🟡 partial | runtime.ts:818-820 (extern classes) | Available as extern classes in JS-host mode. Identity comes from real JS objects. Standalone (WASI) target has none. Critical for React ref forwarding and prettier doc memoization. |
| **`Proxy` / `Reflect`** | 🟡 partial | runtime.ts:568-717, :1616, :2459 | `Proxy.revocable` and live-mirror host proxies exist for `__opaque` bridging (#983, #965). User-level `new Proxy(t, h)` goes through `__proxy_handler` but handler traps on compiled Wasm structs are fragile. Not used by any of the four libraries on the hot path — OK to leave. |
| **`try` / `catch` / `finally`** | ✅ supported | src/codegen/statements/exceptions.ts:124-293 | Wasm EH tags, `rethrow` with depth adjustment, `catchRethrowStack`. Works end-to-end; recently hardened for tag alignment. |
| **`throw`** | ✅ supported | exceptions.ts:147-163 | Coerces to externref for the tag; rethrow fast-path for bare `throw e`. |
| **`class` / inheritance / `super`** | ✅ supported | class-bodies.ts, new-super.ts | Static methods, instance methods, constructors, super calls. Private fields present but fragile (recent #998 line-terminator CE). |
| **Private class fields (`#field`)** | 🟡 partial | — | Work for common cases; recent #998 fix for static-private + line terminators. React dev-mode warnings use these; acceptable. |
| **Destructuring (all forms)** | 🟡 partial | destructuring.ts; #1024, #1025, #1040 | Rest/holes/null semantics recently fixed (#1024, #1025). Still soft spots for deeply nested + default + rest combinations. |
| **Spread in calls / arrays / objects** | ✅ supported | — | Covered by long-tail test262 work. |
| **`for...of`, iterator protocol** | 🟡 partial | runtime.ts:1990, #1016 | `[Symbol.iterator]` lookup falls back via sidecar. Iterator close (return/throw) recently fixed (#851). Still fragile around null `next`. |
| **`for...in`** | 🟡 partial | runtime.ts `__keys_of` | Keys iterated from host reflection in JS-host mode only. WasmGC-opaque objects need explicit sidecar (#853 still open). |
| **`String.prototype` surface** | 🟡 partial | src/codegen/string-ops.ts | `replace`, `replaceAll`, `split`, `repeat`, `padStart`, `padEnd`, `codePointAt`, `normalize` (identity), `includes`, `startsWith`, `endsWith` present. `matchAll` unclear. Regex arg path routes through runtime. |
| **`Array.prototype` surface** | ✅ supported | src/codegen/array-methods.ts, #1022, #1030, #1040 | `compileArrayLikePrototypeCall` covers the long tail after recent merges. Reduce/map regression from #1030 fixed in #1040. |
| **`Map` / `Set` with object keys** | 🟡 partial | codegen/index.ts:2661, :4100, expressions/calls.ts:1746 | Registered as extern classes; dispatched via host Map. Identity semantics come from real JS, so object-keyed Maps work in JS-host mode. WasmGC struct identity via `_canBeWeakKey` (runtime.ts:148). Standalone mode has none. |
| **`BigInt`** | 🟡 fragile | Recent #986 (serialization CE), #997 (ToPrimitive wrapper crash) | Several recent crashes patched; literal support exists; not exercised deeply by the four stress tests. |
| **`RegExp`** (basic) | 🟡 partial | declarations.ts, expressions.ts regex paths | Host-backed RegExp via `__regex` import. Basic patterns work. |
| **`RegExp` (lookbehind, named groups, sticky, unicode)** | 🟡 partial | — | Inherited from host. Prettier and axios both rely on named groups — should work in JS-host mode. |
| **`JSON.parse` / `JSON.stringify`** | ✅ supported | runtime.ts | Host `JSON.*`. Reviver/replacer callbacks cross the externref boundary. |
| **`Promise.*` (resolve/all/race/then)** | 🟡 partial | runtime.ts | Available as host calls. Without real `await` suspension, chains collapse to synchronous host-side execution — works for unit tests, wrong for I/O. |
| **`queueMicrotask`, `setTimeout`, `requestAnimationFrame`** | 🔴 missing | — | No compile-time mapping. Would need to be added alongside DOM host globals for #1033. |
| **Tagged templates** | 🟡 partial | #836 still Ready | Non-PropertyAccess tag forms have outstanding CEs. |
| **Template literals** | ✅ supported | literals.ts | Basic forms work. |
| **Large `switch` dispatch (hundreds of cases)** | 🟡 untested | — | No known upper limit; codegen is linear. prettier's printer-estree has ~200 cases — expect scaling to be OK but worth profiling. |
| **Recursive TS types (fiber, AST nodes)** | 🟡 partial | shape-inference.ts | Inference gives up and widens to externref for deeply recursive unions. OK for correctness, bad for perf. |
| **Union type handling** | 🟡 partial | — | Tagged union vs externref-box decision heuristic; widens on sight of `any`. |
| **`any`-typed variables** | ✅ supported | — | Always externref-boxed. Prettier and axios lean on this heavily. |
| **Tree shaking / DCE** | 🟡 partial | src/treeshake.ts, src/codegen/dead-elimination.ts | Present but conservative. React dev/prod branch stripping on `process.env.NODE_ENV` likely doesn't DCE automatically. |

## Per-library gap analysis

### lodash (#1031)

**Required features**

- Arithmetic + comparisons (Tier 1: clamp, inRange, sum, mean, identity, add, ...)
- `Array.prototype` long-tail methods (chunk, flatten, uniq, compact, zip, ...)
- Deep object traversal via `Object.keys` / `for...in` (Tier 3: pick, omit, invert)
- Iterator protocol for spread / destructuring (Tier 3/4)
- Closure + `Map` for memoize, debounce, throttle (Tier 4)
- Symbol.iterator guards in `_.isArrayLike`, `_.isIterable`
- `cloneDeep` exercises generic structural traversal + prototype chain reads
- RegExp in `_.words`, `_.kebabCase`, `_.camelCase`

**Current gaps**

- Module graph not resolved → needs per-file bundling or standalone modules
- `for...in` over Wasm-opaque structs still partial (#853 open) → affects `_.forOwn`, `_.keys`
- `Object.defineProperty`-based sidecar properties on prototypes: wrapper-prototype writes recently fixed (#1026) but prototype pollution patterns still fragile
- `Symbol.iterator` set directly on a user struct goes through runtime.ts:1991 sidecar — works in JS-host mode only
- `cloneDeep` on cyclic structures needs identity-keyed memoization Map (WeakMap ok in JS-host)

**Projected readiness**

- Tier 1 (pure math / identity): **~90%** compile and pass their own unit tests
- Tier 2 (array helpers): **~70%** after the #1022/#1030/#1040 merges
- Tier 3 (object iteration): **~40%** — limited by `for...in` and `Object.keys` semantics on WasmGC objects
- Tier 4 (cloneDeep, memoize, debounce): **~10%** — depends on WeakMap identity + timers

**Top 3 blockers**

1. No module graph → must bundle first or compile per-file with opaque cross-refs
2. `for...in` / `Object.keys` correctness on WasmGC objects (#853)
3. `cloneDeep` memoization needs a WasmGC-object-keyed Map (works in JS-host, not in standalone)

### axios (#1032)

**Required features**

- `import http from 'node:http'` et al. resolved as host-provided externrefs
- Node `EventEmitter` (`on`, `once`, `emit`) as pass-through externref
- Node `Readable`/`Writable`/`Transform` streams as externref
- `Buffer` global + `Buffer.from`, `Buffer.concat`, `Buffer.byteLength`
- `process.env.NODE_ENV` read path
- Real `async` / `await` (axios is Promise-chain all the way down)
- `class AxiosError extends Error` with `Error.captureStackTrace`
- `AbortController` / `CancelToken` with `Promise.race`
- `URL` / `URLSearchParams` globals (host)

**Current gaps**

- **No Node host-import routing at all** — all `node:*` imports become `declare const X: any`, so symbols inside those modules are unknown types. Need the `NODE_HOST_IMPORT_MODULES` set proposed in #1032 wired into src/import-resolver.ts.
- **`await` is a no-op** (src/codegen/expressions.ts:790) — real HTTP completion relies on microtask + IO event loop, neither of which suspend Wasm execution.
- `class AxiosError extends Error` — `Error` subclassing through our extern class machinery works for methods but `instanceof AxiosError` checks across the boundary are fragile.
- `Buffer` as a global needs to be treated as an extern class like `Map`/`Set` — currently undefined.

**Projected readiness**

- Tier 1 (pure helpers: `utils.js`, `bind`, `cookies`, `buildFullPath`): **~60%** once bundled; most fail on ambient Node types or `Buffer` refs
- Tier 2 (core): **~30%** — interceptor chain uses Promise chains heavily
- Tier 3 (browser adapter): **~10%** — XHR/fetch undefined
- Tier 4 (Node adapter): **~0% until host-import scaffold lands**

**Top 3 blockers**

1. `NODE_HOST_IMPORT_MODULES` compile-time routing (new issue needed)
2. Real `async`/`await` lowering (huge research-level task)
3. `Buffer` global as extern class

**Host-import scaffold status**

Nothing landed yet. #1035 is the closest parallel work (WASI `node:fs`) but it goes through compile-time syscall translation, not externref routing. Axios needs the JS-host externref variant — these are two different mechanisms with the same surface. Recommend designing them together.

### react (#1033)

**Required features**

- `Symbol.for('react.element')` — stable across modules
- Module-level mutable slot (`ReactCurrentDispatcher.current`)
- Closure capturing a mutable ref cell (`useState` returns `[value, setValue]` where `setValue` writes into the cell)
- Deps-array shallow comparison with `Object.is`
- `WeakMap` for ref tracking / context values
- `Object.freeze` on elements (no-op in prod is fine)
- Linked-list fiber structs with recursive `next: Fiber | null`
- DOM host imports (`document`, `window`, `HTMLElement`, `requestAnimationFrame`, `queueMicrotask`)
- `try`/`catch` around render for error boundaries
- `Map` with function identity for reconciler's work loops

**Current gaps**

- `DOM_HOST_GLOBALS` not defined → every `document.*` call is undefined
- `queueMicrotask` / `requestAnimationFrame` have no compile-time mapping
- `Object.is` — need to verify NaN and `-0` semantics match ES (we have the primitives; unclear if a single `Object.is` intrinsic is registered)
- `useEffect` dispatch needs a real microtask queue; without `await` suspension the effect flush has to run synchronously at commit, which is actually fine for the synchronous scheduler that #1033 recommends as a first cut
- Recursive fiber types will widen to externref — correctness OK, perf bad

**Projected readiness**

- Tier 1 (ReactElement, createContext, forwardRef): **~60%** once bundled — Symbol.for path works via host
- Tier 2 (hooks): **~50%** — ref-cell closure model is the key enabler; should compile
- Tier 3 (reconciler): **~25%** — recursive tree diff will compile but hit perf walls
- Tier 4 (react-dom): **~0% until DOM host-import scaffold lands**

**Top 3 blockers**

1. `DOM_HOST_GLOBALS` + `queueMicrotask` / `requestAnimationFrame` compile-time routing
2. Real `async`/`await` for concurrent features (acceptable to defer for Counter smoke test)
3. Private-field + computed class member edge cases — dev-mode branches hit this

**Hooks feasibility assessment**

**Yes, hooks should work.** The mutable-ref-cell closure path (src/codegen/closures.ts:971-1131) is exactly what `useState` needs: `setN(x)` captures the ref cell struct, not the scalar value, and writes into its mutable `$value` field. Module-level `let` compiles to a Wasm global, so `ReactCurrentDispatcher.current = x` inside `beginWork` is visible to the hook dispatcher. The only live question is whether cross-render hook-list stability holds up — that depends on the reconciler placing `useState` calls in a stable index order, which is React's own responsibility, not ours.

### prettier (#1034)

**Required features**

- Classes with static members, static private fields, class inheritance (plugin registration)
- Recursive AST traversal with large switch-on-type (hundreds of cases)
- String concatenation performance (70% of runtime)
- RegExp with named groups, unicode, sticky (tokenizer)
- `String.prototype.replaceAll`, `matchAll`, `normalize`, `padStart`
- `Map` with object keys (docbuilder group-fit memoization)
- `Set` iteration order
- `throw` inside expression position (parser error throws)
- `try`/`catch` around parse to decorate errors
- `Number.prototype.toString(radix)` + scientific notation
- Tagged template literals (less critical)
- `Object.freeze` on config objects (treat as no-op)

**Current gaps**

- Module graph — prettier 3.x is ESM with ~500 source files; pre-bundling via its own build pipeline is required
- `String.prototype.matchAll` coverage unclear (need to grep `string-ops.ts`)
- Large switch codegen is untested at >100 cases; may need a jump-table pass if linear emission is slow
- Map identity for docbuilder memoization is OK in JS-host, not in standalone
- `String.raw` and exotic tagged-template receivers (#836 open)

**Projected readiness**

- Tier 1 (common utils, text helpers): **~80%** once bundled
- Tier 2 (doc printer): **~60%** — the print algorithm is mostly string ops + recursion, both supported
- Tier 3 (options + parser adapter): **~50%**
- Tier 4 (language-js plugin): **~40%** — the large switch and many small specialized printers are the unknown

**Top 3 blockers**

1. Module graph resolution (pre-bundle is an OK workaround)
2. Large-switch codegen scaling — verify it compiles AND runs in reasonable time for the ~200-case estree printer
3. Map<Doc, boolean> memoization with object identity (works in JS-host)

**Self-format diff feasibility**

**Partial.** Prettier is the only stress test where byte-for-byte correctness is the acceptance bar. Given the fragility of recent destructuring/nullish paths (#1024, #1025), and the partial coverage of String.prototype.matchAll and RegExp edge cases, expect the first self-format diff run to produce many small mismatches — each one a concrete correctness bug. That is a *feature* of the test, not a failure mode. Budget multiple sprints of diff-triage. The killer signal is still worth it.

## Cross-cutting compiler gaps (prioritized)

1. **Real module graph resolution**
   - Description: `preprocessImports` rewrites every `import` to `declare const X: any` (src/import-resolver.ts:23). There is no multi-file compilation, no cross-file symbol resolution, no type flow across module boundaries.
   - Libraries blocked: lodash (all tiers), axios (all tiers), react (all tiers), prettier (all tiers)
   - Effort: **hard** (multi-week)
   - Workaround: require all stress tests to be pre-bundled by `esbuild`/`rollup` into a single file before compilation. This eliminates 95% of the problem for the stress-test use case; defer a real graph compiler.
   - Issue: **file a new issue** — "Multi-file module graph compilation (scoped to pre-bundled single-file mode for stress tests)".

2. **`async`/`await` state-machine lowering**
   - Description: `AwaitExpression` is a no-op at src/codegen/expressions.ts:790. Promise chains collapse to synchronous host calls. No microtask suspension.
   - Libraries blocked: axios (critical), react (concurrent/Suspense — deferrable), prettier (minimal — mostly sync), lodash (debounce/throttle only)
   - Effort: **research** (months)
   - Prerequisite for: #1032 real HTTP GET, #1033 concurrent features
   - Issue: **file a new issue** — "Async/await state-machine lowering (generator-rewrite approach)"

3. **Node builtin module routing (`node:*`)**
   - Description: compile-time resolver hook that maps `import { request } from 'node:http'` to externref host imports, without trying to compile the builtin source.
   - Libraries blocked: axios (critical), react dev utilities (minor)
   - Effort: **medium** (~1 sprint)
   - Prerequisite for: #1032 any tier past Tier 2
   - Issue: **file a new issue** — "Node builtin modules as host imports (`NODE_HOST_IMPORT_MODULES` set, `node:` prefix normalization)"

4. **DOM host globals**
   - Description: analog of Node builtins but for `document`, `window`, `HTMLElement`, `Event`, `requestAnimationFrame`, `queueMicrotask`, etc. Should register these as extern classes with a published method signature set.
   - Libraries blocked: react (critical for Tier 4), prettier (no), lodash (no), axios (browser adapter only)
   - Effort: **medium**
   - Prerequisite for: #1033 Tier 4 (react-dom renderer)
   - Issue: **file a new issue** — "DOM globals as extern classes (`DOM_HOST_GLOBALS`, `queueMicrotask`, `requestAnimationFrame`)"

5. **`for...in` / `Object.keys` over WasmGC-opaque structs**
   - Description: #853 already tracks this. The gap is real iteration of fields on WasmGC objects that the host sees as opaque.
   - Libraries blocked: lodash Tier 3 (pick/omit/invert), prettier (mild — option resolution)
   - Effort: **medium**
   - Issue already exists: **#853**

6. **Object-identity-keyed Map / WeakMap in standalone mode**
   - Description: Map/WeakMap with non-primitive keys currently route through host JS `Map` via extern classes. Standalone mode has no such thing. Not a blocker for JS-host-mode stress tests, but required for the WASI deliverable (#1035) if any library uses object-keyed Maps.
   - Libraries blocked: none for JS-host mode; prettier + react in standalone mode
   - Effort: **hard**
   - Issue: **file a new issue** — "Object-identity Map/WeakMap in standalone mode (sidecar keyed on WasmGC ref address)"

7. **Large-switch codegen scaling**
   - Description: prettier's printer-estree has ~200 cases. Our switch lowering is linear; may hit slow compile or bloated code size.
   - Libraries blocked: prettier (Tier 4)
   - Effort: **easy-medium** (profile first, jump-table pass only if needed)
   - Issue: **file a new issue** — "Large switch codegen: profile and optimize for prettier printer-estree (~200 cases)"

8. **Tree-shaking on `process.env.NODE_ENV`**
   - Description: React and prettier have `if (process.env.NODE_ENV === 'production')` branches throughout. Without DCE, dev-only paths compile too, multiplying surface area and exposing more bugs than prod-only would.
   - Libraries blocked: react (major surface-area amplifier), prettier (minor)
   - Effort: **easy** — substitute constant at compile time
   - Issue: **file a new issue** — "Compile-time `process.env.NODE_ENV` substitution + DCE"

9. **`queueMicrotask` as a compile-time intrinsic**
   - Description: needed for React effect flushing; currently undefined.
   - Libraries blocked: react
   - Effort: **easy** (map to host `queueMicrotask` as extern)
   - Issue: rolled into "DOM globals as extern classes" above

## Recommendations

1. **Attempt prettier first.** It is the cleanest test: no host-import design question, pure compute, deterministic. Any failure is a real compiler correctness bug with a trivial reproducer (diff two strings). The self-format byte-diff is the strongest correctness signal we have. Start with Tier 1 and the doc printer; expect many small mismatches — treat each as an issue.

2. **Fix cross-cutting gap #1 (module graph via pre-bundling) before any stress test runs.** The fastest path is to accept pre-bundled input: run each library through `esbuild --bundle --format=esm` first and hand the resulting single file to the compiler. This eliminates the graph-compiler research problem without committing to a real implementation.

3. **Fix cross-cutting gaps #3 and #4 (Node + DOM host-import routing) before starting axios and react.** These are both ~medium sprints and share a mechanism (extern-class set + import resolver hook). Design them together as one issue, implement as two.

4. **Defer gap #2 (async/await state machine) and gap #6 (standalone object-keyed Maps).** Both are research-level. Route axios's smoke test around `await` by running its Promise-returning calls synchronously in the host (Promise.resolve is already synchronous in the microtask queue, so a simple harness can `.then(...)` to get the result). That gives a "real GET" signal without lowering `await`.

5. **File gap #8 (`process.env.NODE_ENV` DCE) before react Tier 2.** Even if hooks work, the dev-build `react.development.js` has ~40% dead code that we would otherwise compile. This is the single highest-leverage surface-area reduction for #1033.

6. **Descope or defer: full Proxy semantics, full BigInt arithmetic, concurrent React, axios cancellation edge cases.** None of these are on the critical path for the stress tests' acceptance tests. Keep them backlog-only until a stress test proves they block progress.

## Appendix: specific function / file references

- **Module / imports**: src/import-resolver.ts:23 `preprocessImports`; src/compiler.ts:54; src/compiler/output.ts:311
- **AwaitExpression no-op**: src/codegen/expressions.ts:790
- **Closure ref cells**: src/codegen/closures.ts:971-1131 (`getOrRegisterRefCellType`, capture boxing)
- **Try/catch / exceptions**: src/codegen/statements/exceptions.ts:124-293
- **Symbol.iterator sidecar**: src/runtime.ts:380-403, :1009, :1990-2026
- **`Symbol.for`**: src/runtime.ts:1618
- **WeakMap/WeakSet/WeakRef extern classes**: src/runtime.ts:818-820; src/codegen/index.ts (extern class registration)
- **Map/Set extern class**: src/codegen/index.ts:2661, :4100; src/codegen/expressions/calls.ts:1746
- **Live-mirror host proxy**: src/runtime.ts:568-717, :2459
- **`Object.defineProperty` sidecar accessors**: src/runtime.ts:1323-1446
- **`Object.freeze` / `Object.seal` WeakSets**: src/runtime.ts:38-42
- **String methods**: src/codegen/string-ops.ts (replaceAll, padStart, repeat, codePointAt, normalize)
- **Array methods (long tail)**: src/codegen/array-methods.ts (after #1022/#1030/#1040 merges)
- **Generator flag / yield**: src/codegen/context/types.ts:121 `isGenerator`; src/codegen/expressions.ts:794 `YieldExpression`
- **Shape inference / recursive type widening**: src/shape-inference.ts
- **Tree-shaking / DCE**: src/treeshake.ts, src/codegen/dead-elimination.ts
