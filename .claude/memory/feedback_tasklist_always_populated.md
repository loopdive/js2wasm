---
name: TaskList must always be populated
description: Create TaskList entries at sprint start and immediately whenever new issues are added to a sprint
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Always keep the TaskList populated so agents can self-serve without tech lead dispatch.

**Why:** When the TaskList is empty, idle agents have no way to pick up work and just spin sending idle_notification pings. This breaks the self-serve loop entirely.

**How to apply:**
- At sprint start: create a TaskList entry for every issue in `plan/issues/sprints/{N}/` with `status: ready` before dispatching any agents.
- When a new issue is created mid-sprint and marked `ready`: immediately create a TaskList entry for it.
- When an issue is blocked (depends_on unresolved): still create the task but note the dependency in the description; do not assign it.
- Check TaskList is non-empty before dispatching the first agent of any session.
