# ts2wasm Backlog

## Current — Test262 Full Suite (March 2026)

*Full run in progress (48,104 tests). Previous: 9,270 pass (23.4%), 14,950 CE, 39,687 total.*
*Sprint 2026-03-19: 53 issues committed. Full run pending with all fixes.*

### Open issues

| # | Feature | Type | Priority |
|---|---------|------|----------|
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | Feature | High (merge conflicts, branch preserved) |

### Recently completed (2026-03-19 session — 53 issues)

**Features:**
- #578 WASI target (console.log → fd_write, process.exit → proc_exit)
- #599 Native WasmGC strings (decoupled from fast mode, --nativeStrings flag)
- #600 WIT generator for Component Model (TypeScript → WIT interfaces)
- #601 Binaryen wasm-opt post-processing pass
- #602 Tail call optimization (return_call/return_call_ref)
- #608 TypedArray constructor support (9 types)
- #614 ArrayBuffer/DataView constructors
- #124 Delete operator via undefined sentinel
- #323 Native type annotations (type i32 = number → i32 locals)
- #631 Prototype chain patterns (getPrototypeOf, .constructor, .prototype)
- #634 Getter/setter accessor side effects via global promotion

**CE fixes (estimated ~8,000+ CE eliminated):**
- #611 Null guards for undefined AST nodes (2,995 CE)
- #619 Class element handlers (4,230 CE)
- #621 Unsupported call expression fallback (1,692 CE)
- #624 Prevent class struct corruption (953 CE)
- #625 local.set type mismatch (552 CE)
- #626 Call argument coercion (378 CE)
- #627 Void RHS in logical operators (354 CE)
- #628 Yield outside generator — isGenerator flag (283 CE)
- #581-#583, #612-#617 Various CE fixes

**Runtime fixes:**
- #585 Illegal cast closure return type (44/51 fixed)
- #588 Finally block compiles once (was duplicated)
- #590 Generator return depth in for-of-string
- #622 Null pointer deref — destructureParamObject guard
- #629 Tuple struct destructuring in generators (2,444 fail)
- #632 RegExp literal flags crash
- #633 Shape inference in try/catch/loop/switch blocks

**Performance:**
- #594 Leaf struct types marked final (V8 devirtualization)
- #595 i32 loop counters for integer for-loops
- #596 Peephole: remove redundant ref.as_non_null after ref.cast
- #597 Type-specialized arithmetic skips AnyValue
- #74 SIMD WAT emission complete

**Refactoring:**
- #586 Deduplicated array method callbacks (-484 lines)
- #587 Deduplicated destructuring code (-155 lines)
- #591 Extracted type-coercion.ts (680 lines)
- #592 Consolidated 19 AST passes into single visitor

**Test infrastructure:**
- #604, #606, #609, #610, #620, #623, #629, #630 Various test improvements
- #452 TypeScript compiler pattern compatibility (95% — 19/20 patterns)

### Backlog — JS runtime features

| # | Feature | Tests | Priority |
|---|---------|-------|----------|
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | 648 | High (merge conflicts) |

### Future — architecture improvements (from deep review)

| Priority | Improvement | Impact |
|----------|-------------|--------|
| High | Add missing Instr opcodes to IR types | Eliminates 158 unsafe `as unknown as Instr` casts |
| High | Extract createCodegenContext() factory | Fixes WASI multi-module bug, eliminates duplication |
| Medium | Create walkInstructions utility | Eliminates 5 duplicate instruction walkers |
| Medium | Add reverse typeIdxToStructName map | 8 O(N) scans → O(1) |
| Medium | Split expressions.ts further | 24K lines → focused modules |

### Future — platform support

| Priority | Feature | Impact |
|----------|---------|--------|
| Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon, Cosmonic |
| High | WASI HTTP handler | Unlocks serverless edge platforms |
| Medium | Shopify Functions template | Best adoption opportunity |
| Low | Deno/Cloudflare loader plugins | Developer experience |

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1-2 files
- M: < 400 lines, 2-3 files
- L: > 400 lines, multiple files

## Completed (630+ issues)

See `plan/issues/done/log.md` for the full completion log.

Key milestones:

- React reconciler compiles to WasmGC, 2.3x faster than JS (1000-node tree)
- 98-99% pass rate on supported test262 categories
- 53 issues completed in single session (2026-03-19)
- WASI target, native strings, WIT generator, tail calls, SIMD
- 95% TypeScript compiler pattern compatibility
- Deep architecture review with actionable improvements

