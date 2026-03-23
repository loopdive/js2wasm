# Goal: compilable

**All test262 tests compile without errors.**

- **Status**: Active
- **Target**: CE 5,982 → 0
- **Current**: 14,239 pass / 5,982 CE / 26,880 fail / 1,001 skip (as of 2026-03-22)
- **Dependencies**: None — this is a root goal.

## Why

Compile errors are the lowest-hanging fruit. A test that doesn't compile can't pass.
Every CE fixed is a potential new pass. Many CEs are mechanical (missing coercions,
type mismatches) and can be fixed in bulk.

## Top CE patterns (current, 2026-03-22)

| Pattern | Count | Issue | Status |
|---------|------:|-------|--------|
| Missing RegExp_new import | 1,468 | #754 | Open — RegExp extern class not registered from real TS libs |
| call expected externref, got ref | 1,149 | #772 | Partially fixed — extern.convert_any post-pass added, 463 resolved |
| struct.get type mismatch in callbacks | 717 | #697 | Open — wrong struct type in closure captures |
| for-of destructuring on non-array | 501 | #761 | Open — rest/spread in destructuring |
| local.set type mismatch | 448 | #444 | Open — externref vs ref coercion |
| struct.new arg count mismatch | 201 | #411 | Open — dynamic field addition after struct.new |
| not enough arguments on stack | ~100 | #776 | Mostly fixed — yield expression + Promise_then |
| immutable global assignment | ~36 | #777 | Mostly fixed — fixupModuleGlobalIndices extended |

## Session fixes (2026-03-22)

| Fix | CE resolved |
|-----|-------------|
| extern.convert_any at call sites (#772) | -463 |
| fixupModuleGlobalIndices (#777) | -248 |
| yield expression stack value (#776) | -7 |
| Object.defineProperty host import (#770) | ~-30 |
| **Total** | **-864 CE** |

## Issues

| # | Title | Impact | Priority | Status |
|---|-------|--------|----------|--------|
| **754** | RegExp_new import from real TS lib types | 1,468 CE | Critical | Open |
| **772** | Insert missing extern.convert_any at call sites | 1,299 CE | Critical | Partially done |
| **773** | Monomorphization — eliminate type mismatches at source | All CE | High | Open (architectural) |
| **411** | struct.new stack mismatch | 975 CE | Critical | Open |
| **511** | Wasm validation: call/call_ref type mismatch | 514 CE | Critical | Open |
| **444** | Wasm validation: local.set type mismatch | 483 CE | High | Open |
| **515** | Uninitialized local + struct.get/set type errors | 470 CE | High | Open |
| **409** | Unsupported call expression patterns | 3,931 CE | Critical | Open (review) |
| **401** | Wasm validation errors (call args, struct.new, stack) | 3,672 CE | Critical | Open |
| **765** | Compile error triage (umbrella) | 4,443 CE | High | Open |
| **510** | TS parse errors from test wrapping | 175 CE | High | Open |
| **698** | Call type mismatch residual | 1,044 CE | Medium | Open |
| **697** | Struct type errors for non-class structs | 813 CE | Medium | Open |
| **761** | Rest/spread in destructuring | 501 CE | High | Open |
| **405** | Internal compiler errors — undefined properties | 64 CE | Medium | Open |
| **406** | 'base' is possibly null errors | 81 CE | Medium | Open |
| **287** | Generator function CEs — yield in loops/try | 119 CE | Medium | Open |
| **288** | Try/catch/finally CEs — complex patterns | 40 CE | Medium | Open |
| **430** | String-to-number coercion for non-addition arithmetic | 36 CE | Medium | Open |
| **431** | Math.pow/min/max fallthru type mismatch | 27 CE | Medium | Open |
| **446** | Wasm validation: call_ref type mismatch | 56 CE | Medium | Open |
| **447** | Wasm validation: stack fallthru (residual) | 48 CE | Medium | Open |
| **448** | Wasm validation: type mismatch i32 | 47 CE | Medium | Open |
| **445** | Wasm validation: call args missing | 72 CE | Medium | Open |
| **420** | Cannot destructure non-array types | 83 CE | Medium | Open |
| **413** | Parameter default self-reference | 59 CE | Medium | Open |
| **404** | Compound assignment on unresolvable property type | 88 CE | Medium | Open |
| **433** | Equality operators mixed type i32/f64 mismatch | 10 CE | Low | Open |
| **776** | yield in expression position — not enough args | ~100 CE | Medium | ✅ Done |
| **777** | immutable global — fixupModuleGlobalIndices | 240 CE | Medium | ✅ Done |

## Success criteria

- CE count = 0 (or < 100 for genuinely unsupported features)
- All CE patterns with >50 occurrences have fixes
- 88%+ compilable → 100% compilable
