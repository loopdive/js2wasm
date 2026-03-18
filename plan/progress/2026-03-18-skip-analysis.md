# Skip Feature Analysis — 2026-03-18

## Summary

Of the 8,005 skipped test262 tests, **all are unlockable** except 33 cross-realm tests — and even those will likely pass trivially (#500).

The initial PO assessment labeled 730 tests (eval, Proxy, with, dynamic import, cross-realm) as "genuinely impossible in WasmGC." The project lead pushed back on every one:

- **eval/Function()**: "could be a host import that dynamically compiles a Wasm module" → two-stage compilation (#496)
- **dynamic import()**: "host API that loads and imports a library" → host-side module loading (#497)
- **Proxy**: "compiler knows when we're dealing with a proxy — specialize the codegen" → type-aware compilation with zero cost for non-proxy code. "Handler could be inlined if small" → trap inlining eliminates dispatch overhead entirely (#498)
- **with**: static AST identifier enumeration makes it compile-time resolvable (#499)
- **cross-realm**: single-module Wasm has no cross-realm issues — tests probably pass trivially (#500)

**Lesson**: "impossible in Wasm" is almost never true. The right question is "what compilation strategy makes this work?" Every JS feature has a compilation path — some use host imports, some use type-aware specialization, some use static analysis. The architectural constraint is effort, not feasibility.

## Issues Created

### Quick wins — stale filter removal (674 tests, XS/S effort)

| # | Feature | Tests | Effort | Notes |
|---|---------|------:|--------|-------|
| #491 | Remove stale null/undefined skip filter | 480 | XS | #348 already fixed this |
| #494 | Remove stale filters (Object.keys, new Object, globalThis, for-of destr.) | 194 | XS | Already implemented features |

### High-value unlocks — new compile-time patterns (5,036 tests)

| # | Feature | Tests | Effort | Approach |
|---|---------|------:|--------|----------|
| #488 | Property introspection (hasOwnProperty) | 1,617 | M | Compile-time struct field existence check; runtime field name table for dynamic keys |
| #481 | Symbol.iterator as compile-time struct field | 1,327 | M | Well-known symbol → reserved struct field name `__symbol_iterator` |
| #489 | General .call()/.apply() | 822 | M | Unwrap `X.prototype.Y.call(obj)` → `obj.Y()`; generic `fn.call(this, ...)` |
| #490 | Function/class .name property | 576 | S | Static string field on function/class structs |
| #483 | Symbol() constructor — narrow skip filter | 207 | S | Existing i32 implementation (#471), just narrow the filter |
| #482 | Symbol.toPrimitive | 113 | M | Compile-time well-known symbol → struct method |
| #485 | Symbol.match/replace/search/split (RegExp) | 87 | M | Same well-known symbol pattern |
| #484 | Symbol.species | 52 | L | Requires constructor refs as values |
| #486 | Symbol.toStringTag + hasInstance | 22 | S | Struct field / static method |
| #487 | User Symbol as property key (tagged struct) | 60 | M | Optional `Map<i32, externref>` field on structs that use symbol keys |
| #495 | Array-like objects with numeric keys | 77 | S | Detect `{0:x, 1:y, length:N}` → compile as array |

### Partially achievable (1,121 tests, ~50% passable)

| # | Feature | Tests | Approach | Passable |
|---|---------|------:|----------|---------|
| #492 | delete operator | 288 | Set field to undefined sentinel | ~144 |
| #493 | Prototype chain (narrow filter) | 233 | Only skip dynamic __proto__ mutation; instanceof/constructor already work | ~120 |
| — | dynamic property assignment on empty object | 73 | Hashmap fallback for objects with unknown property names | ~50 |
| — | Dynamic import() | 442 | Static import() for known specifiers could work | ~50 |
| — | TypedArray | 54 | Linear memory views, implementable but large effort | ~30 |
| — | JSON.stringify replacer/space | 40 | Extend existing impl | ~40 |

### Previously "impossible" — now achievable with creative approaches (730 tests)

| # | Feature | Tests | Approach | Feasibility |
|---|---------|------:|----------|-------------|
| #496 | eval / new Function() | 533 | Host import does two-stage compilation: receives source string, compiles to Wasm module via ts2wasm on the host, links + returns result. Scope sharing via serialized locals struct. | Hard |
| #497 | Dynamic import() | 442 | Host import resolves specifier, compiles + links module at runtime. Static specifiers can be bundled at build time. | Medium |
| #498 | Proxy | 70 | Type-aware compilation: compiler knows which objects are Proxies (sees `new Proxy()`). Three tiers: (1) inline small traps at access site = zero cost, (2) direct-call known trap functions, (3) indirect dispatch only for variable handlers. Non-proxy code pays zero cost. | Hard |
| #499 | with statement | 94 | Static identifier dispatch: walk AST inside `with` block, enumerate all identifiers, emit `hasOwnProperty(obj, name) ? obj[name] : scope[name]` per identifier. Compile-time known. | Medium |
| — | cross-realm | 33 | Module isolation via dynamic import (#497). Low priority. | Low |

**Key insight: none of these are truly impossible.** eval and import use host-side compilation. Proxy uses type-aware specialization with trap inlining. `with` uses static AST analysis. The "impossible" label was premature.

## Impact projection

If all "quick wins" and "high-value unlocks" are implemented:

| Current | After quick wins | After high-value unlocks | After "impossible" features |
|---------|-----------------|------------------------|---------------------------|
| 5,751 pass (25.1%) | ~6,400 pass (28%) | ~8,500+ pass (37%+) | ~9,500+ pass (41%+) |
| 8,005 skip | ~7,331 skip | ~2,969 skip | ~33 skip (cross-realm only) |

Combined with fixing the 2,197 fail and 6,912 CE (separate track), realistic ceiling is **60-70% pass rate** — significantly higher than the original 45-55% estimate.

**Revised conclusion**: There are NO fundamentally impossible features except cross-realm (33 tests). Every other skip category has a viable implementation path. The ceiling is determined by engineering effort, not architectural limitations.

## Execution priority

```
Phase 1 — Quick wins (1 day)
  #491 remove null/undefined filter (480 tests)
  #494 remove stale filters (194 tests)
  #483 narrow Symbol filter (207 tests)

Phase 2 — Big unlocks (1-2 weeks)
  #488 property introspection (1,617 tests) — critical
  #481 Symbol.iterator (1,327 tests) — critical
  #489 .call()/.apply() (822 tests) — critical
  #490 function .name (576 tests) — high

Phase 3 — Well-known symbols (1 week)
  #482 Symbol.toPrimitive (113 tests)
  #485 Symbol RegExp protocol (87 tests)
  #486 Symbol.toStringTag/hasInstance (22 tests)

Phase 4 — Partial features (ongoing)
  #492 delete operator (288 tests)
  #493 narrow prototype filter (233 tests)
  #487 user Symbol as property key (60 tests)
  #495 array-like objects (77 tests)
```

## Symbol roadmap

```
#483 (easy)     → narrow skip filter, unlock Symbol() identity tests
   ↓
#481 (critical) → Symbol.iterator as compile-time struct field (1,327 tests)
   ↓
#482 (high)     → Symbol.toPrimitive (113 tests)
#485 (low)      → Symbol.match/replace/search/split (87 tests)
#486 (low)      → Symbol.toStringTag + hasInstance (22 tests)
   ↓
#487 (low)      → user Symbol as property key via tagged struct variant (60 tests)
```

Total Symbol tests: 1,846. #483 + #481 cover 83% of them.

### How well-known Symbol compilation works

WasmGC structs have statically defined fields. Symbols are runtime-unique opaque values. These seem incompatible — but **well-known symbols** (`Symbol.iterator`, `Symbol.toPrimitive`, etc.) have fixed semantics known at compile time.

The approach: map each well-known symbol to a reserved struct field name:
- `[Symbol.iterator]()` → `__symbol_iterator` method field
- `[Symbol.toPrimitive](hint)` → `__symbol_toPrimitive` method field
- `obj[Symbol.iterator]` → `struct.get $__symbol_iterator`

For user-created symbols (`const s = Symbol()`), objects that use them as property keys get an optional `Map<i32, externref>` field (#487). Objects that don't use symbol keys have zero overhead.

### What remains truly impossible for Symbol

- `Symbol.for()` / `Symbol.keyFor()` — global symbol registry requires runtime string→symbol lookup across all modules. Could be implemented with a module-level Map but doesn't unlock many tests.
- Full `Object.getOwnPropertySymbols()` — requires listing all symbol-keyed properties, which would need the tagged struct's Map to be iterable. Achievable but low ROI.
