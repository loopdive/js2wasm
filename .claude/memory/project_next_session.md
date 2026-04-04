---
name: project_next_session
description: Session state — 17,822 pass (41.3%), cache disabled, sprint 36 in progress
type: project
---

## Final state (2026-04-04)

**Git:** main at `448bef79`
**Test262:** `17,822 / 43,120` official pass (41.3%) — cache disabled, honest result
**Report:** `benchmarks/results/test262-report-20260404-033322.json`

### Session totals (sprints 31-36)
- Start: 15,103 pass (35.2%)
- End: 17,822 pass (41.3%)
- Improvement: +2,719 pass (+6.1%)

### Key lesson: cache was hiding truth
- The test262 disk cache caused false baselines (17,782 was cache-inflated)
- Cache now permanently disabled — every test compiled fresh
- Proposals pre-filtered at file level (not just skipped in JSONL)

### Sprint 36 (in progress)
Done: #914, #915, #916, #917, #918, #920, #922, #932, #942, #944
Merging: #921 (test-and-merge script running)
Pending merge: #919, #927, #931
Pending work: #923 (state leakage), #933 (shared charts)
Deferred: #910-#913 (refactoring → sprint 37)

### Sprint 37 (planned)
Property descriptors (#797), prototype chain (#799), runner stability (#943),
compiler state leakage (#923), refactoring (#910-#913).
Target: 55-60% conformance.

### Process changes this session
- test-and-merge.sh replaces tester agents (zero tokens)
- developer.md model: sonnet (was opus)
- senior-developer.md for hard issues (opus + max effort)
- reasoning_effort field in all issue files
- Never dismiss regressions — always bisect
- Cache disabled permanently
