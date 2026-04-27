---
name: scratch-cleanup
description: Sweep leaked ad-hoc dev scratch files (check-*.ts, debug-*.ts, test-*-debug.ts, tests/probe-*.test.ts, etc.) into .tmp/ so git status stays clean and token cost per tool call stays low.
---

# Scratch Cleanup

Find all leaked ad-hoc dev scratch files in /workspace, verify they are not legitimate WIP, move them into the gitignored `.tmp/` folder, and verify `.gitignore` patterns cover future leaks.

## When to use

- `git status` in /workspace shows 20+ untracked `check-*`, `debug-*`, `test-*`, `probe-*`, `run-*` files
- Starting a new session and inheriting leaked scratch from prior dev agents
- After an OOM or crash where dev worktrees may have spilled files into the main workspace
- Before running `/compact` or `/session-wrapup` to keep the committed state clean

## Step 1: Verify /workspace/main

```bash
pwd && git branch --show-current
```

Must be `/workspace` on `main`.

## Step 2: Survey untracked non-plan files

```bash
git status --short | grep '^??' | grep -vE '(plan/|\.claude/|test262$|components/)' | head -60
```

Patterns to sweep (all represent ad-hoc debug/probe scripts):

**Root level:**
- `check-*.ts`, `check-*.mts`
- `debug-*.ts`, `debug-*.mts`
- `run-*.ts`, `run*.mjs`, `run-test*.mjs`
- `test-*-debug.ts`, `test-*-main.ts`, `test-on-main*.ts`
- `test-src*.ts`, `test-wat*.ts`
- `test-throws-*.ts`, `test-full-wat-*.ts`, `test-disposable-*.ts`, `test-pr-*.ts`

**Under tests/:**
- `tests/probe-*.test.ts`
- `tests/test-*-debug.test.ts`, `tests/test-*-probe.test.ts`
- `tests/scope-close-*-debug.test.ts`
- `tests/regression-check.test.ts`
- `tests/test-type-mismatch.test.ts`
- `tests/test-pr*-regressions.test.ts`
- `tests/*-debug*.test.ts`

**Preserve (do NOT move):**
- `tests/issue-NNNN*.test.ts` — likely real WIP from a dev; check PR queue before moving
- `plan/**` — planning docs
- `.claude/memory/**` — team memory

## Step 3: Check for false positives

Before moving anything, verify the file is NOT referenced by an open PR:

```bash
for f in <SUSPECT_FILES>; do
  if gh pr list --limit 20 --json files --jq ".[] | select(.files[]?.path==\"$f\") | .number"; then
    echo "  KEEP: $f referenced by open PR"
  else
    echo "  MOVE: $f"
  fi
done
```

For `tests/issue-NNNN*.test.ts` files: additionally check if the issue is currently in-progress and the test file is the dev's WIP (if so, leave it).

## Step 4: Ensure .tmp/ exists

```bash
mkdir -p .tmp
```

## Step 5: Move

```bash
mv <FILES...> .tmp/
ls .tmp/ | wc -l
```

## Step 6: Verify gitignore covers the patterns

```bash
grep -qE '^\.tmp/' .gitignore || echo ".tmp/" >> .gitignore
```

Also verify the root-level and tests/ patterns are in `.gitignore` as a safety net:

```bash
grep -E '^/check-\*\.ts|^/debug-\*|tests/probe-\*' .gitignore
```

If missing, add them. Reference the current working `.gitignore` block:

```
# Dev scratch — ad-hoc probe/debug/repro scripts
.tmp/
/check-*.ts
/check-*.mts
/debug-*.ts
/debug-*.mts
/run-*.ts
/run-*.mts
/run[0-9]*.ts
/run-test*.mjs
/test-*-debug.ts
/test-*-main.ts
/test-on-main*.ts
/test-src*.ts
/test-wat*.ts
/test-throws-*.ts
/test-full-wat-*.ts
/test-disposable-*.ts
/test-pr-*.ts
tests/probe-*.test.ts
tests/test-*-debug.test.ts
tests/test-*-probe.test.ts
tests/scope-close-*-debug.test.ts
tests/regression-check.test.ts
tests/test-type-mismatch.test.ts
tests/test-pr*-regressions.test.ts
tests/*-debug*.test.ts
```

## Step 7: Verify clean state

```bash
git status --short | head -20
```

Should show only the modified `.gitignore` (if you updated it) and any legitimate planning/memory edits.

## Step 8: Commit

```bash
git add .gitignore
git commit -m "chore: scratch cleanup — move leaked dev files to .tmp/

Checklist completed.

Moved N leaked scratch files from /workspace root and tests/ into the
gitignored .tmp/ folder. Updated .gitignore patterns to catch future
leaks automatically.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

Only `.gitignore` needs staging — the moved files are already gitignored and the move itself is invisible to git.

## Notes

- **Never delete without moving first** — the files might contain diagnostic state a dev can recover. Moving to `.tmp/` preserves them while getting them out of git's way.
- **Deleting `.tmp/` is OK** between sessions — nothing committed depends on it.
- **Don't move `tests/issue-NNNN*.test.ts` blindly** — these are often legitimate per-issue test files. Only move if they are clearly `*-debug` or `*-probe` variants.
- **Root cause prevention:** ensure CLAUDE.md tells dev agents to write scratch in `.tmp/` directly. Pattern-based `.gitignore` is a safety net, not a substitute for the convention.
