---
name: Sprint wrap-up is not complete until SM retro + diary + status=closed
description: A "record sprint results" commit is not a complete sprint wrap-up — retro, diary entry, and status:closed are all required
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
A sprint is NOT closed by a "record sprint results" commit alone. Sprint 44 was skipped this way — the closing session wrote the commit and pushed the tag, but the SM was never spawned, no retro was written, diary was not updated, and sprint.md status stayed "planned".

**Why:** The session that closes a sprint often runs out of context or time after merging PRs and tagging. The wrap-up steps (SM retro, diary entry, status update) feel like documentation and get deferred — then forgotten across the context boundary.

**How to apply:** At session start, check the previous sprint is fully closed before starting new sprint work (added to session-start-checklist.md item 14). A sprint is only closed when ALL of:
1. `sprint.md` has `status: closed`
2. `plan/log/retrospectives/sprint-{N}.md` exists
3. `plan/diary.md` has a sprint-{N} close entry
4. `git tag sprint/{N}` exists

If any are missing, run `/sprint-wrap-up` before proceeding.
