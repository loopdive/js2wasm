---
name: project_next_session
description: Session state: 15,160 pass after macOS runner repair; Sprint 31 resumed
type: project
---

## Final state (2026-04-01)

**Git:** main at `bd26b5f5`
**Test262:** `15,160 / 48,174` pass (31.5%) from `benchmarks/results/test262-report.json`

### What changed this session
1. **macOS test262 runner repaired**:
   - explicit `esbuild` devDependency
   - native macOS reinstall of `node_modules`
   - portable lock/worktree/esbuild handling in `scripts/run-test262-vitest.sh`
2. **Root-cause fix for fake compile timeouts**:
   - `scripts/compiler-pool.ts` did not call `dispatch()` when the first worker sent `ready`
   - queued jobs could sit idle until the parent 30s timeout fired
   - after the fix, isolated formerly timing-out tests pass in under 1s
3. **Full test262 usable again on macOS**:
   - final run completed all `48,174` tests instead of stalling at startup

### Important conclusion
- The earlier 30s `compile_timeout` pattern on macOS was mostly a **queue-dispatch bug**, not evidence that the compiler itself was hanging on those files.

### Sprint 31 state now
- Already merged on `main`: `#839`, `#866`, `#876`, `#877`
- Next issue in queue: `#854`
- Still risky / redesign-heavy: `#826`, `#862`
- `#822` remains the biggest CE bucket and still needs careful staged work
