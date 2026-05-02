---
id: 881
title: "Dashboard: real-time resource monitoring — memory graphs, agent widgets, test progress"
status: ready
created: 2026-03-30
updated: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: high
goal: observability
depends_on: [876]
---
# #881 -- Dashboard: real-time resource monitoring

## Problem

We can't see memory usage, agent status, or test progress in real time. This leads to OOM kills, over-provisioning agents, and blind test runs. Need live monitoring integrated into the dashboard.

## Requirements

### 1. Memory timeline graph
- Stacked area chart showing cumulative memory usage over time
- Layers: vitest workers (per fork), compiler workers, claude agents, system/IDE
- Data source: `.claude/nonces/memory-monitor.jsonl` (sampled every 10s by monitor hook)
- Show 16GB container limit as a red line
- X-axis: time, Y-axis: MB
- Auto-updates via WebSocket from Vite plugin

### 2. Agent widgets
- One card per active agent showing:
  - Name, role, current task
  - Memory (RSS + peak VmHWM)
  - Uptime (since spawn)
  - Status: coding / testing / idle / waiting
- Data source: team config + process stats

### 3. Test progress widgets
- Active test run: progress bar (X of 48K), elapsed time, estimated remaining
- Memory usage of test workers (current + peak)
- Pass/fail/CE counts updating live
- Data source: memory monitor + test262 report (refreshed by Vite plugin watcher)

### 4. Resource planning table
- Show measured peaks for each scenario (from memory-monitor logs):
  - Equiv test: peak per worker
  - Test262: peak per worker at different test counts (10K, 20K, 30K, 48K)
  - Agent: peak at idle, active, peak
  - Compiler worker: peak per compilation
- Calculate: "Can I spawn N agents and run M test forks?" → yes/no with projected total

### 5. Historical peaks
- Parse all memory-monitor.jsonl entries to build a history of peak usage
- Show trend: are agents getting more memory-hungry over time?
- Correlate with test262 pass count — does higher pass count = more memory?

## Data sources

- `.claude/nonces/memory-monitor.jsonl` — live samples (vitest, compiler, agent RSS + VmHWM)
- `.claude/nonces/events.jsonl` — agent spawn/shutdown events with RAM
- `.claude/nonces/test-memory-log.jsonl` — pre/post test RAM snapshots
- `~/.claude/teams/{team}/config.json` — active team members
- `benchmarks/results/test262-report.json` — live test results
- `/proc/[pid]/status` — VmHWM for running processes

## Acceptance criteria

- Memory timeline visible on dashboard during test262 run
- Agent cards show current RSS and peak
- Test progress shows pass/fail updating live
- Resource planning table gives go/no-go for agent+test combos
