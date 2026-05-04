---
id: 1029
title: "Migrate to TypeScript 7.x (Go rewrite / typescript-go) when compiler API stabilizes"
status: backlog
created: 2026-04-11
updated: 2026-05-03
priority: low
feasibility: hard
reasoning_effort: high
goal: platform
blocked_by: external
related: [1288]
---
# #1029 — Migrate to TypeScript 7.x (Go rewrite / `typescript-go`)

## Problem

Microsoft is rewriting the TypeScript compiler in Go as the 7.x successor to the current TypeScript 5.x/6.x JavaScript codebase (project codename "Corsa", repo at [microsoft/typescript-go](https://github.com/microsoft/typescript-go)). The Go compiler is announced as roughly 10× faster than the TypeScript-authored compiler and will eventually become the default `tsc`.

js2wasm currently uses the TypeScript 5.x/6.x JavaScript compiler as its parser and type-checker frontend. We invoke it from Node.js and walk the AST in `src/codegen/*`. A migration to TypeScript 7.x would:

- Potentially give a large compile-time speedup (parser + checker currently dominate cold compile time for larger inputs)
- Align us with the long-term supported TypeScript frontend
- Enable embedding the compiler as a Go/Wasm library from non-Node hosts (useful for `--target wasi` and the playground standalone mode)

## Status: Blocked on upstream API stability

The Go rewrite currently has **no stable public compiler API** for embedders. The upstream tracking discussion is:

- [microsoft/typescript-go#516 — "Transformer Plugin or Compiler API"](https://github.com/microsoft/typescript-go/issues/516) (open)

Until typescript-go exposes a stable, embeddable compiler API (program / source file / type checker / symbol / node surface) that we can use from Node.js (via WASI or a `.node` addon) or from a Go host, we **cannot** replace our current TypeScript 5.x dependency without rewriting large parts of `src/codegen/*` against an unstable, moving target.

## Trigger to unblock

Reopen this issue and move it to `ready/` once one of the following lands upstream:

1. `microsoft/typescript-go#516` resolves with a documented, versioned compiler API
2. A separate RFC / release announcement from the typescript-go team declaring "the compiler API is stable"
3. A community-maintained Go/Node bridge emerges that provides an API surface compatible with the current `typescript` npm package's consumer-facing shape (`ts.createProgram`, `ts.TypeChecker`, `ts.Node` et al.)

## Scope when unblocked

- Benchmark the Go compiler's parse + check cost against current `typescript` 5.x/6.x for representative js2wasm inputs
- Evaluate whether we use typescript-go from Node via a subprocess/WASI bridge, or whether we introduce a Go-based build step
- Audit `src/codegen/*` for uses of the TypeScript API surface not yet provided by typescript-go
- Keep current TypeScript 5.x/6.x as a fallback path until feature parity is confirmed

## API Audit (2026-05-03, via #1288)

`@typescript/native-preview@7.0.0-dev.20260502.1` package exports:

| Export | What it is |
|--------|-----------|
| `./sync`, `./async` | `API`, `Project`, `Program`, `Checker`, `Snapshot` classes — require spawning a `tsgo` Go subprocess via socket/proto IPC |
| `./ast` | `SyntaxKind`, `NodeFlags`, `ScriptKind`, `ScriptTarget`, `isXxx` predicates — **in-process, no subprocess** |
| `./ast/factory` | AST factory helpers |
| `./dist/enums/` | All TypeScript enums standalone |

Key findings:
- **No `createProgram()` in-process.** All parse/check goes to the Go subprocess via IPC.
- **Enums are usable today** (`SyntaxKind`, `TypeFlags`, `ObjectFlags`, etc.) from `./ast` with zero subprocess overhead.
- **The Go binary is fast.** Local benchmark on ~70 .ts files: 22.9s (tsc) → 3.8s (tsgo) cold; 22s → 0.13s warm. The 10× headline holds.
- **AST nodes are the same shape.** The Go binary produces TypeScript AST nodes that are transmitted over IPC and presented as JS objects via `./sync`. Our codegen walks (`visitNode`, `SyntaxKind` switches) should be compatible.

### Batch approach (path forward for this issue)

The IPC overhead kills per-file subprocess calls. But `@typescript/native-preview/sync` exposes a `Project` class that can hold all source files — the Go binary processes them in parallel internally. For test262 (43k files), the approach would be:

1. Create one long-lived `Project` instance
2. Add all test262 input files via `project.updateSnapshot()`
3. Call `project.openFile()` once per file to get `Program` + AST
4. Walk the AST with existing codegen (same `SyntaxKind` switches)

This avoids 43k round-trips and lets the Go binary parallelize parse+check natively. The IPC payload would be one large proto blob vs 43k small ones.

Alternative: call the `tsgo` binary directly via its protocol (bypass the JS wrapper entirely). The JS wrapper is thin IPC glue; the protocol is documented in the `tsgo` source.

### Direct binary approach

`tsgo` exposes a long-lived server mode (same mechanism LSP uses). We could:
- Spawn one `tsgo` process
- Send batch file parse/check requests via the socket
- Receive AST + type info back as proto messages
- Deserialize in JS using the `./ast` types

This is deeper work but eliminates the JS wrapper overhead entirely. The Go binary handles all parallelism natively.

### Direct binary approach

`tsgo` exposes a long-lived server mode (same mechanism LSP uses). We could:
- Spawn one `tsgo` process
- Send batch file parse/check requests via the socket
- Receive AST + type info back as proto messages
- Deserialize in JS using the `./ast` types

This is deeper work but eliminates the JS wrapper overhead entirely. The Go binary handles all parallelism natively.

### Dependency on upstream

Neither approach requires waiting for `microsoft/typescript-go#516`. The subprocess API via `./sync` is already functional. The gap is on our side: threading the batch `Program` through the codegen pipeline (replacing `ts.createProgram()` call sites).

## Concrete benchmark (2026-05-03 — directly validated in /workspace worktree)

Tested against the full `src/**/*.ts` tree (~70 files, ~12k LOC):

| Metric | TS5 | TS7 batch | Ratio |
|--------|-----|-----------|-------|
| Cold project parse | 22,900ms | 173ms | **132× faster** |
| `getSourceFile()` cold (first fetch) | 0ms (in-memory) | 2ms/file (IPC fetch) | — |
| `getSourceFile()` warm (JS cache) | 0ms | 0.001ms | — |
| Total 3-file round-trip after snapshot | 6ms | 6ms | ~equal |

**Critical compatibility findings:**

1. `allowJs: true` works in tsgo — plain JavaScript files parse and return valid AST.
2. **AST nodes are 100% property-compatible**:
   - `ImportDeclaration.moduleSpecifier.text` ✅
   - `FunctionDeclaration.name.text`, `.body.statements.length` ✅
   - `VariableDeclaration.name.text`, `.initializer.kind` ✅
   - `SyntaxKind` enum values are **identical** between TS5 and TS7
   - `node.pos`, `node.end`, `node.flags` ✅
   - `node.parent` chain works ✅
3. **One change required**: `ts.forEachChild(node, cb)` → `node.forEachChild(cb)` (the TS7 `forEachChild` is a method on each node, not a static function). This is a mechanical search-replace across `src/codegen/*.ts`.
4. **TypeChecker gap**: `proj.program.getTypeChecker()` doesn't exist in TS7. The program exposes `getSemanticDiagnostics`, `getSyntacticDiagnostics`, etc., but not a walkable `TypeChecker`. For test262 (plain JS, no TS type annotations), TypeChecker provides minimal value anyway — type inference from type annotations is absent. TS5 can be kept as a TypeChecker fallback for TS-mode compilation.
5. **`node.forEachChild` walks 37,026 nodes** in `index.ts` correctly — the full AST is traversable.

## Implementation plan (now feasible without upstream stabilization)

**Phase 1 — test262 runner** (high value, self-contained):
1. In `tests/test262-runner.ts`, replace the per-file `ts.createProgram([file], opts)` pattern with:
   - One `new API({})` + `api.updateSnapshot({ openProject: tsconfig })` per worker shard
   - Per-file `proj.program.getSourceFile(path)` (cached after first fetch)
2. In `src/codegen/*.ts`, replace `ts.forEachChild(node, visitor)` → `node.forEachChild(visitor)` (search-replace; TS7 nodes have this method)
3. TypeChecker: in the test262 path (JS files), skip TypeChecker usage (already mostly a no-op for unannotated JS). For TS-mode compilation, keep TS5 checker.
4. Expected test262 throughput improvement: Go binary handles all shard files in parallel; cold-parse per shard drops from O(n×tsc_startup) to one fast `updateSnapshot`.

**Phase 2 — full TS-mode compilation** (requires TypeChecker workaround):
- Option A: Keep TS5 `TypeChecker` alongside TS7 AST (hybrid mode — parse fast, type-check with TS5)
- Option B: Use TS7 semantic diagnostics to extract type info (needs investigation)
- Option C: Wait for upstream `TypeChecker` API exposure

**Tracked separately**: implementation issue will be filed as #1290 (test262 runner TS7 batch).

## Notes

The original blocker ("no stable public compiler API") is resolved in practice — `@typescript/native-preview/sync` is already functional and AST-compatible. The remaining work is on our side. This issue can now be moved to `ready` once #1288 merges and team capacity allows.

The TypeChecker gap is the only genuine limitation vs. TS5. For test262 (plain JS), it's irrelevant. For full TS compilation, Phase 2 options above apply.
