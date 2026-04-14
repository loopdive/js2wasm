---
name: Suspended issues stay in plan/issues/
description: When suspending work on an issue, keep the file in plan/issues/ and express its state through frontmatter
type: feedback
---

When suspending work on an issue, the file should stay in `plan/issues/` and its frontmatter should reflect that it is not done.

**Why:** Suspended issues are not done — they need to be picked up again. Keeping a single canonical issue location avoids file moves and stale references.

**How to apply:** When writing `## Suspended Work` to an issue file, keep the file in `plan/issues/` and set a non-done status in frontmatter.
