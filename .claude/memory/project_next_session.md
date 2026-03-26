---
name: project_next_session
description: 2026-03-26 session state — 20+ fixes landed, run test262 to measure, continue crash-free + core-semantics
type: project
---

## Current state (2026-03-26)

**Git:** main branch, many commits since last verified test262 run
**Last verified test262:** 16,187 pass / 1,761 CE (before this wave)
**This wave:** 20+ commits landed, NOT yet measured with test262

## Commits landed this wave (need test262 verification)

### Crash-free goal
- c34744ef — TypeError for destructuring null/undefined (#783)
- ba053f40 — detect JS undefined in destructuring defaults (#782)
- dc8dd4a8 — __async_iterator for for-await-of (#781)
- 3ab9b8b7 — null guards for array/object method dispatch (#780)
- e4941684 — null guards for for-of array/string struct.get (#785)
- 4e034a13 — ref.test guards before ref.cast (#512)
- bcca88b8 — null deref residual — closure + vec (#441)
- 36653e19 — TypeError for nested destructuring null (#730)

### Core-semantics goal
- 826e9719 — NaN sentinel for f64 default params (#787)
- 9f646920 — generator return value buffering (#729) ⚠️ 1 regression
- 929d121d — param destructuring defaults in closures
- c1c013d0 — AnyValue unboxing fix (boolean/undefined) (#786)

### Error-model goal
- 610e1fe5 — early error checks: rest, await, yield, strict words (#784)
- RangeError validation for Array/toString/toFixed (#733)

### Property-model / builtin-methods
- 832b2ca7 — hasOwnProperty correctness (#732)
- 8d17e2d8 — function.name property (#731)
- 4c32461d — Array method improvements (#734)
- 99709f88 — instanceof host fallback (#738)
- 2690afc8 — type coercion paths (#315)

## Known regressions
- 9f646920 (generator return) introduced +1 net regression in equivalence tests
- e4941684 through 4e034a13 introduced +3 net regressions (not bisected)

## Goal status (updated by PO)
- **compilable:** substantially complete (94.4%)
- **crash-free:** near complete — only #775 remains
- **core-semantics:** active — #771, #786 remaining
- **error-model:** active — #736, #733, #402, #721 remaining
- **property-model:** activatable
- **class-system:** activatable
- **builtin-methods:** activatable (~70%)

## Next steps
1. `pnpm run test:262` — measure all 20+ commits (default 3 workers)
2. Bisect the 4 regressions (9f646920 + e4941684-4e034a13)
3. Continue on core-semantics (#771 arguments, #513 wrong values)
4. Start property-model and class-system (now unblocked)
5. All agents as teammates (TeamCreate), file locks via plan/file-locks.md
6. See plan/team-setup.md for memory budget and agent limits
