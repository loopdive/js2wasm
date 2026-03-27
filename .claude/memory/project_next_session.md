---
name: project_next_session
description: 2026-03-27 session state — 20,162 pass after regression fixes, Temporal skipped
type: project
---

## Current state (2026-03-27 ~00:40 UTC)

**Git:** main branch, pushed
**Latest test262:** 20,162 pass / 29,696 fail (49,858 total)
**Pre-session baseline:** 17,602 pass
**Session gain:** +2,560

## Key fixes this session
1. **Regression fix** — reverted unresolvable method call TypeError → externref fallback (+1,709)
2. **Struct.new rewrite** — forward type-stack simulation replaces fragile backward walk
3. **TDZ compile-away** — static analysis skips unnecessary runtime checks
4. **__proto__ field removed** — was added to all structs unconditionally, broke struct.new args
5. **Cache fix** — bundle-based hash + auto-rebuild at import time
6. **Exception tag export** — JS host reads exception payloads correctly
7. **catch_all + rethrow** — foreign JS exceptions caught properly
8. **Property descriptors** — per-shape flags, getOwnPropertyDescriptor, freeze/seal compile-away
9. **Skip filters** — Temporal, strict-mode-only, private class element hangs
10. **Test infra** — flock, auto-rebuild, 10s timeout, devs run npm test in worktree

## Active agents
- dev-arr: #801 array literal type mismatch (537 fail)
- po: plan updates

## Remaining regression
Still -1,099 below adjusted baseline from #775/#789 null guards. These guards throw TypeError on for-of null, element access null, etc. Mostly correct JS behavior but some overcatch.

## Open issues (77 in ready/)
Top priorities: #801 (537 fail), #794 residual, #800 remaining audit items

## Principles established
- **Compile away, don't emulate** — resolve at compile time, zero runtime overhead
- **No host imports for features that can be static** — freeze/seal/typeof/TDZ all compile-time
- **Dynamic proto only when needed** — #802, conditional field, not all structs
