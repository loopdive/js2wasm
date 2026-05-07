---
id: 1332
sprint: 50
title: "RegExp host-mode: prototype method edge cases (exec, test, flag accessors, RegExpStringIterator)"
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
# #1332 — RegExp host-mode: prototype method edge cases

Carved out of #1002 (RegExp js-host mode). Catches the long-tail prototype method failures that aren't part of the four Symbol protocols.

## Problem

84 test262 failures across:
- 27 `RegExp.prototype.exec` edge cases
- 16 `RegExp.prototype.test` edge cases
- 24 `RegExp.prototype` flag/source accessors (flags, global, ignoreCase, unicode, sticky, dotAll, multiline, hasIndices, source)
- 17 `RegExpStringIterator` prototype tests

## Sample failures

- `built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T7.js`
- `built-ins/RegExp/prototype/exec/failure-lastindex-access.js`
- `built-ins/RegExp/prototype/test/S15.10.6.3_A1_T8.js`
- `built-ins/RegExp/prototype/flags/coercion-global.js`
- `built-ins/RegExp/prototype/unicode/cross-realm.js`
- `built-ins/RegExpStringIteratorPrototype/ancestry.js`

## Spec references

- §22.2.6.2 RegExp.prototype.exec
- §22.2.6.16 RegExp.prototype.test
- §22.2.6.4 / 6.5 / etc. flag accessors
- §22.2.9 RegExpStringIterator

## Approach

Mostly host-wrapper coercion / `this` binding / cross-realm semantics. Not as deep as the Symbol protocols but spec-edge-case-heavy.

## Acceptance criteria

- 60+ of 84 flip to pass
- Remaining ones documented

## Related

- Parent #1002 (closed-as-scoped)
