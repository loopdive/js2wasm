# js2wasm Team Specification

## Roles

### Product Owner (PO)
Owns the backlog and sprint lifecycle. Communicates progress to the stakeholder.

**Responsibilities:**
- Create and refine issues in `plan/issues/*.md`
- Maintain `plan/backlog.md` — move items between Backlog, Sprint, and Completed
- Define sprints by selecting ~30 issues from the Backlog into a new Sprint section (status: Open)
- Review completed work (status: Review → Done) once all sprint items reach Review
- Report sprint results to the stakeholder (the user)
- Trigger deployment after all tests pass
- Plan the next sprint iteratively based on test results and stakeholder feedback

### Developer
Implements features and fixes. Works in isolation to avoid conflicts.

**Responsibilities:**
- Claim Open tasks from the current sprint
- Work in a **separate git worktree** on a new branch (`issue-{N}-{short-description}`)
- Update issue status: Open → In Progress → Review
- Push the branch and create a GitHub PR when implementation is complete
- Update the issue `.md` with implementation notes and the PR link

## Sprint Lifecycle

```
Planning → Open → In Progress → Review → Done → Deploy → Next Sprint
```

1. **Planning**: PO selects ~30 issues from Backlog, moves them to Sprint N (status: Open)
2. **Open**: Developer claims tasks, begins work
3. **In Progress**: Developer actively implementing in worktree branch
4. **Review**: Developer done, PR created, CI runs test262, PO reviews
5. **Done**: PO approves after PR checks pass or are explicitly overridden, issue closed
6. **Deploy**: All sprint items Done + tests pass → deployment
7. **Next Sprint**: PO plans next batch based on results

## Conventions

### Issue format (`plan/issues/{N}.md`)
```markdown
# Issue #N: Title

## Status: backlog|open|in-progress|review|done

## Summary
Brief description of the feature or bug.

## Scope
Files and areas affected.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

### Backlog format (`plan/backlog.md`)
```markdown
## Sprint N (current)
| # | Feature | Status | Assignee |
| - | ------- | ------ | -------- |

## Open issues (backlog)
| # | Feature | Complexity | Tests blocked |
| - | ------- | ---------- | ------------- |

## Completed
| # | Feature | Tests |
| - | ------- | ----- |
```

### Branch naming
`issue-{number}-{short-description}` (e.g., `issue-138-fix-comparison-ops`)

### PR format
- Title: `feat|fix|refactor: description (#issue)`
- Body: Summary, scope, test results
