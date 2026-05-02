---
id: 108
title: "Issue 108: String(), Boolean(), Array() as global conversion functions"
status: done
created: 2026-03-10
updated: 2026-04-14
completed: 2026-03-11
goal: compilable
---
# Issue 108: String(), Boolean(), Array() as global conversion functions

## Summary

Several test262 tests use the global constructors `String()`, `Boolean()`, and
`Array()` as plain conversion/factory functions (not with `new`). The compiler
currently does not recognize these as callable functions, producing:

```
Unknown function: String
Unknown function: Boolean
Unknown function: Array
```

## Error counts (from compile-error harvest)

| Error | Count |
|---|---|
| `Unknown function: String` | ~8 |
| `Unknown function: Boolean` | ~8 |
| `Unknown function: Array` | ~2 |

## Example tests

- `test/built-ins/Number/S9.3.1_A3_T2_U180E.js` — calls `String(num)` to convert a number to string
- `test/built-ins/Boolean/S15.6.1.1_A1_T3.js` — calls `Boolean(x)` to convert values to boolean
- `test/built-ins/Boolean/S15.6.1.1_A2.js` — `Boolean(undefined)` etc.
- `test/built-ins/Array/S15.4.5.1_A2.2_T1.js` — `Array(n)` to create array of length n

## Semantics

- `String(x)` — equivalent to `x.toString()` for most types; for numbers → string conversion
- `Boolean(x)` — truthiness coercion: `Boolean(0)` → `false`, `Boolean("")` → `false`, etc.
- `Array(n)` — creates a new array with `length` set to `n`; `Array(a, b, c)` → `[a, b, c]`

## Approach

1. In the call-expression codegen, detect calls to identifiers `String`, `Boolean`, `Array`
   where the callee is a plain identifier (not a method call)
2. `String(x)`: emit a host import or existing string-conversion intrinsic
3. `Boolean(x)`: emit a truthiness check (already needed by `if`/`while` conditions)
4. `Array(n)` with single numeric arg: allocate a new array with given length
5. `Array(a, b, c, ...)` with multiple args: compile as array literal `[a, b, c, ...]`

## Complexity

S
