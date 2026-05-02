---
id: 677
title: "Full property descriptor support (writable/enumerable/configurable)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
goal: error-model
depends_on: [1113]
test262_fail: 1000
files:
  src/codegen/index.ts:
    new:
      - "property descriptor bitfield on struct fields"
  src/codegen/expressions.ts:
    new:
      - "Object.getOwnPropertyDescriptor returns descriptor object"
---
# #677 — Full property descriptor support (writable/enumerable/configurable)

## Status: open

~1,000+ tests check property descriptors. Our struct fields have no descriptor metadata.

### Approach
Add a per-struct descriptor bitfield:
1. Each struct gets an `i32` field `__descriptors` — 2 bits per field (writable, configurable). Enumerable defaults to true.
2. `Object.defineProperty(obj, "prop", { writable: false })` → set the bit
3. `Object.getOwnPropertyDescriptor(obj, "prop")` → read bits, construct descriptor object
4. Assignment to non-writable: check bit before struct.set, throw TypeError if not writable
5. `delete` on non-configurable: check bit, throw TypeError

The bitfield costs 4 bytes per struct instance. For most code (no defineProperty), the bits are never checked — zero overhead.

## Complexity: L
