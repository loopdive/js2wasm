---
id: 504
title: "Auto-generated README feature coverage + benchmark tables"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: async-model
depends_on: [501]
files:
  scripts/update-readme.ts:
    new:
      - "auto-generate feature coverage + benchmark tables from test262-report.json and latest.json"
    breaking: []
  README.md:
    new: []
    breaking:
      - "feature table replaced with auto-generated version between marker comments"
---
# #504 — Auto-generated README feature coverage + benchmark tables

## Status: review

README.md has a manually maintained "Supported TypeScript Subset" table (line 142) that's outdated. Create a script that auto-generates it from test results.

## Deliverable: `scripts/update-readme.ts`

### Feature coverage table

Reads `benchmarks/results/test262-report.json`, groups categories into user-friendly feature names, computes pass rates:

```markdown
<!-- AUTO:COVERAGE:START -->
| Feature | Status | Pass | Total | Rate |
|---------|--------|-----:|------:|-----:|
| Math methods | Full | 264 | 273 | 97% |
| Array methods | Partial | 120 | 450 | 27% |
| Classes | Partial | 631 | 4960 | 13% |
<!-- AUTO:COVERAGE:END -->
```

Category mapping:
- `built-ins/Math/*` → "Math methods"
- `built-ins/Array/prototype/*` → "Array methods"
- `language/statements/class` + `language/expressions/class` → "Classes"
- `language/expressions/assignment` → "Assignment & destructuring"
- `language/statements/for` + `for-of` + `for-in` → "Loops"
- `language/expressions/object` → "Object literals"
- `built-ins/String/prototype/*` → "String methods"
- `built-ins/Promise/*` → "Promises"
- `built-ins/JSON/*` → "JSON"
- `built-ins/Map/*` + `built-ins/Set/*` → "Collections (Map, Set)"
- etc.

Status from pass rate: ≥90% "Full", ≥50% "Mostly", ≥20% "Partial", <20% "Basic", 0 pass "Planned"

### Benchmark comparison table

Reads `benchmarks/results/latest.json`:

```markdown
<!-- AUTO:BENCHMARKS:START -->
| Benchmark | JS | Wasm (GC) | Speedup |
|-----------|---:|----------:|--------:|
| fibonacci(35) | 45ms | 12ms | 3.8× |
<!-- AUTO:BENCHMARKS:END -->
```

### README markers

Add `<!-- AUTO:COVERAGE:START -->` / `<!-- AUTO:COVERAGE:END -->` around the existing feature table in README.md. Same for benchmarks section.

### Usage
```bash
npx tsx scripts/update-readme.ts
```

Run after each test262 run or benchmark run to keep README current.

## Complexity: S

## Acceptance criteria
- [x] Script reads test262-results.jsonl and generates feature table
- [x] Script reads latest.json and generates benchmark table (placeholder if absent)
- [x] Patches README.md between marker comments (preserves rest of file)
- [x] Status badges derived from pass rate (Full/Mostly/Partial/Basic/Planned with emoji)
- [x] Idempotent -- running twice produces same result

## Implementation Summary

### What was done
Created `scripts/generate-readme-tables.ts` that:
1. Reads `benchmarks/results/test262-results.jsonl` (per-test JSONL, not the report.json which may be empty)
2. Groups 211 test262 categories into 36 user-friendly feature names using prefix matching
3. Generates a summary table (total/pass/fail/CE/skip counts)
4. Generates a feature coverage table sorted by pass rate, with status badges
5. Generates a benchmark table from `benchmarks/results/latest.json` (graceful fallback if absent)
6. Patches README.md between `<!-- AUTO:COVERAGE:START/END -->` and `<!-- AUTO:BENCHMARKS:START/END -->` markers
7. Auto-inserts markers on first run (replaces old "Supported TypeScript Subset" section)
8. Preserves the "Not Supported" table (var/eval/with)

### Design decisions
- Reads JSONL directly instead of report.json, since the report can be stale/empty
- Skip-filtered tests excluded from "Total" column (only pass+fail+CE counted) to show true pass rate
- Status thresholds: >=90% Full, >=50% Mostly, >=20% Partial, >0% Basic, 0% Planned

### Files changed
- `scripts/generate-readme-tables.ts` (new)
- `README.md` (updated with auto-generated tables)
