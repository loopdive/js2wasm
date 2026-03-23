# Goal: spec-completeness

**The long tail: metaprogramming, Temporal, SharedArrayBuffer, Proxy, eval, and all remaining edge cases.**

- **Status**: Blocked
- **Phase**: 5 (long tail after all other conformance goals)
- **Target**: 90%+ pass rate. Fix remaining edge cases across all categories.
- **Dependencies**: `async-model`, `symbol-protocol`, `builtin-methods`, `property-model`

## Why

After the major feature areas are correct, what remains is the long tail of
spec compliance: Proxy traps, eval/Function() edge cases, Temporal API,
SharedArrayBuffer, and thousands of edge-case tests. This is where the
pass rate goes from "good" to "excellent."

## Issues

| # | Title | Impact | Priority |
|---|-------|--------|----------|
| **696** | Classify "other fail" runtime errors (4,649) | 4,649 FAIL | Critical (triage) |
| **727** | Sub-classify assertion failures (wrong values) | 11,480 FAIL | High (analysis) |
| **661** | Temporal API via polyfill | 1,128 tests | Medium |
| **674** | SharedArrayBuffer / Atomics | 493 tests | Medium |
| **671** | with statement support | 272 tests | Low |
| **498** | Proxy full support | — | Medium |
| **496** | eval/Function() edge cases | — | Medium |
| **497** | Dynamic import() edge cases | — | Medium |
| **310** | Reduce skip filters — re-evaluate conservative skips | — | Medium |
| **491** | Remove stale null/undefined filter | — | Medium |
| **494** | Remove stale skip filters | — | Medium |
| **500** | Remove cross-realm filter | — | Low |
| **671** | with statement support | — | Low |
| **674** | SharedArrayBuffer and Atomics | — | Low |
| **696** | Classify "other fail" runtime errors | 4,649 FAIL | High |

## Success criteria

- "Other fail" errors classified and top categories fixed
- Proxy traps work for common patterns
- eval() and new Function() handle edge cases
- Skip filter count minimized — only genuinely unsupported features skipped
- Pass rate ≥ 90%
