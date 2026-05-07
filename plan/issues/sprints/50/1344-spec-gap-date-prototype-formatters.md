---
id: 1344
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
# #1344 — Date: string formatters, parsers, ISO normalization

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
