---
id: 844
title: "Unsupported new expression for built-in classes (85 CE)"
status: done
created: 2026-03-28
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: iterator-protocol
test262_ce: 85
---
# #844 -- Unsupported new expression for built-in classes (85 CE)

## Problem

85 tests fail because the compiler does not support `new` for certain built-in classes. The compiler has explicit `new` support for some classes (Array, Date, RegExp, Map, Set, etc.) but not for SharedArrayBuffer, AggregateError, FinalizationRegistry, BigInt64Array, BigUint64Array, or primitive wrapper constructors.

## Breakdown by class

| Class | CE count | Notes |
|-------|----------|-------|
| SharedArrayBuffer | 44 | Requires SharedArrayBuffer extern class |
| AggregateError | 32 | Error subclass with `errors` iterable parameter |
| FinalizationRegistry | 20 | Already skip-filtered but some tests leak through |
| BigInt64Array | 18 | Requires BigInt support |
| BigUint64Array | 7 | Requires BigInt support |
| Number (wrapper) | 1 | `new Number(42)` creates Number object |
| String (wrapper) | 1 | `new String("s")` creates String object |
| Boolean (wrapper) | 1 | `new Boolean(true)` creates Boolean object |
| EvalError | 1 | Error subclass |

Note: Some tests have multiple class mentions, so the sum exceeds 85.

## Sample files with exact errors

### 1. new AggregateError

**File**: `test/built-ins/AggregateError/cause-property.js`
**Error**: `L29:13 Unsupported new expression for class: AggregateError; L33:18 Unsupported new expression for class: AggregateError`
**Source** (lines 28-33):
```js
var errors = [];
var message = "my-message";
var cause = { message: "my-cause" };
var error = new AggregateError(errors, message, { cause });
```

### 2. new Number/String/Boolean (wrapper objects)

**File**: `test/language/module-code/top-level-await/new-await-parens.js`
**Error**: `L12:19 Unsupported new expression for class: Number; L13:19 Unsupported new expression for class: String; L14:24 Unsupported new expression for class: Boolean`
**Source** (lines 12-14):
```js
var ns = new Number(await 1);
var ss = new String(await '');
var bs = new Boolean(await true);
```

### 3. new AggregateError with iterableToList

**File**: `test/built-ins/AggregateError/errors-iterabletolist.js`
**Error**: `L66:1 Unsupported new expression for class: AggregateError; L72:3 Unsupported new expression for class: AggregateError`
**Source** (lines 66-72):
```js
new AggregateError([], "message");
// ...
var error = new AggregateError([], "message");
```

### 4. new AggregateError constructor check

**File**: `test/built-ins/AggregateError/is-a-constructor.js`
**Error**: `L23:1 Unsupported new expression for class: AggregateError`
**Source** (line 23):
```js
new AggregateError([]);
```

### 5. new SharedArrayBuffer (covered by #674)

**File**: `test/built-ins/Atomics/add/bigint/good-views.js`
**Error**: `L36:37 Unsupported new expression for class: SharedArrayBuffer`

## Root cause

In `src/codegen/expressions.ts`, the `NewExpression` handler has a switch/map of known constructors. The following are missing:

1. **AggregateError**: Needs `(iterable, message, options?) -> Error` -- requires iterable consumption
2. **Primitive wrappers** (Number, String, Boolean): `new Number(42)` creates a Number object with `.valueOf()` returning the primitive. Different from `Number(42)` which returns a primitive.
3. **SharedArrayBuffer**: Blocked on #674
4. **FinalizationRegistry**: Blocked on WeakRef/FinReg support
5. **BigInt64Array/BigUint64Array**: Blocked on BigInt support

## Suggested fix (immediate wins)

1. Add `new AggregateError(errors, message)` constructor support -- create Error extern with `errors` property
2. Add primitive wrapper constructors: `new Number(n)`, `new String(s)`, `new Boolean(b)` -- create extern objects wrapping the primitive value
3. Mark SharedArrayBuffer, FinalizationRegistry, BigInt TypedArrays as blocked on their respective feature issues

## Acceptance criteria

- `new AggregateError()` compiles (32+ CE eliminated)
- Primitive wrapper constructors compile (3 CE eliminated)
- Clear dependency tracking for blocked classes
