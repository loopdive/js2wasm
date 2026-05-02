---
id: 476
title: "Narrow hasOwnProperty.call skip — 647 tests"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: property-model
---
# #476 — Narrow hasOwnProperty.call skip (647 tests)

647 tests skipped for "Object.prototype.hasOwnProperty.call not supported". Many tests use `hasOwnProperty.call(obj, key)` just to check property existence — the same as `obj.hasOwnProperty(key)` which is implemented (#341). Narrow the filter to only skip tests using the indirect `Object.prototype.hasOwnProperty.call` pattern on non-struct objects.
