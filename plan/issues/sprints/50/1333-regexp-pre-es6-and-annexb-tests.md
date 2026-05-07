---
id: 1333
sprint: 50
title: "RegExp host-mode: Pre-ES6 (S15.10) tests + annexB legacy accessors"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: low
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
parent: 1002
---
# #1333 — RegExp host-mode: Pre-ES6 (S15.10) tests + annexB legacy accessors

Carved out of #1002 (RegExp js-host mode).

## Problem

86 test262 failures across:
- 69 Pre-ES6 (S15.10) RegExp tests — legacy spec test names targeting older RegExp behavior
- 17 annexB legacy accessors — `RegExp.input` / `RegExp.lastMatch` / `RegExp.leftContext` / `RegExp.rightContext` / `RegExp.lastParen` / `RegExp.$1`–`$9`

## Sample failures

- `built-ins/RegExp/S15.10.2.7_A4_T2.js` (and 68 sibling S15.10.* tests)
- `annexB/built-ins/RegExp/legacy-accessors/input/this-cross-realm-constructor.js`
- `annexB/built-ins/RegExp/legacy-accessors/lastMatch/...`

## Approach

Two distinct sub-issues:

**(a) Pre-ES6 (S15.10) tests** — likely all share the same root cause(s). Sample one and trace; many will cluster onto one or two underlying gaps (e.g., constructor argument coercion, source-property quoting, flags string ordering).

**(b) annexB legacy accessors** — these are pre-RegExp-ES6 globals (`RegExp.$1` etc.) that point to the last-matched groups. Implementing them requires the host-wrapper to update a hidden global slot after every match. This is annexB (browser-only legacy), so explicit *non*-implementation may be acceptable per acceptance.

## Acceptance criteria

- Either implement, or document as wont-fix (annexB legacy)
- Pre-ES6 cluster: 50+ flip to pass

## Related

- Parent #1002 (closed-as-scoped)
