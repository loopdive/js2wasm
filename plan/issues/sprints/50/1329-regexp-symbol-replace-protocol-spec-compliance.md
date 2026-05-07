---
id: 1329
sprint: 50
title: "RegExp host-mode: Symbol.replace / replaceAll protocol spec compliance (110 fails)"
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
# #1329 — RegExp host-mode: Symbol.replace / replaceAll protocol spec compliance (110 fails)

Carved out of #1002 (RegExp js-host mode). #1002 closed as a scoping deliverable; this is one of four Symbol-protocol follow-ups.

## Problem

110 test262 failures touching `RegExp.prototype[Symbol.replace]`, `String.prototype.replace`, `String.prototype.replaceAll` — each a different ECMA-262 §22.2.6.10 spec edge case.

Status breakdown: 104 fail, 2 compile_timeout, 4 compile_error.

## Sample failures

- `built-ins/RegExp/prototype/Symbol.replace/arg-1-coerce.js`
- `built-ins/RegExp/prototype/Symbol.replace/result-coerce-matched.js`
- `built-ins/RegExp/prototype/Symbol.replace/fn-invoke-this-strict.js`
- `built-ins/RegExp/prototype/Symbol.replace/y-fail-lastindex-no-write.js`
- `built-ins/RegExp/prototype/Symbol.replace/flags-tostring-error.js`
- `built-ins/RegExp/prototype/Symbol.replace/result-coerce-index-err.js`
- `built-ins/RegExp/prototype/Symbol.replace/subst-capture-idx-1.js`
- `built-ins/String/prototype/replace/cstm-replace-on-boolean-primitive.js`
- `built-ins/String/prototype/replaceAll/replaceValue-call-skip-no-match.js`
- `built-ins/String/prototype/replaceAll/cstm-replaceall-on-string-primitive.js`
- `built-ins/String/prototype/replaceAll/searchValue-replacer-call-abrupt.js`

## Spec references

- §22.2.6.10 RegExp.prototype[@@replace]
- §22.1.3.18 String.prototype.replace
- §22.1.3.19 String.prototype.replaceAll
- §22.2.7.4 GetSubstitution

## Approach

Symbol.replace has the deepest semantic surface of the Symbol protocols:
- function-callback path: replacer function with `this` binding rules (sloppy mode, strict mode)
- string-substitution path: `$&`, `$\``, `$'`, `$n`, `$<name>` substitutions (GetSubstitution algorithm)
- coercion of result properties (`index`, `length`, captures)
- `lastIndex` write semantics on sticky/non-sticky patterns
- replaceAll's argument-must-be-global guard

## Acceptance criteria

- 90+ of the 110 fails flip to pass
- Remaining ones documented

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1328 (Symbol.match), #1330 (Symbol.search), #1331 (Symbol.split)
