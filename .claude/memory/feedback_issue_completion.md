---
name: Issue completion procedure
description: When a developer agent completes an issue, what to do — move file, update frontmatter, write implementation summary, log completion, check test results. Also covers issue frontmatter format and file locking.
type: feedback
---

## Issue Frontmatter Format

Every open issue file (in `ready/` or `blocked/`) has YAML frontmatter:

```markdown
---
created: 2026-03-12
updated: 2026-03-12
priority: high          # critical, high, medium, low
depends_on: [317, 321]  # issue numbers that must be done first ([] if none)
es_edition: es2020      # or multi / n/a
language_feature: regexp
task_type: bug          # bug, feature, test, refactor, planning
files:                   # source files this issue needs to modify
  - src/codegen/expressions.ts
  - src/codegen/index.ts
---
```

The `files` field serves as a **lock claim**. Before a developer agent starts work:
1. Check all other in-progress issues' `files` lists
2. If any overlap, the developer must wait or request access from the PO
3. Only the PO can grant concurrent access to the same file

The `generate-graph.ts` script reads this frontmatter to build `graph-data.json` for the HTML visualizer.

## Issue Completion Procedure

When a developer agent finishes an issue, the following steps must be performed:

### 1. Move the issue file
- Move from `plan/issues/ready/{N}.md` to `plan/issues/done/{N}.md`
- If it was in `blocked/`, move to `done/` (it was unblocked and completed in one go)

### 2. Add/update frontmatter
Add `completed:` date to the existing frontmatter:

```markdown
---
created: 2026-03-12
updated: 2026-03-20
priority: high
depends_on: [317, 321]
es_edition: es2020
language_feature: regexp
task_type: bug
files:
  - src/codegen/expressions.ts
completed: 2026-03-12
---
```

### 3. Write implementation summary
Append an `## Implementation Summary` section to the issue file with:
- **What was done**: brief description of the approach taken
- **What worked**: key decisions that went well
- **What didn't work**: approaches that were tried and abandoned, and why
- **Files changed**: list of modified files
- **Tests**: which tests now pass that didn't before (equivalence tests, test262 categories, etc.)

### 4. Update the completion log
Add a row to `plan/issues/done/log.md`:

```
| {N} | {date} | {title} | {summary of what was done} |
```

### 5. Check for unblocked issues
Look at `plan/issues/blocked/` for any issues that list `#{N}` as a dependency.
If all their dependencies are now in `done/`, move them to `ready/`.

### 6. Regenerate graph
Run `npx tsx plan/generate-graph.ts` to update the visualization data.
