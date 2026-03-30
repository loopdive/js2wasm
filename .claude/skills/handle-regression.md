---
name: handle-regression
description: Protocol for detecting, isolating, and fixing regressions in test262 pass count. Use when a test run shows fewer passes than expected.
---

# Handle Regression Protocol

Use this when a test262 run shows fewer passes than the baseline or previous run.

## Step 1: Confirm the regression is real

```bash
# Compare current vs archived results
python3 -c "
import json, os
current = {}
with open('benchmarks/results/test262-results.jsonl') as f:
    for line in f:
        r = json.loads(line)
        current[r['file']] = r

archives = sorted([f for f in os.listdir('benchmarks/results')
                   if f.startswith('test262-results-') and f.endswith('.jsonl')])
if not archives:
    print('No archived results to compare. Run was the first.')
    exit()

prev = {}
with open(f'benchmarks/results/{archives[-1]}') as f:
    for line in f:
        r = json.loads(line)
        prev[r['file']] = r

regressions = [(t, prev[t]['status'], current[t]['status'], current[t].get('error','')[:60])
               for t in prev if prev[t]['status'] == 'pass' and current.get(t,{}).get('status') != 'pass']
fixes = [t for t in current if current[t]['status'] == 'pass' and prev.get(t,{}).get('status') != 'pass']

print(f'Regressions: {len(regressions)}, Fixes: {len(fixes)}, Net: {len(fixes) - len(regressions):+d}')

from collections import Counter
patterns = Counter()
for t, old, new, err in regressions:
    if 'SyntaxError' in err: patterns['expected SyntaxError but compiled'] += 1
    elif 'null' in err.lower(): patterns['null deref'] += 1
    elif new == 'compile_error': patterns['new compile error'] += 1
    elif 'returned' in err: patterns['wrong return value'] += 1
    else: patterns[err[:30] or new] += 1

print()
print('Regression patterns:')
for p, c in patterns.most_common(10):
    print(f'  {c:4d}  {p}')

print()
print('Sample regressions (1 per pattern):')
shown = set()
for t, old, new, err in sorted(regressions):
    for p in patterns:
        if p not in shown and p[:15] in (err + new)[:60]:
            print(f'  {t}')
            shown.add(p)
            break
    if len(shown) >= 5: break
"
```

If regressions < 10 and could be flaky tests, re-run test262 to confirm.

## Step 2: Identify which merge caused it

### Option A: git bisect (fast, automated)

```bash
GOOD="<last-known-good-commit>"  # from runs/index.json
BAD="HEAD"

# Pick one sample test per regression pattern
git bisect start
git bisect bad $BAD
git bisect good $GOOD

# Use vitest filter for a specific regressed test
git bisect run npx vitest run tests/test262-vitest.test.ts -t "<test-name>"
# Result: "<hash> is the first bad commit"
git bisect reset
```

Note: git bisect can be confused by merge commits. Use `--first-parent` if results seem wrong, or bisect each regression pattern separately.

### Option B: test at merge boundaries (manual but reliable)

If bisect is unreliable (merge commits), test at each merge point:

```bash
# List code merges between good and bad
git log --oneline --first-parent $GOOD..HEAD | grep -E "feat|fix|Merge"

# For each suspect merge, checkout and test
git stash
git checkout <merge-commit>
npx vitest run tests/test262-vitest.test.ts -t "<test-name>" 2>&1 | grep -E "passed|failed"
git checkout main
git stash pop
```

### Option C: test on dev worktrees (if still available)

```bash
# Each dev's worktree has their code in isolation
git worktree list

# Test the sample on each worktree
for wt in /workspace/.claude/worktrees/*/; do
  echo "=== $(basename $wt) ==="
  cd "$wt" && npx vitest run tests/test262-vitest.test.ts -t "<test>" 2>&1 | grep -E "passed|failed"
done
cd /workspace
```

## Step 3: Reopen issues and resume sprint

For each regression source:

1. **Move the offending issue back from `done/` to `ready/`**:
   ```bash
   mv plan/issues/done/{N}.md plan/issues/ready/
   ```
2. **Update issue frontmatter**: set `status: regression`, add `regression: true`
3. **Add a `## Regression` section** to the issue file (preserve existing `## Implementation Notes`):
   ```markdown
   ## Regression (sprint-{N})

   **Detected**: YYYY-MM-DD via test262 run
   **Tests affected**: N regressions (pattern: ...)
   **Sample test**: test/path/to/regressed-test.js
   **Root cause**: [what the original fix did wrong]
   **Fix approach**: [how to fix without losing the original improvement]
   **Bisect result**: [commit hash] was the first bad commit

   ## Regression Fix

   **Commit**: [hash]
   **What changed**: [description]
   **Test results**: X/Y regressed tests restored, original fix preserved: yes/no
   ```

   The issue file becomes the full history: problem → fix → regression → regression fix.
4. **Update the sprint doc** (`plan/sprints/sprint-{N}.md`): mark the issue as regressed in the task table
5. **Update dependency graph**: re-add the issue as ready
6. **Create tasks** for each regression pattern, referencing the reopened issue

The sprint is NOT done until all regressions are fixed. The sprint results must show pass count >= baseline.

## Step 4: Assign and fix

Each regression pattern may need a different fix. Create one task per pattern:

| Pattern | Count | Likely culprit | Task |
|---------|-------|---------------|------|
| SyntaxError | N | #NNN (try/catch wrapping?) | #task |
| null deref | N | #NNN (cast guards?) | #task |
| new CE | N | #NNN (repair pass?) | #task |

Assign each to a dev. They work in parallel on separate files.

**No dev is released from a regression task without running full test262 and confirming pass count recovery.** "It looks fixed" or "sampled tests pass" is not sufficient — the full suite must run.

## Step 5: Fix and verify

Each dev:
1. Reads the original commit (`git show <hash>`)
2. Understands what the change did and why the regression happens
3. Fixes on their branch — the fix must:
   - Restore the regressed tests to PASS
   - AND preserve the original fix's improvements (don't just revert)
   - If both aren't possible: revert the original and file a new issue for a better approach
4. **Runs full test262 on their integrated branch** (mandatory for regression fixes)
5. Verifies: the specific regressed tests now pass AND the original fix still works
6. Creates test proof, merges via ff-only

## Step 6: Verify full recovery

After all regression fixes are merged:

```bash
pnpm run test:262
```

Compare pass count to the baseline. Must be **>= baseline**. Ideally baseline + genuine fixes.

If pass count is still below baseline after all fixes:
- Investigate remaining regressions (repeat from Step 1)
- If the fix is too complex, revert the original issue and file a new issue with the regression noted
- **The sprint does not close with a net regression**

## Step 7: Update sprint doc

```markdown
## Regression incident

**Detected**: [date]
**Cause**: [which issues]
**Impact**: -N tests
**Resolution**: [what was fixed/reverted]
**Final result**: [pass count after fix, delta from baseline]
**Time spent**: [hours on regression vs productive work]
```

Move fixed issues back to `done/` with the regression notes preserved.

## Prevention (for future sprints)

- **Pre-merge hook requires test proof** — all tests on branch before merging to main
- **Full test262 mandatory for core codegen changes** — not just equiv tests
- **Archive results before every run** — enables diff analysis
- **One merge at a time, test between merges** — catches regressions early when they're small
- **Never stack untested merges** — the sprint-31 regression came from 4 merges without testing between them

## Red flags that indicate a regression source

| Red flag | Likely cause |
|----------|-------------|
| "expected SyntaxError but compiled" | try/catch wrapping catching compile-time errors |
| null deref spike | ref.cast guards silently producing null |
| new CEs in previously-passing tests | repair pass changing correct code |
| tests pass in worktree but fail on main | merge interaction between branches |
