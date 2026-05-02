---
id: 1249
title: "class private fields and methods (#name syntax) — PrivateIdentifier codegen"
status: done
created: 2026-05-02
completed: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: max
task_type: feature
area: codegen
language_feature: classes, private-fields
goal: npm-library-support
related: [1244]
---
# #1249 — Class private fields and methods (`#name` syntax)

## Problem

TypeScript/ES2022 class private fields (`#methods`, `#children`, `#params`) currently cause a
compile error. This blocks Hono Tier 2+ since `TrieRouter` and `Node` use them extensively.

Example from Hono's trie-router:
```ts
class Node {
  #methods: Array<Readonly<Result<T>>> = [];
  #children: Record<string, Node<T>> = {};

  addRoute(method: string, path: string, handler: T): void {
    this.#children[method] ??= new Node();
  }
}
```

Private fields use `PrivateIdentifier` AST nodes in TypeScript's AST — the current codegen
does not handle `PrivateIdentifier` in member access expressions or class field declarations.

## Expected behavior

Private fields should compile to WasmGC struct fields, since the storage model is identical
to regular fields — private semantics are a TypeScript/JS concept enforced at the language
level, not at the Wasm level. The `#name` identifier just needs to be treated as a regular
(non-colliding) field name in the struct layout.

## Implementation sketch

1. In `src/codegen/expressions.ts`, handle `PropertyAccessExpression` where the name is a
   `PrivateIdentifier` — treat `this.#foo` as `this.__private_foo` (mangle the name to avoid
   collision with any public field `foo`).
2. In `src/codegen/index.ts` class layout pass, treat `ClassElement` with `PrivateIdentifier`
   names the same as regular property elements — allocate a struct field.
3. Private methods: treat as regular methods in the vtable/function-table, using the mangled name.
4. The mangling should be consistent: `#foo` → `__priv_foo` throughout.

## Acceptance criteria

1. Minimal class with `#field` compiles and accesses correctly.
2. `tests/issue-1249.test.ts` covers private field read/write and private method call.
3. Hono's `Node` class with `#methods` and `#children` gets past the compile error.
4. No regression in `tests/equivalence/` class tests.

## Related

- #1244 — Hono stress test; Tier 2 blocked on this
- #1250 — logical assignment operators (Tier 2 blockers)

## Resolution

Investigation showed that the support is **already implemented**
end-to-end. Codegen layers (`binary-ops`, `class-bodies`, `expressions`,
`expressions/assignment`, `typeof-delete`, `property-access`) all
consult `ts.isPrivateIdentifier` and mangle `#foo` -> `__priv_foo`
consistently before lowering to struct fields or method dispatch.

This PR formalizes the support with regression-guard tests in
`tests/issue-1249.test.ts`:

- Private field read after default init
- Private field write then read
- Private + public field side-by-side (no name collision via mangling)
- Private method called from public method (`this.#m()`)
- Chained private method calls (`this.#a(this.#b(x))`)
- Private array field with `.push()` / `.length` (Hono Node-like pattern)
- Multiple private fields used together (state encapsulation)

All 7 tests pass against the existing implementation; no codegen
changes needed.

## Side findings (separate follow-up to file)

While writing the tests, I discovered an unrelated optimizer bug:
**method calls in expression-statement position get dropped** when
the result is unused, even when the method has side effects (e.g.
mutates `this.#count`). Reproduces with both public and private
fields, so it's not specific to private-field support. The third
call's return shows up as the FIRST call's result; the WAT confirms
only one `call` instruction is emitted for the body. This affects
#1244 (Hono) patterns where method side-effects matter and merits
its own issue.
