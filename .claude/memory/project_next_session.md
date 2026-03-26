---
name: project_next_session
description: 2026-03-26 session state — 15,154 true pass (honest baseline after exception tag fix)
type: project
---

## Current state (2026-03-26)

**Git:** main branch, 9 commits this session
**Latest test262 (clean, correct):** 15,154 pass / 34,681 fail (49,835 total)
**Previous "baseline":** 16,580 was inflated by misclassified exceptions

## Key fix this session
- Exception tag export (#792) — `__exn_tag` now exported so JS host can read exception payloads. This fixed error classification but revealed 1,426 false passes.

## All commits this session
1. 294fb1e2 — null TypeError guards (#775)
2. 78016a71 — arguments externref vec (#771)
3. 8953ac44 — TypeError only on genuine null (#789)
4. c43e9ce0 — SyntaxError early detection (#791)
5. 1482374c — TDZ in closures + for-loop let/const (#790)
6. 0226f60d — memory, devcontainer, plan, test infra updates
7. 500ac958 — propertyHelper.js verifyProperty (#770)
8. 4a2cab21 — skip filter cleanup (#494)
9. 1e53ce79 — export exception tag (#792)
10. strict-runtime merge — onlyStrict "use strict" prefix

## Active team (ts2wasm-sprint)
- dev-770: #511 call/call_ref type mismatches
- dev-661: #661 fallthru type errors
- dev-515: #413 param default self-reference

## Next priorities
- Merge active dev work, measure again
- The honest 15,154 baseline means every future improvement is real
- Top impact areas: wrong return values, missing error throws, null pointer derefs
