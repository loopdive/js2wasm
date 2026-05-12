# §14.7.5 for / for-in / for-of / for-await-of

**Spec**: https://tc39.es/ecma262/#sec-for-in-and-for-of-statements
**Status**: ⚠️ partial
**Test262 categories**: `language/statements/for`, `language/statements/for-in`, `language/statements/for-of`, `language/statements/for-await-of`
**Coverage**: 1495 / 2485 pass (60.2%) — 990 fail, 0 skip
**Top error buckets**: assertion_fail=703, other=86, null_deref=69

## What the spec requires

for: counted loop. for-in: enumerate own + inherited keys via Object.keys / host. for-of: GetIterator + loop. for-await-of: same with await on each Next.

## Current implementation

Files / runtime imports involved:

- `src/codegen/statements.ts (compileForStatement)`
- `src/codegen/expressions.ts`

## Gap

for-of fails on iterables that throw inside next() — IteratorClose isn't called in some paths. for-await-of fails on null_deref (50) and illegal_cast (36) — likely missing externref guards.
