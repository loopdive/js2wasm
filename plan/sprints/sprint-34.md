# Sprint 34

**Date**: 2026-04-03
**Goal**: Push toward 43% — medium-difficulty high-impact runtime fixes
**Baseline**: 17,583 pass / 43,120 official (40.8%) — post sprint-33

## Context

After sprints 31/35 (CE reduction + incremental fixes) and 33 (benchmark recovery), this sprint targets the medium-difficulty runtime failures that don't require full architectural features.

## Task queue

Issues already completed in sprint 35 are removed. Remaining:

| Order | Issue | Impact | Notes |
|-------|-------|--------|-------|
| 1 | #858 | 182 FAIL | Worker/timeout exits + eval null deref |
| 2 | #863 | 70 FAIL | decodeURI/encodeURI missing |
| 3 | #845 | 340 CE | Misc CE: object literals, RegExp, for-in/of edges (needs architect) |
| 4 | #855 | 210 FAIL | Promise/async error handling |
| 5 | #853 | 58 FAIL | Opaque Wasm objects in for-in/Object.create |
| 6 | #849 | 200 FAIL | Mapped arguments object sync (needs architect) |
| 7 | #822 WI4 | 17 CE | struct.new type stack inference (deferred from s31) |

### Already done (removed from queue)
- ~~#856~~ — done in sprint 35 (ValidateAndApplyPropertyDescriptor)
- ~~#844~~ — done (prior session)
- ~~#831~~ — done in sprint 35 (negative test early error detection)
- ~~#840~~ — done in sprint 35 (array 0-arg)
- ~~#829~~ — done (prior session)

### Stretch / architectural (not in this sprint)
- #797 — Property descriptor subsystem (~5,000 FAIL) — needs full architect spec
- #799 — Prototype chain (~2,500 FAIL) — needs full architect spec
- #831 remaining — yield-as-id, await-as-id patterns (159/242 done, 83 remain)

## Dev paths

**Dev-1**: #858 → #863 → #853 (runtime error fixes)
**Dev-2**: #845 (needs architect first) → #855 → #849

## Expected impact

| Issue | Est. tests fixed |
|-------|-----------------|
| #858 | ~100 |
| #863 | ~50 |
| #845 | ~200 |
| #855 | ~100 |
| #853 | ~40 |
| #849 | ~100 |
| **Total** | **~590** |

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
