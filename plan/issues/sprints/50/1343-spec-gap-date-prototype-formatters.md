---
id: 1343
sprint: 50
title: "spec gap: Date.prototype string formatters and parsers (174 of 485 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: date
goal: spec-completeness
parent: 1328
---
# #1343 — Date: string formatters, parsers, ISO normalization

## Problem

`built-ins/Date/prototype`: **311 / 485 pass (64.1%) — 174 fails (156 assertion_fail,
6 other, 4 runtime_error, 3 null_deref, 3 wasm_compile)**.

Spec §21.4.4 (Date.prototype) requires precise output formats:
- `toISOString()` — `YYYY-MM-DDTHH:mm:ss.sssZ`
- `toJSON()` — calls `toISOString()` after coercing to Number first; throws RangeError on Invalid Date.
- `toString()` — `"DDD MMM dd YYYY HH:mm:ss GMT±hhmm (timezone-name)"`
- `toDateString()` / `toTimeString()` — parts of toString.
- `toUTCString()` — `"DDD, dd MMM YYYY HH:mm:ss GMT"`
- `Date.parse(str)` — accepts the formats produced by the above plus a few extra ISO variants.

Date is implemented as a host externref forwarder (`src/runtime.ts`), so most failures are
either:
1. The host's locale-specific output (timezone name) doesn't match test262's expected output.
2. Our `Symbol.toPrimitive` hook on Date isn't being called when Date is concatenated with a string.
3. Date.parse round-trip mismatch on edge dates (year 0, BC dates, leap-second handling).

## Acceptance criteria

1. `built-ins/Date/prototype/toISOString/15.9.5.43-0-1.js` passes.
2. `built-ins/Date/prototype/toJSON/invoke-tojson-result-throws.js` passes.
3. `built-ins/Date/prototype/Symbol.toPrimitive/this-val-non-obj.js` passes.
4. Pass-rate for `built-ins/Date/prototype` rises from 64% to ≥85%.

## Files to modify

- `src/runtime.ts` — Date.prototype.* host bridges (verify each forwards correctly)
- `src/codegen/registry/date.ts` — Symbol.toPrimitive emit on Date

## Implementation Plan

### Root cause

Most failures are timezone-locale dependent — our Wasm runs in node where the timezone is the
system default. Test262 sets `TZ=America/Los_Angeles` for some tests; we must respect that
env var. Some tests also call `Date.prototype[Symbol.toPrimitive]` directly; we don't expose it.

### Approach

1. Verify `process.env.TZ` is honored in test262 runner (it likely is).
2. Add `Symbol.toPrimitive` registration on Date prototype: returns string for "string"/"default" hint,
   number for "number" hint.
3. Audit the host imports: Date.prototype.toJSON should call ToPrimitive(this, "number") then check
   for !Number.isFinite(tv) to throw RangeError on Invalid Date.

### Edge cases

- Invalid Date (`new Date(NaN)`): toISOString throws RangeError; toString returns "Invalid Date";
  toJSON returns null.
- Symbol.toPrimitive hint "default": treat as "string" per spec §21.4.4.45.
- Year before 1970 or after 9999: ISO format must use `±YYYYYY` extended notation.

### Test262 sample

- `test262/test/built-ins/Date/prototype/toISOString/15.9.5.43-0-1.js`
- `test262/test/built-ins/Date/prototype/Symbol.toPrimitive/this-val-non-obj.js`
- `test262/test/built-ins/Date/prototype/toJSON/invoke-tojson-result-throws.js`

## Investigation Findings (senior-dev, 2026-05-08)

**Issue file's premise was wrong** — Date is NOT a host externref forwarder.
It's a Wasm-native struct (`__Date` with `i64 timestamp` field) implemented
in `src/codegen/expressions/builtins.ts::compileDateMethodCall` (line 440)
using Howard Hinnant's civil_from_days algorithm
(`ensureDateCivilHelper`, line 105). All getters and `setTime` are
implemented purely in Wasm i64 arithmetic. There is no host import for
Date methods at runtime; the `date_method` runtime fallback exists but
is unreachable for `__Date` struct values.

**Real failure breakdown** (174 fails in `built-ins/Date/prototype`):

| Method | Fails | Reason |
|--------|------:|--------|
| `setHours` | 17 | not implemented in `compileDateMethodCall` |
| `setFullYear` | 14 | not implemented |
| `setMinutes` | 12 | not implemented |
| `setMonth` | 11 | not implemented |
| `setSeconds` | 11 | not implemented |
| `setMilliseconds` | 8 | not implemented |
| `setDate` | 8 | not implemented |
| `setUTCHours` | 7 | not implemented |
| `setUTC{Month,Seconds,Date,Milliseconds,Minutes,FullYear}` | 23 | not implemented |
| `toISOString` | 8 | RangeError on Invalid Date not thrown |
| `toJSON` | 7 | `Cannot convert object to primitive value` — Symbol.toPrimitive not called on Date |
| `Symbol.toPrimitive` | 6 | method not exposed as Date.prototype member |
| `toUTCString` | 5 | format mismatch |
| `toString`, `toDateString`, `toTimeString` | 8 | format mismatch on edge years |
| `toTemporalInstant` | 6 | Temporal proposal — already in skip filters |
| `getDay`/`getMinutes`/`getHours`/`getSeconds`/`getTimezoneOffset` | 7 | NaN propagation broken: `new Date(NaN).getX()` returns 0 not NaN |

**Root cause**: the `DATE_METHODS` allowlist in `compileDateMethodCall`
(line 451) excludes ALL setters except `setTime`. When `date.setHours(...)` is
called, the function returns `undefined`, control flow falls through to
generic externref dispatch which fails because `__Date` is not externref.
This explains ~110 of the 174 fails directly; the remainder are formatter
edge cases and Symbol.toPrimitive plumbing.

## Implementation Plan (senior-dev, revised)

### Slice 1: NaN-propagating getters (~7 fails, low risk)
For each getter in `compileDateMethodCall`, when the timestamp is `i64.MIN`
(our representation of NaN — confirm this), emit `f64.const NaN` instead of
the modulo computation. Test with `new Date(NaN).getDay()` etc.

### Slice 2: time-of-day setters (~50 fails)
`setMilliseconds`, `setSeconds`, `setMinutes`, `setHours` and UTC variants.
Time-of-day setters don't need calendar recomputation — adjust timestamp
by delta:
```
ms_of_day = ((timestamp mod 86400000) + 86400000) mod 86400000  // floor-mod
day_of_epoch_ms = timestamp - ms_of_day
new_ms_of_day = newH*3600000 + newM*60000 + newS*1000 + newMs
new_timestamp = day_of_epoch_ms + new_ms_of_day
struct.set timestamp; return f64.convert_i64_s
```
For partial setters (e.g. `setMinutes(m)` keeps current s, ms), compute
existing components first.

### Slice 3: calendar setters (~36 fails)
`setDate`, `setMonth`, `setFullYear` and UTC variants. Need:
1. Decompose current timestamp → (y, mo, d, h, mi, s, ms) via
   `__date_civil_from_days`.
2. Replace the relevant field(s) with argument(s).
3. Recompose timestamp via `__date_days_from_civil`.
4. Write back, return f64.

May want a new helper `__date_components_from_timestamp` returning a
packed i64 (year * 10000 + month * 100 + day) plus a separate
time-of-day extractor.

### Slice 4: Invalid Date / Symbol.toPrimitive (~13 fails)
- `toISOString` should throw RangeError when timestamp == NaN sentinel.
- `toJSON` per §21.4.4.42: ToPrimitive(this, "number"); if !isFinite,
  return null; else call toISOString.
- `Date.prototype[Symbol.toPrimitive]`: register in classAccessorSet so
  `date[Symbol.toPrimitive]("string")` dispatches to Wasm helper.

### Slice 5: format polish (~16 fails)
- Negative years: `-000001` 6-digit padded.
- 5-digit years: `+002025` 7-digit prefixed.
- `toUTCString`: `DDD, dd MMM YYYY HH:mm:ss GMT` exactly (no tz suffix).

### Skip: `toTemporalInstant` (6 fails)
Temporal proposal — already in skip filters.

### Estimate
- Slice 1 + Slice 2: ~1.5h, ~57 fails fixed.
- Slice 3: ~2.5h, ~36 fails.
- Slice 4 + Slice 5: ~2h, ~29 fails.
- **Total: ~6h senior-dev for ~80% of fails (target ≥85% pass-rate).**

### Files
- `src/codegen/expressions/builtins.ts::compileDateMethodCall` — add setter cases, NaN guards, Symbol.toPrimitive
- `tests/issue-1343.test.ts` — per-slice equivalence tests

## Status (2026-05-08, senior-dev-2)

Started investigation in worktree
`/workspace/.claude/worktrees/issue-1343-date-formatters` while PR #264
(#1311 fix) CI was running. Did not push code; this issue requires a
focused multi-hour effort and shouldn't be rushed during CI-wait. Worktree
is clean — only this issue file is modified. Ready for re-claim by next dev
or for me to resume after #264 self-merges.
