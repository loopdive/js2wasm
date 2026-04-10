---
name: Always run /sprint-wrap-up before closing a sprint
description: Tech lead must invoke the sprint-wrap-up skill before tagging and closing any sprint
type: feedback
---

Always run `/sprint-wrap-up` before closing any sprint — never do it ad-hoc.

**Why:** Sprint 39 was closed with the wrong tag format, no results update in the sprint file, no dep graph update, and no backlog cleanup. The skill has the full checklist.

**How to apply:** When the user says "close sprint N" or "let's wrap up the sprint", invoke `/sprint-wrap-up` first, then follow its checklist step by step before tagging.
