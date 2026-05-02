---
id: 1274
title: "Hono Tier 2 stress test: route registration + basic dispatch via TrieRouter"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: classes, Map, closures
goal: npm-library-support
depends_on: [1267, 1268]
related: [1244, 1249, 1250]
---
# #1274 — Hono Tier 2 stress test

## Context

Tier 1 (#1244) passes: `splitPath`, `getPath`, `getMatcher` all compile and produce correct
output. Tier 2 is the next step: compile Hono's `TrieRouter` class, register routes via
`.add()`, and dispatch via `.match()`.

## Tier 2 patterns

```ts
// From hono/src/router/trie-router/router.ts (simplified)
import { Node } from './node.ts';

class TrieRouter<T> {
  #node: Node<T>;
  constructor() { this.#node = new Node(); }
  add(method: string, path: string, handler: T) {
    this.#node.insert(method, path, handler);
  }
  match(method: string, path: string) {
    return this.#node.search(method, path);
  }
}
```

Depends on:
- Private fields `#node` — done (#1249)
- `??=` in `Node.insert` — done (#1250)
- `obj[key] ??= value` on index-signature — blocked on #1268
- Side-effectful method calls not dropped — blocked on #1267

## Acceptance criteria

1. `router.add('GET', '/user/:id', handler)` compiles without error
2. `router.match('GET', '/user/42')` returns the correct handler + params
3. `tests/stress/hono-tier2.test.ts` covers static routes, parameterized routes, 404 miss
4. Any remaining compile errors documented as skip markers with issue refs
