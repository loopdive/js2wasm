---
id: 479
title: "Narrow wrapper constructor skip — 155 tests"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: contributor-readiness
---
# #479 — Narrow wrapper constructor skip (155 tests)

155 tests still skipped for "uses wrapper constructor". Issue #344 made wrapper constructors return primitives, but the skip filter may still be catching some tests. Check if the filter is stale or if these tests genuinely need typeof === "object" behavior.
