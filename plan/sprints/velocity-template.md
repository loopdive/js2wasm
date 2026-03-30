# Sprint Velocity Template

Copy this section into each sprint doc under `## Velocity`.

```markdown
## Velocity

| Metric | Sprint N | Sprint N-1 | Delta |
|--------|----------|------------|-------|
| Issues closed (merged) | | | |
| Issues closed (stale/already-fixed) | | | |
| CE fixed | | | |
| FAIL fixed | | | |
| Pass delta (test262) | | | |
| Sprint duration (sessions) | | | |
| Stale issues caught by smoke-test | | | |
| Regressions introduced & reverted | | | |
```

## How to fill in

- **Issues closed (merged)**: count of issues moved to `done/` with actual code changes
- **Issues closed (stale)**: issues closed because they were already fixed
- **CE fixed**: decrease in compile errors (baseline CE - final CE)
- **FAIL fixed**: decrease in runtime failures (baseline FAIL - final FAIL)
- **Pass delta**: final pass count - baseline pass count from test262 runs
- **Sprint duration**: number of agent sessions (a session = one conversation context)
- **Stale issues caught**: issues that smoke-test showed were already fixed
- **Regressions**: issues that were merged then reverted
