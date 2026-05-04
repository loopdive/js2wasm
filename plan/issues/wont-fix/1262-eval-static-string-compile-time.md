---
id: 1262
title: "eval tier 2: compile eval(\\\"static string\\\") as regular code at compile time"
status: wont-fix
created: 2026-05-02
updated: 2026-05-02
completed: 2026-05-02
closed_reason: duplicate of #1163 (done — static eval literal inlining already shipped)
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: performance
depends_on: [1261]
---
# #1262 — eval tier 2: compile `eval("static string")` as regular code at compile time

## Problem

`eval("const x = 1; x + 2")` where the argument is a string literal known at compile time has zero
need for runtime eval machinery. The string can be parsed and compiled as an immediately-invoked
inline block, with the result wired directly into the surrounding expression.

## Implementation

When `classifyEvalTier` returns `tier2` (static string argument):

1. Parse the argument string as a JS/TS snippet using the existing TypeScript parser
2. Compile the snippet inline within the current function context
3. Wire the result value directly — no host `eval` import, no LRU cache miss path

Fallback: if the snippet fails to parse or uses features not yet supported by the compiler,
emit a compile-time warning and fall back to the runtime eval path (tier 4/5 as appropriate
for the enclosing module).

## Acceptance criteria

1. `eval("1 + 2")` in a TS function emits no eval import — just `f64.const 3` (constant-folded)
2. `eval("x + 1")` where `x` is in scope emits an inline load+add, no eval import
3. Fallback: `eval("with(obj){}") ` emits a warning and falls back gracefully

## Depends on

#1261 (eval tiering classifier)
