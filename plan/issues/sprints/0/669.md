---
id: 669
title: "eval() and new Function() support"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
goal: spec-completeness
test262_fail: 2500
files:
  src/codegen/expressions.ts:
    new:
      - "compile eval() string argument at compile time when static"
      - "runtime eval via embedded mini-interpreter for simple expressions"
---
# #669 — eval() and new Function() support

## Status: open

~2,500 tests use eval() or new Function(). 

### Approach
1. **Static eval**: When the argument is a string literal, compile it at compile time: `eval("1+2")` → `3`
2. **Template eval**: When the argument is a template with known structure, inline: `eval("var x = " + n)` → `var x = n`  
3. **Simple expression eval**: Embed a tiny expression evaluator in Wasm (arithmetic, string ops, property access) — covers `eval("obj.prop")` patterns
4. **Function() constructor**: Same as eval but wraps in a function. `new Function("a", "return a+1")` → compile the body string

Won't cover: runtime-generated code, multi-statement eval, eval that modifies scope. But covers 60-70% of test262 eval usage.

## Complexity: L
