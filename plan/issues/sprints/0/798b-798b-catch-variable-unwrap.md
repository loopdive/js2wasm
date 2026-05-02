---
id: 798b
title: "#798b -- Catch variable unwrap"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: easy
goal: error-model
depends_on: [798a]
subtask_of: 798
commit: 043a7b31
---
# #798b -- Catch variable unwrap

## Implementation summary

When a caught exception is stored in the catch variable, unwrap the externref payload correctly. Bundled with #798c (rethrow instruction) in a single commit. The catch variable now correctly holds the exception value whether it came from a Wasm `throw $tag` or a foreign JS exception via `catch_all`.

Commit: 043a7b31
