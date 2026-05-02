---
id: 48
status: planned
created: 2026-05-02
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: false
---

# Sprint 48

**Date**: TBD (follows S47)
**Planned**: 2026-05-02 — seeded from S47 analysis + backlog review

## Goals

1. **IR migration completion** — finish Slice 13d (Array methods) + retire legacy codegen paths freed by Slices 13b-c
2. **int32/uint32 inference** — land #1126 (JS number flow specialization, max-effort senior work)
3. **Conformance** — Function.prototype.bind (#1038, 70 FAIL), iterator CT cluster (#991, #993)
4. **Standalone readiness** — #1094 shrink runtime.ts host boundary (leads to #1099 standalone demo)

## Sprint issues

### Ready

| Issue | Title | Priority | Blocked by |
|---|---|---|---|
| #1233 | IR Phase 4 Slice 13d — Array per-element-type methods through IR | medium | #1238 (S47) |
| #1126 | Infer when JS number flows can be safely lowered to int32 or uint32 | high | — (was S47 carry) |
| #1038 | Function.prototype.bind not implemented (~70 FAIL) | high | — |
| #1236 | Premature i32 specialization for accumulators silently saturates on overflow | high | — |
| #991 | Iterator helper generator-reentrancy tests hit 30s compiler timeout | high | — |
| #993 | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compile timeout | high | — |
| #1094 | Shrink runtime.ts host boundary — compile-away JS semantics | high | — |
| #1199 | perf: linear-memory backing for typed numeric arrays | high | — |
| #1200 | perf: loop-invariant code motion (hoist arr.length out of for conditions) | medium | — |

### Carry from S47 (if not landed)

| Issue | Title |
|---|---|
| #1229 | eval/RegExp LRU cache + peephole rewrite (7 compile_timeouts) |
| #1177 Stage1 | TDZ Stage 1 re-land (blocked — needs senior investigation) |

## Out of sprint (deferred to S49+)

- **#1099** — Standalone execution demo (depends on #1094 fully landing first)
- **#1233 callback methods** (`.map`/`.filter`/`.reduce`) — deferred, integrates with IR closure model
- **Playground mobile layout** (#1237 renamed from #1223) — medium priority UX, not blocking
- **Architecture refactors** (#1095 Instr union, #688 modularize) — low urgency while IR migration is active

## Issue inventory

S48 starts with 9 seeded issues. Capacity: 4 dev agents.

Recommended dispatch (after S47 drains):
- **Senior dev** → #1126 (max-effort int32 inference)
- **Dev** → #1233 (Array IR methods, after #1238 lands in S47)
- **Dev** → #1038 (Function.bind, medium effort)
- **Dev** → #1199 or #991/#993 (linear-memory or CT cluster)
