---
id: 1312
sprint: 50
title: "Async recursive function (next() compose pattern) — Unhandled rejection"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, runtime, async, closures
language_feature: async, closures, recursion
goal: npm-library-support
related: [1309, 1306]
---
# #1312 — Async recursive closure pattern fails with Unhandled rejection

## Background

Surfaced during #1309 Slice A investigation. The Hono compose pipeline
uses an inner `async function next()` that recursively invokes
itself through middleware that takes `next` as a parameter. The
pattern fails with an "Unhandled rejection" runtime error. Sequential
non-recursive async calls work; the recursion is the trigger.

## Reproducer

```ts
type Next = () => Promise<string>;
type Mw = (c: Context, next: Next) => Promise<string>;

class Context {
  path: string;
  constructor(path: string) { this.path = path; }
}

function compose(mws: Mw[]): (c: Context) => Promise<string> {
  return async (c: Context) => {
    let i = 0;
    async function next(): Promise<string> {
      const idx = i;
      i = i + 1;
      if (idx >= mws.length) return "end";
      const mw = mws[idx];
      return await mw(c, next);   // mw closes over next; eventually calls next() again
    }
    return await next();
  };
}

export async function test(): Promise<string> {
  const mws: Mw[] = [
    async (c: Context, n: Next) => "[A]" + await n(),
    async (c: Context, n: Next) => "[B]" + await n(),
  ];
  const handler = compose(mws);
  return await handler(new Context("/x"));
}
// expected: "[A][B]end"
// actual: Unhandled rejection
```

Verified working (no recursion):

```ts
type Mw = (s: string) => Promise<string>;
const mws: Mw[] = [
  async (s) => "[A]" + s,
  async (s) => "[B]" + s,
];
export async function test(): Promise<string> {
  const a = await mws[0]("end");
  const b = await mws[1](a);
  return b;
}
// works → "[B][A]end"
```

## Hypothesis

`next` is captured as a closure variable inside the outer arrow.
Inside the inner `async function next()`, the `i` variable is
captured by ref-cell for mutation. When `mw(c, next)` is called, `mw`
itself captures `next` and re-invokes it.

Possible causes:
- The `next` funcref captured by `mw` may be stale / null at
  invocation time — the closure struct for `next` may not be fully
  initialized when stored as a capture.
- Async + recursion may interact badly with the ref-cell capture
  for `i`. The mutation `i = i + 1` runs before the recursive call
  returns; if the ref-cell isn't writable, subsequent calls see
  stale `i`.
- The Promise wrap on `next()` return might be double-applied or the
  recursion may hit the wasm call stack limit if `next()` is
  inadvertently spinning.

## Investigation steps

1. Add minimal recursive async without middleware indirection:
   ```ts
   async function f(n: number): Promise<number> {
     if (n <= 0) return 0;
     return n + await f(n - 1);
   }
   ```
   If this fails, the issue is async recursion itself.
2. Add recursion-via-parameter: pass a function as parameter and
   call it recursively. If this works but compose doesn't, the issue
   is in capturing `next` by closure-closure-over.
3. Inspect the closure struct for `next` — verify `next.func` is
   non-null when `mw(c, next)` is invoked.
4. Bisect on `let i = 0` mutation — replace with `const i =
   computeOnce()` to remove the ref-cell.

## Acceptance

- The compose reproducer above returns `"[A][B]end"`.
- `tests/issue-1312.test.ts` covering: simple async recursion, async
  recursion via parameter, and the full Hono compose shape.
- Empty + short-circuit cases continue to pass (already verified
  working in `tests/stress/hono-tier6.test.ts`).

## Why this is separate from #1309 Slice A

This bug is in the closure-capture / async-recursion interaction.
The architect's `isAsyncCallExpression` fix doesn't touch closure
struct creation or ref-cell handling. Separate root cause.
