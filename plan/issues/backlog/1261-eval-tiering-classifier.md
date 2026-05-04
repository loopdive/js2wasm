---
id: 1261
title: "eval tiering: classify eval sites into 5 tiers at compile time"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, type-analysis
language_feature: eval, strict-mode
goal: performance
required_by: [1262, 1263, 1264, 1265]
---
# #1261 — eval tiering: classify eval sites into 5 tiers at compile time

## Problem

`eval` is currently treated as a single undifferentiated worst-case scenario. The actual impact on optimization ranges from zero (no eval in module) to severe (direct sloppy-mode eval). A tiered classification at compile time lets each tier apply exactly the right optimization overhead — nothing more.

## The 5 tiers

| Tier | Description | Optimization impact |
|------|-------------|---------------------|
| 1 | No eval anywhere in module | Full optimization, direct calls, unboxed locals |
| 2 | `eval("static string literal")` | Compile as regular code at compile time, zero runtime impact |
| 3 | Indirect eval `(0,eval)(...)` | Global scope only; locals unaffected; funcref indirection only for global fns in sloppy mode |
| 4 | Direct eval in strict mode | No function replacement; locals stay unboxed; shadow scope + null-check deopt (see #1264) |
| 5 | Direct eval in sloppy mode | Full boxing + mutable funcref globals for function replacement (see #1265) |

**Key insight**: TypeScript and ESM are always strict mode (tier 4 at worst). The worst case (tier 5) only applies to legacy sloppy-mode scripts — an increasingly rare target.

## Work

- Add `classifyEvalTier(sourceFile: ts.SourceFile): EvalTier` in `src/codegen/index.ts`
  - Scan for `eval(...)` call expressions
  - Detect strict mode: `"use strict"` directive, `.ts` extension, `.mjs`/ESM
  - Classify indirect vs direct eval via the callee shape
  - Classify string literal argument (tier 2)
- Expose `evalTier` on `ModuleContext` for downstream use by #1262–#1265
- Tier 1: already the default; make it explicit so we can assert no eval-related overhead fires

## Acceptance criteria

1. `classifyEvalTier` correctly returns tiers 1–5 for representative inputs (test in `tests/eval-tiering.test.ts`)
2. TypeScript source files always classify as tier ≤ 4 (strict mode assertion)
3. No behavior change — classification is read-only at this stage; actual optimization gating lands in follow-up issues

## Depends on

None — standalone analysis pass.

## Note on existing work

- **Tier 2 (static literal)** is already implemented via #1163 (done). #1261 should recognize it and skip any redundant handling.
- **Tier 3–5 scope boxing** is genuinely new — not covered by #1164 (runtime eval) or #1102/#1066 (standalone mode). Those address *how eval executes code*, not *how the surrounding scope is protected*.

## Unblocks

#1263, #1264, #1265, #1266
