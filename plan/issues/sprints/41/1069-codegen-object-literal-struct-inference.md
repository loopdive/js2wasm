---
id: 1069
title: "codegen: object literal → struct inference fails on bundled JS config objects"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-14
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
language_feature: object-literals
goal: npm-library-support
parent: 1034
---
# #1069 — object literal → struct inference fails on bundled JS config objects

## Problem

Compiling `node_modules/prettier/doc.mjs` (prettier 3.8.1 bundled ESM, ~1.5K
lines) via `compile({ allowJs: true })` emits 11 diagnostics of the form:

```
Object literal type not mapped to struct
Cannot determine struct type for object literal
```

These object literals are config/options records in the doc-printer code
path — typically either plain `{ groupId, shouldBreak, ... }` shapes passed
as arguments to helper functions, or inline `{ type: "...", ... }` doc
nodes returned from factory functions.

The compile still "succeeds" (`result.success === true`, 107KB binary
produced) but the affected sites emit unknown/placeholder instructions,
which is one of the reasons the resulting binary fails Wasm validation at
runtime for unrelated functions.

## Context

In `allowJs` mode, TS infers wide or structural types for plain JS object
literals — often without a nominal interface anchor. Our codegen's
object-literal → `struct.new` mapping path requires a resolved named
struct type to pick a `typeIdx`; when it can't infer one from the context,
it falls back to either a `ref.null` placeholder or skips emission,
producing the two error strings above.

Prettier's bundled output is the first real-world codebase to hit this at
scale — 11 sites in ~1500 lines.

## Acceptance criteria

- [ ] `prettier/doc.mjs` compiles with 0 `Object literal type not mapped`
      and 0 `Cannot determine struct type` diagnostics
- [ ] Codegen falls back to an anonymous boxed-anyref struct shape (one
      `{ $key: anyref }` struct per distinct key-set) rather than emitting
      a placeholder when the contextual type is too wide
- [ ] Regression tests cover both the narrow path (typed `: MyInterface`)
      and the fallback path (untyped bundled JS output)

## Notes

- Surfaced by #1034 prettier stress run, 2026-04-11
- Report: `plan/log/issues/1034-report.md`
- Likely touches `src/codegen/expressions/object-literal.ts` and the
  struct-type-inference pass in `src/codegen/struct-types.ts`
- This is a **high-value** fix: removing it would give us 11 fewer
  diagnostics on prettier alone and likely unblock several test262
  `language/expressions/object/` patterns too

## Related

- Parent: #1034
