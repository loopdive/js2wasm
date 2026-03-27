---
name: project_next_session
description: 2026-03-27 — 15,380 real pass, 4 devs working, patches saved
type: project
---

## Current state (2026-03-27 ~03:00 UTC)

**Git:** main at 25c23920, pushed
**Test262 (real):** 15,380 pass / 49,861 total (6,177 skip, 693 CE)
**Pre-session:** 17,602 — still regressed by -1,769 from null guards

## Active devs (team ts2wasm-w6, may be orphaned)
- dev-regress: fixing -617 regression (#815) — 44 ins / 254 del in stack-balance.ts + expressions.ts
- dev-rest: rest/spread destructuring (#761) — 84 ins across 3 files
- dev-syntax: SyntaxError gaps (#736) — 211 ins in compiler.ts
- dev-cast2: illegal cast (#778) — 22 ins

## Patches saved at /tmp/patch-final-*.diff (847 lines total)
If agents get killed, apply: `git apply /tmp/patch-final-*.diff`

## CRITICAL: vitest "pass" includes skips
Always check report JSON for real numbers, not vitest summary.

## Sprint plan: plan/sprint-current.md
Wave 1 done (#812, #813, #814). Wave 2 in progress (#789, #766, #761, #737, #733, #736, #778).

## What was accomplished this session
- Exception tag export, catch_all, rethrow
- Property descriptors, freeze/seal, getOwnPropertyDescriptor (compile-away)
- Struct.new forward type-stack simulation
- TDZ compile-away, typeof compile-away
- Dead code elimination
- Local.set type coercion post-pass
- Cache fix (bundle-based hash + auto-rebuild)
- Method call fallback reverted (fixed -2,281 regression)
- __proto__ field removed (fixed -3,419 regression)
- Test infra: flock, Temporal skip, statusline fixes
