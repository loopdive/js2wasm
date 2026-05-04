---
id: 1290
title: "perf: test262 runner — TS7 batch-parse via @typescript/native-preview (132× cold speedup)"
sprint: 49
status: done
created: 2026-05-03
updated: 2026-05-03
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: test-runner
goal: performance
related: [1029, 1288]
---
# #1290 — test262 runner: TS7 batch-parse via `@typescript/native-preview`

## Problem

The test262 runner calls `ts.createProgram([file], opts)` per test file. Each call starts a fresh
TypeScript 5.x program with a cold parse. At 43k test files with ~3 shards × ~1400 files each,
this parse overhead dominates runner wall-clock time.

## Opportunity

`@typescript/native-preview/sync` exposes a `Project` API where one `api.updateSnapshot()` call
causes the Go (`tsgo`) binary to parse **all files in the project in parallel**, then
`program.getSourceFile(path)` fetches each file's already-parsed AST (2ms cold, <0.001ms warm).

**Measured on `src/**/*.ts` (~70 files, 12k LOC):**

| | TS5 | TS7 |
|--|-----|-----|
| Cold project parse | 22,900ms | 173ms |
| `getSourceFile()` per-file (warm) | 0ms (in-proc) | ~0.001ms (JS cache) |

**132× faster cold-parse.** For test262, the shard-level speedup would be proportional —
each shard parses ~1400 files; the Go binary handles them in parallel.

## Compatibility (all validated 2026-05-03)

- `allowJs: true` works in tsgo — plain JS files parse correctly
- AST nodes are **property-compatible** with TS5:
  - `SyntaxKind` enum values: identical (ImportDeclaration=273, FunctionDeclaration=263, etc.)
  - Named properties: `node.moduleSpecifier.text`, `node.name.text`, `node.body.statements`, `node.pos`, `node.end`, `node.flags`, `node.parent` — all work
  - `statements` arrays on SourceFile, Block, etc. — work
- **One mechanical change**: `ts.forEachChild(node, cb)` → `node.forEachChild(cb)`  
  TS7 exposes `forEachChild` as an instance method on each AST node, not a static function.
  This is a search-replace across `src/codegen/*.ts` (~50 call sites).
- **TypeChecker gap**: `proj.program.getTypeChecker()` is not available in the TS7 API.
  For test262 JS files (no type annotations), TypeChecker is largely unused — type coercion
  falls back to `externref`. Keeping TS5 TypeChecker for TS-mode compilation is optional.

## Implementation plan

### Step 1 — per-shard API in test262 runner

In `tests/test262-runner.ts` (the worker-side function that processes a shard):

```ts
import { API } from '@typescript/native-preview/sync';

// In the shard worker init (called once per worker, not per file):
const api = new API({});
const tsconfig = writeTmpTsconfig(shardFiles, { allowJs: true, noEmit: true, checkJs: false });
const snap = api.updateSnapshot({ openProject: tsconfig });
const proj = [...snap.projectMap.values()][0];

// Per file (replaces ts.createProgram([file], opts)):
const sourceFile = proj.program.getSourceFile(filePath);
```

The `tsconfig` can be written as a temp file or passed via `files: [...]` in the snapshot API.

### Step 2 — replace `ts.forEachChild` in codegen

In `src/codegen/index.ts`, `src/codegen/expressions.ts`, `src/codegen/statements.ts`:

```ts
// Before:
ts.forEachChild(node, visitor);

// After:
(node as any).forEachChild(visitor);
// OR — add a helper:
function forEachChild(node: ts.Node, visitor: (n: ts.Node) => void) {
  if ((node as any).forEachChild) (node as any).forEachChild(visitor);
  else ts.forEachChild(node, visitor);
}
```

The `as any` cast is temporary until we can properly type the TS7 nodes. The TS7 `forEachChild`
signature is `node.forEachChild(cb: (child: Node) => void): void` — same as TS5's static form.

### Step 3 — TypeChecker handling

For test262 (JS files), TypeChecker calls mostly resolve to "don't know → externref". Two options:
- **Option A (quickest)**: Guard all `checker.*` calls with `if (checker)` and return `undefined`.
  This is already the behavior when TypeChecker can't resolve a type for a JS expression.
- **Option B (parallel)**: Keep a TS5 `ts.createProgram()` for TS-mode compilation, use TS7 for JS.

Start with Option A for test262.

### Step 4 — tsconfig generation for shards

The test262 runner already creates a `tsconfig.json` per run for the runner. Extend it to:
```json
{
  "compilerOptions": { "allowJs": true, "noEmit": true, "checkJs": false },
  "files": ["path/to/test1.js", "path/to/test2.js", ...]
}
```
Pass via `updateSnapshot({ openProject: tsconfigPath })`.

## Acceptance criteria

- [ ] `pnpm run test:262` runtime drops by at least 40% vs baseline (measured wall-clock)
- [ ] test262 pass count within ±5 of baseline (TS7 AST compatibility)
- [ ] No regressions in `tests/equivalence.test.ts`
- [ ] `ts.forEachChild` replaced with `node.forEachChild` (or a compatibility helper) across codegen
- [ ] TypeChecker fallback is clean — no uncaught errors when checker is null/unavailable
- [ ] The TS7 path is guarded by `JS2WASM_TS7=1` env or a tsconfig flag so TS5 remains the default

## Out of scope

- Full TypeChecker migration (Phase 2 of #1029)
- TS-mode compilation via TS7 (separate phase)
- Type annotation inference from TS7 semantic analysis

## Notes

This issue implements Phase 1 of #1029 and does NOT require `microsoft/typescript-go#516` to resolve.
The `@typescript/native-preview` package's `./sync` API is already functional for this use case.

`@typescript/native-preview` is already a devDependency (added in #1288). No new dependency needed.

The `--ts7` CLI flag from #1288 enables the TS7 backend; this issue wires the actual batch API into
the hot path of the test262 runner.

## Implementation status — phased

The full work is split into two PRs to keep risk surface manageable:

### Phase 1 (this PR — foundation)

- [x] Add backend-agnostic `forEachChild` helper to `src/ts-api.ts` that
      dispatches between TS5's static `ts.forEachChild` and TS7's instance
      method `node.forEachChild`. Identical signature; no behavior change for
      TS5.
- [x] Migrate all 23 `src/**` files using `ts.forEachChild(node, cb)` to use
      the helper. **97 call sites swapped.** TS5 path is unchanged (helper
      falls back to `ts.forEachChild` when no instance method is present).
- [x] Regression tests: `tests/issue-1290.test.ts` pins (1) helper iterates
      identically to `ts.forEachChild` on TS5 nodes, (2) early-return semantics
      preserved, (3) instance-method dispatch picks up TS7-shaped nodes,
      (4) compile() smoke test still passes end-to-end.

### Phase 2 (follow-up — runner integration)

The hot-path work — pre-batch parsing all shard files via
`api.updateSnapshot()`, threading a pre-parsed `SourceFile` into
`compileSource()` via a new `analyzeOptions.preParsedSourceFile`, gating the
runner path with `JS2WASM_TS7=1` — is deferred to a follow-up issue. Phase 1
ships the AST-iteration compat layer that makes Phase 2 unblockable.

The 40% wall-clock drop and ±5 pass-count target apply to Phase 2.
