do# Pre-Completion Checklist

**You MUST read this file and confirm each step before signaling task completion.**

## Before signaling completion

1. [ ] All work is committed to your branch (no uncommitted changes)
2. [ ] `git rebase main` — rebase your branch onto current main
   - If conflicts: resolve them, `git add`, `git rebase --continue`
   - If rebase goes wrong: `git rebase --abort` (your commits are safe), retry or ask for help

## Post-rebase test sequence

Tests must run AFTER rebase to catch integration issues. Use the test lock to prevent OOM from parallel test runs.

### Before every test run

3. [ ] Check free RAM: `free -m | awk '/Mem/{print $4}'` — need **>2GB free** to proceed. If <2GB, message tech lead and wait.
4. [ ] Acquire test lock: `mkdir /tmp/ts2wasm-test-lock 2>/dev/null` — if it fails, another agent is testing. Wait and retry.
5. [ ] Message team: `"Running tests for #N"` (so others know to wait)

### Test sequence (run in order, stop on failure)

6. [ ] **Equivalence tests**: `npm test -- tests/equivalence.test.ts`
   - These must pass. If they fail, you introduced a regression — fix it before continuing.
7. [ ] **Issue-specific test262 tests**: compile+run the specific test262 files your issue targets
   - Verify your fix actually works on the tests from the issue description
8. [ ] **Full test262** (optional but recommended): `pnpm run test:262`
   - **REQUIRES EXTRA COORDINATION** — this uses ~4GB RAM and takes ~2 min. Only one agent may run it at a time.
   - Before starting: broadcast `"Running full test262 for #N — hold all tests"` and wait for acknowledgment
   - Re-check RAM: `free -m | awk '/Mem/{print $4}'` — need **>4GB free** (more than scoped tests)
   - If another agent is already running full test262: do NOT start a second one. Wait for them to finish.
   - Check for regressions: pass count should not decrease vs main
   - Only run if your changes touch core codegen paths (expressions.ts, statements.ts, index.ts, type-coercion.ts)

### After testing

9. [ ] Release test lock: `rmdir /tmp/ts2wasm-test-lock`
10. [ ] Message team: `"Tests done for #N"`

## Finalize

11. [ ] Issue file updated with implementation notes
12. [ ] Issue status set to `review` in frontmatter
13. [ ] File locks removed from `plan/file-locks.md`

## Signal completion

14. [ ] Final rebase check: `git rebase main` — no-op if nothing changed, catches main moving during your test run
15. [ ] Message tech lead: `"Completed #N (commit <hash>). Branch is rebased onto main, tests pass, ready for ff-only merge."`

## What NOT to do

- Do NOT signal completion before rebasing
- Do NOT ask tech lead to resolve conflicts — you own them
- Do NOT leave uncommitted changes on your branch
- Do NOT run tests in parallel with other agents — use the lock
- Do NOT run tests with <2GB free RAM
