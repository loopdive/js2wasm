# ts2wasm Backlog

## 1. Compiler correctness (highest impact on test262)

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [646](../ready/646.md) | High | More AST node handlers (undefined .kind) | 5,329 CE |
| [647](../ready/647.md) | High | Null pointer dereferences | 1,513 FAIL |
| [648](../ready/648.md) | High | Illegal cast residual | 988 FAIL |
| [649](../ready/649.md) | Medium | Stack underflow residual | 876 CE |
| [650](../ready/650.md) | Medium | Stack fallthrough | 300 CE |
| [645](../done/645.md) | ✅ Done | testTypedArray.js include | 1,731 unskipped |
| [651](../done/651.md) | ✅ Done | FilterResult discriminated union | type safety |

## 2. JS runtime features

| # | Priority | Feature | Tests |
|---|----------|---------|-------|
| [123](../ready/123.md) | High | Wrapper constructors (new Number/String/Boolean) | 648 |
| [498](../ready/498.md) | Medium | Proxy via compile-time trap inlining | 465 |
| [125](../ready/125.md) | Medium | Object.defineProperty / property descriptors | 106 |
| [341](../ready/341.md) | Medium | Property introspection (hasOwnProperty) | — |
| [342](../ready/342.md) | Medium | Array.prototype.method.call/apply | — |
| [345](../ready/345.md) | Medium | Symbol.iterator and iterable protocol | — |

## 3. Architecture improvements

| # | Priority | Improvement | Impact |
|---|----------|-------------|--------|
| [635](../ready/635.md) | High | Add missing Instr opcodes to IR types | Eliminates 158 unsafe casts |
| [636](../ready/636.md) | High | Extract createCodegenContext() factory | Fixes WASI multi-module bug |
| [637](../ready/637.md) | Medium | Create walkInstructions utility | Eliminates 5 duplicate walkers |
| [638](../ready/638.md) | Medium | Add reverse typeIdxToStructName map | 8 O(N) → O(1) |

## 4. Platform support

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon, Cosmonic |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience |
| [644](../ready/644.md) | Medium | Integrate report into playground | Developer experience |

## 5. Test infrastructure

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [643](../ready/643.md) | Medium | Atomic report writes | Prevents data loss |

## Completed (640+ issues)

See `plan/issues/done/log.md` for the full completion log.

Session 2026-03-19: 59 issues committed. Key: WASI target, native strings, WIT generator, tail calls, SIMD, peephole optimizer, type annotations, prototype chain, delete operator, TypedArray/ArrayBuffer, 8K+ CE eliminated.
