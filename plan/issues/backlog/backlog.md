# ts2wasm Backlog

## 1. Runtime features & JS compatibility

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [678](../ready/678.md) | High | Dynamic prototype chain traversal | 625 FAIL |
| [669](../done/669.md) | ✅ Done | eval() / new Function() static compilation | 2,500 tests |
| [670](../done/670.md) | ✅ Done | Proxy get trap execution | 465 tests |
| [672](../done/672.md) | ✅ Done | WeakMap/WeakSet/WeakRef | 580 tests |
| [673](../done/673.md) | ✅ Done | Reflect API compile-time rewrites | 391 tests |
| [676](../done/676.md) | ✅ Done | RegExp exec result unpacking | 720 tests |
| [677](../done/677.md) | ✅ Done | Property descriptor writable enforcement | 1,000 tests |
| [671](../ready/671.md) | Low | with statement support | 272 tests |
| [674](../ready/674.md) | Low | SharedArrayBuffer / Atomics | 493 tests |
| [675](../ready/675.md) | Medium | Dynamic import() | 471 tests |
| [661](../ready/661.md) | Medium | Temporal API via polyfill | 1,128 tests |

## 2. Architecture — host import elimination

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [680](../ready/680.md) | High | Pure Wasm generators (state machines) | Eliminates 10 host imports |
| [681](../ready/681.md) | High | Pure Wasm iterators (struct-based) | Eliminates 5 host imports |
| [679](../done/679.md) | ✅ Done | Dual string backend (js-host vs standalone) | Architecture |
| [682](../ready/682.md) | Medium | RegExp Wasm engine for standalone mode | No host in WASI |
| [638](../ready/638.md) | Medium | Reverse typeIdxToStructName map | 12 O(N) → O(1) |
| [652](../ready/652.md) | Low | Compile-time ARC / static lifetime analysis | Research |

## 3. Platform support

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge |
| [644](../ready/644.md) | Critical | Integrate report into playground | Developer experience |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience |

## Completed (94 issues this session, 690+ total)

See `plan/issues/done/log.md` for the full completion log.

**Session 2026-03-19/20**: 94 issues in one session. Pass: 9,270 → 15,244 (+64%). CE: 14,950 → 5,666 (-62%). Key features: WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer, static eval, Proxy traps, Reflect, WeakMap/Ref, RegExp exec, property descriptors, stack balancing, native Date.
