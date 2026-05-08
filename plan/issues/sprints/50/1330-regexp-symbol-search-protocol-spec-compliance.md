---
id: 1330
sprint: 50
title: "RegExp host-mode: Symbol.search protocol spec compliance (37 fails)"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
parent: 1002
---
# #1330 — RegExp host-mode: Symbol.search protocol spec compliance (37 fails)

Carved out of #1002 (RegExp js-host mode). Smaller surface than match/replace — narrower issue.

## Problem

37 test262 failures touching `RegExp.prototype[Symbol.search]` and `String.prototype.search`. Status: 34 fail, 3 compile_timeout.

## Sample failures

- `built-ins/RegExp/prototype/Symbol.search/failure-return-val.js`
- `built-ins/String/prototype/search/S15.5.4.12_A1_T12.js`

## Spec references

- §22.2.6.13 RegExp.prototype[@@search]
- §22.1.3.16 String.prototype.search

## Approach

Symbol.search is the simplest of the four — saves and restores `lastIndex`, calls RegExpExec, returns the index of the match (or -1). Most failures likely are about:
- `lastIndex` save/restore semantics (must NOT be mutated by search)
- Coercion of the input string (ToString)
- Custom subclass `[Symbol.search]` overrides

## Acceptance criteria

- 30+ of 37 flip to pass
- Remaining ones documented

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1328 (Symbol.match), #1329 (Symbol.replace), #1331 (Symbol.split)

## Implementation Plan

### Root cause
The host-mode wrapper relies on V8's native `RegExp.prototype[@@search]` (spec §22.2.6.13) — V8 already implements all spec steps correctly, including `lastIndex` save/restore and `RegExpExec` dispatch. So compile-and-run of `String.prototype.search(regex)` already works for the common shape. **What fails** are tests that invoke the protocol *directly* via `RegExp.prototype[Symbol.search].call(receiver, str)` or `re[Symbol.search](str)` (e.g. `cstm-exec-return-invalid.js`, `coerce-string.js`, `failure-return-val.js`, `lastindex-no-restore.js`).

The compiler lowers `Symbol.search` to `i32.const 9` (the well-known-symbol sentinel registered in `getWellKnownSymbolId`, see `src/codegen/property-access.ts:1664`). When this i32 is used as an element-access key on an externref RegExp, `compileElementAccessBody` (`src/codegen/property-access.ts:2532-2547`) coerces the i32 to externref via `f64.convert_i32_s` → `__box_number`, so the host receives a plain `Number(9)` rather than `Symbol.search`. `_safeGet` in `src/runtime.ts:840` only translates 1..14 → real Symbol when `_isWasmStruct(obj)` — for genuine JS objects (RegExp instances, RegExp.prototype) the translation is skipped and `obj[9]` returns `undefined`, so `regex[Symbol.search]` evaluates to `undefined` and any `.call(...)` throws "undefined is not a function".

### Changes

**File: `src/codegen/property-access.ts`** (shared with #1328/#1329/#1331/#1332 — coordinate)
- In `compileElementAccessBody` (line ~2532, externref branch) and the primitive branch (line ~2574), detect when `expr.argumentExpression` is a property access of the form `Symbol.<wellKnown>` (use `getWellKnownSymbolId` from line 70). When matched, emit `i32.const N` then `call $__box_symbol` (already registered via `import-manifest.ts:104`-equivalent — see `__box_symbol` in `src/runtime.ts:2072-2097`) **instead of** `__box_number`. Use `ensureLateImport(ctx, "__box_symbol", [{kind:"i32"}], [{kind:"externref"}])`.
- Apply the same fix in element *assignment* (`compileElementAccessAssign` if present) so `obj[Symbol.search] = fn` reaches the host as a real Symbol.

**File: `src/runtime.ts` (defensive)**
- In `_safeGet` (line 840) and `_safeSet` (line 907), when `obj` is **not** a WasmGC struct AND the receiver is *not* an Array/TypedArray/string/arguments-like (i.e. `!Array.isArray(obj) && typeof obj.length !== "number"`), allow the same i32→Symbol translation. This belt-and-braces fix catches indirect paths (e.g. `Reflect.get(obj, k)` from a captured key) without breaking `arr[9]` integer access.

### Spec algorithm (§22.2.6.13 RegExp.prototype[@@search])
V8 implements steps 1-9 natively. The compiler-level fix simply ensures the lookup reaches V8.

### Edge cases / acceptance
- `cstm-exec-return-invalid.js` — `RegExp.prototype[Symbol.search].call(fakeRe, 'a')` with non-RegExp receiver: V8 throws TypeError correctly once dispatch resolves.
- `coerce-string.js` — `/ring/[Symbol.search]({toString:…})`: works once the symbol lookup returns the real method; V8 handles ToString.
- `lastindex-no-restore.js`, `failure-return-val.js` — `lastIndex` save/restore is V8-native.
- Receiver-validation, `Get(R, "lastIndex")`, `Set(R, "lastIndex", previousLastIndex)` — all V8 native.

### Test files to verify
- `tests/equivalence/regexp-methods.test.ts` — add cases: `re[Symbol.search]("xyz")` returns int, `RegExp.prototype[Symbol.search].call(fakeRe, "a")` invokes user `exec`.
- Re-run test262 bucket `built-ins/RegExp/prototype/Symbol.search/*` and `built-ins/String/prototype/search/*`.
