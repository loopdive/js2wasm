---
id: 1285
title: "Hono Tier 3 stress test — recursive TrieRouter with class-typed Node children"
status: in-progress
created: 2026-05-02
updated: 2026-05-03
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

~~#1284 — class-typed dict round-trip fix.~~ Resolved 2026-05-02 (PR #182).

## Resolution (2026-05-03)

`#1284` landed (PR #182): `collectUsedExternImports` now suppresses
`${ClassName}_new` host-import registration whenever a user
`ClassDeclaration` / `ClassExpression` of that name appears in source,
preventing the funcMap aliasing that caused `new Node(42)` to lower to
`call __extern_set(...)`. With that fix, the recursive TrieRouter
exercised in this issue compiles and runs end-to-end.

### Tests added

- `tests/stress/hono-tier3.test.ts` — 6 `it` blocks covering:
  - Tier 3a — static routes at depth 1, 2, 3
  - Tier 3b — root path match (empty-segment edge case)
  - Tier 3c — parameterized segments (`:id`, `:name`, `:cid`) at varying depths
  - Tier 3d — wildcard fallback (`*`) consuming any remainder
  - Tier 3e — misses return 0 (unknown top-level + over-deep)
  - Tier 3f — full add+match roundtrip with 11 routes + 3 misses
- `tests/stress/hono-tier2.test.ts` Tier 2e — unskipped; now runs the
  smallest reproducer (`addChild` + `getChild` on
  `#children: { [s: string]: Node }`) as a permanent regression
  sentinel.

All Hono tier tests (14 / 14) pass: Tier 1 ×3, Tier 2 a–e ×5, Tier 3 ×6.
