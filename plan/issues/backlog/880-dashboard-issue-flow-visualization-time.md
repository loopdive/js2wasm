---
id: 880
title: "Dashboard: issue flow visualization — time from ready to done per issue"
status: ready
created: 2026-03-30
updated: 2026-04-28
priority: low
feasibility: medium
reasoning_effort: high
goal: observability
depends_on: [876]
---
# #880 -- Dashboard: issue flow visualization

## Problem

No visibility into how long issues take from ready → in-progress → done. Can't identify bottlenecks.

## Requirements

- Parse git log for issue file moves (ready/ → done/) to get cycle times
- Show average cycle time per sprint
- Highlight outliers (issues that took unusually long)
- Optional: Gantt-style view of issue timelines within a sprint

## Acceptance criteria

- Cycle time metric visible on dashboard
- Per-sprint average shown in sprint history table
