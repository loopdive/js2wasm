---
id: 1144
title: "Static class elements: this.#priv access inside static methods uses wrong receiver"
status: done
created: 2026-04-20
updated: 2026-04-20
completed: 2026-04-20
priority: medium
feasibility: medium
reasoning_effort: medium
goal: spec-completeness
---
## Problem

Private field access (`this.#priv`) inside static class methods resolved the receiver incorrectly, causing Wasm null traps or wrong values. Static methods receive the class constructor as `this`, not an instance — the codegen path did not account for this.

## Acceptance Criteria

- [x] `this.#priv` inside a static method resolves correctly via the class object
- [x] test262 static private field access tests pass

## Implementation

Merged via PR #204 (branch `issue-class-elements-static`). Follow-up static private getter fix also in PR #158.
