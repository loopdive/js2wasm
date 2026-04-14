---
name: sprint-planning
description: Collaborative sprint planning — validate issues, prioritize, get architect/SM input, create task queue. Any agent can facilitate.
---

# Sprint Planning

Facilitates sprint planning as a collaborative process. Can be run by the tech lead, PO, or any agent.

## Participants

Planning should involve multiple perspectives. If dedicated agents are spawned, message them. If not, invoke the relevant skills inline:
- **PO perspective**: prioritize by value, write acceptance criteria
- **Architect perspective**: feasibility assessment, specs for hard issues (use `/architect-spec`)
- **SM perspective**: process constraints from last retro, capacity limits
- **Dev perspective**: estimate effort, flag risks

## Step 1: Read current state

```bash
# Check baseline
cat plan/issues/{N-1}/sprint.md | grep "Final numbers"

# Check what's ready
rg -l '^status: ready$' plan/issues/*.md

# Check dependency graph
cat plan/log/dependency-graph.md

# Check last retro for process constraints
cat plan/issues/{N-1}/sprint.md | grep -A 3 "Action items"
```

## Step 2: Validate candidate issues

For each high-priority issue, smoke-test against current main (use `/smoke-test-issue`):
- **Still fails**: candidate for sprint
- **Already passes**: close it, mark it done
- **Partially fixed**: update issue with current status

## Step 3: Prioritize by value

Order candidates by impact × unblocking potential, not just CE/FAIL count:
- Which fixes unblock the most downstream work?
- Which affect the most test categories?
- Which are quick wins vs deep investigations?

## Step 4: Assess feasibility

For each candidate:
- **Easy** (< 50 lines, clear fix): dispatch directly to dev
- **Medium** (< 150 lines, known approach): dispatch with guidance in task description
- **Hard** (> 150 lines, unclear approach, core codegen): invoke `/architect-spec` first, dispatch only after spec is written

## Step 5: Check capacity

- Max 3 dev agents (16GB RAM constraint)
- 1 task per dev at a time (wait for merge before next)
- Account for merge/test cycle time (~10-15 min per task)
- Typical sprint: 6-10 tasks across 2-3 devs

## Step 6: Create task queue

For each selected issue, create a task via `TaskCreate`:
- Reference the issue file path
- Include key context: file, function, approach
- Reference architect spec if one exists
- Set dependencies if tasks must be sequential

## Step 7: Document the plan

Write `plan/sprints/sprint-{N}-planning.md` with:
- Validation results (which issues are real vs stale)
- Feasibility assessments
- Decisions made (what was proposed/accepted/rejected and by whom)
- Final task queue with dev assignments
- Expected impact estimate

## Step 8: Create sprint doc

Write `plan/issues/sprints/{N}/sprint.md` with:
- Date, goal, baseline numbers
- Team roster
- Task queue table
- Results section (filled later)
- Retrospective section (filled by SM)

## Output

Message tech lead: `"Sprint-{N} plan ready. {X} tasks, estimated {Y} tests improved. Doc at plan/issues/sprints/{N}/sprint.md"`
