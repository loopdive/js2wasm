---
id: 1265
title: "eval tier 5: sloppy-mode direct eval — full local boxing + funcref globals"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: low
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: eval, sloppy-mode
goal: compatibility
depends_on: [1261]
---
# #1265 — eval tier 5: sloppy-mode direct eval — full local boxing + funcref globals

## Background

Sloppy-mode direct eval is the hardest tier. Unlike strict mode, sloppy eval can:

1. Introduce new variables into the enclosing scope (the compiler can't know what variables
   exist after eval returns)
2. Replace top-level function declarations via `function greet() {}` inside eval

The shadow-scope approach from #1264 doesn't work here because the set of variables is open —
eval can create new ones.

## Approach

For modules that contain sloppy-mode direct eval:

### Local variables → full boxing

All locals in functions reachable by the eval site must be `externref` (boxed). This is the
only correct approach given the open variable set. At function entry/exit, unbox/rebox as needed
to interface with callers that use unboxed types.

### Function replacement → mutable funcref globals

Each top-level function gets a mutable funcref global:

```wat
(global $__fn_greet (mut funcref) (ref.func $greet))
```

All call sites to top-level functions use `global.get` + `call_ref` instead of `call`:

```wat
;; before: (call $greet ...)
;; after:  (global.get $__fn_greet) (call_ref $fn_type ...)
```

When eval replaces `greet`, the host runtime updates `$__fn_greet` to point to the new function.

### Blast radius analysis

The compiler statically identifies which functions are reachable by the eval site through
shared state (closures, globals, parameters, return values). Only those functions need boxing.
Functions that have no data path to the eval site are unaffected. This keeps the blast radius
bounded to the statically analyzable subgraph.

## Cost

- One `global.get` per top-level function call in affected modules
- `externref` locals in eval-reachable functions (boxing overhead on each use)

This is acceptable because sloppy-mode scripts are an increasingly rare target — TypeScript and
ESM (which are always strict) never hit this tier.

## Acceptance criteria

1. `function greet() { return "hello" }; eval("function greet() { return 'world' }"); greet()` → "world"
2. Locals in eval-reachable functions remain correct after eval introduces new variables
3. Functions with no data path to eval site have no funcref indirection (static blast radius)

## Depends on

#1261 (tiering classifier)

## Note

TypeScript/ESM consumers never hit this tier. This exists purely for sloppy-mode legacy script
compatibility and can be deferred indefinitely unless a specific use case requires it.
