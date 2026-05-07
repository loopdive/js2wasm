---
id: 1331
sprint: 50
title: "RegExp host-mode: Symbol.split protocol spec compliance (123 fails)"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
parent: 1002
---
# #1331 — RegExp host-mode: Symbol.split protocol spec compliance (123 fails)

Carved out of #1002 (RegExp js-host mode). Largest single Symbol-protocol bucket.

## Problem

123 test262 failures touching `RegExp.prototype[Symbol.split]` and `String.prototype.split`. Status: 119 fail, 2 compile_timeout, 2 compile_error.

## Sample failures

- `built-ins/RegExp/prototype/Symbol.split/coerce-string-err.js`
- `built-ins/RegExp/prototype/Symbol.split/species-ctor-y.js`
- `built-ins/String/prototype/split/argument-is-regexp-d-and-instance-is-string-dfe23iu-34-65.js`

## Spec references

- §22.2.6.14 RegExp.prototype[@@split]
- §22.1.3.22 String.prototype.split

## Approach

Symbol.split is large because the spec algorithm is complex:
- species constructor lookup (`Symbol.species` on `this.constructor`)
- creation of a sticky-flagged splitter regex
- internal splitter loop with `lastIndex` advancement
- empty-match handling (advance by one)
- limit argument (ToUint32 coercion)

Beware: this protocol is also used by string `split(regex)` so issues here cascade.

## Acceptance criteria

- 100+ of 123 flip to pass
- Remaining ones documented

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1328 (Symbol.match), #1329 (Symbol.replace), #1330 (Symbol.search)
