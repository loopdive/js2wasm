---
name: project_next_session
description: 2026-03-27 session end — 15,144 pass (+975), depth counter fix, valueOf guard
type: project
---

## Final state (2026-03-27 ~08:30 UTC)

**Git:** main at 11fc02b0, pushed
**Test262:** 15,144 pass / 49,881 total (10,474 skip, 877 CE)
**Session start:** 14,169 → **+975 gain**
**Pre-session:** 17,602 (670 skip)

## Key fixes this session
1. Compilation depth counter with proper decrement (fixed 870 false CEs)
2. valueOf re-entrancy guard in type-coercion.ts
3. Dynamic import() via __dynamic_import host import (#675)
4. Object.defineProperty (#797c), proxy wrappers for structs
5. Iterator protocol (#766), iterator null.next
6. Block-scoped shadowing (#786), rest/spread (#761)
7. SyntaxError detection (#736), RangeError validation (#733)
8. Unbox/coerce (#795), BindingElement (#794), opaque structs
9. Exception tag, catch_all, rethrow, property descriptors, freeze/seal
10. Struct.new rewrite, TDZ/typeof compile-away, dead code elimination

## Still blocking
- String/prototype hang (#816) — ~1,200 tests skipped
- class/elements hang (#793) — ~3,073 tests skipped
- Both need deep profiling to find the recursion loop
- 77 open issues in ready/

## Active devs (may be orphaned)
- dev-regex2: RegExp runtime (#763)
- dev-async: async iteration (#735)
- Both have no code changes — may be stuck

## Principles
- Compile away, don't emulate
- vitest "pass" includes skips — check report JSON
- Don't kill agents without permission
- Test wrapped context before removing skip filters
- Depth counter must decrement (try/finally)
