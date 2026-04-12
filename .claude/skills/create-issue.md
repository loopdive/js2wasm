---
name: create-issue
description: Create a new issue file from a test262 failure pattern. Includes smoke test, sample extraction, and proper frontmatter.
---

# Create Issue from Failure Pattern

## Input

Describe the failure pattern: error message, test category, approximate count.

## Steps

1. Find the next available issue number:
```bash
ls plan/issues/ready/ plan/issues/blocked/ plan/issues/backlog/ plan/issues/done/ 2>/dev/null | grep -oP '\d+' | sort -n | tail -1
```
Add 1.

2. Find sample test files matching the pattern:
```bash
grep -l "<error pattern>" /workspace/benchmarks/results/test262-results.jsonl | head -5
```
Or search the JSONL:
```bash
python3 -c "
import json
matches = []
with open('benchmarks/results/test262-results.jsonl') as f:
    for line in f:
        r = json.loads(line)
        if '<pattern>' in r.get('error',''):
            matches.append(r['file'])
print(f'Found {len(matches)} matching tests')
for m in matches[:5]:
    print(f'  {m}')
"
```

3. For each sample, extract the relevant source lines from the test file.

4. Write the issue file:
```markdown
---
id: {N}
title: "{description} ({count} tests)"
created: YYYY-MM-DD
updated: YYYY-MM-DD
priority: {high|medium|low}
feasibility: {easy|medium|hard}
depends_on: []
goal: core-semantics
es_edition: {es5|es2015|es2016|es2017|es2018|es2019|es2020|es2021|es2022|es2023|es2024|multi|n/a}
language_feature: {normalized-feature-slug}
task_type: {bug|feature|test|refactor|planning}
---

# #{N} -- {title}

## Problem

{count} tests fail with {error pattern}. {1-2 sentence description}.

### Sample files with exact errors and source

**1. {test name}**
File: `{path}`
Error: `{exact error}`
```js
// Relevant source lines
```
Root cause: {why the compiler produces wrong output}

## ECMAScript spec reference

{Link to the relevant spec section(s) at https://tc39.es/ecma262/}
Example: [§7.1.1 ToPrimitive](https://tc39.es/ecma262/#sec-toprimitive)

If multiple sections apply, list each with a one-line note on which
step or sub-algorithm is relevant to this issue.

## Root cause in compiler

{Which codegen function/file produces this pattern}

## Suggested fix

{High-level approach — specific enough for architect to spec}

## Acceptance criteria

- {specific test files that must pass}
- >={target} of {total} tests fixed
```

Required metadata rules:
- `created` is the first known creation date and should not change later
- `updated` must be bumped whenever the issue meaningfully changes
- `es_edition` should capture the relevant language edition, or `multi` / `n/a`
- `language_feature` should be a stable machine-readable feature or subsystem slug
- `task_type` must be one of `bug`, `feature`, `test`, `refactor`, `planning`

5. Add to dependency graph and backlog.
