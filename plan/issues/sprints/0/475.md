---
id: 475
title: "Narrow negative test skip — 892 tests improperly classified"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: error-model
---
# #475 — Narrow negative test skip (892 tests)

892 tests are skipped as "negative test" but #402 and #418 already improved negative test handling. Investigate why these are still skipped — the `shouldSkip` or `handleNegativeTest` logic may have a gap. Many negative tests should now be properly classified (PASS if compilation fails with expected error, FAIL if it succeeds).
