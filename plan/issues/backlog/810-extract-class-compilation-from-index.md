---
id: 810
title: "Extract class compilation from index.ts → class-codegen.ts"
status: ready
created: 2026-03-26
updated: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: high
goal: maintainability
subtask_of: 688
---
# #810 — Extract class compilation from index.ts → class-codegen.ts

## What moves

~1,800 lines — class body compilation:

- `compileClassBodies` (line 12008, 731 lines)
- `collectClassDeclaration` (line 9495, 531 lines)
- `compileSuperCall` (line 12739)
- `resolveClassMemberName` (line 9482)
- `resolveGenericCallSiteTypes` (line 10026)
- `inferParamTypeFromCallSites` (line 10069)

## Validation

1. `npm test` must pass
2. Test: class declarations, inheritance, super calls, static methods, constructors
3. No behavior change

## Risk: MEDIUM

Class compilation touches struct registration (which stays in index.ts). The extracted functions will import struct-related helpers from index.ts. Need to verify no circular imports — `compileClassBodies` calls `compileFunctionBody` which is also in index.ts. May need to keep `compileFunctionBody` in index.ts or move both together.

## Complexity: M
