---
id: 670
title: "Proxy trap execution (beyond pass-through)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: medium
goal: spec-completeness
depends_on: [498]
test262_fail: 465
files:
  src/codegen/expressions.ts:
    new:
      - "compile Proxy handler traps as interceptors at property access sites"
---
# #670 — Proxy trap execution (beyond pass-through)

## Status: open

#498 compiles `new Proxy(target, handler)` as pass-through. 465 tests expect traps to execute.

### Approach
When the handler is an object literal with known traps:
1. **get trap**: At every `proxy.prop` access site, emit: call handler.get(target, "prop", proxy)
2. **set trap**: At every `proxy.prop = val` site, emit: call handler.set(target, "prop", val, proxy)
3. **has trap**: At every `"prop" in proxy` site, emit: call handler.has(target, "prop")
4. **apply trap**: At every `proxy()` call site, emit: call handler.apply(target, thisArg, args)

The compiler sees the handler object literal at compile time — inline the trap bodies directly at each access site. Zero runtime dispatch.

For handlers stored in variables: fall back to externref dispatch through host.

## Complexity: L
