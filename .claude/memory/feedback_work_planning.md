---
name: Work planning and coordination improvements
description: Lessons from 2026-03-26 session on team dispatch, task planning, and dev specialization
type: feedback
---

## Task Planning

- **Pre-create 6-8 tasks at session start** — read dependency-graph.md, pick top issues, create full task specs BEFORE spawning devs. Devs should never wait for the TTL to think of the next task.
- **Full context in task descriptions** — include file paths, line numbers, the fix approach, and constraints. Don't just say "see issue #N". The task description IS the spec.
- **Sort by priority and difficulty** — alternate hard/easy so devs don't all block on hard problems.

## Dev Assignment

- Any dev can work on any task (compiler or infra) — don't rigidly specialize.
- Separate by **file locks**, not by role: check which files other devs have claimed and assign non-overlapping work.
- If a dev finishes fast, assign the next task from the queue immediately — don't shut them down.

## Time Boxing

- Hard codegen issues (like #792 multi-struct dispatch): **30 min max**. If not done, report findings and the TTL decides whether to continue or pivot.
- Test infra tasks: **15 min max**. These should be quick wins.

## Merge Batching

- Don't measure after every merge — batch 3-4 merges, then run one clean test262.
- Clear cache before measurement runs (stale cache gave identical results across commits).
- The tester teammate should only be spawned when ready to measure, not idle the whole session.

## Idle Teammate Management

- Don't spawn tester/PO at session start — spawn them on demand when merges are ready or issues need updating.
- Devs that finish fast: have a pre-built task queue so they immediately pick up the next one without TTL intervention.

**Why:** In the 2026-03-26 session, dev-770 churned through 3 small tasks while dev-792 was stuck on one big one. Tasks were created reactively, causing idle cycles. Tester/PO sat idle generating noise until shut down.

**How to apply:** At session start: read issues → create task queue → specialize devs → dispatch. During session: monitor time boxes, batch merges, spawn tester only for measurement.
