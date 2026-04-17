# Sprint 8

**Date**: 2026-03-16
**Goal**: Property access, element access, class inheritance, skip filter removal
**Baseline**: ~6,366 pass (from 2026-03-18 run, likely lower on 03-16)

## Issues
- #153, #173, #174 — BigInt cross-type comparison tests
- #204 — Various fixes
- #329, #339, #340, #343, #345, #346 — Runtime failure patterns
- #331 — Strict mode eval/arguments diagnostic suppression
- #337 — Null guards for property/element access
- #344 — Wrapper constructors return primitives
- #350, #351, #353, #354 — Test coverage improvements
- #356, #360 — Remove overly broad skip filters (closure-as-value, JSON.stringify)
- #357 — IIFE and call expression tagged templates
- #358, #359 — Gap coverage issues
- #362 — typeof on member expressions
- #363 — Tagged template .raw property and identity
- #364 — .call()/.apply() on arrow functions and module-level closures
- #365, #366, #370, #372, #374, #376 — Additional gap coverage
- #371 — Compile import.meta expressions
- #373 — Remove outdated loop condition skip filters
- #383 — Downgrade tolerated syntax diagnostics
- #384 — ES2021+ string/array method type declarations
- #387 — Graceful fallback for unsupported assignment targets
- #388, #389 — Element access on externref, class instances
- #390 — Element assignment via __extern_set fallback
- #391 — Downgrade TS7053 index signature diagnostic
- #392 — Graceful fallback for unknown field access on class structs
- #393 — Compound assignment on externref element access
- #395 — Function references callable via closure wrapping
- #396 — Null guards for struct dereference traps
- #397-#407 — Additional fixes and test coverage
- #398 — Inherit parent field initializers and accessors

## Results
**Final numbers**: incremental (no test262 run recorded this day)
**Delta**: 50+ issues resolved, major element/property access improvements

## Notes
- Systematic approach: each fix followed by docs move to done + dependency graph update
- Heavy focus on graceful fallbacks instead of compile errors
- Element access on externref/class/struct types unified

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #407 | Deferred imports module flag error | low | done |

<!-- GENERATED_ISSUE_TABLES_END -->