---
id: 1244
title: "npm stress test: compile Hono web framework to Wasm"
status: done
created: 2026-05-02
completed: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: stress-test
area: codegen, runtime
language_feature: classes, closures, routing, middleware
goal: platform
related: [1031, 1034, 1243]
---
# #1244 — npm stress test: compile Hono web framework to Wasm

## Problem

We have lodash (#1031) and prettier (#1034) as npm stress tests. Hono adds a new coverage
dimension: **web framework semantics** — routing dispatch, middleware chains, TypeScript class
hierarchies, and Request/Response object handling. It runs on edge runtimes (Cloudflare Workers,
Deno, Bun) — which means zero Node.js APIs, pure compute + string manipulation. That profile is
close to what js2wasm targets.

Goal: establish a Hono tier breakdown and track it as a third npm library benchmark, analogous
to the lodash stress test.

## About Hono

- TypeScript-first, ESM, ~14 KB minified, zero external deps in core
- Routing: trie-based, regex support, dynamic segments (`:param`, `*`)
- Middleware: composable, async or sync
- Context: `c.req`, `c.res`, `c.json()`, `c.text()` — request/response helpers
- Uses classes, closures, Map/Set, `Symbol`, tagged template literals, `URLPattern`

## Tier breakdown (estimated)

| Tier | Coverage | Pattern | Likely pass rate |
|------|----------|---------|-----------------|
| 1 | Core router math (trie traversal, string matching) | Pure functions, closures, string ops | ~85% |
| 2 | Route registration + basic dispatch | Class constructors, Map-based routing table | ~65% |
| 3 | Middleware chain + Context object | Class hierarchy, closure captures, Symbol usage | ~40% |
| 4 | Full Request/Response handling | Web API objects, async/await, URL parsing | ~15% |

## Compiler gaps Hono is expected to expose

1. **`for...in` / `Object.keys` over compiled objects** (#1243) — context spread patterns
2. **`Symbol` as object key** — Hono uses Symbols internally for context slots
3. **Chained method calls on generics** — `app.get('/path', handler).post('/other', handler)`
4. **`URLPattern` or `URL` parsing** — host-import needed for Tier 4
5. **`instanceof` across compilation boundaries** — `c instanceof Context`
6. **Tagged template literals** in response helpers (minor)
7. **`async` route handlers** — Hono supports both sync and async middleware

## Acceptance criteria

1. A `tests/hono-stress.test.ts` file exists that imports a subset of Hono functions and
   verifies output correctness (analogous to `tests/lodash-stress.test.ts`).
2. Tier 1 (trie routing, path matching) compiles and produces correct results for at least
   5 representative route patterns.
3. Tier 2 (route registration, basic dispatch) compiles and correctly dispatches to a
   registered handler.
4. Known gaps beyond Tier 2 are documented as skip markers with issue references (not
   left as silent failures).
5. The test file is tracked in CI and a result line added to `plan/issues/sprints/47/sprint.md`
   with the tier coverage achieved.
6. Any new compiler gaps found that are not already tracked get filed as backlog issues.

## Implementation sketch

```ts
// tests/hono-stress.test.ts
import { compile } from '../src/index.ts';
import { test, expect } from 'vitest';

// Tier 1: pure path-matching utilities (extracted, no class dependency)
test('hono tier 1 — static route match', async () => { ... });
test('hono tier 1 — parameterized route match', async () => { ... });

// Tier 2: Hono class instantiation + .get()/.post() registration
test('hono tier 2 — route registration', async () => { ... });

// Tier 3: middleware + context (if #1243 lands first)
// test.skip('hono tier 3 — middleware chain', ...); // blocked on #1243
```

Start with Hono's `src/router/reg-exp-router/` or `src/router/trie-router/` as the most
self-contained entry point (pure data structures + string ops, no Web API dependency).

## Related

- #1031 — lodash stress test (established the tier-breakdown pattern)
- #1034 — prettier stress test
- #1243 — for...in / Object.keys enumeration (unblocks Hono Tier 3 context patterns)
- `plan/design/architecture/npm-stress-compiler-gaps.md` — lodash gap analysis template
