---
id: 389
title: "- Element access on class instances (76 CE)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: test-infrastructure
test262_ce: 76
files:
  src/codegen/expressions.ts:
    new:
      - "compileElementAccess — handle struct-typed class instances with bracket notation"
    breaking: []
---
# #389 -- Element access on class instances (76 CE)

## Status: open

76 tests fail with "Element access on struct type '__anonClass_0'" because bracket notation on class instances is not supported. The compiler does not know how to translate `obj[key]` when the object is a WasmGC struct.

## Details

Class instances are backed by WasmGC structs with named fields. Bracket notation requires resolving the field at compile time (for string literals) or implementing a dynamic lookup table.

```javascript
class C { x = 1; y = 2; }
var c = new C();
var val = c["x"];  // should resolve to struct.get for field 'x'
```

Fix:
1. For string literal keys, resolve the field name on the struct type and emit `struct.get`
2. For computed keys that can be statically determined, do the same
3. For truly dynamic keys, consider a field name table approach or emit an error with a clear message

## Complexity: M

## Acceptance criteria
- [ ] `instance["fieldName"]` compiles to struct.get for known fields
- [ ] String literal bracket access works for class instances
- [ ] Reduce test262 compile errors by ~76
