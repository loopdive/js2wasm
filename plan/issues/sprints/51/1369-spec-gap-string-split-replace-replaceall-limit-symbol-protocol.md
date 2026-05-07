---
id: 1369
sprint: 51
title: "spec gap: String.prototype.{split,replace,replaceAll,match,matchAll} — limit, @@split/@@replace/@@match protocol (~150 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: strings
goal: spec-completeness
---
# #1369 — String.prototype.{split,replace,replaceAll,match,matchAll}: separator/limit/RegExp-symbol protocol

## Problem

| method     | fails | top                                |
|------------|-------|------------------------------------|
| split      | 90    | mostly assertion_fail              |
| match      | 23    |                                    |
| replace    | 20    |                                    |
| replaceAll | 20    |                                    |
| matchAll   | 12    |                                    |
| **total**  | **165** |                                  |

Spec algorithms (§22.1.3.{21,17,18}):

- `String.prototype.split(separator, limit)` — if `separator` has a
  `Symbol.split` method, call `separator[@@split](S, limit)`. Otherwise treat as
  string. Spec also clamps `limit` via `ToUint32` — `undefined` → 2^32-1, NaN → 0.
- `String.prototype.replace(searchValue, replaceValue)` — if `searchValue` has
  `Symbol.replace`, dispatch. If `replaceValue` is a function, call it with
  match arguments.
- `String.prototype.replaceAll(searchValue, replaceValue)` — REQUIRES global
  RegExp if searchValue is RegExp; throws TypeError otherwise.
- `String.prototype.match(regex)` — if regex has `Symbol.match`, dispatch; else
  wrap in RegExp.
- `String.prototype.matchAll(regex)` — similar with `Symbol.matchAll`.

Current state in `src/codegen/string-ops.ts`:

- `split` likely accepts only string separators, no @@split dispatch on
  custom objects with `Symbol.split`.
- `replace` likely doesn't dispatch on `Symbol.replace`.
- `replaceAll` doesn't enforce the "global flag" check on RegExp args (TypeError).
- `match`/`matchAll` may bypass the @@match/@@matchAll dispatch.
- Replace function callback args (match, p1, p2, …, offset, string, groups) may
  be wrong order or missing `groups`.

Sample failures:

- `String.prototype.split/this-value-not-obj-coercible.js` — TypeError on null/undefined receiver.
- `String.prototype.split/separator-undef-limit-zero.js` — limit=0 returns `[]`.
- `String.prototype.replaceAll/non-global-regexp-throws.js` — TypeError when regex is non-global.
- `String.prototype.replace/replacement-fn-args.js` — replacement fn called with `(match, ...captures, offset, string, groups)`.
- `String.prototype.match/symbol-match.js` — custom Symbol.match dispatch.

## Acceptance criteria

1. `String.prototype.split/separator-undef-limit-zero.js` passes.
2. `String.prototype.split/symbol-split.js` passes.
3. `String.prototype.replaceAll/non-global-regexp-throws.js` passes.
4. `String.prototype.replace/replacement-fn-args.js` passes (correct arg order).
5. `String.prototype.matchAll/regexp-prototype-not-flags.js` passes.
6. Pass-rate for these five methods rises from ~30% to ≥75%; **+90 net passes**.

## Files to modify

- `src/codegen/string-ops.ts` — `compileStringSplit`, `compileStringReplace`,
  `compileStringReplaceAll`, `compileStringMatch`, `compileStringMatchAll`.
- `src/runtime.ts` — host imports for fall-through paths.

## Implementation Plan

### Root cause

These methods were implemented for the common "string separator" / "no special
flags" case. The Symbol-protocol dispatch and the spec's argument-coercion order
were skipped.

### Approach

#### A. Symbol-protocol dispatch (split/replace/match/matchAll)

For each method, before the inline fast path, emit a runtime check:

```wasm
;; if separator has @@split:
local.get $separator
ref.is_null
i32.eqz
if
  local.get $separator
  call $__has_at_split        ;; returns i32 (1 if has Symbol.split)
  if
    local.get $separator
    local.get $this_string
    local.get $limit
    call $__invoke_at_split   ;; returns externref
    return
  end
end
;; else: fall through to inline string-split
```

Helpers:
- `__has_at_split(externref) -> i32` = `typeof obj[Symbol.split] === 'function'`.
- `__invoke_at_split(separator, S, limit) -> externref` = `separator[Symbol.split](S, limit)`.

Same pattern for `@@replace`, `@@match`, `@@matchAll`, `@@search`.

For RegExp args specifically, the symbol IS present on RegExp.prototype — so the
fast path is bypassed for any RegExp arg, routing through host's regex engine.
This is correct.

#### B. Limit coercion for split

```wasm
;; ToUint32(limit)
;; - undefined: 2^32 - 1
;; - 0 / NaN: 0
;; - negative: large unsigned
```

Today we likely use `i32.trunc_sat_f64_s` which gives wrong results for negative
values (`-1.0` → `i32.MIN_VALUE`, but spec says `2^32 - 1`).

Use `i32.trunc_sat_f64_u` after special-casing NaN and undefined:

```wasm
local.get $limit_f64
local.get $limit_f64
f64.ne                          ;; 1 if NaN
if (result i32)
  i32.const 0
else
  local.get $limit_f64
  i32.trunc_sat_f64_u
end
```

#### C. replaceAll non-global-regexp check

```wasm
;; if searchValue is RegExp and not global → TypeError
local.get $searchValue
call $__is_regexp               ;; returns i32
if
  local.get $searchValue
  call $__regexp_get_flags      ;; returns externref string
  call $__contains_g            ;; returns i32
  i32.eqz
  br_if $throw_typeerror
end
```

Helpers `__is_regexp`, `__regexp_get_flags`, `__contains_g` already exist or are
trivial.

#### D. Replacement function arg order

For `replace(re, fn)`:
```
fn(match, p1, p2, ..., pn, offset, string)
```
For named groups (RegExp with `(?<name>...)`):
```
fn(match, p1, ..., pn, offset, string, groups)
```

The host's `String.prototype.replace` already handles this; if we forward to host,
no fix needed. If we have a Wasm-native fast path, verify the arg order in
`compileStringReplace` matches.

### Edge cases

- `"abc".split()` — no separator; spec returns `["abc"]`.
- `"abc".split("")` — split into chars: `["a", "b", "c"]`.
- `"abc".split("", 0)` — limit 0 returns `[]`.
- `"abc".split(/(?:)/g)` — matches empty at every position; spec returns
  `["a","b","c"]`.
- `"abc".replaceAll("", "x")` — inserts "x" between every char; result `"xaxbxcx"`.
- `"abc".replaceAll(/b/, "x")` — TypeError (non-global RegExp).
- `"abc".replace(/b(?<G>.)/, (m, p1, off, str, groups) => groups.G)` — `groups` is
  the named-groups object.

### Test262 sample

- `test262/test/built-ins/String/prototype/split/separator-undef-limit-zero.js`
- `test262/test/built-ins/String/prototype/split/symbol-split.js`
- `test262/test/built-ins/String/prototype/replaceAll/non-global-regexp-throws.js`
- `test262/test/built-ins/String/prototype/replace/replacement-fn-args.js`
- `test262/test/built-ins/String/prototype/matchAll/regexp-prototype-not-flags.js`
- `test262/test/built-ins/String/prototype/match/cstm-matcher-get-throws.js`

### Estimated impact

+90 passes. §22.1 climbs from 63% to ~70%.
