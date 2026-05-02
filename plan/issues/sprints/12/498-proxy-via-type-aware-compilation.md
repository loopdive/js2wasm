---
id: 498
title: "Proxy via type-aware compilation with trap inlining (70 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: hard
goal: spec-completeness
required_by: [670]
test262_skip: 70
files:
  src/codegen/expressions.ts:
    new:
      - "compileProxyConstruction — type-aware proxy compilation with trap inlining"
    breaking: []
---
# #498 — Proxy via type-aware compilation with trap inlining (70 tests)

## Status: review

70 tests use `new Proxy(target, handler)`. Previously considered impossible in WasmGC, but achievable with compile-time specialization.

## Approach: Type-aware proxy compilation

The key insight: **the compiler knows when an object is a Proxy** because it sees `new Proxy(target, handler)`. TypeScript's type system tracks the proxy type through the program. Non-proxy code pays zero cost.

### Three compilation tiers

**Tier 1 — Inline small traps (zero cost)**
When the handler is an object literal with small trap functions (<10 AST nodes), inline the trap body at every access site:

```javascript
const proxy = new Proxy(target, {
  get(t, prop) { return t[prop] * 2; }
});
proxy.x;  // compiles to: target.x * 2 (inlined, no dispatch)
```

**Tier 2 — Direct-call larger traps (one function call)**
When traps are known functions but too large to inline:

```javascript
proxy.x;  // compiles to: call $handler_get(target, "x")
```

No indirect dispatch — the trap function is known at compile time.

**Tier 3 — Dynamic dispatch (handler is a variable)**
When the handler is not known at compile time:

```javascript
const proxy = new Proxy(target, handlerVar);
proxy.x;  // compiles to: struct.get handler $get → call_ref(target, "x")
```

Only this tier has runtime overhead, and it only applies to the proxy-typed variable.

### How non-proxy code stays fast

The proxy type flows through TypeScript's type system. When code accesses properties on a known non-proxy type, the compiler emits normal `struct.get` — no checks, no branches.

For `any`-typed values that COULD be a proxy: add a 1-bit `__is_proxy` flag to the struct header. Check this bit before dispatch. Strictly-typed code never hits this branch.

### Proxy struct layout

```
struct ProxyWrapper {
  field $__is_proxy i32           // always 1
  field $__target (ref $Target)   // the wrapped object
  field $__handler (ref $Handler) // the handler with trap methods
}
```

Property access on a ProxyWrapper:
- `proxy.x` → check `$__is_proxy`, if 1: call `handler.get(target, "x")`
- `proxy.x = v` → call `handler.set(target, "x", v)`
- `"x" in proxy` → call `handler.has(target, "x")`
- `delete proxy.x` → call `handler.deleteProperty(target, "x")`

### Traps to support

| Trap | JS operation | Priority |
|------|-------------|----------|
| get | property read | Critical |
| set | property write | Critical |
| has | `in` operator | High |
| apply | function call | High |
| construct | `new` operator | Medium |
| deleteProperty | `delete` | Medium |
| ownKeys | `Object.keys()` | Low |
| getPrototypeOf | `Object.getPrototypeOf()` | Low |

## Complexity: L

## Acceptance criteria
- [ ] `new Proxy(target, { get(t,p) { return t[p]; } })` compiles and works
- [ ] Small trap functions are inlined (zero runtime cost)
- [ ] Non-proxy objects have zero overhead (no proxy checks)
- [ ] `proxy.x`, `proxy.x = v`, `"x" in proxy` dispatch through handler
