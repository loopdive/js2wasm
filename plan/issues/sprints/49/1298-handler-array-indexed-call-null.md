---
id: 1298
sprint: 49
title: "Function-typed array values silently return null when invoked via index access"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, arrays, function-types
goal: npm-library-support
depends_on: []
related: [1297, 1244]
---
# #1298 — `Handler[]` / `Map<string, Handler>` / `{ [k: string]: Handler }` lose callability when retrieved by index

## Background

While implementing #1297 (Hono Tier 5 — App class) we discovered that
function-typed values stored in any *indexed* container (array, Map, or
indexed object) lose their callable nature when retrieved. The function
ref is stored without error, but invoking it through the index access
returns `null` (or null-derefs at runtime), as if the retrieved value
were a non-function externref.

## Reproductions

### Direct function-typed local — works ✓

```typescript
type Handler = (s: string) => string;
export function test(): string {
  const h: Handler = (s: string) => s + "!";
  return h("hello"); // → "hello!"
}
```

### Function-typed class field (single) — works ✓

```typescript
type Handler = (s: string) => string;
class M {
  h: Handler;
  constructor(h: Handler) { this.h = h; }
  call(): string { return this.h("hello"); }
}
export function test(): string {
  return new M((s: string) => s + "!").call(); // → "hello!"
}
```

### Function-typed array — broken ✗

```typescript
type Handler = (s: string) => string;
export function test(): string {
  const arr: Handler[] = [(s: string) => s + "!"];
  return arr[0]("hello"); // → null  (expected "hello!")
}
```

### Function-typed Map value — broken ✗

```typescript
type Handler = (s: string) => string;
class M {
  routes: Map<string, Handler> = new Map();
  add(k: string, h: Handler): void { this.routes.set(k, h); }
  call(k: string): string {
    const h = this.routes.get(k);
    if (h == null) return "NULL";
    return h("hello"); // → RuntimeError: dereferencing a null pointer
  }
}
```

### Function-typed indexed object — broken ✗

Same null-deref as the Map case for `routes: { [k: string]: Handler }`.

## Hypothesis

Function refs stored in array elements / Map values / index-signature
fields are likely coerced to `externref` / `anyref` on insertion to
match the homogeneous element type. On retrieval the value is read back
as `externref` instead of `funcref`, and the call site tries to invoke
the externref directly — yielding either null (when call returns a
default) or a null-pointer trap (when the runtime tries to dereference
the wrapped object).

The same pattern works for non-function types (string[], number[],
class instances) because struct refs / strings already round-trip through
externref via `extern.convert_any`. For functions we need either:

1. A `funcref` storage path for arrays/maps with function element types
   (preserves callability), or
2. A boxing scheme where function refs round-trip through externref but
   are unboxed to the typed funcref before the call (struct wrapper +
   `ref.cast` at the call site).

## Fix scope

- Detect function-typed element/value types in array literals,
  `Array.push`, `Map.set`, and index assignments
- Preserve funcref typing through `arr[i]`, `map.get(k)`,
  `obj[k]` retrieval when the static element type is a function
- Wire the indirect-call path (`call_ref`) through the retrieved funcref
  instead of trying to call the externref directly

## Files

- `src/codegen/expressions.ts` — array/map/index access, function call
  expression
- `src/codegen/index.ts` — Map.get / Array element type resolution

## Acceptance criteria

1. `arr[0]("x")` returns the correct string for `arr: Handler[]`
2. `m.get(k)("x")` returns the correct string for `Map<string, Handler>`
3. `obj[k]("x")` returns the correct string for indexed-object Handlers
4. Tier 5 #1297 tests `5a — single GET route dispatches` and
   `5d — three chained routes each dispatch to the right handler`
   pass without skip markers

## Why this matters

Hono, koa, express, nearly every JS routing library represents handlers
as a Map or array of functions. Without this, `App` cannot dispatch
real handlers. The Hono stress-test ladder cannot progress past Tier 5b
until this is fixed.
