---
name: conflict_resolution_opus
description: Merge conflict resolution in compiler source files must be delegated to a senior-developer (Opus) agent, not handled inline by Sonnet
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Dispatch conflict resolution in compiler source files to a `senior-developer` agent (Opus model), not Sonnet inline. Use the TaskList priority queue for dispatch — do NOT block the tech lead on resolution.

**Why:** Resolving conflicts in codegen, compiler, and type files requires deep understanding of the compiler's invariants. Sonnet may make plausible-looking but subtly wrong resolutions that pass equivalence tests but break edge cases. Opus has the reasoning depth for this.

**How to apply:** Conflicts are resolved BEFORE opening a PR (dev merges `origin/main` into branch as the first step of completion):
1. Planning artifact conflicts (`dashboard/`, `plan/`, `public/graph-data.json`) → `git checkout --theirs` + `pnpm run build:planning-artifacts`
2. Compiler source conflicts (`src/**/*.ts`) → create a **priority TaskList item** at the top of the queue:
   - Subject: `[CONFLICT] Resolve merge conflicts on <branch>: <file1>, <file2>`
   - Body: list each conflicted file, describe both sides, note which tests to run (equiv), push + open PR when done
   - Assign to `senior-developer` agent (Opus model)
   - Blocking dev waits for Opus to resolve before opening PR — do NOT open PR with unresolved conflicts
3. After conflicts are resolved and PR is open: dev monitors `.claude/ci-status/pr-N.json` for CI result, then self-merges via `gh pr merge --admin --merge` when `net_per_test > 0` and SHA matches
