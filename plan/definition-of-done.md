# Definition of Done

An issue is **done** when all of the following are true:

## Code quality
- [ ] Smoke-test confirmed issue was real before work began
- [ ] Code implemented on a feature branch (`issue-{N}-{description}`)
- [ ] Pre-commit checklist followed (see `plan/pre-commit-checklist.md`)
- [ ] No new `as unknown as Instr` casts without justification

## Testing
- [ ] Equivalence tests pass (no regressions introduced)
- [ ] Issue-specific test262 tests pass — results recorded in issue file (`## Test Results` with X/Y pass counts)
- [ ] Branch integrated with current main (`git merge main`, not rebase)
- [ ] Tests re-run after integration (catches merge-induced regressions)

## Merge
- [ ] Merged to main via `git merge --ff-only`
- [ ] No force pushes, no skipped hooks

## Documentation
- [ ] Issue file has `## Implementation Summary` describing the fix
- [ ] Issue file has `## Test Results` with before/after pass counts
- [ ] Issue file moved to `plan/issues/done/`
- [ ] Issue frontmatter updated: `status: done`, `completed: YYYY-MM-DD`

## Bookkeeping
- [ ] `plan/dependency-graph.md` updated (completed issue struck through)
- [ ] Sprint doc updated with result
- [ ] File locks removed from `plan/file-locks.md`
- [ ] Blocked issues checked — newly unblocked issues moved to `ready/`

## What "done" is NOT
- Code committed but not merged
- Tests pass on branch but not after integration with main
- Issue file still in `ready/` or `blocked/`
- "It works on my machine" without recorded test results
