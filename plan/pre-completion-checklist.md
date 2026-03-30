# Pre-Completion Checklist

**You MUST read this file and confirm each step before signaling task completion.**

## Before signaling completion

1. [ ] All work is committed to your branch (no uncommitted changes)
2. [ ] `git merge main` — merge main INTO your branch (not rebase)
   - If conflicts: resolve them, `git add`, `git commit`
   - If merge goes wrong: `git merge --abort` (your commits are safe)
   - **Never rebase** — rebase rewrites SHAs and causes branch name churn

## Post-integration test sequence

Tests must run AFTER merging main to catch integration issues. Use the test lock to prevent OOM from parallel test runs.

### Before every test run

3. [ ] Check free RAM: `free -m | awk '/Mem/{print $4}'` — need **>2GB free** to proceed. If <2GB, message tech lead and wait.
4. [ ] Acquire test lock: `mkdir /tmp/ts2wasm-test-lock 2>/dev/null` — if it fails, another agent is testing. Wait and retry.
5. [ ] Message tech lead: `"Running tests for #N"`

### Test sequence (run in order, stop on failure)

6. [ ] **Equivalence tests**: `npm test -- tests/equivalence.test.ts`
   - These must pass. If they fail, you introduced a regression — fix it before continuing.
7. [ ] **Issue-specific test262 tests**: compile+run the specific test262 files your issue targets
   - Verify your fix actually works on the tests from the issue description
8. [ ] **Full test262** (optional but recommended): `pnpm run test:262`
   - **REQUIRES EXTRA COORDINATION** — this uses ~4GB RAM and takes ~2 min. Only one agent may run it at a time.
   - Before starting: message tech lead `"Running full test262 for #N — hold all tests"`
   - Re-check RAM: need **>4GB free**
   - Check for regressions: pass count should not decrease vs main
   - Only run if your changes touch core codegen paths (expressions.ts, statements.ts, index.ts, type-coercion.ts)

### After testing

9. [ ] Release test lock: `rmdir /tmp/ts2wasm-test-lock`
10. [ ] Message tech lead: `"Tests done for #N"`

## Finalize

11. [ ] Issue file updated with implementation notes
12. [ ] Issue status set to `review` in frontmatter
13. [ ] File locks removed from `plan/file-locks.md`

## Signal completion

14. [ ] Final integration check: `git merge main` — no-op if nothing changed, catches main moving during your test run
15. [ ] Message tech lead: `"Completed #N (commit <hash>). Branch integrated with main, tests pass, ready for review."`

## What NOT to do

- Do NOT signal completion before merging main into your branch
- Do NOT use `git rebase` — use `git merge main` instead
- Do NOT ask tech lead/tester to resolve conflicts — you own them
- Do NOT leave uncommitted changes on your branch
- Do NOT run tests in parallel with other agents — use the lock
- Do NOT run tests with <2GB free RAM
