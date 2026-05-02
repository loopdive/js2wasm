---
id: 110
title: "Issue 110: `in` operator for property existence test"
status: done
created: 2026-03-10
updated: 2026-04-14
completed: 2026-03-11
goal: compilable
---
# Issue 110: `in` operator for property existence test

## Summary

The compiler does not support the `in` operator, producing:

```
Unsupported string operator: InKeyword
```

This causes ~4 test failures in `language/expressions/conditional`.

## Example test

- `test/language/expressions/conditional/in-branch-1.js`

Typical usage:

```js
var x = "a";
var obj = { a: 1 };
assert("a" in obj);
assert(!("b" in obj));
```

## Semantics

`key in obj` returns `true` if `obj` has an own or inherited property named `key`.

For the ts2wasm compiler, the relevant cases are:
- `string in struct` — check if the struct has a field named by the string literal key
- `string in object` — for flat objects tracked as structs, this is a static check

Since the compiler maps object shapes to WasmGC structs at compile time, the `in`
operator can be resolved statically for known struct types:
- If the key is a string literal and the target type is a known struct: return constant `true`/`false`
- If the key is dynamic or the struct is unknown: emit an unsupported error (or always-false stub)

## Approach

1. In the binary-expression codegen, handle `InKeyword` operator
2. Resolve the right-hand type to a struct; check if the literal key exists as a field
3. Return `i32.const 1` (true) if the field exists, `i32.const 0` if not
4. For dynamic keys or unknown types, emit `compile_error` with a clear message

## Complexity

S
