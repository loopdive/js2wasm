---
id: 478
title: "assert.throws side-effect assertions — 342 tests"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: error-model
---
# #478 — assert.throws side-effect assertions (342 tests)

342 tests are skipped because they use `assert.throws` with side-effect-dependent assertions that our current shim doesn't handle. The #397 shim calls the function and catches errors but doesn't verify the error type or check side effects after the throw. Narrow the skip filter or enhance the shim.
