---
id: 1328
sprint: 50
title: "RegExp host-mode: Symbol.match / matchAll protocol spec compliance (101 fails)"
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
# #1328 — RegExp host-mode: Symbol.match / matchAll protocol spec compliance (101 fails)

Carved out of #1002 (RegExp js-host mode). #1002 closed as a scoping deliverable; this is one of four Symbol-protocol follow-ups.

## Problem

101 test262 failures touching `RegExp.prototype[Symbol.match]`, `RegExp.prototype[Symbol.matchAll]`, `String.prototype.match`, `String.prototype.matchAll` — each a different ECMA-262 §22.2.6.8 spec edge case.

Status breakdown: 97 fail, 3 compile_timeout, 1 compile_error.

## Root cause

The host-mode dispatch goes through `RegExp.prototype[Symbol.match]` on the JS RegExp wrapper, but our compiler's call-path for `r[Symbol.match](s)` does not always route through the JS engine's spec-compliant implementation. Several edge cases (e.g. `r.lastIndex = '1.9'` ToLength coercion) end up returning `null` instead of doing the spec-required coercion + match.

Concrete repro:
```ts
const r = /./y;
(r as any).lastIndex = '1.9';   // string lastIndex
r[Symbol.match]('abc');          // returns null (should return ['b'])
```

## Sample failures

- `built-ins/RegExp/prototype/Symbol.match/builtin-coerce-lastindex.js`
- `built-ins/RegExp/prototype/Symbol.match/coerce-arg-err.js`
- `built-ins/RegExp/prototype/Symbol.match/g-match-no-coerce-lastindex.js`
- `built-ins/RegExp/prototype/Symbol.match/y-fail-lastindex-no-write.js`
- `built-ins/RegExp/prototype/Symbol.match/builtin-success-g-set-lastindex.js`
- `built-ins/RegExp/prototype/Symbol.match/name.js`
- `built-ins/RegExp/prototype/Symbol.matchAll/species-constructor-species-is-not-constructor.js`
- `built-ins/RegExp/prototype/Symbol.matchAll/this-get-flags.js`
- `built-ins/String/prototype/match/S15.5.4.10_A2_T11.js`
- `built-ins/String/prototype/matchAll/regexp-is-null.js`

## Spec references

- §22.2.6.8 RegExp.prototype[@@match]
- §22.2.6.9 RegExp.prototype[@@matchAll]
- §22.1.3.13 String.prototype.match
- §22.1.3.14 String.prototype.matchAll
- §22.2.7.1 RegExpExec
- §22.2.7.2 RegExpBuiltinExec

## Approach

Trace the codegen path for `obj[Symbol.match](s)` via `obj` being a host RegExp. Likely needs:
- Ensure `Symbol.match` property access on a RegExp externref dispatches through the host's `RegExp.prototype[Symbol.match]`
- Verify ToLength coercion happens on `lastIndex` before the match
- Verify the returned result-array shape matches spec

## Acceptance criteria

- 80+ of the 101 fails flip to pass
- Remaining ones documented with their specific spec gap

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1329 (Symbol.replace), #1330 (Symbol.search), #1331 (Symbol.split)
