---
id: 456
title: "Implement well-known Symbol support (Symbol.iterator, Symbol.toPrimitive)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: critical
goal: iterator-protocol
---
# #456 — Implement well-known Symbol support

## Problem
1,767 tests are skipped due to Symbol usage, and react-reconciler relies heavily on `Symbol.iterator` for the iterable protocol. User-created `Symbol()` is out of scope, but well-known symbols are a finite set that can be compiled statically.

## Approach
Well-known symbols are compile-time constants — map them to reserved method slots or struct fields:

1. **Symbol.iterator** — compile to a reserved method slot on iterable structs. When `for-of` or spread encounters an object, call the `[Symbol.iterator]()` slot. Host imports (`__iterator`, `__iterator_next`) already exist; extend to cover all iterable patterns.
2. **Symbol.toPrimitive** — compile to a reserved method slot called during type coercion (`+`, template literals, comparison). Falls back to `toString()`/`valueOf()`.
3. **Symbol.hasInstance** — compile `instanceof` to check for a `[Symbol.hasInstance]` method before falling back to prototype check.

## Implementation
- Add a `symbolSlots` map to struct type metadata: `{ iterator?: funcref, toPrimitive?: funcref, hasInstance?: funcref }`
- When compiling `class Foo { [Symbol.iterator]() { ... } }`, populate the iterator slot
- When compiling `for-of`, spread, or destructuring: check for iterator slot, call it
- Detect `Symbol.iterator` in property access / computed property names at compile time
- Do NOT support: `Symbol()`, `Symbol.for()`, `Symbol.keyFor()`, symbol-keyed properties on arbitrary objects

## Test Impact
- Unblocks ~1,767 skipped tests (Symbol usage)
- Unblocks `for-of` on custom iterables
- Required by react-reconciler for fiber tree iteration

## Acceptance Criteria
- `for (const x of customIterable)` works when class defines `[Symbol.iterator]()`
- `[...iterable]` spread works with Symbol.iterator
- Destructuring from iterables works
- Symbol.toPrimitive called during type coercion
