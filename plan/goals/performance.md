# Goal: performance

**Generated Wasm is fast: type flow analysis eliminates externref overhead, monomorphization specializes hot paths.**

- **Status**: Activatable (independent of conformance)
- **Target**: Competitive with JIT-compiled JavaScript for typed code.
- **Dependencies**: `core-semantics` (need correct output to optimize)
- **Track**: Parallel — does not block conformance goals.

## Why

Currently every value flows through `externref` with boxing/unboxing overhead.
Whole-program type flow analysis can prove that many functions only receive
specific types (f64, i32, string), enabling native-typed parameters and
eliminating the externref roundtrip.

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **743** | Whole-program type flow analysis | Foundation for optimization | Critical (XL) |
| **760** | Monomorphize functions with call-site types | Native arithmetic | High (Hard) |
| **744** | Function monomorphization for polymorphic sites | Specialized copies | High (Hard) |
| **685** | Interprocedural return type flow | Perf + correctness | Medium |
| **686** | Closure capture type preservation | Perf | Medium |

## Success criteria

- Functions called only with known types compile without externref parameters
- Polymorphic functions get specialized copies (up to 4 per function)
- Binary size does not increase >20% from monomorphization
- Measurable speedup on numeric benchmarks
