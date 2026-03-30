---
name: bisect-regression
description: Quickly find which commit introduced a test262 regression using git bisect with automated test.
---

# Bisect Regression

Find which commit introduced a regression using `git bisect` with an automated test script.

## Prerequisites

- Two archived test262 JSONL files: one "good" (higher pass count) and one "bad" (current/lower)
- Or: a known good commit hash and the current HEAD

## Step 1: Identify the regression

```bash
# Compare current vs archived results
python3 -c "
import json, os

current = {}
with open('benchmarks/results/test262-results.jsonl') as f:
    for line in f:
        r = json.loads(line)
        current[r['file']] = r['status']

# Find archived files
archives = sorted([f for f in os.listdir('benchmarks/results')
                   if f.startswith('test262-results-') and f.endswith('.jsonl')])
print('Available archives:', archives)

# Compare with most recent archive
if archives:
    prev = {}
    with open(f'benchmarks/results/{archives[-1]}') as f:
        for line in f:
            r = json.loads(line)
            prev[r['file']] = r['status']

    regressions = [t for t in prev if prev[t] == 'pass' and current.get(t) != 'pass']
    fixes = [t for t in current if current[t] == 'pass' and prev.get(t) != 'pass']
    print(f'Regressions: {len(regressions)}, Fixes: {len(fixes)}')

    # Pick a sample regression test for bisecting
    if regressions:
        print(f'Sample test for bisect: {regressions[0]}')
"
```

## Step 2: Run git bisect with vitest filter

```bash
GOOD="<commit-hash-where-test-passed>"  # e.g., the baseline commit
BAD="HEAD"

git bisect start
git bisect bad $BAD
git bisect good $GOOD

# vitest exits 0 on pass, 1 on fail — perfect for bisect
git bisect run npx vitest run tests/test262-vitest.test.ts -t "<test-name-pattern>"
```

Example with a specific test file:
```bash
git bisect run npx vitest run tests/test262-vitest.test.ts -t "S7.9.2_A1_T6"
```

This binary-searches through commits (~7 steps for 90 commits) and reports the first bad commit.

## Step 3: Analyze the result

```bash
# git bisect will print: "<hash> is the first bad commit"
git show <hash> --stat
git show <hash>
```

## Step 4: Clean up

```bash
git bisect reset
```

## For multiple regression patterns

If different tests regressed from different commits, bisect each pattern separately:

```bash
# Pattern 1: SyntaxError regressions
git bisect start && git bisect bad HEAD && git bisect good $GOOD
git bisect run npx vitest run tests/test262-vitest.test.ts -t "S7.9.2_A1_T6"
git bisect reset

# Pattern 2: null deref regressions
git bisect start && git bisect bad HEAD && git bisect good $GOOD
git bisect run npx vitest run tests/test262-vitest.test.ts -t "RegExp-decimal-escape"
git bisect reset
```

## Tips

- Use `git bisect skip` if a commit doesn't compile at all
- For large regressions (1000+ tests), pick 1 representative per pattern
- Each bisect takes O(log n) steps × test time — keep the test fast
- After finding the bad commit, verify with `git show` and check which files changed
