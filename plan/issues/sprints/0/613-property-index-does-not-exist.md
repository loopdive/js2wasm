---
id: 613
title: "Property 'index' does not exist on string[] (206 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: easy
goal: builtin-methods
test262_ce: 206
files:
  src/checker/lib-es5.ts:
    new: []
    breaking:
      - "add 'index' property to RegExpMatchArray type"
---
# #613 — Property 'index' does not exist on string[] (206 CE)

## Status: open

206 tests (all RegExp-related) fail with "Property 'index' does not exist on type 'string[]'. Did you mean 'indexOf'?"

### Root cause

`RegExp.exec()` and `String.match()` return a `RegExpMatchArray` which extends `string[]` with extra properties: `index`, `input`, `groups`. The compiler's type definitions don't include these.

### Fix

Update the lib type definitions to declare `RegExpMatchArray` with `index: number` and `input: string` properties. Or add these to the `DOWNGRADE_DIAG_CODES` suppression list since the runtime already provides them.

## Complexity: XS
