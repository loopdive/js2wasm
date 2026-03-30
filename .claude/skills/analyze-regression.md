---
name: analyze-regression
description: Compare two test262 result files to find exactly which tests changed status. Use after a test262 run shows unexpected pass count changes.
---

# Analyze Regression

Diffs two test262 JSONL result files to find exactly which tests flipped status.

## Steps

1. List available result archives:
```bash
ls -lt /workspace/benchmarks/results/test262-results*.jsonl | head -10
```

2. Pick the two files to compare (current vs previous):
```bash
CURRENT="/workspace/benchmarks/results/test262-results.jsonl"
PREVIOUS="/workspace/benchmarks/results/test262-results-YYYYMMDD-HHMMSS.jsonl"
```

3. Build status maps and diff:
```bash
python3 -c "
import json
from collections import Counter

current, previous = {}, {}
with open('$CURRENT') as f:
    for line in f:
        r = json.loads(line)
        current[r['file']] = r['status']
with open('$PREVIOUS') as f:
    for line in f:
        r = json.loads(line)
        previous[r['file']] = r['status']

# Find flips
regressions = []  # was pass, now not
fixes = []        # was not pass, now pass
for test in set(current) | set(previous):
    old = previous.get(test, 'missing')
    new = current.get(test, 'missing')
    if old == 'pass' and new != 'pass':
        regressions.append((test, old, new))
    elif old != 'pass' and new == 'pass':
        fixes.append((test, old, new))

print(f'Regressions (pass→fail): {len(regressions)}')
for t, o, n in sorted(regressions)[:20]:
    print(f'  {n:15s} ← {o:15s}  {t}')
if len(regressions) > 20:
    print(f'  ... and {len(regressions)-20} more')

print(f'\nFixes (fail→pass): {len(fixes)}')
for t, o, n in sorted(fixes)[:20]:
    print(f'  {n:15s} ← {o:15s}  {t}')
if len(fixes) > 20:
    print(f'  ... and {len(fixes)-20} more')

# Categorize regressions by new status
regr_cats = Counter(n for _, _, n in regressions)
print(f'\nRegression breakdown: {dict(regr_cats)}')
"
```

4. Report findings:
   - Number of regressions and fixes
   - Top regression patterns (which status did they flip to?)
   - Common file paths (is it one codegen area?)

## Output

Message with: `"Regression analysis: +N fixes, -M regressions. Top pattern: [description]"`
