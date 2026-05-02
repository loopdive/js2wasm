---
id: 62
title: "Issue 62: JSON.parse / JSON.stringify via host"
status: done
created: 2026-03-02
updated: 2026-04-14
completed: 2026-03-02
goal: spec-completeness
---
# Issue 62: JSON.parse / JSON.stringify via host

## Summary

Support `JSON.parse()` and `JSON.stringify()` by delegating to the host.

## Desired behavior

```ts
const str = JSON.stringify({ x: 1, y: 2 });  // '{"x":1,"y":2}'
const obj = JSON.parse(str);                   // externref
```

## Implementation

### Runtime
- `JSON_stringify: (obj) => JSON.stringify(obj)` — returns string (externref)
- `JSON_parse: (str) => JSON.parse(str)` — returns externref

### Codegen
- Detect `JSON.stringify(expr)` and `JSON.parse(expr)` as special call patterns
- Emit host import calls
- Return type: externref for parse, string (externref) for stringify
- The generic `jsApi` proxy may already handle `JSON_stringify` / `JSON_parse`
  if we map the call correctly

## Complexity

S — ~50 lines, 1-2 files
