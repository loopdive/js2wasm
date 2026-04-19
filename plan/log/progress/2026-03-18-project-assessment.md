# Project Assessment — 2026-03-18

## Summary

ts2wasm is a TypeScript-to-WebAssembly compiler using WasmGC. After 8 days of intensive development (613 commits, 469 issues completed), test262 conformance went from 9.9% to 25.1%. The architecture is sound but approaching diminishing returns as remaining tests increasingly require JS runtime features that conflict with the pure-Wasm philosophy.

## Metrics

### Conformance trajectory

| Date | Pass | Total | Rate | Delta |
|------|-----:|------:|-----:|------:|
| Mar 10 | 2,260 | 22,824 | 9.9% | — |
| Mar 13 | 4,749 | 22,767 | 20.9% | +2,489 (+110%) |
| Mar 16 | 5,312 | 22,959 | 23.1% | +563 (+12%) |
| Mar 17 | 5,735 | 17,606 | 32.6% | +423 (partial run) |
| Mar 18 | 5,751 | 22,865 | 25.1% | +16 |

### Current breakdown (22,865 tests)

| Status | Count | % | Description |
|--------|------:|---:|-------------|
| Pass | 5,751 | 25.1% | Compiles and produces correct output |
| Fail | 2,197 | 9.6% | Compiles but wrong result |
| CE | 6,912 | 30.2% | Doesn't compile |
| Skip | 8,005 | 35.0% | Unsupported features (not attempted) |

### Development velocity

- 613 commits in 8 days
- 469 issues completed
- 214 test files passing (vitest)
- 38,000 lines of codegen (expressions.ts + statements.ts + index.ts)

## What works

The compiler handles a substantial TypeScript/JavaScript surface:

- Classes (inheritance, static, private fields/methods, expressions)
- Closures and arrow functions (ref cells for mutable captures)
- Destructuring (array, object, nested, default values)
- Generators and async/await (basic patterns)
- Generics
- Template literals
- Optional chaining and nullish coalescing
- Map, Set, Promise collections
- RegExp (via host import)
- BigInt (i64 ops)
- Spread/rest operators
- Computed property names
- for-of, for-in iteration
- try/catch (basic patterns)
- A React scheduler compiles to Wasm (15/15 tests, #455)

## What doesn't work (and why)

### Fixable — compiler bugs and missing patterns (~40% of remaining)

These are codegen patterns that are architecturally sound but not yet implemented:

- **Unsupported call expression** (1,752 CE): spread in calls, optional chaining calls, super method calls, property method calls. Each requires a specific codegen pattern.
- **Wasm validation errors** (577 CE): The compiler generates syntactically valid but semantically invalid Wasm — type mismatches on the stack, wrong argument counts for struct.new/call. These are bugs in the codegen.
- **Wrong return values** (1,979 fail): Tests compile but produce wrong results. Root causes: destructuring value extraction (51%), private field reads (15%), prototype method returns (11%), other (23%). These are correctness bugs, not architectural limits.
- **Null pointer dereference** (88 fail): Struct access on null references. Needs null guards.

### Structurally hard — requires runtime support (~35% of remaining)

These tests require JS runtime behaviors that WasmGC cannot express natively:

| Feature | Tests blocked | Difficulty |
|---------|-------------:|------------|
| Symbol / Symbol.iterator | 1,875 skip | Needs runtime type tag system |
| Property introspection (hasOwnProperty, etc.) | 1,633 skip | Needs property metadata layer |
| class/function .name property | 576 skip | Needs string metadata per function |
| delete operator | 487 skip | WasmGC structs have fixed fields |
| Dynamic code execution (eval) | 517 skip | Fundamentally impossible in Wasm |
| Object.defineProperty | 413 skip | Needs full property descriptor runtime |
| Prototype chain | 234 skip | Needs dynamic dispatch tables |
| Proxy | 70 skip | Needs complete runtime interception layer |

### Fundamentally impossible (~5% of remaining)

- `eval()`, `new Function()`, `with` statement — dynamic code execution cannot work in ahead-of-time compiled Wasm
- Full prototype chain with runtime modification — WasmGC structs are statically typed

## Growth curve analysis

The pass rate growth is flattening:

```
+2,489 in 3 days (Mar 10-13) — low-hanging fruit
  +563 in 3 days (Mar 13-16) — harder patterns
  +439 in 2 days (Mar 16-18) — diminishing returns
```

Each remaining pass requires fixing increasingly specific codegen patterns. The "unsupported call expression" bucket alone has dozens of sub-patterns (spread args, optional chain calls, super.method(), computed property calls, etc.), each needing separate codegen logic.

## Feasibility assessment

### Realistic ceiling: 40-50% pass rate (~10-12k tests)

By fixing the remaining CE patterns and correctness bugs, the compiler can reach 40-50% conformance. This is achievable with continued effort on:

1. Call expression patterns (1,752 CE → fixable)
2. Wasm validation errors (577 CE → bugs to fix)
3. Wrong return values (1,979 fail → correctness debugging)
4. Null guards (88 fail → straightforward)

### Unlikely ceiling: 60%+

Reaching 60%+ would require implementing Symbol, basic property introspection, and function .name — possible but architecturally expensive (needs a runtime type/metadata layer in Wasm).

### Not achievable without fundamental redesign: 80%+

Full JS conformance requires Proxy, eval, property descriptors, prototype chain manipulation, and delete — these need a JS runtime in Wasm, which contradicts the project's "no JS host dependency" principle.

## Recommendations

### 1. Define the supported subset explicitly

The project's value proposition is "TypeScript without dynamic JS features compiles to pure Wasm." Make this explicit:

**Supported**: static types, classes, closures, generics, async/await, collections, destructuring, template literals, optional chaining, BigInt

**Unsupported (by design)**: eval, Proxy, Symbol (full), property descriptors, delete, prototype chain mutation, with statement

### 2. Shift focus from test262 breadth to real-world depth

The React scheduler test (#455) is more valuable than 100 test262 edge cases. Identify 5-10 real-world TypeScript modules and make them compile correctly. This proves the compiler works for actual code, not just spec tests.

### 3. Prioritize correctness over compilation

The 2,197 "returned 0" failures are more dangerous than the 6,912 CEs. A CE gives a clear error message. A wrong result silently breaks programs. Focus on reducing fail count before CE count.

### 4. Consider a "supported features" tier system

- **Tier 1 (fully supported)**: primitives, arithmetic, control flow, functions, basic classes, arrays
- **Tier 2 (mostly supported)**: generics, destructuring, async/await, Map/Set, generators
- **Tier 3 (partial)**: advanced class patterns, Symbol basics, try/catch
- **Tier 4 (unsupported)**: Proxy, eval, property descriptors, full Symbol

This gives users clear expectations and guides development priorities.

## Conclusion (revised after deeper analysis)

ts2wasm is not a dead end, and the ceiling is higher than initially estimated.

After deeper analysis of the 8,005 skipped tests, **91% are unlockable** with targeted work. Features previously labeled "impossible" (eval, Proxy, dynamic import, with) all have viable implementation paths:

- **eval/Function()**: host-side two-stage compilation (#496)
- **Proxy**: type-aware compilation with trap inlining — zero cost for non-proxy code (#498)
- **dynamic import()**: host-side module loading (#497)
- **with**: static AST identifier dispatch (#499)

Only cross-realm (33 tests) has no viable path.

**Revised ceiling: 60-70% test262 pass rate**, up from the initial 40-50% estimate. The limit is engineering effort, not architectural constraints. The project's "no JS host dependency" principle can be relaxed selectively (eval/import host imports) while keeping the core compilation pure Wasm.

See `plan/log/progress/2026-03-18-skip-analysis.md` for the full breakdown and issue roadmap (#481-#499).
