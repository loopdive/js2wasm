# Code Review Report — 2026-03-18

Comprehensive review of the ts2wasm compiler for bugs, security vulnerabilities, and performance optimization opportunities. Four parallel exploration agents reviewed codegen (38K lines), runtime, emit, test infrastructure, and performance.

## Security Issues (3 issues)

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| #548 | **High** | WAT string injection — import/export names interpolated without escaping | `emit/wat.ts:141,210` |
| #548 | **High** | Memory bounds — `__str_from_mem`/`__str_to_mem` accept unvalidated ptr/len from Wasm | `runtime.ts:143-160` |
| #549 | Medium | Path traversal — symlinks not resolved in playground file API | `vite-plugin-test262.ts:247` |
| #550 | Medium | XSS — error messages rendered as HTML without escaping | `report.html:329-336` |

### WAT injection detail

```typescript
// wat.ts:141 — VULNERABLE
`(import "${imp.module}" "${imp.name}" ${desc})`
```

A malicious import name like `"test" (func 999) (import "x` could inject WAT instructions. Impact is limited (WAT is text format, not directly executable) but could affect tooling that consumes WAT output.

### Memory bounds detail

```typescript
// runtime.ts:148 — NO BOUNDS CHECK
const u16 = new Uint16Array(mem.buffer, ptr, len);
return String.fromCharCode(...u16); // also: 65k spread limit
```

Attacker-controlled Wasm can pass arbitrary `ptr`/`len`, causing out-of-bounds reads or stack overflow via the spread operator.

## Correctness Issues (5 issues)

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| #551 | **High** | Function index shifting shared reference bug — double-shift when savedBodies arrays are shared | `index.ts:6043-6054` |
| #551 | **High** | Stack discipline — `__box_number` fallback drops value, pushes null, changes stack semantics | `expressions.ts:606-618` |
| #552 | Medium | Non-null assertions without bounds checks — 5+ locations crash on unexpected input | `statements.ts:734,766,796` |
| #553 | Medium | Division by zero missing in constant folding modulo path | `expressions.ts:23125` |
| #553 | Medium | Duplicate constant folding code (lines 16331 and 23122) — bugs fixed in one but not the other | `expressions.ts` |
| #554 | **High** | JSONL concurrent write corruption — 8 workers appendFileSync to same file | `run-test262.ts:454` |
| #554 | Medium | Lock file TOCTOU race — stale lock deletion has window for concurrent acquisition | `run-test262.ts:196-221` |
| #555 | Medium | Cache invalidation misses uncommitted changes — uses git HEAD not file content | `run-test262.ts:36` |

### Index shifting detail

The `addUnionImports` function at `index.ts:6043-6054` skips double-shifting using reference equality:
```typescript
if (sb === curBody) continue; // relies on reference identity
```

If the same instruction array appears in multiple places (cloned, or shared between saved contexts), the identity check fails and indices get shifted twice → wrong function calls in the generated Wasm.

This is called 16+ times during compilation from different paths in `expressions.ts`, each time walking ALL compiled function bodies recursively.

## Performance Issues (3 issues)

| # | Priority | Issue | Estimated speedup | Location |
|---|----------|-------|-------------------|----------|
| #556 | **High** | O(n²) struct deduplication — linear scan for each new struct | 20-30% | `index.ts:6789-6806` |
| #557 | **High** | Repeated instruction tree traversal — 16+ full walks of all function bodies | 15-25% | `expressions.ts:31-117` |
| #558 | Medium | Multiple redundant AST passes + linear type/property lookups | 10-15% | `index.ts:465-535,6341` |

### Combined optimization potential: 35-50% compile time reduction

### O(n²) struct dedup detail

```typescript
// index.ts:6792 — QUADRATIC
for (const [existingName, existingFields] of ctx.structFields) {
  if (!existingName.startsWith("__anon_")) continue;
  // field-by-field comparison for every new struct
}
```

For 1,000 object literals: ~500K comparisons. Fix: hash-based `Map<fieldSignature, structName>` for O(1) lookup.

### Instruction traversal detail

`shiftLateImportIndices` (expressions.ts:31-117) walks every instruction in every compiled function body, recursing into blocks, if/else, loops, catches. Called from 16 sites:
- Lines 5835, 5846, 6696, 7103, 7114, 8009, 8057, 8105, 8153, 8187, 8235, 15940, 15985, 16091, 17751

For 100 functions × 500 instructions × 10 late imports = 500K recursive visits.

Fix: batch all late imports and apply one shift pass at the end, or use symbolic function references resolved in a final pass.

### Redundant passes detail

5-6 separate AST walks in `index.ts:465-535`:
1. `collectConsoleImports` — walks AST
2. `collectStringMethodImports` — walks AST again
3. `collectMathImports` — walks AST again
4. `collectUnionImports` — walks AST again
5. `collectDeclarations` — walks AST again
6. `collectDeclaredFuncRefs` — walks all function bodies

Fix: single-pass visitor that detects all patterns in one walk.

## Summary

| Category | Issues | Total findings |
|----------|-------:|---------------|
| Security | 3 (#548-#550) | 4 vulnerabilities |
| Correctness | 5 (#551-#555) | 8 bugs |
| Performance | 3 (#556-#558) | 5 optimization opportunities |
| **Total** | **11** | **17 findings** |

### Priority order for fixes

1. **#548** (security) — WAT injection + memory bounds: easy fix, high impact
2. **#556** (perf) — hash-based struct dedup: XS effort, 20-30% speedup
3. **#557** (perf) — batch index shifts: M effort, 15-25% speedup
4. **#551** (correctness) — index shifting bug: causes wrong Wasm in edge cases
5. **#554** (correctness) — JSONL corruption: causes data loss in test runs
6. Everything else (medium priority, easy fixes)
