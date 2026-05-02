---
id: 823
title: "Destructuring initializer not evaluated"
status: done
created: 2026-03-27
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: core-semantics
parent: 779
test262_fail: 121
---
# #823 -- Destructuring initializer not evaluated (121 fail)

## Problem

121 tests fail because default initializers in destructuring patterns are not evaluated when the destructured value is undefined. For example:

```js
const { x = getValue() } = {};  // getValue() should be called but isn't
```

The compiler either skips the initializer entirely or evaluates it unconditionally instead of only when the value is undefined.

## Acceptance criteria

- Default initializers in destructuring evaluated only when value is undefined
- 121 related test failures fixed
