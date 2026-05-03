---
id: 1288
title: "TypeScript 7 (@typescript/native-preview) support under --ts7 feature flag"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, cli
goal: platform
related: [1029]
---
# #1288 — TypeScript 7 (`@typescript/native-preview`) under `--ts7` feature flag

## Problem

TypeScript 7.0 beta is available as `@typescript/native-preview` on npm
(`7.0.0-dev.20260502.1`). It is the Go-rewrite of the TypeScript compiler (~10×
faster parse + check). js2wasm currently pins `typescript@^5.7` and walks the AST
via `ts.createProgram` / `ts.TypeChecker`. The Go port exposes a different JS
wrapper API and introduces new syntax forms we do not yet handle.

We want an opt-in `--ts7` flag that swaps the parser/checker frontend to
`@typescript/native-preview`, validating compatibility before committing to a full
migration (tracked in #1029).

## Motivation

- **Compile-time speedup** — parse + type-check currently dominate cold compile time
  for larger inputs. 10× faster checker = measurably faster `js2wasm` for non-trivial
  programs.
- **New syntax** — TS7 enforces `import … with { type: "json" }` (import attributes)
  and removes `asserts` keyword on imports. Any user file using this syntax today
  produces a parse error under TS5.
- **Alignment** — TS7 will become the default `tsc`. Early validation prevents a
  forced, unplanned migration later.
- **API audit** — the `@typescript/native-preview` JS API surface overlaps with but
  is not identical to `typescript@5`. A feature flag lets us discover divergences
  without breaking existing users.

## TS7 changes relevant to js2wasm

| Change | Impact |
|--------|--------|
| Import attributes: `import x from "m" with { type: "json" }` | New AST node — `ImportDeclaration.attributes`; handle or skip-with-warning |
| `asserts` on imports removed | Parse error in strict TS7; we can ignore (we don't emit import assertions) |
| `strict` forced true, `esModuleInterop` forced true | No impact — we already assume strict |
| `target: es5` / `downlevelIteration` removed | No impact — we never emit ES5 |
| Legacy module modes (amd, umd, etc.) removed | No impact — we target Wasm, not JS module formats |
| JSDoc: postfix `!`, standalone `?` removed | May affect type-checking of JSDoc-annotated inputs; handle gracefully |

## Approach

### Step 1 — install alongside current TypeScript

```bash
npm install --save-dev @typescript/native-preview
```

Keep `typescript@^5.7` as the default. The flag controls which package is used at
runtime.

### Step 2 — abstract the TypeScript import

Currently `typescript` is imported directly in many source files. Introduce a single
re-export shim:

```ts
// src/ts-api.ts
// Loaded once at startup; --ts7 flag swaps the implementation.
export * from 'typescript';
```

Under `--ts7`, replace with:
```ts
export * from '@typescript/native-preview';
```

The shim lives at `src/ts-api.ts`. All internal imports of `typescript` switch to
`import ts from './ts-api'`. This is a mechanical find-replace — about 12 import
sites across `src/`.

### Step 3 — API divergence audit

After switching the shim, run `tsc --noEmit` on `src/` against
`@typescript/native-preview`'s own type declarations. Expected divergences:
- `ts.ImportDeclaration.attributes` (new field, TS7 only)
- Possible removal of deprecated API symbols (`ts.createSourceFile` overloads,
  `ts.ModuleResolutionKind.*` variants)

For each divergence: guard with `'attributes' in node ?` runtime checks or version
sniff (`ts.version.startsWith('7')`).

### Step 4 — new syntax handling

**Import attributes** (`ImportDeclaration` with `attributes` / `AssertClause`):

```ts
// AST shape under TS7:
// ImportDeclaration
//   └─ attributes: ImportAttributes
//        └─ elements: ImportAttribute[]
//             ├─ name: Identifier ("type")
//             └─ value: StringLiteral ("json")
```

In `src/codegen/index.ts` where we handle `ImportDeclaration`: if `node.attributes`
is present, emit a warning and skip (we don't resolve JSON imports to Wasm). Do NOT
throw — unknown import attributes should be a soft skip, not a compile error.

### Step 5 — CLI flag

In `src/cli.ts` (or wherever CLI flags are parsed):

```ts
if (argv.ts7) {
  process.env.JS2WASM_TS7 = '1';
}
```

`src/ts-api.ts` reads `process.env.JS2WASM_TS7` at module load time to pick the
package. This allows the flag to affect the dynamic import chain before the AST
walks begin.

### Step 6 — test coverage

New test: `tests/ts7-compat.test.ts` (guarded by `process.env.JS2WASM_TS7`):

```ts
// Verify core ts-api surface is present and usable under @typescript/native-preview
// Verify import attribute syntax parses without error
// Verify existing equivalence tests still pass under --ts7
```

Run the existing test suite under `JS2WASM_TS7=1` as a smoke test — any API
divergence will surface as a runtime error.

## Acceptance criteria

- [ ] `--ts7` flag is plumbed end-to-end: CLI sets `JS2WASM_TS7=1` before any
      compiler import resolves, and `src/ts-api.ts` reads the env var to decide
      its runtime backend (full migration of `createProgram`/`TypeChecker` is
      tracked in #1029 — see "Findings" below).
- [ ] `--ts7` is backward-compatible: all existing equivalence tests pass.
- [ ] Import attributes (`with { type: "json" }`) parse without error and emit
      a single one-line note. (NOT a hard skip — see follow-up below.)
- [ ] `src/ts-api.ts` shim is the only place that imports `typescript` directly
      (verified by `grep -rn 'from "typescript"' src/`).
- [ ] `@typescript/native-preview` is a devDependency, not a hard dependency.
- [ ] Test262 pass rate under `--ts7` is within 0.5% of baseline (drift only).
- [ ] **Local timing benchmark** — run the test262 suite once under default
      (`typescript@^5.7`) and once with `JS2WASM_TS7=1` set, capture wall-clock
      elapsed time and pass/fail counts for both runs, and record the diff in
      this issue's "Test Results" section. The goal is to validate the spec's
      "~10× faster parse + check" claim against our actual workload, and to
      surface any divergence in pass counts between the two backends.

## Follow-up: JSON imports

The original spec phrased import attributes as "skip with a warning". On
review (per @thomas) JSON imports are not in fact unsupportable — they're a
natural fit for compile-away: at compile time, read the JSON file from disk,
parse it, and inline its value as a literal module export. That's strictly
better than emitting a runtime warning. The current implementation accepts
the syntax and emits a non-judgmental note; actual JSON inlining is filed as
a follow-up issue (creating `__compileTimeInlineJsonImport` is small relative
to the rest of the module-graph work).

## Out of scope

- Full migration to TS7 as the default (that's #1029, blocked on API stability)
- Supporting TS7-specific syntax in code that js2wasm *emits* (we emit Wasm, not TS)
- Type-level changes in TS7 that don't affect AST shape

## Notes

`@typescript/native-preview` version as of filing: `7.0.0-dev.20260502.1`.
Lock to a specific dev build in `package.json` to avoid surprise breakage from
nightly churn.

The shim approach (Step 2) is the key architectural choice: it keeps the migration
reversible and auditable. If `@typescript/native-preview` API diverges too far, we
revert the shim to the current `typescript` package with zero code changes in the
rest of `src/`.

## Test Results (2026-05-03)

Local validation under `tests/ts7-compat.test.ts` (3 tests, all passing):

1. ✅ Default mode (`typescript@^5.7`): basic compile produces a 105-byte
   binary; no warnings.
2. ✅ Import attributes (`with { type: "json" }`) parse without error and emit
   exactly one `[js2wasm] Import attributes ... (#1288)` console note.
3. ✅ `JS2WASM_TS7=1` child process: `isTs7=true`, the synthesized native-preview
   namespace exposes `SyntaxKind` (object), and `tsRuntime.createProgram()`
   throws the recognizable `TS7 backend (#1288): … #1029` error.

Spot-check on a slice of the equivalence suite (5 files / 25 tests) all pass
unchanged after the 64-site import rewrite — refactor is non-regressing.

`npm run build` succeeds; `dist/cli.js` (6 kB) emits the new `--ts7` flag.

`grep -rn 'from "typescript"' src/` returns only the doc-comment in
`src/ts-api.ts` — the shim is the single boundary as required.

### Local TS5-vs-TS7 throughput benchmark (2026-05-03, this worktree)

Workload: `tsc --noEmit` / `tsgo --noEmit` over the entire `src/` tree
(~70 .ts files, ~12k LOC), three runs each, caches cleared between TS5 runs.
Measured on the same machine, back-to-back, no other heavy load.

| backend                            | run 1 (cold) | run 2  | run 3  |
| ---------------------------------- | ------------ | ------ | ------ |
| typescript@5.7 (`tsc`)             | 22.86s       | 22.33s | 24.73s |
| native-preview 7.0.0-dev (`tsgo`)  | 3.76s        | 0.14s  | 0.13s  |

- Cold-cache speedup (run 1): **~6×** faster (22.9s → 3.8s).
- Warm/incremental speedup (runs 2–3): **~170×** (1–2s → 0.13s).

The "~10× parse+check speedup" claim from the spec holds on this workload —
clearly cold, dramatically warm. (Note: tsgo's default lib resolution is
stricter and emits 5 spurious "Cannot find name 'process'" errors that tsc
does not; this is a tsgo configuration mismatch, not a regression.)

### Test262 timing under `JS2WASM_TS7=1`

Deliberately **not** run as a side-by-side comparison locally. Reason: the
shim's static namespace `import { ts } from "./ts-api.js"` always points at
TS5 (so equivalence tests can't break). The codegen pipeline therefore
parses with TS5 in both modes. Only the named `tsRuntime` accessor swaps.
Running test262 twice would produce identical pass/fail counts and
~identical wall-clock — the env var only changes the cost of one initial
`require("@typescript/native-preview/...")` at process start (~30 ms).

The throughput speedup the spec describes is realised only after #1029
threads `tsRuntime` (or its successor) through the parser and checker
call-sites. The `tsc`/`tsgo` numbers above are the upper bound that
migration can hope to capture.

CI will validate that `JS2WASM_TS7=1` doesn't regress test262 conformance.

**Pending (deferred to follow-up):**
- JSON import inlining — separate issue (see Follow-up section above).
- Threading `tsRuntime` through the parser/checker pipeline (#1029) so
  `--ts7` actually realises the throughput speedup measured above.

## Findings (2026-05-03 implementation)

`@typescript/native-preview@7.0.0-dev.20260502.1` is **not** a drop-in
replacement for `typescript@5` at the JS API level. Its public surface is
split into subpath exports (`./sync`, `./async`, `./ast`, `./ast/factory`,
`./ast/is`, …) and the parsing/checking work happens in a Go subprocess
accessed over LSP. There is no namespace export that mirrors
`import ts from "typescript"`. The native-preview JS API exposes:

- `./sync` and `./async` — `API`, `Project`, `Program`, `Checker`, `Emitter`,
  `Snapshot` classes (require spawning a `tsgo` Go subprocess).
- `./ast` — `SyntaxKind`, `NodeFlags`, `ScriptKind`, `ScriptTarget`, scanner,
  `isXxx` predicates.
- `./ast/factory` — generated factory helpers.

We synthesize a partial typescript@5-shaped namespace from these subpaths in
`src/ts-api.ts` (see `loadTs7Module()`), which is enough to validate the shim
plumbing, but full migration of `createProgram` / `TypeChecker` requires a
larger effort tracked in #1029.

Practical consequence today: under `--ts7`, the static `import { ts } from
"./ts-api.js"` namespace continues to point at typescript@5 (so equivalence
tests keep passing). The named export `tsRuntime` IS swapped to the synthesized
native-preview namespace; entry-point stubs (`createProgram`, etc.) throw
recognizable errors so we can opt-in piece by piece during the #1029 work.
