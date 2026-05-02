---
id: 676
title: "RegExp internals: exec groups, lastIndex, named captures"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: class-system
test262_fail: 720
files:
  src/codegen/expressions.ts:
    new:
      - "unpack RegExp.exec() result groups, lastIndex, named captures"
  src/runtime.ts:
    new:
      - "RegExp host imports for exec result unpacking"
---
# #676 — RegExp internals: exec groups, lastIndex, named captures

## Status: open

~720 RegExp tests fail at runtime. The RegExp object is created via host but result unpacking is incomplete.

### Approach
1. **exec() result array**: `regex.exec(str)` returns an array-like with index, input, groups. Unpack via host import `__regexp_exec(regex, str) -> { match, index, groups }`
2. **lastIndex**: Track via host. `regex.lastIndex` getter/setter through host imports
3. **Named captures**: `(?<name>...)` groups accessible via `result.groups.name`. Unpack from host result
4. **Flags**: Already fixed (#632). Extend with flag-specific behavior (g, i, m, s, u, y, d)
5. **String methods**: `str.match(regex)`, `str.replace(regex, fn)`, `str.search(regex)` — dispatch through host

## Complexity: M
