---
id: 1266
title: "compiler flag --no-eval-scope-write: TypeError instead of shadow scope deopt"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen, cli
language_feature: eval
goal: performance
depends_on: [1264]
---
# #1266 — `--no-eval-scope-write`: opt-in TypeError for eval scope mutations

## Problem

The shadow scope + deopt path from #1264 adds a null-check after every direct eval call.
TypeScript codebases that use eval for introspection (logging, REPL, debug) but never write
to outer scope variables pay this null-check unnecessarily.

## Solution

Add `--no-eval-scope-write` compiler flag. When set:

- Skip the shadow scope struct entirely
- After `eval(str)` returns, emit no null-check
- The host eval shim throws `TypeError` at runtime if eval attempts to write a value back
  into the caller's scope

This gives full static optimization (no boxing, no shadow, no null-check) for the common
TypeScript/ESM case while preserving correctness via an explicit runtime guard.

## CLI

```
--no-eval-scope-write   Throw TypeError if eval writes to enclosing scope.
                        Enables full optimization of locals in eval-containing functions.
                        Safe for TypeScript/ESM code that doesn't rely on eval side-effects.
```

## Implementation

1. Pass `noEvalScopeWrite: boolean` on `CompileOptions`
2. In eval codegen (tier 4): if flag set, emit no shadow struct, no post-eval null-check
3. In host eval shim: check flag; if set, throw TypeError on any scope write attempt

## Acceptance criteria

1. `--no-eval-scope-write` eliminates all post-eval null-checks in WAT output
2. `eval('x = 42')` with flag set throws TypeError at runtime
3. `eval('1 + 1')` with flag set works normally (read-only, no scope write)

## Depends on

#1264 (shadow scope implementation — this is the "skip shadow" escape hatch)
