---
id: 1330
sprint: 50
title: "RegExp host-mode: Symbol.search protocol spec compliance (37 fails)"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
parent: 1002
---
# #1330 — RegExp host-mode: Symbol.search protocol spec compliance (37 fails)

Carved out of #1002 (RegExp js-host mode). Smaller surface than match/replace — narrower issue.

## Problem

37 test262 failures touching `RegExp.prototype[Symbol.search]` and `String.prototype.search`. Status: 34 fail, 3 compile_timeout.

## Sample failures

- `built-ins/RegExp/prototype/Symbol.search/failure-return-val.js`
- `built-ins/String/prototype/search/S15.5.4.12_A1_T12.js`

## Spec references

- §22.2.6.13 RegExp.prototype[@@search]
- §22.1.3.16 String.prototype.search

## Approach

Symbol.search is the simplest of the four — saves and restores `lastIndex`, calls RegExpExec, returns the index of the match (or -1). Most failures likely are about:
- `lastIndex` save/restore semantics (must NOT be mutated by search)
- Coercion of the input string (ToString)
- Custom subclass `[Symbol.search]` overrides

## Acceptance criteria

- 30+ of 37 flip to pass
- Remaining ones documented

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1328 (Symbol.match), #1329 (Symbol.replace), #1331 (Symbol.split)
