---
name: test-and-merge
description: Test on integrated branch, then merge to main. Any agent can invoke this.
---

# Test and Merge Pipeline

Follow every step in order. Stop on first failure. **All testing happens on YOUR branch, not main.**

## Step 1: Verify state (on your branch)

```bash
pwd
git branch --show-current  # must NOT be main
git status --short         # must be clean
git log --oneline -3       # confirm your commits are here
```

If you're on main or have uncommitted changes, STOP.

## Step 2: Merge main into your branch

```bash
git merge main
```

- **Clean merge**: proceed to Step 3
- **Conflicts**: resolve them yourself, `git add`, `git commit`
- **Cannot resolve**: message tech lead. STOP.

## Step 3: Check RAM

```bash
free -m | awk '/Mem/{print $7}'
```

Need >2GB available. If less, message tech lead and STOP.

## Step 4: Run equivalence tests (ON YOUR BRANCH)

```bash
npm test -- tests/equivalence.test.ts
```

- **All pass** (or same failures as main baseline): proceed
- **New failures**: you introduced a regression. Fix it. Do NOT proceed to main.

## Step 5: Run issue-specific test262 tests (ON YOUR BRANCH)

Compile+run the sample tests from your issue to verify the fix works.

## Step 6: Run full test262 (if touching core codegen)

Only if your changes touch `src/codegen/expressions.ts`, `src/codegen/statements.ts`, `src/codegen/index.ts`, or `src/codegen/type-coercion.ts`:

```bash
pnpm run test:262
```

Pass count must not decrease vs main baseline.

## Step 7: Create test proof

**All tests passed on your integrated branch.** Create the proof file:

```bash
BRANCH=$(git branch --show-current)
cat > /workspace/.claude/nonces/merge-proof.json <<EOF
{
  "branch": "${BRANCH}",
  "timestamp": "$(date -Iseconds)",
  "equiv_passed": true,
  "equiv_failures": "same as main baseline",
  "test262_run": false,
  "notes": ""
}
EOF
```

Set `test262_run` to `true` if you ran full test262. Add pass count in `notes`.

## Step 8: Merge to main

```bash
cd /workspace
git merge --ff-only <your-branch-name>
```

The pre-merge hook validates the proof file exists and is recent. If it blocks: go back to Step 2.

## Step 9: Verify merge

```bash
git diff HEAD~1 --stat
```

Check for unexpected deletions.

## Step 10: Post-merge cleanup

1. Move issue: `mv plan/issues/ready/{N}.md plan/issues/done/`
2. Update `plan/dependency-graph.md`
3. Check `plan/issues/blocked/` for newly unblocked issues
4. Message tech lead: `"Merged #N to main. Tests passed on integrated branch. Post-merge cleanup done."`

## If anything went wrong

- Do NOT force merge
- `cd /workspace && git reset --hard HEAD~1` to undo merge
- Message tech lead
