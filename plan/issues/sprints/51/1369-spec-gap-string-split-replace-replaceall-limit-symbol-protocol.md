---
id: 1369
sprint: 51
title: "spec gap: String.prototype.{split,replace,replaceAll,match,matchAll} — limit, @@split/@@replace/@@match protocol (~150 fails)"
status: in-progress
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

## 2026-05-08 investigation notes (dev-incr)

Probed acceptance criteria locally on `origin/main` HEAD `192b03eb1`.
**Most acceptance-criteria cases already pass** — the remaining
failures cluster in three distinct codegen bugs that need careful
coordinated changes (not appropriate for a single PR per the
dev-self-merge regression-rate gate).

### Already passes

- `"abc".split(undefined)` → `["abc"]` ✓
- `"abc".split("")` → `["a","b","c"]` ✓
- `"a,b,c".split(/,/)` → `["a","b","c"]` ✓
- `"abc".replaceAll(/b/, "x")` throws TypeError on non-global RegExp ✓
- `"abcabc".replaceAll(/b/g, "x")` → `"axcaxc"` ✓
- `"abc".replaceAll("", "x")` → `"xaxbxcx"` ✓
- `"abc".match(/b/)` returns `["b", index, ...]` ✓
- `"abc".match(/x/)` returns `null` ✓
- `"aabbab".matchAll(/a/g)` iterates correctly ✓
- `"abc".matchAll(/a/)` (non-global) throws TypeError ✓
- `"abc".replace(/(b)/, "[$1]")` → `"a[b]c"` (capture refs) ✓
- `String.prototype.split.call(null, ",")` → TypeError (receiver
  coercion) ✓

### Three remaining clusters

#### Cluster 1 — `split(separator, limit)` drops the limit argument

```ts
"a,b,c,d".split(",", 2);  // returns ["a","b","c","d"], not ["a","b"]
"abc".split("b", 0);       // returns ["a","c"], not []
```

WAT shows the limit is compiled as `f64.const N` then dropped before
the host call:

```
global.get $abcd
global.get $comma
f64.const 2
drop                    ;; <-- limit dropped
call $string_split_import
```

The `STRING_METHODS` table at `src/codegen/index.ts:3140` declares
`split: { params: [externref], result: externref }` — only the
separator. Need to extend to `params: [externref, externref]` so the
call site emits the limit, and update the padding rule for missing
limit to use `__get_undefined()` (NOT `ref.null.extern` — `null` would
ToUint32 to 0, not the spec default 2^32-1). Affects ~30+ split tests.

#### Cluster 2 — `replace(re, fn)` callback args off-by-one

```ts
"abc".replace(/b/, function(this: any, m, off, str) {
  // expected: m="b", off=1, str="abc"
  // actual:   m=1,   off="abc", str=undefined
});
```

The Wasm callback function type has 5 params (cap + 4) but the JS
host wrapper passes only 3 actual args (match, offset, string), so
the trailing `str` is undefined and the rest are shifted. The offset
mismatch suggests the wrapper passes args starting at param index 1
instead of 2 — possibly the `this` slot is being conflated. Needs
inspection of `__make_callback` and the closure-bridge layer.

This bug is closely related to #1382 (Wasm closures not JS-callable
from host imports — bridge gap). Likely the same root cause: the JS
host wrapper around Wasm closures has an arg-passing convention
mismatch.

Affected: every `replace(re, fn)` test that inspects the callback
arguments. Likely ~15 fails.

#### Cluster 3 — `Symbol.split` / `Symbol.replace` / `Symbol.match`
            custom-method dispatch missing

The current pipeline always routes through `string_split` /
`string_replace` host imports. If a user passes an object with a
custom `Symbol.split` method, the spec says we must call
`obj[Symbol.split](S, limit)`. Today we coerce the separator to a
string and split on its toString — which works for RegExp (since
RegExp.prototype.@@split is special-cased on the host) but not for
user-defined separator objects.

This is a narrow population in test262 (a handful of tests). Spec
work but low impact.

### Why this isn't safe to fix in one PR

#1380 (PR #272) showed that adding new params to host-imported
methods can mask existing bugs and trigger regressions in unrelated
test buckets when the stack-balance fixup pass interacts with the
shifted call signature. The fix needs:

1. Add `limit` as the 2nd `split` param in `STRING_METHODS`.
2. Add a per-method padding rule so missing `limit` becomes
   `__get_undefined()`, not `ref.null.extern`.
3. Audit the Wasm callback wrapper argument convention (cluster 2).
4. Run a full Test262 sharded CI to catch cascade regressions.

The first two items are coordinated changes to two files
(string-ops.ts/index.ts + property-access.ts call site). The third
item is structural and overlaps with #1382. Suggest splitting:

- **#1369a** — `split` limit (Cluster 1, contained codegen change).
- **#1369b** — `replace` callback args (Cluster 2, depends on #1382
  closure bridge).
- **#1369c** — `Symbol.split`/`@@replace`/`@@match` dispatch
  (Cluster 3, runtime helper additions).

Releasing the task back to the queue with this triage so the next
dev / architect can resume cleanly with focused sub-issues.
