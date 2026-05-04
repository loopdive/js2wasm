---
name: Update issue status to in-progress when dispatching
description: Always update issue frontmatter status to in-progress immediately when dispatching an agent to work on it
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
When dispatching a developer agent to an issue, immediately update the issue file's frontmatter `status: ready` → `status: in-progress` and commit it before or alongside the dispatch.

**Why:** The dashboard and issue tracking rely on frontmatter status to show what's in progress. Leaving it as `ready` after dispatch makes the kanban board inaccurate.

**How to apply:** Any time an Agent is spawned for an issue, update the issue file at `plan/issues/sprints/{sprint}/{N}.md` status field to `in-progress` and commit in the same dispatch step.
