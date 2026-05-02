---
id: 835
title: "Unknown extern class: Error types (32 CE)"
status: done
created: 2026-03-28
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: error-model
test262_ce: 32
---
# #835 -- Error types not registered as extern classes (32 CE)

## Problem

32 tests fail with "Unknown extern class: <ErrorType>". The compiler special-cases `new Error(msg)` in expressions.ts but doesn't register Error, TypeError, RangeError, SyntaxError, etc. as full extern classes in `ctx.externClasses`. When code creates Error instances and passes them to Array methods or accesses properties, the extern class lookup fails.

## Breakdown by error type

| Error Type | Count |
|-----------|-------|
| AggregateError | 13 |
| Error | 7 |
| SyntaxError | 5 |
| TypeError | 3 |
| RangeError | 2 |
| EvalError | 1 |
| URIError | 1 |

## Sample files with exact errors

### 1. AggregateError

**File**: `test/built-ins/AggregateError/prototype/errors-absent-on-prototype.js`
**Error**: `L19:23 Unknown extern class: AggregateError`
**Source** (line 19):
```js
var prototype = AggregateError.prototype;
```

### 2. Error passed to Array.prototype.filter

**File**: `test/built-ins/Array/prototype/filter/15.4.4.20-1-14.js`
**Error**: `L17:14 Unknown extern class: Error`
**Source** (lines 11-17):
```js
function callbackfn(val, idx, obj) {
  return obj instanceof Error;
}

var obj = new Error();
obj.length = 1;
obj[0] = 1;
```

### 3. SyntaxError passed to Array.prototype.indexOf

**File**: `test/built-ins/Array/prototype/indexOf/15.4.4.14-1-14.js`
**Error**: `L13:23 Unknown extern class: SyntaxError`
**Source** (lines 11-13):
```js
var obj = new SyntaxError();
obj.length = 2;
obj[1] = true;
```

### 4. Error passed to Array.prototype.forEach

**File**: `test/built-ins/Array/prototype/forEach/15.4.4.18-1-14.js`
**Error**: `L19:1 Unknown extern class: Error`
**Source** (lines 14-19):
```js
var obj = new Error();
obj.length = 2;
obj[0] = 12;
obj[1] = 11;

Array.prototype.forEach.call(obj, callbackfn);
```

### 5. SyntaxError passed to Array.prototype.lastIndexOf

**File**: `test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-1-14.js`
**Error**: `L13:18 Unknown extern class: SyntaxError`

## Root cause

In `src/codegen/index.ts` or `src/codegen/expressions.ts`, the extern class registry does not include Error types. The `new Error()` special case only handles construction, not subsequent property access or method calls on Error instances.

## Fix

Register Error, TypeError, RangeError, SyntaxError, URIError, EvalError, ReferenceError, and AggregateError in `ctx.externClasses` with basic property access support (message, name, stack). Same pattern as Map, Set, RegExp registration.

## Acceptance criteria

- All Error types registered as extern classes
- 32 compile errors eliminated
- Property access on Error instances works (`.message`, `.name`)
