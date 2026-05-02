---
id: 473
title: "Array.prototype method .call/.apply support (852 skipped tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: test-infrastructure
---
# #473 -- Array.prototype method .call/.apply support

852 test262 tests are skipped because they call Array.prototype methods via
`.call()` or `.apply()` with an explicit `this` argument.

## Skip reason
"Array.prototype.method.call/apply" -- tests like:
```js
Array.prototype.push.call(obj, 1, 2, 3);
Array.prototype.indexOf.call(arrayLike, value);
```

## Current state
- Array methods work when called directly on arrays (e.g., `arr.push(1)`)
- But `.call(thisArg, ...)` and `.apply(thisArg, [...])` are not supported
- The skip filter prevents these tests from running

## Approach
1. Implement `.call()` on function references -- dispatch to the underlying function
   with the first argument as `this`
2. Implement `.apply()` similarly but with array spreading
3. For Array.prototype methods specifically, handle the case where `thisArg` is
   an array-like object (has `.length` and numeric indices)
4. Remove the skip filter for these tests

## Impact
- 852 tests directly unblocked
- Many of these test edge cases of Array methods that are otherwise passing
- Likely unlocks additional passes in Object/String prototype methods too
