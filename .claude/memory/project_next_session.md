---
name: project_next_session
description: 2026-03-27 session end — 20,162 pass (+2,560 from 17,602 baseline)
type: project
---

## Final state (2026-03-27 ~01:15 UTC)

**Git:** main branch, pushed
**Test262:** 20,162 pass / 29,696 fail (49,858 total, Temporal skipped)
**Pre-session:** 17,602 pass
**Session gain:** +2,560

## Fixes landed
- Exception tag export, catch_all, rethrow (#798a/b/c)
- Property descriptor table, getOwnPropertyDescriptor, freeze/seal (#797a/b/d)
- Struct.new forward type-stack simulation (replaced fragile backward walk)
- TDZ compile-away (static analysis)
- Null guard skip for provably non-null, typeof compile-away (#800)
- Method call fallback reverted from TypeError to externref (fixed -2,281 regression)
- __proto__ field removed (fixed -3,419 regression)
- Cache: bundle-based hash + auto-rebuild
- Test infra: flock, Temporal skip, strict mode skip, private class skip
- Tuple literal type fix for destructuring defaults (#801)

## Top remaining CE patterns
1. not enough arguments (3,492 CE) — struct.new/call arg count
2. expected N elements on stack (2,901 CE) — stack balance
3. call[] type mismatch (2,637 CE) — argument types
4. local.set type mismatch (1,380 CE)

## Top remaining fail patterns
1. gen.next not a function (1,164) — generator runtime
2. illegal cast (1,026) — ref.cast wrong type
3. stack overflow (958) — infinite recursion

## Principles
- Compile away, don't emulate
- No runtime fields on all structs (conditional only)
- TTL runs test262, devs run npm test in worktree + flock
- Bundle-based cache hash, auto-rebuild at import time

## 77 open issues in ready/
