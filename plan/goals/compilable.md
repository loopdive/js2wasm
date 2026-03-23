# Goal: compilable

**All test262 tests compile without errors.**

- **Status**: Active
- **Target**: CE 4,443 → 0. Pass rate ~40%.
- **Dependencies**: None — this is a root goal.

## Why

Compile errors are the lowest-hanging fruit. A test that doesn't compile can't pass.
Every CE fixed is a potential new pass. Many CEs are mechanical (missing coercions,
type mismatches) and can be fixed in bulk.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **759** | Insert missing extern.convert_any at call sites | 1,299 CE | Critical |
| **411** | struct.new stack mismatch | 975 CE | Critical |
| **511** | Wasm validation: call/call_ref type mismatch | 514 CE | Critical |
| **444** | Wasm validation: local.set type mismatch | 483 CE | High |
| **515** | Uninitialized local + struct.get/set type errors | 470 CE | High |
| **409** | Unsupported call expression patterns | 3,931 CE | Critical (review) |
| **401** | Wasm validation errors (call args, struct.new, stack) | 3,672 CE | Critical |
| **765** | Compile error triage (umbrella) | 4,443 CE | High |
| **510** | TS parse errors from test wrapping | 175 CE | High |
| **698** | Call type mismatch residual | 1,044 CE | Medium |
| **697** | Struct type errors for non-class structs | 813 CE | Medium |
| **405** | Internal compiler errors — undefined properties | 64 CE | Medium |
| **406** | 'base' is possibly null errors | 81 CE | Medium |
| **287** | Generator function CEs — yield in loops/try | 119 CE | Medium |
| **288** | Try/catch/finally CEs — complex patterns | 40 CE | Medium |
| **430** | String-to-number coercion for non-addition arithmetic | 36 CE | Medium |
| **431** | Math.pow/min/max fallthru type mismatch | 27 CE | Medium |
| **446** | Wasm validation: call_ref type mismatch | 56 CE | Medium |
| **447** | Wasm validation: stack fallthru (residual) | 48 CE | Medium |
| **448** | Wasm validation: type mismatch i32 | 47 CE | Medium |
| **445** | Wasm validation: call args missing | 72 CE | Medium |
| **420** | Cannot destructure non-array types | 83 CE | Medium |
| **413** | Parameter default self-reference | 59 CE | Medium |
| **404** | Compound assignment on unresolvable property type | 88 CE | Medium |
| **433** | Equality operators mixed type i32/f64 mismatch | 10 CE | Low |

## Success criteria

- CE count = 0 (or < 100 for genuinely unsupported features)
- All CE patterns with >50 occurrences have fixes
- 88%+ compilable → 100% compilable
