---
name: test-and-merge
description: Full tester pipeline — merge main into branch, equiv tests, ff-only merge. Invoked by a dedicated short-lived tester agent, not by devs.
---

# Test and Merge Pipeline

**This skill is executed by a dedicated tester agent spawned by the tech lead.**
Devs do NOT run test262 themselves. They signal "ready for test" and the tech lead spawns a tester.

## How it works

1. Dev finishes code → signals tech lead: "branch X ready for test"
2. Tech lead spawns a short-lived tester agent (`isolation: "worktree"`)
3. Tester runs this skill on the dev's branch
4. Tester reports results and terminates (frees ~600MB immediately)
5. Tech lead approves/rejects → dev merges or fixes

**Only one tester runs at a time.** Tech lead queues branches.

---

## Step 1: Verify state (on the dev's branch)

```bash
git branch --show-current  # must be the dev's branch
git status --short         # must be clean
git log --oneline -3       # confirm dev's commits are here
```

## Step 2: Merge main into the branch

```bash
git merge main
```

- **Clean merge**: proceed
- **Conflicts**: report to tech lead — dev must resolve. STOP.

## Step 3: Build compiler bundle from THIS worktree

```bash
npx esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript
```

**Critical: build from the worktree, NOT from /workspace.**

## Step 4: Run equivalence tests

```bash
npx vitest run tests/equivalence/ --reporter=verbose 2>&1 | tail -30
```

- **All pass** (or same failures as baseline): proceed
- **New failures**: report to tech lead. STOP.

## Step 5: Run full test262

```bash
npx vitest run tests/test262-vitest.test.ts --reporter=verbose 2>&1 | tail -20
```

Record the pass count from the output: `Tests X failed | Y passed (Z)`

## Step 6: Report results

Message tech lead:
```
Test262 for branch [name]: [pass] pass / [total] total
Delta from baseline: [+/-N]
Equiv tests: [pass/fail]
Recommendation: MERGE / REJECT
```

## Step 7: If approved — merge to main

```bash
cd /workspace
git merge --ff-only <branch-name>
```

Then post-merge cleanup:
1. `git diff HEAD~1 --stat` — verify no deletions
2. Move issue to done/
3. Update dependency graph

## Step 8: Terminate

Report final status to tech lead and exit. Do not wait for more tasks.

---

## Memory budget

- Tester agent: ~600MB
- Vitest parent: ~600MB
- Vitest fork (48K tests): ~7GB peak
- Total: ~8.2GB
- Requires: shut down idle devs before spawning tester if RAM < 9GB available
