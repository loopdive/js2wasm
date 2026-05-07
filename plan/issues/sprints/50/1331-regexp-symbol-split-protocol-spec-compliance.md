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

## Implementation Plan

### Root cause
Two distinct gaps drive 123 failures (spec §22.2.6.14 / §22.1.3.22):

1. **Symbol.search/split sentinel boxing (shared with #1330)** — `regex[Symbol.split](str)` and `RegExp.prototype[Symbol.split].call(...)` lookups return `undefined` because the compiler boxes the i32 sentinel `10` as `Number(10)` instead of `Symbol.split`. See #1330 implementation plan for the fix in `src/codegen/property-access.ts:2532-2587`. Land #1330 first (or together) — the same edit unblocks ~30-40 of the 123 here.

2. **`String.prototype.split(regex)` host-import gating** — `collectStringMethodImports` in `src/codegen/index.ts:3137-3157` only marks `split` as needing the **host** import (instead of the native `__str_split` helper) when the first argument's static type is `RegExp` (`argType.getSymbol()?.getName() === "RegExp"`). When the regex argument has type `any`, an alias, a parameter typed `RegExp | string`, or comes from `eval()`, the static check fails, the compiler routes through native `__str_split`, and the regex argument is implicitly stringified — losing all RegExp semantics (species ctor, sticky flag advancement, captures-into-result). This is why so many `String/prototype/split/argument-is-regexp-*` tests fail despite the `string_split` import existing.

### Changes

**File: `src/codegen/property-access.ts`** (shared with #1330)
- Same well-known-symbol → `__box_symbol` rewrite for element-access key compilation (see #1330 spec). Symbol.split has sentinel id `10` per `getWellKnownSymbolId`.

**File: `src/codegen/index.ts`**
- Function `collectStringMethodImports` (line 3131) — broaden the regexp-arg detection at line 3144-3157. Replace the strict symbol-name match with a check that returns `true` when **any** of the following hold:
  1. `argType.getSymbol()?.getName() === "RegExp"` (current behavior),
  2. `argType.getCallSignatures().length === 0 && argType.getProperties().some(p => p.name === "exec" || p.name === "lastIndex")` — duck-type fallback for typed-as-any regex,
  3. The argument is a `RegularExpressionLiteral` (`expr.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral`),
  4. The argument is a `NewExpression` whose constructor identifier text is `"RegExp"`.
- Apply the same broadening in `src/codegen/string-ops.ts:1680-1687` (`firstArgIsRegExp`).
- When the static type cannot be proven non-RegExp, default to **also** registering the host import (it's strictly more capable than the native helper) — register both, and at the call site emit the host import path.

**File: `src/codegen/string-ops.ts`**
- Function path at line 1746-1766 (`split` native) — when `firstArgIsRegExp` is true OR the arg type is `any`/`unknown`, fall through to the host `string_split` import path (line 1827-1872) instead of using `__str_split`.

### Spec algorithm (§22.2.6.14 RegExp.prototype[@@split])
V8 implements all 17 steps correctly, including:
- SpeciesConstructor lookup (step 5),
- splitter construction with `y` (sticky) flag added (steps 11-13),
- the splitter loop with `lastIndex` advancement (steps 19-25),
- empty-match `AdvanceStringIndex` (step 24c),
- `limit = ToUint32(limit)` (step 9).

The compiler fix only needs to ensure dispatch reaches V8 with the correct receiver and argument types. Do **not** re-implement the algorithm in Wasm.

### Shared helper
Note for the dev: there is no `RegExpExec` helper in this codebase — V8 *is* the helper. Both #1330 and #1331 reuse the same `__box_symbol` codegen plumbing; coordinate the property-access.ts edit to land once (probably via #1330 first, then #1331 picks up the broadening of `collectStringMethodImports`).

### Edge cases
- `species-ctor.js` — `re.constructor[Symbol.species] = ctor`: V8 honors this once the dispatch reaches it.
- `coerce-limit.js` — `regex[Symbol.split](str, {valueOf: …})`: V8 handles ToUint32 of object limit.
- `last-index-exceeds-str-size.js` — V8 handles bounds.
- `String.prototype.split` with `any`-typed RegExp arg from a function parameter — fix #2 above.
- `"abc".split(eval("/x/"))` — peephole in `expressions/calls.ts:349` already produces an externref RegExp; arg-type detection (#2 above) needs to recognize this case.

### Test files to verify
- `tests/equivalence/regexp-methods.test.ts` — add cases: `"a,b,c".split(/,/)` returns `["a","b","c"]`; `"abcde".split(/x/iy)` species-ctor receiver; split with limit.
- Re-run test262 buckets `built-ins/RegExp/prototype/Symbol.split/*` and `built-ins/String/prototype/split/*`.
