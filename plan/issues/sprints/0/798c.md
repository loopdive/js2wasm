---
id: 798c
title: "#798c -- Rethrow instruction for throw-of-catch-variable"
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
# #798c -- Rethrow instruction for throw-of-catch-variable

## Implementation summary

Emit `rethrow` instruction when `throw` is used on the catch variable inside a catch block. This preserves the original exception identity (important for foreign JS exceptions) instead of wrapping it in a new `throw $tag`. Bundled with #798b.

Commit: 043a7b31
