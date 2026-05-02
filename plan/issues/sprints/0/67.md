---
id: 67
title: "Issue 67: Closed import objects — replace Proxy with compiler manifest"
status: done
created: 2026-03-03
updated: 2026-04-14
completed: 2026-03-03
goal: spec-completeness
---
# Issue 67: Closed import objects — replace Proxy with compiler manifest

Parent: [#66](66.md) — security design doc

## Summary

Replace the three runtime `Proxy` objects with a closed `buildImports()` that
takes a compiler-generated import manifest. This is the core security fix:
after this, only declared imports exist in the import object, `__extern_get`
is restricted, and import functions type-check their arguments.

## Steps

### 1. Export `ImportDescriptor[]` from `CompileResult`

Add an `imports` field to `CompileResult` (index.ts). Each descriptor has a
`module`, `name`, `kind`, and structured `intent` (string_literal, math,
console_log, extern_class, string_method, builtin, etc.).

Build the manifest in `compileSource()` / `compileMultiSource()` by classifying
`mod.imports` — same logic `generateEnvImportLine()` already uses.

### 2. Replace `buildImports()` with a closed builder

New signature: `buildImports(manifest: ImportDescriptor[], deps?)`.
Iterates the manifest, calls a closed `resolveImport()` switch per intent type.
Returns a plain `Object.freeze()`-d env object — no Proxy.

### 3. Remove `jsApi`, `domApi`, and inner Proxy

Delete all three Proxy exports. `buildImports(manifest, deps)` is the only
way to create imports. `compileAndInstantiate()` uses `result.imports`
internally.

### 4. Restrict `__extern_get`

The compiler emits which property names are accessed via bracket notation.
Add these to the manifest as `{ type: "extern_get", properties: string[] }`.
The generated import checks the property name against the allowlist:

```ts
case "extern_get":
  const allowed = new Set(imp.intent.properties);
  return (obj: any, prop: any) => {
    const key = String(prop);
    if (!allowed.has(key)) throw new Error(`Property access "${key}" not allowed`);
    return obj[key];
  };
```

If the compiler can resolve all bracket accesses to known property names,
`__extern_get` is never emitted at all.

### 5. Type-safe import wrappers

- String methods: coerce receiver with `String(s)` before calling the method,
  preventing Symbol.replace or coercion attacks on non-string arguments
- Extern class methods: the import is a direct closure over the specific method
  name, not a dynamic property lookup from the import name string
- Math: direct reference `Math.floor`, not `Math[name.slice(5)]`

## Tests

- All existing tests pass (update test helpers that build import objects)
- New: compile source with various imports, verify `result.imports` matches
- New: verify unlisted import name is absent from built object
- New: verify `__extern_get` rejects unlisted property names
- New: verify `string_constructor` is not callable unless declared

## Files

- `src/index.ts` — add `ImportDescriptor`, add `imports` to `CompileResult`
- `src/compiler.ts` — build manifest from `mod.imports`
- `src/runtime.ts` — new `buildImports()`, delete Proxies
- Tests — update helpers, add security tests

## Complexity

M — ~300 lines across 3-4 files
