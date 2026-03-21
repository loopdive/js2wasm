---
name: Nothing is impossible in Wasm
description: Don't label JS features as "impossible to compile to Wasm" — find the compilation strategy instead
type: feedback
---

Never label JS features as "impossible in WasmGC." The project lead pushed back on every "impossible" feature and found viable paths:

- eval → host-side two-stage compilation
- Proxy → type-aware codegen with trap inlining (zero cost for non-proxy code)
- dynamic import → host-side module loading
- with → static AST identifier enumeration

**Why:** "Impossible" closes off thinking. The right question is "what compilation strategy makes this work?" Every JS feature has a path — some via host imports, some via type specialization, some via static analysis.

**How to apply:** When analyzing test262 skips or assessing feasibility, always propose a concrete compilation approach. Use "hard" or "requires host import" instead of "impossible."
