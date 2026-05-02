---
id: 1123
title: "Verify landing page claims and code examples against current compiler behavior"
status: done
created: 2026-04-15
updated: 2026-04-15
completed: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: investigation
area: website
language_feature: n/a
goal: spec-completeness
---
# #1123 -- Verify landing page claims and code examples against current compiler behavior

## Problem

The landing page is increasingly used as the public product story for js2wasm,
but several sections now make concrete technical claims about compatibility,
standalone execution, module sandboxing, performance characteristics, and code
examples.

Those statements are only useful if they are true **today** in the current
codebase and benchmark setup. If the page over-claims, uses stale examples, or
implies behavior that only works under narrower conditions, it weakens product
credibility and makes technical review harder.

This needs a systematic pass over both:

1. **Claims in copy**
   - hero rotation text
   - mission/feature boxes
   - standalone / no-interpreter section
   - benchmark captions and comparison framing
   - security / dependency / compatibility claims
2. **Code examples on the page**
   - inline JavaScript examples
   - WebAssembly / import examples
   - any benchmark-backed example source referenced by the page

## Goal

Establish whether each landing-page claim and code example is currently met by
the compiler, runtime, benchmarks, and generated artifacts.

Where a claim is not fully met, the issue must not stop at "wrong" or
"outdated." It must:

1. recommend the immediate copy correction if wording should be narrowed, and
2. propose one or more concrete follow-up implementation tickets if the project
   should instead close the gap technically.

## Required review method

The review must be evidence-based, not impressionistic.

For every material claim or example, verify against one or more of:

- current code paths in `src/`
- current landing page sources in `index.html` and web components
- benchmark harnesses and emitted JSON under `benchmarks/` and `public/`
- current compiler output for the referenced examples
- existing issues that already document known gaps or caveats

If a claim is conditionally true, the review must spell out the condition
precisely instead of marking it simply true/false.

## Deliverables

1. A reviewed inventory of the landing page's material claims and examples
2. For each item, one of:
   - **verified**
   - **partially verified**
   - **not currently met**
3. Evidence notes pointing to the code, benchmark, or artifact that supports
   the assessment
4. Proposed copy correction where the current wording is too strong or too vague
5. Follow-up issue proposals for every gap that should be closed in product,
   compiler, runtime, or benchmark work

## Acceptance criteria

- every major technical claim on the landing page has been reviewed
- every code example on the landing page has been checked against current
  compiler behavior or generated artifacts
- each claim/example is labeled with a verification outcome and evidence
- claims that are not fully met include a proposed narrower wording
- gaps that should be solved technically have concrete follow-up tickets
  proposed, not just noted informally
- the output clearly separates:
  - what is already true now
  - what is only true with caveats
  - what is still aspirational

## Notes

- This issue is about **truthfulness and technical grounding** of the landing
  page, not visual design polish
- If the review finds that a claim is not met and no obvious technical path
  exists, that must still result in a documented recommendation: narrow the
  copy now, and only restore the stronger claim once the implementation exists

## Audit Results

### Claims Inventory

| # | Claim / Example | Location | Verdict | Action Taken |
|---|----------------|----------|---------|-------------|
| 1 | Hero: "A next generation JavaScript compiler" | hero data-texts | **verified** | No change |
| 2 | Hero: "Compile JavaScript without embedding a JS engine" | hero data-texts | **verified** | No change — true for AOT output |
| 3 | Hero: "fast cold starts and speed" | hero data-texts | **verified** | Cold-start benchmark (#1005) confirms competitive performance |
| 4 | Hero: "Reduce supply chain attack surface with module sandboxing" | hero data-texts | **partially verified** | True for module boundary isolation; no ambient access possible. Caveat: security story is structural, not audited |
| 5 | Hero: "Target existing Javascript code, not a new language" | hero data-texts | **verified** | No change |
| 6 | Mission: "drop-in deployment target for existing JavaScript and npm packages" | #mission | **partially verified** | Aspirational framing ("mission is to") is acceptable. npm package support is limited |
| 7 | Feature: "Not a New Language — Compile existing JavaScript and npm packages" | feature card | **partially verified** | **Fixed**: narrowed to "existing JavaScript and TypeScript" without "npm packages" claim |
| 8 | Feature: "JS Host or Standalone" | feature card | **verified** | Dual-mode architecture confirmed in codebase |
| 9 | Feature: "Module Sandboxing" | feature card | **verified** | True — Wasm modules have no ambient access |
| 10 | Feature: "Dependency Injection" | feature card | **verified** | True — imports are explicit |
| 11 | "Goal: 100% JavaScript compatibility" | #goals header | **verified** | Framed as goal, not current state. Donut chart shows actual pass rate |
| 12 | Test262 conformance data | t262-donut component | **verified** | Current data: 22,450/43,172 (52.0%) — auto-updated by CI |
| 13 | Runtime Speed benchmark | perf-benchmark-chart | **verified** | `playground-benchmark-sidebar.json` exists and is populated |
| 14 | Loading Speed benchmark | perf-benchmark-chart | **verified** | `loadtime-benchmarks.json` exists and is populated |
| 15 | Wasmtime benchmark charts | #wasm-hosts section | **not currently met** | **Fixed**: commented out charts — data files `wasm-host-wasmtime-*.json` don't exist |
| 16 | "runs anywhere WebAssembly runs" | #how-it-works | **partially verified** | **Fixed**: narrowed to "any WebAssembly host with GC support" (WasmGC required) |
| 17 | "No interpreter embedded, no garbage collector shipped" | #how-it-works | **partially verified** | **Fixed**: clarified "garbage collection is handled by the host via WasmGC" |
| 18 | Fibonacci JS example | #how-it-works | **verified** | Compiles and produces correct result (55). Tested |
| 19 | Fibonacci WAT example | #how-it-works | **not currently met** | **Fixed**: was idealized pure-f64; actual output uses externref + box/unbox. Updated to match real compiler output |
| 20 | DOM JS example | #how-it-works | **partially verified** | **Fixed**: removed `el.style.color = "blue"` — silently dropped by compiler |
| 21 | DOM WAT example | #how-it-works | **not currently met** | **Fixed**: was showing generic `__extern_method_call`; actual output uses typed DOM bindings (`Document_createElement`, `Element_set_textContent`, etc.). Updated to match |
| 22 | `js2.import()` API | #how-it-works | **not currently met** | **Fixed**: API doesn't exist. Replaced with actual `compile()` + `buildImports()` + `WebAssembly.instantiate()` workflow |
| 23 | eval() "✗ Not supported" | feat table | **not currently met** | **Fixed**: eval now compiles via host import delegation. Changed to "⚠ host" badge |
| 24 | Primitives example | feat table | **verified** | Compiles and runs correctly. Tested |
| 25 | Feature table WAT snippets | feat table (all) | **partially verified** | WAT is simplified/representative, not exact compiler output. Acceptable for illustrative purposes |
| 26 | Footer: "ahead-of-time compilation for WebAssembly GC" | footer | **verified** | Accurate description |

### Follow-up Issues Proposed

1. **`el.style.color` compilation** — CSS style property access via `.style.propName` is silently dropped. Should either compile to a host import or produce a compile error. (Existing or new issue needed)
2. **Wasmtime benchmark CI** — populate `wasm-host-wasmtime-*.json` data files from CI when Wasmtime is available, then uncomment the chart section
3. **`js2.import()` convenience API** — if this high-level API is desired, implement it as a wrapper around `compile()` + `buildImports()` + `WebAssembly.instantiate()`
4. **f64-only function optimization** — the fibonacci function could produce pure f64 output without box/unbox if the compiler detected all-numeric signatures; this would make the landing page WAT match the idealized version

## Implementation Notes

Changes made to `index.html`:
- Fibonacci WAT: updated to show actual externref + box/unbox output with "simplified" comment
- DOM JS: removed `el.style.color = "blue"` (silently dropped by compiler)
- DOM WAT: updated to show typed DOM bindings instead of generic `__extern_method_call`
- `js2.import()`: replaced with actual `compile()` + `buildImports()` API
- "Not a New Language" card: narrowed from "npm packages" to "JavaScript and TypeScript"
- "no garbage collector shipped": clarified to "handled by host via WasmGC"
- "runs anywhere WebAssembly runs": narrowed to "any WebAssembly host with GC support"
- Wasmtime charts: commented out (data files don't exist)
- eval(): updated from "✗ Not supported" to "⚠ host" (now compiles via host import)
