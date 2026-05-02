---
id: 1263
title: "eval tier 3: indirect eval (0,eval)(...) — no local boxing, global scope only"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval, indirect-eval
goal: performance
depends_on: [1261]
---
# #1263 — eval tier 3: indirect eval `(0,eval)(...)` — no local boxing, global scope only

## Problem

Indirect eval (`(0, eval)(str)`, `window.eval(str)`, a stored reference to eval) runs in the
**global scope** per ECMA-262. It cannot see or mutate local variables in the calling function.
This means:

- **Strict mode**: zero impact on locals or function closures. No boxing needed anywhere.
- **Sloppy mode**: can only affect the global scope — new `var`/function declarations go on the
  global object, not into any enclosing scope. Funcref indirection is only needed for *global*
  function call sites, not local calls.

Currently the compiler likely treats any `eval` reference conservatively. This issue gates the
optimization on the indirect-eval classification.

## Detection

Indirect eval call shapes (check callee at AST level):
- `(0, eval)(...)` — comma operator forces indirect call
- `var e = eval; e(...)` — stored reference
- `obj.eval(...)` — property access, not direct identifier
- Any call where the callee is `eval` but is NOT a plain `Identifier` reference in the direct
  position

ECMA-262: only `eval(...)` as a direct call expression (callee is `Identifier "eval"`) is direct eval.
Everything else is indirect.

## Implementation

In `classifyEvalTier`: detect indirect form → return `tier3`.

At code-gen time when `evalTier === tier3`:
- **Strict mode module**: emit the host `eval` import as today, but skip all local boxing and
  funcref indirection. A note on scope: the global scope is already `externref`-based, so
  global mutations still work.
- **Sloppy mode module**: only apply funcref indirection to top-level function calls (not
  local calls). Local variables stay unboxed.

## Acceptance criteria

1. `(0, eval)("x = 1")` in a TS file compiles without local boxing
2. Local variables before/after the indirect eval call remain unboxed (`f64`, `i32`)
3. Correct runtime: if indirect eval mutates a global, the mutation is visible via
   the normal global access path

## Depends on

#1261
