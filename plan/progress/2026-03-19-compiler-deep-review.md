# Compiler Deep Review — 2026-03-19

In-depth analysis of the ts2wasm compiler codebase: correctness, efficiency, code quality, and security. Three parallel review agents examined 38,000+ lines across codegen, emit, type mapping, and runtime.

## Competitive Landscape

### How others run JS/TS in Wasm

| Project | Approach | Binary size | JS compat | Production? |
|---------|----------|-------------|-----------|-------------|
| **StarlingMonkey** (Fastly) | SpiderMonkey interpreter compiled to Wasm + weval AOT | ~8 MB | ~100% ES2023 | Yes |
| **Javy** (Shopify) | QuickJS interpreter compiled to Wasm | 220B–869KB | ES2020 | Yes |
| **AssemblyScript** | AOT compiler for TS-like subset | 1–4 KB | 0% (different language) | Yes |
| **Porffor** | AOT JS→Wasm (linear memory) | <100 KB | ~50% test262 | No |
| **Static Hermes** (Meta) | AOT JS→C→native/Wasm | ~50 KB native | Partial | No |
| **ts2wasm** (this project) | AOT TS→WasmGC | 0.2–10 KB | ~68% (curated subset) | No |

### Two fundamental approaches

**Interpreter-in-Wasm** (StarlingMonkey, Javy): Compile an existing JS engine to Wasm. Near-100% compatibility but large binaries (869KB–8MB). The engine IS the module.

**AOT compilation** (ts2wasm, Porffor, AssemblyScript, Static Hermes): Compile source code directly to Wasm instructions. Tiny binaries, fast startup, but limited JS compatibility. No eval/dynamic code generation.

### ts2wasm's unique position

ts2wasm is the **only AOT compiler targeting WasmGC** for a JavaScript-family language. This gives it:

1. **Smallest binaries** — no runtime, no GC, no allocator. A function compiles to ~200 bytes. WasmGC structs are managed by the host GC.
2. **No JS engine dependency** — runs on wasmtime, wasmer (when WasmGC support lands), any Wasm host.
3. **TypeScript type information** — unlike Porffor (untyped JS), ts2wasm leverages TS types for optimal Wasm type selection.

### Closest competitor: Porffor

Porffor is the most similar project — AOT JS→Wasm. Key differences:

| | ts2wasm | Porffor |
|---|---|---|
| Target | WasmGC (structs, arrays) | Linear memory |
| Input | TypeScript (uses type info) | JavaScript (no types) |
| GC | Host-managed (zero overhead) | Custom GC in linear memory |
| test262 | ~68% of curated subset | ~50% of full suite |
| Binary size | ~0.2–10 KB | ~10–100 KB |
| eval support | Planned (host import, #496) | Never (fundamental limitation) |

Porffor's author explicitly states eval/Function() can never work in their AOT approach. ts2wasm's host-import design (#496) could enable it.

### WasmGC runtime support

| Runtime | WasmGC | Notes |
|---------|--------|-------|
| V8 (Chrome 119+) | Full | Production since Nov 2023 |
| SpiderMonkey (Firefox 120+) | Full | Production |
| JSC (Safari 18.2+) | Full | Production since Dec 2024 |
| Wasmtime 27+ | Full | "Null" collector (bump allocate, no collection) |
| Wasmer | No | Open issue since 2023 |
| wazero | No | Open issue since 2023 |

**Risk**: Non-browser WasmGC support is limited. Wasmtime has it but with a minimal collector. Wasmer and wazero don't support it at all. This limits the serverless use case today.

**Mitigation**: All browsers support WasmGC. The serverless runtimes (Fastly, Cloudflare, Deno) use V8 or SpiderMonkey underneath, so WasmGC works there too.

## Overall Rating

**Architecture: A-** — Clean pipeline (checker → codegen → emit), clear separation of concerns, well-organized despite file sizes. The collection-then-compilation pattern is sound.

**Correctness: B** — No show-stopping bugs in the common path, but several edge cases in try/catch, generators, and string import shifting could produce wrong Wasm. The binary encoder is rock-solid.

**Efficiency: B-** — 35 AST passes where 2-3 would suffice. Linear scans in hot paths (field lookup, type dedup). The recent hash-based optimizations (#556, #557, #558) addressed the worst offenders but more remain.

**Code Quality: C+** — 1,500+ lines of duplicated array method callbacks, 1,300+ lines of duplicated destructuring logic, functions exceeding 500 lines. Well-commented in places but inconsistent.

**Security: B** — Memory bounds checks exist but return empty string instead of errors. WAT string escaping incomplete. DOM containment uses duck typing. No critical exploits found.

---

## Critical Findings

### 1. addStringImports missing savedBodies shift (index.ts:1233-1239)

**Severity: HIGH** — Can produce wrong function call indices.

`addStringImports` shifts function indices in compiled bodies when new string imports are added, but unlike `addUnionImports` (line 6137-6142), it does NOT shift savedBodies from the body-swap pattern. If string imports are added while compiling inside nested blocks (try/catch, if/else), the outer body's function indices remain unshifted.

```typescript
// addStringImports (line 1233) — MISSING savedBodies shift
if (ctx.currentFunc) {
  const curBody = ctx.currentFunc.body;
  const alreadyShifted = ctx.mod.functions.some(f => f.body === curBody); // O(n), fragile
  if (!alreadyShifted) shiftFuncIndices(curBody);
  // ← savedBodies NOT shifted!
}

// addUnionImports (line 6137) — CORRECT
for (const sb of ctx.currentFunc.savedBodies) {
  if (shifted.has(sb)) continue;
  shiftFuncIndices(sb);
  shifted.add(sb);
}
```

Also uses fragile reference-equality check (line 1235) instead of Set-based tracking.

### 2. Finally block executes 2-3 times (statements.ts:3627-3720)

**Severity: HIGH** — Observable side effects in finally blocks execute multiple times.

When both `catch` and `finally` exist, the finally block instructions are inlined at:
- End of try body (line 3629)
- Inside inner try's catch_all (lines 3699-3700)
- After the inner try (lines 3719-3720)

JavaScript semantics require finally to run exactly once. The current approach duplicates the instructions, causing side effects (mutations, I/O, counter increments) to run 2-3 times.

### 3. ref.as_non_null on ref.null traps (expressions.ts:16596-16597)

**Severity: HIGH** — Runtime trap on default value for non-nullable ref types.

```typescript
case "ref":
  return [
    { op: "ref.null", typeIdx: ... },
    { op: "ref.as_non_null" },  // ← ALWAYS TRAPS
  ];
```

`defaultValueInstrs` for a non-nullable ref type pushes null then immediately asserts non-null. This is logically impossible and will trap at runtime whenever this code path is hit.

### 4. Generator for-of-string missing return depth (statements.ts:2975-3023)

**Severity: HIGH** — `return` inside `for (const c of str)` in a generator targets the wrong block.

`compileForOfString` adjusts `breakStack` and `continueStack` but does NOT update `generatorReturnDepth`. Compare with `compileForOfArray` (line 3148) which correctly updates it. This means `return` statements inside for-of-string loops in generators will target the wrong Wasm block depth.

---

## Correctness Issues (Medium)

### 5. String escaping incomplete (wat.ts:117-121)

`escapeWatString` only escapes `\` and `"`. Newlines, tabs, and control characters are passed through raw, producing invalid WAT. Fix: escape `\n`, `\t`, `\r`, and non-printable characters as `\u{XX}`.

### 6. Labeled break/continue in generators (statements.ts:3487-3511)

Label registration records `breakIdx`/`continueIdx` but not `generatorReturnDepth`. Labeled breaks inside generator functions could target the wrong block depth.

### 7. DOM containment bypass (runtime.ts:280-292)

- If `domRoot` lacks a `contains()` method, all containment checks return `true` (line 284)
- `isNodeLike` uses duck typing (`"parentElement" in v`) instead of `instanceof Node` (line 290)
- A plain object `{ parentElement: null }` passes the DOM node check

### 8. Constructor strips trailing undefined (runtime.ts:47-51)

`new Foo(a, b, undefined)` becomes `new Foo(a, b)`, silently changing arity. Constructors that check `arguments.length` get wrong results.

---

## Efficiency Issues

### 9. 35 sequential AST collection passes (index.ts:478-548)

The compilation pipeline walks the entire AST 35+ times for separate collection functions (console imports, string methods, math methods, extern declarations, etc.). Each pass is O(n) for n AST nodes, giving O(35n) total. A single visitor collecting all metadata would reduce this to O(n).

**Estimated impact: 10-15% compile time reduction.**

### 10. Linear field lookups in hot paths (index.ts:9909, 9937, 9960, 11031, 11047)

```typescript
const fieldIdx = fields.findIndex((f) => f.name === fieldName);
```

Called in loops during class constructor compilation. O(fields²) for classes with many fields/properties. Fix: build `Map<fieldName, index>` once.

### 11. 1,500+ lines of duplicated array method callbacks (expressions.ts:20480-24250)

`forEach`, `filter`, `map`, `reduce`, `find`, `findIndex`, `some`, `every`, `indexOf`, `lastIndexOf` — each implements nearly identical loop structure with element access, coercion, callback invocation. A shared helper function could reduce this by 60%.

### 12. 1,300+ lines of duplicated destructuring (statements.ts:614-2878)

Object destructuring (614-901), array destructuring (1024-1414), and for-of destructuring (2266-2878) have nearly identical null guards, nested patterns, and default value handling.

---

## Code Quality

### Files by size and complexity

| File | Lines | Functions >200 lines | Duplicated code |
|------|------:|---------------------:|----------------:|
| expressions.ts | 24,427 | 5 (coerceType, compileBinary, compileCall, compilePropertyAccess, compileConditional) | ~1,500 lines (array methods) |
| index.ts | 11,562 | 9 (generateModule, ensureAnyHelpers, collectClass, compileClass, compileFunctionBody, etc.) | addStringImports duplicates addUnionImports pattern |
| statements.ts | 4,195 | 0 | ~1,300 lines (destructuring) |
| type-mapper.ts | 289 | 0 | Minor (type check functions) |
| wat.ts | 489 | 0 | Minor (formatting) |
| encoder.ts | 119 | 0 | None — clean and correct |
| runtime.ts | 469 | 0 | Minor |

### Positive patterns

- **VOID_RESULT sentinel**: Used consistently across 30+ sites, cleanly distinguishes void compilation from failure
- **Ref cells for closures**: Correct implementation, properly initialized and accessed
- **Struct deduplication**: Hash-based after #556 fix — O(1) lookup
- **Function type caching**: Signature-based map after #558 fix — O(1) lookup
- **Error accumulation**: Errors pushed to `ctx.errors[]` rather than thrown, allowing compilation to continue and report all issues
- **Binary encoder**: Compact, correct LEB128 encoding with proper signed/unsigned handling

### Negative patterns

- **22,000-line single file** (expressions.ts) — should be split into modules by expression category
- **`as unknown as Instr` casts** — 50+ occurrences, working around incomplete type definitions
- **Inconsistent error handling** — some paths push errors, others silently fall through, others use non-null assertions
- **Mixed concerns** — `ensureStructForType` does both type registration AND method pre-registration
- **Magic strings** — field naming conventions (`__is_wrapper`, `__symbol_iterator`, `__anon_N`) are implicit contracts between files

---

## Security Summary

| Finding | Severity | Location |
|---------|----------|----------|
| WAT string injection via import names | Medium | wat.ts:141,210 |
| Memory bounds returns empty string (not error) | Medium | runtime.ts:149-152 |
| DOM containment bypass via duck typing | Medium | runtime.ts:280-292 |
| Constructor arity silently changed | Low | runtime.ts:47-51 |
| ref.as_non_null on ref.null (trap) | High | expressions.ts:16596 |

No critical security vulnerabilities found. The Wasm sandbox itself provides strong isolation — even with these issues, malicious code cannot escape the Wasm boundary.

---

## Recommendations (prioritized)

### Immediate (correctness)

1. **Fix addStringImports** — add savedBodies shifting to match addUnionImports pattern (index.ts:1233)
2. **Fix finally duplication** — emit finally body into a helper function, call once (statements.ts:3627)
3. **Fix defaultValueInstrs** — remove ref.as_non_null for ref type defaults (expressions.ts:16596)
4. **Fix generator for-of-string** — add generatorReturnDepth update (statements.ts:2975)

### Short-term (quality + efficiency)

5. **Extract array method helper** — shared loop/callback pattern, eliminate 1,500 lines of duplication
6. **Extract destructuring helper** — shared null guard/nested pattern logic
7. **Build field name maps** — O(1) lookup instead of findIndex in class compilation
8. **Fix WAT string escaping** — escape control characters

### Long-term (architecture)

9. **Split expressions.ts** — extract into `binary-ops.ts`, `call-expression.ts`, `array-methods.ts`, `type-coercion.ts`
10. **Consolidate AST passes** — single visitor collecting all import/declaration metadata
11. **Replace `as unknown as Instr`** — extend the Instr union to cover all used opcodes
12. **Add compilation assertions** — verify struct field counts, callback arities, stack balance

---

## Verdict

The compiler is **production-viable for its target use case** (TypeScript subset → Wasm). The architecture is clean, the hot path (expression compilation) is correct for common patterns, and the binary encoder is solid.

The main risks are in **edge cases**: try/catch/finally, generators, and late import shifting. These affect perhaps 5% of test262 tests but would be showstoppers for real-world code that uses these patterns.

The biggest opportunity is **code deduplication**: 2,800+ lines of near-identical code across array methods and destructuring. Extracting shared helpers would improve maintainability and reduce the surface area for bugs.

For a project of this complexity (38K lines, 506 issues completed in 8 days), the code quality is **better than expected**. The architecture decisions (WasmGC structs, ref cells, inline array methods) are sound and will scale. The main technical debt is in the code structure, not the algorithms.
