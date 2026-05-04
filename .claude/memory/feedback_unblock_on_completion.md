---
name: feedback_unblock_on_completion
description: After each issue is marked done, check if it unblocks dependent backlog/sprint issues and flip their status to ready
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
After every issue is marked `status: done` (post-merge), check `plan/issues/backlog/` and current sprint for issues whose `depends_on` lists the completed ID. If found and their status is `blocked` or `backlog`, flip to `ready`.

`depends_on` stays as structural documentation — never remove it. Only the `status` changes.

**Why:** Issues sit as `blocked`/`backlog` long after their dependencies land. Without active unblocking, the backlog grows stale and devs miss ready work.

**How to apply:** In the post-merge checklist (after setting `status: done` in the issue file and updating the dependency graph), run a quick grep for the completed issue ID in `depends_on` fields across backlog and current sprint:
```bash
grep -rl "depends_on.*<ID>" plan/issues/backlog/ plan/issues/sprints/<current>/
```
Then flip any `status: blocked` or `status: backlog` to `status: ready`.
