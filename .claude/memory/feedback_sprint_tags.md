---
name: Sprint tagging protocol
description: Tag sprint start and end for timeline/stats generation
type: feedback
---

Tag sprints with two git tags:
- `sprint-N/begin` when starting a sprint
- `sprint/N` when it finishes

**Why:** The sprint-stats.ts script computes duration, commits, and issues from the time between tags. The dashboard timeline and velocity chart depend on these tags.

**How to apply:** At sprint start, run `git tag sprint-N/begin`. At sprint end (after final merge), run `git tag sprint/N` and `git push --tags`.
