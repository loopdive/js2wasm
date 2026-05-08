# architect-s51 — sprint 51 spec-gap planning session

**Session**: 2026-05-08
**Role**: Software Architect
**Status**: Done — work delivered, shutting down per team-lead

## Mandate

Team-lead requested 12–16 spec-gap issue files for sprint 51 in
`/workspace/plan/issues/sprints/51/`, IDs starting at #1358. Issues had to
include full `## Implementation Plan` sections (file:function targets, Wasm IR
patterns, edge cases, test262 acceptance lists, impact estimates).

Constraints:
- One dev × 2–4 days per issue.
- Depth over breadth (no vague "Array methods" buckets).
- Don't duplicate sprint 50 issues #1334–#1351.

## What was delivered

**17 issues** (committed — team-lead confirmed all 16 + the late-add #1381).
IDs 1358–1369, 1377–1381 (skipping 1370–1376 which were already taken by the
IR-track work in sprint 51).

Per-issue summary already lives in the issue files themselves; the high-level
roll-up I sent team-lead:

| ID    | Area                                | Est. impact |
|-------|-------------------------------------|-------------|
| 1358  | Array.prototype callbacks on .call  | +300–400    |
| 1359  | Array.{splice,slice,concat} species | +100        |
| 1360  | Array.{indexOf,lastIndexOf,includes}| +130        |
| 1361  | Array.sort comparator + stability   | +30         |
| 1362  | Object.defineProperties             | +250        |
| 1363  | class dstr null/undefined           | **+450**    |
| 1364  | class elements descriptor fidelity  | **+450**    |
| 1365  | class private + brand checks        | +50–80      |
| 1366  | class subclass + builtins           | +100        |
| 1367  | Iterator helper protocol invariants | +170        |
| 1368  | Promise.{all,allSettled,any,race}   | +50–70      |
| 1369  | String split/replace/replaceAll     | +90         |
| 1377  | Array push/pop/shift/unshift/fill   | +50         |
| 1378  | try/catch/finally completion        | +60         |
| 1379  | unary ++/-- ToNumeric               | +30         |
| 1380  | equality (==/===) Symbol/BigInt     | +40         |
| 1381  | String substring/slice/indexOf etc. | +90         |

**Total estimated**: ~+2,580 raw, ~+1,500–1,800 net after discount.
Pushes test262 from 28,116/48,171 (58.4%) toward ~62%.

## Key calls made (so a successor doesn't redo them)

1. **Skipped IDs 1370–1376** because the IR-track issues already occupy them in
   sprint 51 (`1370-ir-class-methods-constructors.md`, etc.). Don't reuse.
2. **Trimmed 4 issues during the first round** (Object.create properties map,
   module error binding, Set methods further fidelity, String scalar accessors)
   because the constraint was 12–16. Of those, **only the String scalar one
   (#1381)** was restored on team-lead's request — the other three remain
   undrafted on disk.
3. **Did NOT re-do Object.defineProperty single-descriptor (#1334)**.
   #1362 is the *map-application* sibling. They share the same descriptor
   storage runtime work (cross-link in #1364 too).
4. **Did NOT re-do Iterator wasm_compile errors** — sprint 50's #1340 already
   owns those. #1367 is the protocol-invariant assertion_fail bucket only.
5. **Did NOT touch §16 modules** — sprint 50 has no module issue, but it's
   `feasibility: hard` with low ROI and the parser/loader work is large; left
   for a focused future sprint.

## Workspace context

- Worked from `/workspace` directly on `main` (team-lead waived isolation since
  files are docs-only and team-lead controlled the merges).
- Issue files are committed (per team-lead's last message).
- No code touched. No tests run.

## Recommended pickup for next architect session

1. **#1334 + #1364 are coupled** — devs should pair them. Architect could write
   a joint design note describing the shared descriptor-table struct.
2. **§16 modules** still uncovered — needs ~1–2 issues:
   cyclic eval error binding, import-attributes, block-scoped fn declarations
   in strict mode. Hard.
3. **§28.1 Reflect** (sprint 50 #1345 partial) and **§28.2 Proxy** (21.5%)
   could be next-sprint targets if the team can afford a Proxy implementation.
4. **§25.5 JSON** (53%) has bucket left after #1341.
5. **Annex B** (51%) has cleanup opportunities — `escape`, `unescape`, html
   wrapper functions, `String.prototype.substr`.

## Files written this session

```
plan/issues/sprints/51/1358-spec-gap-array-callback-methods-on-array-like-receivers.md
plan/issues/sprints/51/1359-spec-gap-array-splice-slice-concat-species-and-sparse.md
plan/issues/sprints/51/1360-spec-gap-array-indexof-lastindexof-includes-strict.md
plan/issues/sprints/51/1361-spec-gap-array-sort-comparator-stability.md
plan/issues/sprints/51/1362-spec-gap-object-defineproperties-property-map.md
plan/issues/sprints/51/1363-spec-gap-class-dstr-runtime-cannot-destructure-null.md
plan/issues/sprints/51/1364-spec-gap-class-elements-method-descriptor-fidelity.md
plan/issues/sprints/51/1365-spec-gap-class-private-fields-and-brand-checks.md
plan/issues/sprints/51/1366-spec-gap-class-subclass-builtins-and-prototype-chain.md
plan/issues/sprints/51/1367-spec-gap-iterator-helpers-protocol-invariants.md
plan/issues/sprints/51/1368-spec-gap-promise-all-allsettled-any-race-resolver-element.md
plan/issues/sprints/51/1369-spec-gap-string-split-replace-replaceall-limit-symbol-protocol.md
plan/issues/sprints/51/1377-spec-gap-array-prototype-pop-shift-unshift-push-fill-mutating.md
plan/issues/sprints/51/1378-spec-gap-try-catch-finally-completion-and-error-fidelity.md
plan/issues/sprints/51/1379-spec-gap-unary-incdec-on-null-undefined-string.md
plan/issues/sprints/51/1380-spec-gap-equality-symbol-bigint-and-reference-error-propagation.md
plan/issues/sprints/51/1381-spec-gap-string-prototype-substring-slice-index-accessors.md
```
