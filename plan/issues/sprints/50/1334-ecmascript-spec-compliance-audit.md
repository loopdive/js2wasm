---
id: 1334
sprint: 50
title: "ECMAScript spec compliance audit: section-by-section review, gap issues, HTML report"
status: done
created: 2026-05-08
updated: 2026-05-08
completed: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: max
task_type: meta
area: compliance, documentation
language_feature: all
goal: npm-library-support
---
# #1334 — ECMAScript spec compliance audit

## Outcome

Completed in PR #260 (branch `issue-1328-spec-audit`).

- **82 spec sections** audited under `spec-compliance/` (≥50 required)
- **5 conforming** ✅ / **54 partial** ⚠️ / **20 not implemented** ❌ / **1 N/A** ➖ (with-statement only)
- **18 gap issues filed** at #1335..#1352 (≥10 required)
- **5 backlog issues filed** at #1353..#1357 for sections currently lacking implementation
  (Memory Model, SharedArrayBuffer/Atomics, Proxy, ShadowRealm, AbstractModuleSource)
- HTML report at `public/benchmarks/spec-compliance.html` (filterable, linked from landing page footer + conformance dashboard)
- Test262 totals as of audit: 28,116 / 48,171 = 58.4% pass

See PR #260 for the full delta. This meta-issue is closed; follow-up work is tracked
in #1335..#1357.

## What this produces

A machine-readable + human-readable audit of which ECMAScript spec sections js2wasm
correctly implements and which it does not, with actionable issues filed for every gap.

## Deliverables

### 1. Per-section compliance docs: `spec-compliance/{section-id}.md`

One file per spec chapter / sub-clause. Example layout:

```
spec-compliance/
  06-ecmascript-data-types.md
  07-abstract-operations.md
  07.1-type-conversion.md
  07.1.1-toprimitive.md
  ...
  23-keyed-collections.md
  23.1-map-objects.md
  ...
```

Each file contains:
- **Section title** + link to tc39.es/ecma262/#sec-...
- **Status**: `✅ conforming` / `⚠️ partial` / `❌ not implemented` / `➖ not applicable`
- **Evidence**: which test262 categories cover it, current pass/total from
  `benchmarks/results/test262-current.jsonl`
- **Gap description**: what's missing or wrong (if not conforming)
- **Issue filed**: link to the sprint 50 issue created to fix the gap (if applicable)

### 2. Summary index: `spec-compliance/summary.json`

Hierarchical JSON mirroring the spec chapter structure:

```json
{
  "title": "ECMAScript 2026 Compliance",
  "generated": "2026-05-08",
  "pass": 42,
  "partial": 18,
  "fail": 31,
  "na": 12,
  "sections": [
    {
      "id": "sec-7.1",
      "title": "Type Conversion",
      "status": "partial",
      "pass": 5, "total": 8,
      "sections": [
        { "id": "sec-7.1.1", "title": "ToPrimitive", "status": "conforming", ... },
        { "id": "sec-7.1.4", "title": "ToNumber", "status": "partial", ... }
      ]
    }
  ]
}
```

### 3. HTML report: `public/benchmarks/spec-compliance.html`

Static HTML+JS (no framework) that renders `summary.json` as a collapsible tree:

- Chapter-level accordion: green/yellow/red indicator + X/Y count
- Expand → sub-clauses with status icons
- Click any non-conforming row → opens the corresponding `spec-compliance/{section}.md`
  on GitHub
- Summary bar at top: total `pass / total` + percentage

### 4. Sprint 50 issues for every gap

For each spec section marked `partial` or `not implemented`, the architect files a
follow-up issue in `plan/issues/sprints/50/` (or backlog if too large for sprint 50)
with:
- Problem: what the spec requires
- Acceptance criteria: what test262 tests must pass
- Files to modify

## Workflow for the architect agent

1. **Fetch the spec index** from `https://tc39.es/ecma262/` — extract the chapter/section
   hierarchy (sections 1-29, subclause IDs like `sec-7.1.1-toprimitive`).

2. **For each chapter** (working from most-impactful first: 7, 10, 12-15, 19, 21-27):
   a. Read the spec section text (fetch from tc39.es/ecma262/#sec-…)
   b. Map to test262 categories using `tests/test262-runner.ts` `TEST_CATEGORIES` list
   c. Count pass/total from `benchmarks/results/test262-current.jsonl` for those categories
   d. Read relevant compiler source (`src/codegen/`, `src/ir/`, `src/runtime.ts`) to
      understand current implementation depth
   e. Write `spec-compliance/{section-id}.md`
   f. Append entry to `summary.json`
   g. If gap found: file issue in sprint 50 (or backlog)

3. **Build HTML report** from `summary.json`.

4. **Commit everything** to a branch and open a PR.

## Priority order for sections

Focus on sections with the most test262 test coverage first (highest impact):

1. §7 Abstract Operations (ToNumber, ToString, ToPrimitive, ToBoolean, etc.)
2. §10 Ordinary and Exotic Objects Behaviours
3. §12-§14 Statements and Declarations  
4. §15 ECMAScript Language: Functions and Classes
5. §21 Text Processing (RegExp, String methods)
6. §22 Indexed Collections (Array, TypedArray)
7. §23 Keyed Collections (Map, Set, WeakMap, WeakSet)
8. §24-§26 Structured Data, Control Abstraction (Promise, generators), Reflection
9. §19 The Global Object

## Files to create/modify

- New: `spec-compliance/` directory with per-section `.md` files
- New: `spec-compliance/summary.json`
- New: `public/benchmarks/spec-compliance.html`
- New issues: `plan/issues/sprints/50/13{29,30,...}-spec-gap-*.md` (one per gap found)
- Update: `plan/issues/backlog/backlog.md` if any gaps are too large for sprint 50

## Acceptance criteria

1. `spec-compliance/summary.json` exists with ≥50 section entries covering the major
   chapters
2. Each `spec-compliance/{id}.md` includes status, evidence, and issue-link (if applicable)
3. `public/benchmarks/spec-compliance.html` renders the tree correctly
4. ≥10 follow-up issues filed for the highest-impact gaps found
5. The report is reachable from the benchmarks landing page (add link to
   `public/benchmarks/report.html` or `dashboard/index.html`)

## Notes

- Use `tc39.es/ecma262/` as the authoritative spec source. The page is a single-page app
  but spec sections are addressable via `#sec-<name>` anchors. Use `WebFetch` to retrieve
  individual sections.
- `benchmarks/results/test262-current.jsonl` has 48,171 entries — stream it, don't load
  entirely into memory.
- Start with the highest test-count categories to maximize issue impact per hour.
- This is an architect task: do NOT implement fixes in this issue. File issues, write docs.
