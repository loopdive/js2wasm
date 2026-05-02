---
id: 791
title: "- SyntaxError detection gaps: code compiles when it should not"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: medium
goal: spec-completeness
---
# #791 -- SyntaxError detection gaps: code compiles when it should not

## Implementation summary

Extended `detectEarlyErrors()` in `src/compiler.ts` with new checks: "use strict" + non-simple parameters, labeled declarations, eval/arguments as binding names in strict mode, switch case duplicate lexical declarations, static prototype, duplicate private names, let/const in single-statement positions. Also fixed `handleNegativeTest()` in test runner to add "use strict" prefix for `onlyStrict` tests.

Estimated 2,690 test262 improvements.
