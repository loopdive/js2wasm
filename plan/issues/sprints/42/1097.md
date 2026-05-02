---
id: 1097
title: "Remove stale import-helper generator path in compiler/output.ts"
status: done
created: 2026-04-12
updated: 2026-04-12
completed: 2026-04-14
priority: low
feasibility: easy
reasoning_effort: low
task_type: refactor
language_feature: compiler-internals
goal: maintainability
closed: 2026-04-12
pr: 142
es_edition: n/a
---
# #1097 — Remove stale import-helper generator in output.ts

## Implementation Summary

Removed dead `generateEnvImportLine()` function from `src/compiler/output.ts`.
The new shared-runtime helper (`generateImportsHelper`) fully replaced it.
~200 LOC deleted, no test regressions (delta=0).

## Source

External compiler engineer review (2026-04-12): "compiler/output.ts still contains a large handwritten import-helper generator path that appears unused now that the newer shared-runtime helper is emitted. Keeping obsolete generator logic in a compiler codebase is exactly the kind of entropy that makes future semantics work slower and riskier."

## Problem

`src/compiler/output.ts` contains two import-helper generation paths:
1. **New path** (L122+): `generateImportsHelper()` — emits a clean helper that delegates to the shared `js2wasm` runtime package (`buildImports`, `instantiateWasm`, etc.)
2. **Old path** (L162+): `generateEnvImportLine()` — a large handwritten function that generates inline JS for every individual host import (console stubs, string methods, Math imports, etc.)

The old path appears to be dead code now that the new shared-runtime helper handles all import wiring. It adds ~200+ LOC of maintenance surface for patterns like `if (name === "string_compare") return "string_compare: (a, b) => ..."` that duplicate what runtime.ts already provides.

## Acceptance criteria

- [x] `generateEnvImportLine` removed (confirmed not called from any active code path)
- [x] All existing tests pass
- [x] output.ts reduced by ≥100 LOC
