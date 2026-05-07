---
id: 1336
sprint: 50
title: "JSON.stringify (objects/arrays) + JSON.parse: architect spec for Wasm shape-walking and recursive-descent parser"
status: ready
needs_architect_spec: true
created: 2026-05-08
updated: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime, codegen
language_feature: json
goal: standalone-mode
related: [1324, 1321]
---
# #1336 — JSON shape-walking + parser: architect spec needed

## Why this exists

Spun out from #1324 (JSON.stringify/parse pure Wasm) after dev-1298
read the strategy outline and pushed back on scope. The primitives-only
slice landed in the #1324 PR (string / number / boolean / null /
undefined / bigint-throw). Object / array stringify and the entire
parse path remain JS-host-only.

This issue is the architecture work — produce a concrete spec that
breaks the rest of the work into implementable PRs. After the spec
lands, schedule the implementation slices.

## Open architecture questions

1. **WasmGC struct field enumeration at runtime.** `_wasmToPlain` in
   the JS runtime uses `__struct_field_names` exports as JS-side
   metadata. To do this in Wasm, we need the struct shape registry
   accessible from Wasm. Options:
   - Per-struct exported `__field_count_<TypeIdx>` + `__field_name_<TypeIdx>_<i>` (large, simple)
   - Single registry struct with `(typeIdx → field-name array)` entries (compact, slower)
   - Inline metadata: each struct carries its field names as an extra field (memory-heavy)
2. **Generic property bag for parse output.** WasmGC structs are
   statically typed — we cannot construct an arbitrary-shape struct at
   runtime from parsed JSON. Options:
   - Use existing `__new_plain_object` (JS host plain object) — defeats
     standalone mode goal but reuses infrastructure
   - Build a `Map<string, externref>` and box it as a JSON object —
     loses prototype-chain instanceof `Object`
   - Add a new "dynamic property bag" Wasm type with a hash-array layout
3. **Growable string buffer.** stringify needs O(N) append. Options:
   - Linear memory + `i32` write pointer + grow-on-demand (familiar, but
     mixing linear memory with WasmGC is weird)
   - WasmGC `array.new_default<i16>` + custom realloc (clean, GC-friendly)
   - Concatenate a tree of small strings, materialize once at end
4. **SyntaxError throwing in the parser.** The ExnTag mechanism that
   `emitNullCheckThrow` uses (#728) — does it work for nested function
   calls inside the parser, or do we need an `__exn_throw_syntax` host
   bridge?
5. **String interning for object keys.** Avoid duplicate i16-array
   allocations for repeated key names. Options:
   - String pool indexed by hash (existing `ctx.stringPool` doesn't
     extend well to runtime-dynamic strings)
   - Per-parse-call cache of seen keys (simple, scoped)

## Acceptance for this issue

- An implementation spec covering each of (1)-(5) above with a chosen
  option, the function signatures, and the IR-side wiring.
- Slicing recommendation: which slices land in which PRs? Suggested:
  - Slice 1: stringify of arrays (uses `__vec_len` / `__vec_get`)
  - Slice 2: stringify of named structs (depends on struct field
    enumeration design)
  - Slice 3: parse of primitives (no structs)
  - Slice 4: parse of arrays
  - Slice 5: parse of objects (depends on property-bag design)

## Out of scope

- Replacer function support (`JSON.stringify(value, replacer)`) — JS
  host only for now
- Pretty-printing (`space` argument) — JS host only for now
- `JSON.stringify` toJSON() protocol — JS host only for now
- BigInt: throws TypeError per spec, already in #1324 primitives slice

## Related

- #1324 — primitives-only slice landed; this issue covers the rest
- #1321 — Number.prototype formatting (depends on but not blocked by;
  #1324's primitives slice uses existing `number_toString` host because
  JSON is base-10 only)
