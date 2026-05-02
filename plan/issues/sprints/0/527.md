---
id: 527
title: "Fix test262 script: use tsx instead of node"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: easy
goal: test-infrastructure
files:
  package.json:
    new: []
    breaking:
      - "test262 script: change 'node' to 'tsx' for TypeScript import resolution"
---
# #527 — Fix test262 script: use tsx instead of node

## Status: open

`pnpm run test262` fails with `ERR_MODULE_NOT_FOUND: Cannot find module '/workspace/tests/test262-runner.js'` because the package.json script uses `node` which can't resolve `.ts` imports.

## Fix

In package.json, change:
```json
"test262": "node scripts/run-test262.ts"
```
to:
```json
"test262": "tsx scripts/run-test262.ts"
```

## Complexity: XS
