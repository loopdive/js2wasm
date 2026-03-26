# Goal: compilable

**All test262 tests compile without errors.**

- **Status**: Substantially complete
- **Phase**: 1 (first priority — unblocks all other goals)
- **Target**: CE 4,910 → < 500. Estimated +2,000 tests.
- **Current**: 16,187 pass / 1,761 CE (as of 2026-03-25). Compilable: 46,901/49,663 = 94.4%.
- **Dependencies**: None — this is a root goal.
- **Note**: CE reduced from 4,910 to 1,761 (-64%). Remaining CEs are harder patterns (type inference, complex destructuring, generator edge cases). Dependents (core-semantics, error-model, crash-free) are now unblocked.

## Why

Compile errors are the lowest-hanging fruit. A test that doesn't compile can't pass.
Every CE fixed is a potential new pass. Many CEs are mechanical (missing coercions,
type mismatches) and can be fixed in bulk.

## Top CE patterns (current, 2026-03-23)

| Pattern                               | Count | Issue | Status                      |
| ------------------------------------- | ----: | ----- | --------------------------- |
| Missing RegExp_new import (residual)  | 1,468 | #754  | Fixed — stale test results  |
| callback struct.get type mismatch     |   854 | #697  | Wave 2 in progress          |
| for-of destructuring on non-array     |   501 | #761  | Open                        |
| struct.new arg mismatch               |   461 | #411  | Wave 2 in progress (~370)   |
| call type mismatch (residual)         |   380 | #511  | Partially fixed             |
| local.set type mismatch (residual)    |    85 | #444  | Partially fixed             |

## Session fixes (2026-03-22 / 2026-03-23)

| Fix                                             | CE resolved |
| ------------------------------------------------ | ----------- |
| extern.convert_any at call sites (#772)          | -463        |
| fixupModuleGlobalIndices (#777)                  | -248        |
| yield expression stack value (#776)              | -7          |
| Object.defineProperty host import (#770)         | ~-30        |
| local.set ref/externref coercion (#444)          | ~-85        |
| call mismatch — spread, capture, extra args (#511) | ~-139     |
| coercion paths — 85 new conversions (#720)       | ~-96        |
| callback closure externref→struct.ref (#697)     | ~-20        |
| struct.new result coercion (wave 2, #411)        | ~-370       |
| callback struct.get (wave 2, in progress)        | ~-854       |
| **Total**                                        | **~-2,312** |

## Issues

| #       | Title                                                  | Impact   | Priority | Status                   |
| ------- | ------------------------------------------------------ | -------- | -------- | ------------------------ |
| **773** | Monomorphization — eliminate type mismatches at source  | All CE   | High     | Open (architectural)     |
| **409** | Unsupported call expression patterns                   | 3,931 CE | Critical | Open (review)            |
| **401** | Wasm validation errors (call args, struct.new, stack)  | 3,672 CE | Critical | Open                     |
| **765** | Compile error triage (umbrella)                        | 4,443 CE | High     | Open                     |
| **515** | Uninitialized local + struct.get/set type errors       | 470 CE   | High     | Open                     |
| **761** | Rest/spread in destructuring                           | 501 CE   | High     | Open                     |
| **510** | TS parse errors from test wrapping                     | 175 CE   | High     | Open                     |
| **698** | Call type mismatch residual                            | 1,044 CE | Medium   | Open                     |
| **684** | Any-typed variable inference from usage                | Many CE  | High     | Open                     |
| **685** | Interprocedural type flow                              | Many CE  | Medium   | Open                     |
| **686** | Closure capture type preservation                      | Many CE  | Medium   | Open                     |
| **405** | Internal compiler errors — undefined properties        | 64 CE    | Medium   | Open                     |
| **406** | 'base' is possibly null errors                         | 81 CE    | Medium   | Open                     |
| **287** | Generator function CEs — yield in loops/try            | 119 CE   | Medium   | Open                     |
| **288** | Try/catch/finally CEs — complex patterns               | 40 CE    | Medium   | Open                     |
| **430** | String-to-number coercion for non-addition arithmetic  | 36 CE    | Medium   | Open                     |
| **431** | Math.pow/min/max fallthru type mismatch                | 27 CE    | Medium   | Open                     |
| **446** | Wasm validation: call_ref type mismatch                | 56 CE    | Medium   | Open                     |
| **447** | Wasm validation: stack fallthru (residual)             | 48 CE    | Medium   | Open                     |
| **448** | Wasm validation: type mismatch i32                     | 47 CE    | Medium   | Open                     |
| **445** | Wasm validation: call args missing                     | 72 CE    | Medium   | Open                     |
| **420** | Cannot destructure non-array types                     | 83 CE    | Medium   | Open                     |
| **413** | Parameter default self-reference                       | 59 CE    | Medium   | Open                     |
| **404** | Compound assignment on unresolvable property type      | 88 CE    | Medium   | Open                     |
| **433** | Equality operators mixed type i32/f64 mismatch         | 10 CE    | Low      | Open                     |
| **754** | RegExp_new import from real TS lib types               | 1,468 CE | Critical | ✅ Done                  |
| **772** | extern.convert_any at call sites                       | 1,299 CE | Critical | ✅ Partially done (-463) |
| **511** | Wasm validation: call/call_ref type mismatch           | 514 CE   | Critical | ✅ Done                  |
| **444** | Wasm validation: local.set type mismatch               | 483 CE   | High     | ✅ Done                  |
| **411** | struct.new stack mismatch                              | 975 CE   | Critical | ✅ Partially done (~370) |
| **697** | Struct type errors / callback closure conversion       | 813 CE   | Medium   | ✅ Partially done        |
| **720** | i32.add expects i32, got f64                           | 96 CE    | Medium   | ✅ Done                  |
| **769** | lib.d.ts RegExp extern class registration              | 600 CE   | Critical | ✅ Done                  |
| **776** | yield in expression position — not enough args         | ~100 CE  | Medium   | ✅ Done                  |
| **777** | immutable global — fixupModuleGlobalIndices            | 240 CE   | Medium   | ✅ Done                  |

## Success criteria

- CE count = 0 (or < 100 for genuinely unsupported features)
- All CE patterns with >50 occurrences have fixes
- 88%+ compilable → 100% compilable
