---
id: 1285
sprint: 47
title: "Hono Tier 3 stress test — recursive TrieRouter with class-typed Node children"
status: blocked
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: test
area: tests
language_feature: classes, index-signature, recursion
goal: npm-library-support
depends_on: [1284]
related: [1244, 1274]
---

# #1285 — Hono Tier 3: recursive TrieRouter with class-typed Node children

## Problem

Hono's actual `TrieRouter` uses a recursive `Node` class:

```ts
class Node {
  #children: { [seg: string]: Node } = {};
  #handlers: number[] = [];

  insert(segments: string[], id: number): void {
    if (segments.length === 0) { this.#handlers.push(id); return; }
    const [head, ...tail] = segments;
    this.#children[head] ??= new Node();
    this.#children[head].insert(tail, id);
  }

  match(segments: string[]): number {
    if (segments.length === 0) return this.#handlers[0] ?? 0;
    const seg = segments[0];
    const rest = segments.slice(1);
    if (this.#children[seg]) return this.#children[seg].match(rest);
    if (this.#children[":*"]) return this.#children[":*"].match(rest);
    return 0;
  }
}
```

This is blocked by #1284 (class-typed dict values null-deref through `__extern_set/__extern_get`).
Once #1284 is fixed, this test documents the full recursive trie integration.

## Acceptance criteria

1. `tests/stress/hono-tier2.test.ts` Tier 2e block unskipped and passing (as part of #1284).
2. New `tests/stress/hono-tier3.test.ts` with a full recursive TrieRouter covering:
   - Static routes at depth 1, 2, 3
   - Parameterized routes (`:id` segments)
   - Wildcard fallback (`:*`)
   - `add` + `match` roundtrip with 10+ registered routes
   - Miss returns 0
3. No regression in Tier 1 or Tier 2a–2d tests.

## Blocked by

#1284 — class-typed dict round-trip fix.
