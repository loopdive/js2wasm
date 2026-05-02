---
id: 82
title: "Issue 82: Study V8, SpiderMonkey, Zena, and AssemblyScript implementation strategies"
status: done
created: 2026-03-08
updated: 2026-04-14
completed: 2026-03-08
goal: core-semantics
---
# Issue 82: Study V8, SpiderMonkey, Zena, and AssemblyScript implementation strategies

## Summary

Research how production engines and TS/JS-to-wasm compilers implement key
language features, extract patterns and techniques applicable to ts2wasm.

## Motivation

We're building many of the same features that mature engines have solved —
strings, arrays, objects, closures, GC, type dispatch. Rather than
reinventing, we should study what works and adapt proven strategies to our
WasmGC context. Each engine made different trade-offs worth understanding.

## What to study

### V8 (Google's JS engine)

| Area | What to learn |
|------|--------------|
| **Strings** | Rope/cons-string for O(1) concat, sliced strings for O(1) substring, string internalization, SeqString vs ExternalString |
| **Arrays** | Packed vs holey arrays, elements kinds (SMI, DOUBLE, ELEMENTS), copy-on-write for literal arrays, transition maps |
| **Objects** | Hidden classes (Maps/Shapes), inline caches, transition trees for property additions, fast vs dictionary mode |
| **Closures** | Context chain allocation, escape analysis to stack-allocate non-escaping closures |
| **GC** | Generational GC, write barriers, evacuation — relevant for our linear-memory backend |
| **Optimization** | TurboFan's sea-of-nodes IR, speculative optimization, deoptimization bailouts |

Key source: `v8/src/objects/`, `v8/src/compiler/`, V8 blog posts.

### SpiderMonkey (Mozilla's JS engine)

| Area | What to learn |
|------|--------------|
| **Strings** | Rope strings (JSRope), dependent strings (substrings sharing buffer), atom table for interning |
| **Arrays** | NativeObject with dense/sparse element representations, TypedArray optimizations |
| **Objects** | Shapes (equivalent to V8's Maps), property storage layout, megamorphic stubs |
| **Wasm integration** | SpiderMonkey's WasmGC implementation — how they represent JS values in wasm, ref types, struct layouts |
| **ICs** | CacheIR — how inline caches compile, stub sharing |

Key source: `js/src/vm/`, `js/src/jit/`, `js/src/wasm/`.

### Zena (elematic/zena)

| Area | What to learn |
|------|--------------|
| **Type system** | Sound type system design — how they avoid TypeScript's unsoundness while keeping familiar syntax |
| **Monomorphization** | How generics are monomorphized to concrete WasmGC types (vs our type-erased approach) |
| **Structs** | How object types map to WasmGC structs, structural vs nominal typing decisions |
| **Multi-value returns** | Using wasm multi-value for tuples and destructuring (we use structs) |
| **Pattern matching** | How algebraic data types compile to WasmGC — tagged unions, exhaustiveness checking |
| **String representation** | Which string strategy they chose for WasmGC (GC arrays, imported strings, linear memory) |

Key source: GitHub `elematic/zena`, compiler source.

### AssemblyScript

| Area | What to learn |
|------|--------------|
| **Linear memory layout** | Object header format, RTTI (runtime type info), memory manager (tlsf allocator) |
| **Strings** | UTF-16 in linear memory, immutable string implementation, string interning |
| **Arrays** | ArrayBuffer backing, typed array views, capacity vs length management |
| **GC** | Reference counting + cycle collection, incremental tracing GC |
| **Closures** | How function references and closures work in linear memory |
| **stdlib** | How they implement Map, Set, Array methods — pure wasm implementations we could adapt |
| **Operator overloads** | How they handle `==` for strings (linear memory comparison loops) |

Key source: `assemblyscript/src/`, `assemblyscript/std/assembly/`.

## Specific questions to answer

### Strings
1. What's the optimal string representation for WasmGC? (V8 uses 5+ representations)
2. How do engines avoid O(n) concat? (ropes) When do they flatten? (on charAt, indexOf)
3. Is UTF-8 or UTF-16 better for wasm? (AS uses UTF-16, V8 uses one-byte/two-byte)
4. How do string views/slices interact with GC? (dependent strings in SM)

### Arrays
1. How do engines handle mixed-type arrays efficiently? (elements kinds in V8)
2. What's the best growth strategy? (V8: 1.5x + 16, AS: power-of-2)
3. How do engines optimize `Array.prototype.map/filter/reduce`? (inlining, allocation sinking)
4. Should we use WasmGC arrays or linear memory arrays? (trade-offs per operation)

### Objects / structural typing
1. How do hidden classes/shapes work, and can we use WasmGC subtyping similarly?
2. How does V8 handle objects with optional properties? (transitions vs dictionary)
3. Can we use WasmGC `ref.test`/`ref.cast` for structural subtyping dispatch?
4. How does Zena handle structural typing with WasmGC's nominal type system?

### Closures
1. How do engines decide stack vs heap allocation for closure environments?
2. Can WasmGC funcref + environment struct replace our current closure approach?
3. How does AS handle closures in linear memory?

### Dynamic typing (for #79)
1. How does V8 represent tagged values? (SMI tagging, pointer tagging)
2. How does Wasmnizer-ts box values for `any`? (host calls vs wasm-native)
3. Can we use WasmGC `i31ref` for small integers + `ref` for heap objects?
4. How does SpiderMonkey's WasmGC implementation handle JS interop values?

## Deliverables

For each engine/compiler, produce a short findings document covering:
1. **Representation choices** — how they store strings/arrays/objects in memory
2. **Key algorithms** — concat, property lookup, type dispatch
3. **Trade-offs** — what they optimized for and what they sacrificed
4. **Applicability** — what we can directly adopt vs what needs adaptation for WasmGC

## Implementation approach

This is a research issue. No code changes directly, but findings should
inform implementation of #70 (fast mode), #74 (SIMD), #75 (string views),
#76 (rope strings), #77 (objects), #79 (gradual typing).

Suggested order:
1. AssemblyScript first — closest to our architecture, easiest to learn from
2. Zena — same target (WasmGC), most directly comparable
3. V8 strings/arrays — gold standard for performance techniques
4. SpiderMonkey WasmGC — relevant for our GC backend specifically

## Complexity

M — Research task, no code. ~2-3 days of reading source code and writing
findings documents. High leverage: understanding proven approaches prevents
costly redesigns later.

## Dependencies

| Issue | Relationship |
|-------|-------------|
| **#70** | Fast mode — string/array representation decisions |
| **#74** | SIMD — V8's SIMD string operations as reference |
| **#75** | String views — V8/SM dependent/sliced strings as model |
| **#76** | Rope strings — V8/SM rope implementations as reference |
| **#77** | Object literals — hidden classes/shapes inform struct design |
| **#79** | Gradual typing — value tagging strategies from V8/SM |
