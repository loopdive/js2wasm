---
title: "Issue #82 - Research Findings: Implementation Strategies"
status: backlog
sprint: Backlog
---
# Issue #82 - Research Findings: Implementation Strategies

## 1. AssemblyScript

**Strings**: UTF-16LE in linear memory, prefixed with a 32-bit byte length. Mimics JS String API (charCodeAt, substring). This ensures seamless JS interop but doubles memory for ASCII-heavy content.

**Arrays**: Backed by ArrayBuffer. Typed arrays expose `.buffer` directly; normal arrays keep it private. Length tracked separately from buffer capacity, enabling grow-without-realloc patterns.

**Allocator**: TLSF (Two-Level Segregate Fit), ~1KB compiled. Real-time friendly, O(1) alloc/free. Also offers buddy allocator and arena allocator as alternatives.

**Map/Set**: Hash table with chained entries stored in ArrayBuffer. Buckets array holds head pointers; entries stored sequentially with `taggedNext` for collision chains. Rehash on load factor threshold.

**Closures**: Not fully supported -- waiting on WasmGC function references. Current workaround encodes closure pointers via bit-shifting (MSB=1 marks closure vs plain function index). Recommends restructuring code to avoid closures.

**Adoptable patterns**: TLSF is irrelevant for WasmGC (host GC manages memory). Map/Set entry layout with chained buckets is a solid pattern. Their closure limitation confirms we should plan for WasmGC func.bind or struct-based closure representation.

## 2. Zena / Wasmnizer-ts

Could not find a project called "zena" from Elematic. The closest comparable project is **Wasmnizer-ts** (web-devkits), a TypeScript-to-WasmGC compiler from Intel.

**Type system**: Uses TS type info to create static WasmGC struct/array types. Dynamic types (`any`) handled via host API (`libdyntype`) -- essentially a JS-side runtime for dynamic dispatch.

**Generics**: WasmGC has no native generics support. The spec discussion (WebAssembly/gc#58) confirms this is post-MVP. Practical approaches: monomorphization (duplicate struct types per instantiation) or type erasure to `anyref` with casts.

**String representation**: Supports `stringref` proposal for language-independent strings, plus js-string-builtins as fallback.

**Adoptable patterns**: The dual-mode approach (static WasmGC types + dynamic fallback via host API) is pragmatic for handling `any`. Monomorphization for generics is the realistic near-term path since WasmGC lacks parametric polymorphism.

## 3. V8 WasmGC

**Struct/array performance**: WasmGC objects have fixed types and structure, enabling efficient field access without hidden-class deopt risk. V8's Turboshaft compiler applies WasmGC-specific typed optimizations.

**ref.test/ref.cast overhead**: Benchmarks show mixed results -- casts on shallow hierarchies are cheap, but deep hierarchies with mixed-type arrays incur measurable cost. V8 optimizes away redundant casts via typed optimization reducers.

**Speculative optimizations (2024-2025)**: V8 now applies speculative inlining and deoptimization to WasmGC code. Demonstrated 7-8% speedup on real workloads (Google Sheets calc engine, Dart Flute). This means WasmGC performance will keep improving.

**js-string-builtins**: Shipped in Chrome 131. Wasm imports from `wasm:js-string` module get inlined by the compiler -- no JS call overhead. Operations: `concat`, `substring`, `charCodeAt`, `length`, `equals`, `fromCharCode`, `fromCodePoint`. Strings are `externref` typed. Imported string constants via special `"_"` module avoid repeated allocation.

**Adoptable patterns**: Use js-string-builtins for strings -- avoids encoding overhead entirely, gets engine-optimized string ops for free. Keep type hierarchies shallow to minimize cast cost. Prefer `ref.test` over `ref.cast` where null/failure is acceptable.

## 4. SpiderMonkey WasmGC

**Status**: WasmGC enabled by default since Firefox 120 (late 2023). Feature-complete for the MVP spec.

**Performance**: Uses IonMonkey/WarpMonkey JIT tiers for WasmGC. Less publicly documented optimization work compared to V8, but functional and spec-compliant.

**JS-Wasm interop**: GC types cross the JS/Wasm boundary. Firefox supports the same externref-based patterns as V8 for string interop. js-string-builtins support is available.

**Adoptable patterns**: Both major engines support WasmGC and js-string-builtins, so we can target these features without browser-compatibility concerns.

## 5. Key Takeaways for js2wasm

1. **Strings: Use js-string-builtins** -- represent strings as `externref`, import operations from `wasm:js-string`. No need to implement string encoding/decoding. Both V8 and SpiderMonkey support this. String constants via imported globals from `"_"` module.

2. **Arrays: WasmGC arrays directly** -- no need for ArrayBuffer-backed linear memory arrays like AssemblyScript. Use `(array.new)`, `(array.get)`, `(array.set)`. For typed arrays, use specialized WasmGC array types (`(array i32)`, `(array f64)`, etc.).

3. **Generics: Monomorphize** -- since WasmGC lacks parametric types, generate separate struct/array definitions per concrete type instantiation. For heavily polymorphic code, fall back to `anyref` + `ref.cast`.

4. **Map/Set: WasmGC struct-based hash table** -- chained hash table with entries as WasmGC structs (key, value, next-ref fields). Bucket array as `(array (ref null $entry))`. No allocator needed -- GC handles entry lifetime.

5. **Closures: Struct-based representation** -- capture environment in a WasmGC struct, pair with function index. Call via `call_indirect` after loading captures from struct. This avoids AssemblyScript's limitation of waiting for `func.bind`.

6. **Type hierarchies: Keep shallow** -- ref.cast/ref.test cost scales with hierarchy depth. Prefer flat struct layouts with optional fields over deep inheritance chains.
