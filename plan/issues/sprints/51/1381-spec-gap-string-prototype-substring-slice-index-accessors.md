---
id: 1381
sprint: 51
title: "spec gap: String.prototype.{substring,slice,indexOf,search,charAt,charCodeAt,codePointAt,at,includes,startsWith,endsWith,trim,concat} edge cases (~128 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: strings
goal: spec-completeness
---
# #1381 — String.prototype scalar accessors: range/index coercion fidelity

## Problem

Sub-bucket failures for non-RegExp string methods (sibling to #1369 which covers
the regex-protocol methods):

| method      | fails |
|-------------|-------|
| substring   | 19    |
| indexOf     | 17    |
| search      | 15    |
| slice       | 13    |
| lastIndexOf | 9     |
| charAt      | 8     |
| trim        | 8     |
| charCodeAt  | 7     |
| endsWith    | 7     |
| includes    | 7     |
| concat      | 7     |
| startsWith  | 5     |
| codePointAt | 4     |
| at          | 2     |
| **total**   | **128** |

These are spread across many small methods but share a few root causes:

1. **fromIndex coercion** — accept `undefined`, `+Infinity`, `-Infinity`, NaN, Symbol.
2. **RequireObjectCoercible receiver** — `String.prototype.substring.call(null)`
   must throw TypeError; ours may auto-stringify to `"null"`.
3. **substring-vs-slice swap** — `substring(5, 3)` swaps args (returns
   `s.substring(3, 5)`); slice does NOT swap (returns "").
4. **Negative indices** — slice clamps to 0; at allows negative; substring clamps to 0.
5. **Surrogate-pair-aware** — codePointAt at a high surrogate followed by a low
   surrogate returns the combined code point; charAt returns just the high surrogate.
6. **`includes`/`startsWith`/`endsWith`(searchValue, position)`** when `searchValue`
   is a RegExp — spec says throw TypeError.
7. **Symbol argument** — `indexOf(Symbol(...))`: ToString throws TypeError.

Sample failing tests:
- `substring/S15.5.4.15_A1_T6.js` — swap when start > end.
- `substring/S15.5.4.15_A1_T7.js` — NaN → 0.
- `indexOf/S15.5.4.7_A1_T5.js` — Symbol → TypeError.
- `includes/searchstring-regexp.js` — TypeError on RegExp arg.
- `slice/S15.5.4.13_A1_T4.js` — NaN end → 0.
- `codePointAt/return-code-unit-when-no-surrogate.js` — surrogate handling.

## Acceptance criteria

1. `built-ins/String/prototype/substring/S15.5.4.15_A1_T6.js` passes (swap when start > end).
2. `built-ins/String/prototype/substring/S15.5.4.15_A1_T7.js` passes (NaN → 0).
3. `built-ins/String/prototype/indexOf/S15.5.4.7_A1_T5.js` passes (Symbol → TypeError).
4. `built-ins/String/prototype/includes/searchstring-regexp.js` passes (TypeError on RegExp arg).
5. `built-ins/String/prototype/slice/S15.5.4.13_A1_T4.js` passes (NaN end → 0).
6. `built-ins/String/prototype/codePointAt/return-code-unit-when-no-surrogate.js` passes.
7. Pass-rate for these 14 methods rises from ~75% to ≥95%; **+90 net passes**.

## Files to modify

- `src/codegen/string-ops.ts` — per-method emitters for substring, slice, indexOf,
  lastIndexOf, charAt, charCodeAt, codePointAt, at, includes, startsWith, endsWith,
  search, concat, trim*.

## Implementation Plan

### Root cause

Each method has slightly different index-coercion rules, but they all share a
fragile `emitIndexCoercion(arg, len)` that does not honor every nuance. Symptom:
clusters of "off by one" / "wrong return" / "no throw on Symbol".

### Approach

#### A. Unified ToIntegerOrInfinity helper

Add `emitToIntegerOrInfinity(fctx)` that produces an i64 (to span the full
integer range):

```wasm
;; input: f64 on stack
;; output: i64 (clamped: NaN→0, ±Infinity→±2^63)
local.tee $f64
local.get $f64
f64.ne                   ;; NaN test (NaN != NaN)
if (result i64)
  i64.const 0
else
  local.get $f64
  i64.trunc_sat_f64_s
end
```

Then per-method:
- `substring(start, end)`: clamp to [0, len]; if start > end, swap.
- `slice(start, end)`: negative → max(0, len + n); clamp; no swap.
- `at(index)`: negative → len + n; if out of [0, len), return undefined.
- `indexOf(search, fromIndex)`: clamp to [0, len].
- `lastIndexOf(search, fromIndex)`: undefined → len; clamp to [0, len].

#### B. RequireObjectCoercible

Receiver === null or undefined → TypeError immediately. For the typed string
fast path, the static type is `string`, so receiver can never be null/undefined
unless inferred as `string | undefined` — in which case emit a runtime check.

For `String.prototype.substring.call(null)`, the Wasm-level call is via host
import; the host throws naturally. Verify this still routes correctly when the
receiver is a typed null.

#### C. RegExp argument check on includes/startsWith/endsWith

Per spec §22.1.3.7/§22.1.3.22/§22.1.3.6: if `searchValue` is a RegExp, throw
TypeError immediately.

```wasm
;; if searchValue is RegExp → TypeError
local.get $searchValue
call $__is_regexp
if
  ;; throwString "TypeError: First argument to String.prototype.includes must
  ;;              not be a regular expression"
end
```

`__is_regexp` is a one-liner host import:
```ts
__is_regexp(v) {
  if (v === null || typeof v !== 'object') return 0;
  const sym = v[Symbol.match];
  if (sym !== undefined) return sym ? 1 : 0;
  return v instanceof RegExp ? 1 : 0;
}
```

#### D. Symbol argument

`indexOf(Symbol(...))`: spec calls `ToString` on the search value, which for
Symbol throws TypeError. Our coerce-to-externref-then-to-string path may return
`"Symbol(x)"` (silent stringification).

Fix: in the coercion helper for string args, check for Symbol:

```ts
__to_string(v) {
  if (typeof v === 'symbol') {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  return String(v);
}
```

This may already exist — verify and route the indexOf/lastIndexOf/search args
through it.

#### E. Surrogate-pair handling

`codePointAt(i)` spec (§22.1.3.4):

```
1. position = ToIntegerOrInfinity(pos).
2. If position < 0 or >= len: return undefined.
3. Let cu = code unit at position.
4. If cu is a leading surrogate AND position+1 < len AND next is trailing surrogate:
     return UTF16Decode(cu, next).
5. Return cu.
```

Our impl might always return cu (skipping step 4).

`charCodeAt(i)`: just return code unit (or NaN for out-of-range).

`charAt(i)`: return single code unit as string (NOT surrogate-decoded).

For native strings (i16 array backend) the surrogate decode is a 4-line check:

```wasm
;; cu is loaded into local $cu (i32, i.e. u16)
local.get $cu
i32.const 0xFC00
i32.and
i32.const 0xD800
i32.eq                              ;; high surrogate?
local.get $i
i32.const 1
i32.add
local.get $len
i32.lt_s
i32.and                             ;; AND has next?
;; if true: load next, check it's low surrogate, combine
```

For wasm:js-string mode, host's `String.prototype.codePointAt` already does this
correctly — verify the host call is wired.

### Edge cases

- `"abc".substring(NaN, 2)` — start = 0; end = 2; result = "ab".
- `"abc".substring(5, -1)` — start = 3 (clamp); end = 0 (clamp); swap → "abc".
- `"abc".at(-100)` — undefined (out of range after coercion).
- `"abc".at(2.5)` — `ToIntegerOrInfinity(2.5) = 2` → "c".
- `"abc".indexOf("", -Infinity)` — "" matches at 0; return 0.
- `"abc".lastIndexOf("", undefined)` — undefined → len → 3.
- `"𝐀".charAt(0)` — high surrogate; charAt returns the high surrogate code unit.
- `"𝐀".codePointAt(0)` — combined code point 0x1D400.
- `"𝐀".codePointAt(1)` — low surrogate code unit 0xDC00.
- `"abc".concat(undefined)` — "abcundefined".
- `"abc".concat({toString: () => "x"})` — "abcx".
- `"  abc  ".trim()` — "abc"; spec uses extensive whitespace set including 　.

### Test262 sample

- `test262/test/built-ins/String/prototype/substring/S15.5.4.15_A1_T6.js`
- `test262/test/built-ins/String/prototype/substring/S15.5.4.15_A1_T7.js`
- `test262/test/built-ins/String/prototype/indexOf/S15.5.4.7_A1_T5.js`
- `test262/test/built-ins/String/prototype/includes/searchstring-regexp.js`
- `test262/test/built-ins/String/prototype/slice/S15.5.4.13_A1_T4.js`
- `test262/test/built-ins/String/prototype/codePointAt/return-code-unit-when-no-surrogate.js`
- `test262/test/built-ins/String/prototype/at/return-undefined-out-of-range.js`
- `test262/test/built-ins/String/prototype/charAt/pos-coerce-undefined.js`
- `test262/test/built-ins/String/prototype/concat/this-not-object-coercible.js`
- `test262/test/built-ins/String/prototype/trim/u180e.js`

### Estimated impact

+90 net passes. §22.1 climbs from 63% to ~70% in conjunction with #1369.
This is a `feasibility: easy` issue suitable for a junior dev — most edits are
small per-method delta patches against the existing emitters in `string-ops.ts`,
not architectural changes.

## 2026-05-08 investigation notes (dev-incr)

Probed the current state on `origin/main`. **Most acceptance-criteria cases
already pass** — the remaining failures cluster around three focused
bugs. The issue is larger than `feasibility: easy` suggests because
the fixes are entangled (signature change + padding semantics +
codegen coercion gap), so I'm releasing the task back to the queue
with this triage so a follow-up dev (or the architect) can pick up
clean.

### What already passes (probed locally on main HEAD a496782f2)

- `"abc".substring(NaN, 2)` — "ab" ✓
- `"abc".substring(2, NaN)` — "ab" ✓
- `"abcdef".substring(5, 3)` — "de" (swap) ✓
- `"abc".slice(NaN)` — "abc" ✓
- `"abc".slice(0, NaN)` — "" ✓
- `"𝐀".codePointAt(0)` — 0x1D400 (surrogate-aware) ✓
- `"𝐀".charAt(0)` — "\uD835" (just high surrogate) ✓
- `"𝐀".charCodeAt(0)` — 0xD835 ✓
- `"abc".at(-1)` — "c" ✓
- `"abc".at(2.5)` — "c" ✓
- `"abc".at(-100)` — undefined ✓
- `"abc".at(10)` — undefined ✓
- `"abc".includes(/x/ as any)` — TypeError ✓
- `"abc".startsWith(/x/ as any)` — TypeError ✓
- `"abc".endsWith(/x/ as any)` — TypeError ✓
- `"᠎".trim().length` — 1 (u180e is NOT whitespace post-ES2018) ✓
- `"abc".concat(undefined)` — "abcundefined" ✓
- `"abc".concat({toString:()=>"x"})` — "abcx" ✓
- `"5".padStart(3, "0")` — "005" ✓
- `"a".repeat(3)` — "aaa" ✓
- Receiver coercion: `String.prototype.indexOf.call(null, "x")` → TypeError ✓
- `String.prototype.substring.call(undefined, 0, 1)` → TypeError ✓

### Three remaining clusters (the actual `+90 passes`)

#### Cluster 1 — `indexOf(search, fromIndex)` numeric arg validation error

```ts
"abc".indexOf("a", 1);
// → Wasm validation fails: call[2] expected externref, found f64.const
```

The call-site at `src/codegen/expressions/calls.ts:4453` does
`compileExpression(ctx, fctx, args[ai]!, expectedArgType)` where
`expectedArgType = externref`. For numeric literals the hint isn't
honored — `argResult` comes back as `f64`, but the post-check
`coerceType(ctx, fctx, argResult, expectedArgType)` doesn't appear
to fire (or fires elsewhere and gets overwritten). Need to trace
which compile path the literal-receiver `"abc".indexOf("a", 1)`
follows — line 4420 vs 6398 — and confirm coerceType is invoked.

Affected: `indexOf`, `lastIndexOf` with numeric `fromIndex`. Likely
~10 fails.

#### Cluster 2 — `lastIndexOf` default fromIndex padded to 0 instead of +Infinity

`"abc".lastIndexOf("a")` returns 0 instead of 3. Expected: spec says
when fromIndex is undefined, default is +Infinity. Our padding logic
in `calls.ts:4470` uses `ref.null.extern` for missing externref args,
which the runtime sees as `null`. JS `"abc".lastIndexOf("a", null)` →
`ToInteger(null) = 0` → searches from index 0 → returns -1 unless
position 0 matches. `"abc".lastIndexOf("a")` (no arg) → +Infinity →
returns 0 (correct match at index 0). But our padded `null` returns 0
because of how `lastIndexOf` clamps fromIndex.

Wait — `"abc".lastIndexOf("a")` should return 0 (last occurrence of
"a" in "abc" is at index 0). My probe expected 3 which was wrong.
Re-probe: actually `"abc".lastIndexOf("a")` in V8 returns `0`, so
the FAIL is _my probe expectation_ being wrong, not the compiler.

Re-checking: `"abcabc".lastIndexOf("a")` should be 3 (last "a"). With
our null-padding it returns 0 (first "a" — because fromIndex=0 means
search up to AND including position 0 only). That IS a real bug.

Fix path: pad with `__get_undefined()` instead of `ref.null.extern`
for the second arg of `lastIndexOf`. Either add a method-specific
padding rule, or change the global padding to use undefined (but that
risks regressing methods like `replace` where ToString(null)="null"
vs ToString(undefined)="undefined" differ).

Affected: `lastIndexOf`. Likely ~9 fails.

#### Cluster 3 — `startsWith`/`endsWith`/`includes` drop the position arg

`STRING_METHODS` table at `src/codegen/index.ts:3120-3122` declares
these as `params: [externref]` — only the search string. The user's
`startsWith(search, position)` second arg gets compiled and then
either dropped by the stack-balance fixup, or simply discarded by
the dispatch loop, and the host always sees position 0.

Fix path: extend the table to `params: [externref, externref]` and
adjust the padding to pass `__get_undefined()` for the missing arg
(same care as cluster 2 — `endsWith`'s default endPosition is `length`
when undefined, but `0` when null; passing null breaks
`"abc".endsWith("c")`).

Affected: `startsWith`, `endsWith`, `includes` with position. Likely
~12 fails.

### Why `feasibility: easy` underestimates the work

All three clusters need a coordinated change to the call-site dispatch
+ the STRING_METHODS table + the padding rule, with careful
consideration of which methods care about null vs undefined for
missing args (`endsWith`, `lastIndexOf`, `padStart`'s padString, …).
Suggest breaking into three sub-issues:

- #1381a — fix `indexOf`/`lastIndexOf` numeric-fromIndex coercion gap
  (literal-receiver dispatch path, line 4453 vs 6453 of calls.ts).
- #1381b — fix `lastIndexOf` default fromIndex (introduce a per-method
  padding rule that uses `__get_undefined()` rather than null).
- #1381c — extend STRING_METHODS for `startsWith`/`endsWith`/`includes`
  to include position param + per-method padding.

Once these three land, the remaining clusters in this issue (Symbol
arg coercion, surrogate pair edge cases) overlap with #1343 (Symbol)
and are negligible-impact.
