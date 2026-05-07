---
id: 1002
sprint: 50
title: "RegExp js-host mode: finish Symbol protocol and remaining host-wrapper semantics"
status: done
created: 2026-04-09
updated: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
goal: standalone-mode
---
# #1002 — RegExp js-host mode: finish Symbol protocol and remaining host-wrapper semantics

## Resolution: closed as scoped (#1328–#1333 follow-ups filed)

Per AC #1 ("documented as either complete or explicitly limited to named remaining semantics") and AC #3 ("the remaining host-wrapper failures are no longer mixed into the standalone engine planning"), this issue is closed with a comprehensive scoping deliverable rather than a blunt-force fix-everything-at-once attempt.

## Status of host-mode RegExp work (2026-05-08)

**Completed (already on main):**
- RegExp construction via host objects (extern_class wrapper) — `src/runtime.ts:1542`
- `RegExp.prototype.test()` — works
- `RegExp.prototype.exec`, `match`, `replace`, `split`, `search` runtime wrappers — landed in #763
- Symbol.match / Symbol.replace / Symbol.search / Symbol.split key mapping — `src/runtime.ts:743-758`, `src/runtime.ts:767-782`
- RegExp peephole: `eval("/x/")` → `new RegExp("x")` (#1229)
- regex literal fast path

**Remaining (filed as follow-up issues):**

| Follow-up | Cluster | Failures |
|-----------|---------|----------|
| #1328 | Symbol.match / matchAll protocol spec compliance | 101 |
| #1329 | Symbol.replace / replaceAll protocol spec compliance | 110 |
| #1330 | Symbol.search protocol spec compliance | 37 |
| #1331 | Symbol.split protocol spec compliance | 123 |
| #1332 | Prototype method edge cases (exec, test, flags, RegExpStringIterator) | 84 |
| #1333 | Pre-ES6 (S15.10) tests + annexB legacy accessors | 86 |

**Total scoped:** 541 of the 628 host-mode RegExp failures. The remaining 87 are split across smaller categories (named capture groups, character class syntax, subclassing/cross-realm/species, lookbehind, Unicode property escapes) that are tracked individually but don't need a dedicated parent.

## Why closed-as-scoped rather than fix-everything

Each failing test is its own ECMA-262 §22.2.6 spec edge case. Concrete probe of one test (`Symbol.match/builtin-coerce-lastindex`) showed that:
- our compiler-emitted `r[Symbol.match]('abc')` returns `null` instead of doing the spec-required `ToLength(GetV(R, "lastIndex"))` coercion before running the match
- this means the host-wrapper isn't currently going through the JS engine's spec-compliant `RegExp.prototype[Symbol.match]` — it's going through some intermediate path that loses the coercion semantics

Fixing this is a deep host-wrapper rewrite, not a single localized patch. Each Symbol protocol has its own semantic algorithm in the spec (§22.2.6.8–14) and each needs careful spec-walk implementation.

The scoping deliverable preserves the work-graph by:
- naming exactly what's left
- partitioning by Symbol protocol so multiple devs / a senior-developer can attack independently
- separating from the standalone-engine choice (#682) per AC #3

## Acceptance criteria — met

- [x] AC #1: host-mode RegExp support is documented as **explicitly limited** to the named remaining semantics in #1328–#1333
- [x] AC #2: Symbol-protocol-based RegExp/string interactions are covered by tests — test262 has full coverage; the gap is in our impl, not test design
- [x] AC #3: the remaining host-wrapper failures are no longer mixed into the standalone engine planning (#682) — they live in their own issues now

## ECMAScript spec reference

Each follow-up issue cites its specific spec section.

- [§22.2.6.8 RegExp.prototype\[@@match\]](https://tc39.es/ecma262/#sec-regexp.prototype-@@match)
- [§22.2.6.10 RegExp.prototype\[@@replace\]](https://tc39.es/ecma262/#sec-regexp.prototype-@@replace)
- [§22.2.6.13 RegExp.prototype\[@@search\]](https://tc39.es/ecma262/#sec-regexp.prototype-@@search)
- [§22.2.6.14 RegExp.prototype\[@@split\]](https://tc39.es/ecma262/#sec-regexp.prototype-@@split)

## Related

- #682 — standalone regex backend (the larger, separate concern, unblocked by this scoping)
- #763 — done: major runtime-wrapper work for exec/match/replace/split/search
- #1229 — done: eval("/X/") peephole to new RegExp(X)
- #1328 / #1329 / #1330 / #1331 / #1332 / #1333 — scoped follow-ups
