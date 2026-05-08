---
id: 1324
sprint: 50
title: "JSON.stringify and JSON.parse: implement in pure Wasm, eliminate JS host dependency"
status: done
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime, codegen
language_feature: json
goal: standalone-mode
---
# #1324 — JSON.stringify / JSON.parse in pure Wasm

## Problem

`JSON_stringify` and `JSON_parse` are JS host imports (`src/runtime.ts:1642-1667`). 
`JSON_stringify` calls `_wasmToPlain` (recursive Wasm→JS object conversion) then
`JSON.stringify`. `JSON_parse` calls native `JSON.parse`.

In standalone/WASI mode, any code touching JSON fails.

## Strategy

### JSON.stringify

The `_wasmToPlain` conversion is already mostly pure logic. Port it to a Wasm function:
1. Emit `__json_stringify(value: externref) → i16-array` as a Wasm function that recursively
   walks the value's type (using the existing `__tag` field for WasmGC structs, and sidecar
   property detection for plain JS objects).
2. Allocate a growable string buffer in linear memory (or use WasmGC `array.new_default`).
3. Handle: null, boolean, number (via `__number_toString`), string (escape as JSON), array
   (recurse via `__vec_get`), object (iterate own enumerable properties via tag-dispatch).
4. Wire `JSON.stringify` call sites in `src/ir/lower.ts` to this Wasm function.

### JSON.parse

RFC 8259 is a simple grammar. Implement a recursive-descent parser in Wasm:
1. Input: i16-array (string) representing UTF-16 JSON source.
2. Output: WasmGC object graph (structs for objects, `__vec_*` for arrays, tagged values for
   primitives).
3. Error path: throw `SyntaxError` on malformed input.
4. Key concern: string interning for object keys — wire to the existing string constant pool
   or use a linear-scan dedup table.

### Estimated size

~400 lines for stringify + ~500 lines for a correct parser. The hard part is the number
formatting (superseded by #1321) and proper unicode escape handling.

## Acceptance criteria

1. `JSON.stringify({a:1, b:[2,3]})` → `'{"a":1,"b":[2,3]}'` in standalone mode
2. `JSON.parse('{"a":1}').a` → `1` in standalone mode
3. `JSON.stringify(null)` → `"null"`, `JSON.stringify([1,null,true])` → `"[1,null,true]"`
4. Malformed JSON throws `SyntaxError`
5. Test262: `test/built-ins/JSON/` — no regressions

## Files

- New: `src/ir/json-wasm.ts` (or inline in `src/ir/lower.ts`) — stringify + parse logic
- `src/ir/lower.ts` — route JSON call sites to Wasm implementations
- `src/runtime.ts` — gate existing JS fallback on JS-host-mode only
- `tests/issue-1324.test.ts`

## Implementation Results — primitives slice (this PR)

Per-tech-lead-direction (option b), this PR landed only the
primitive-typed slice; full object/array stringify and the entire
parse path are tracked under #1353 (architect-spec follow-up).

Implemented in `src/codegen/expressions/calls.ts` via a new
`tryEmitJsonStringifyPrimitive(ctx, fctx, arg)` helper that runs
BEFORE the `JSON_stringify` host-import dispatch. When the argument's
TypeScript type is statically a primitive (Null / Undefined /
BooleanLike / NumberLike), the helper emits pure Wasm that produces
the JSON-correct externref string and returns true; the call site
skips the host import. For all other shapes (StringLike, BigInt,
Object, Union, Any, …) the helper returns false (no stack effect)
and the existing host call runs unchanged.

Per spec § 25.5.2 step 11, NaN and ±Infinity serialize to `"null"`.
Implemented via `(x - x) === 0` finiteness test before
`number_toString` — NaN-NaN and ±∞-±∞ both produce NaN, falsifying
the equality.

`undefined` returns the JS `undefined` value (not a string), via
`emitUndefined` so JS-host mode pulls from `__get_undefined`.

### Tests

`tests/issue-1324.test.ts` — 13 passing scenarios:
- `null`, `true`, `false`, integer, decimal, negative number
- `NaN`, `Infinity`, `-Infinity` → `"null"` per spec
- `undefined` → JS undefined (not a string)
- statically-typed `boolean` and `number` variables
- object input falls through to host (no regression)
- string input falls through to host (no regression)
- replacer/space args compiled for side effects on primitive arg

Sanity-checked against `tests/issue-{837,1239,1267,1268,1298,1313,
1316}.test.ts` — 56 pass / 3 skip (unchanged from main).

### Out of scope — see #1353

- Object / array shape walking (depends on WasmGC field-enumeration design)
- `JSON.parse` (depends on dynamic property-bag struct design)
- `string` runtime escape (compile-time-known string literals fall
  through to the host today; primitives slice handles boolean and
  number, not string)
- BigInt TypeError throw (deferred to #1353)
- Replacer function support, `space` pretty-print, `toJSON` protocol —
  all deferred per architect spec request.
