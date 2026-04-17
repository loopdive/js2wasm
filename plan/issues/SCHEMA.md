# Issue Metadata Schema

This repository treats issue frontmatter as the canonical source of truth for:

- issue identity
- current status
- sprint assignment
- historical created/completed dates
- classification for filtering and dashboards

Sprint markdown remains prose-first documentation. Issue tables inside sprint
files are generated from issue frontmatter and should not be edited manually.
Canonical issue files live under sprint-grouped folders in `plan/issues/`.
Status is expressed only in frontmatter, not in directory placement.

Current layout:

- numbered sprint issues: `plan/issues/sprints/<number>/<issue>.md`
- numbered sprint docs: `plan/issues/sprints/<number>/sprint.md`
- non-sprint buckets:
  - `plan/issues/backlog/`

## Canonical Frontmatter

Use this shape for real issue files:

```yaml
---
id: 1006
title: "Support eval via JS host import"
status: ready
sprint: 42
created: 2026-04-09
updated: 2026-04-09
completed: 2026-04-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: eval
goal: correctness
parent: 1000
depends_on: [1073]
blocked_by: external
---
```

## Required Fields

- `id`
  - Canonical issue identifier.
  - Usually numeric, for example `1006`.
  - Preserve historical alphanumeric suffixes where they are part of the real
    record, for example `797a`.
- `title`
  - Human-readable issue title.
- `status`
  - One of:
    - `backlog`
    - `ready`
    - `in-progress`
    - `review`
    - `blocked`
    - `done`
    - `wont-fix`
- `sprint`
  - Use a plain number for numbered sprints, for example `42`.
  - Use `0` for all pre-sprint historical work that predates Sprint 1.
  - Use `Backlog` only for the non-sprint backlog bucket.

## Historical Fields

- `created`
  - First known issue creation date in `YYYY-MM-DD`.
- `updated`
  - Last metadata/content update date in `YYYY-MM-DD` when maintained.
- `completed`
  - Completion date for `done` or `wont-fix` issues in `YYYY-MM-DD`.

## Classification Fields

- `priority`
  - `critical`, `high`, `medium`, `low`
- `feasibility`
  - `easy`, `medium`, `hard`
- `reasoning_effort`
  - `low`, `medium`, `high`, `max`
- `task_type`
  - One of:
    - `analysis`
    - `bugfix`
    - `feature`
    - `investigation`
    - `infrastructure`
    - `performance`
    - `planning`
    - `docs`
    - `refactor`
    - `test`
- `area`
  - Broad subsystem classification.
  - Optional until historically verified.
  - Suggested values:
    - `compiler`
    - `codegen`
    - `runtime`
    - `host-interop`
    - `testing`
    - `tooling`
    - `dashboard`
    - `website`
    - `planning`
    - `docs`
- `language_feature`
  - Dash-case feature tag, for example:
    - `eval`
    - `destructuring`
    - `iterators`
    - `esm-export-default`
    - `weak-references`
    - `compiler-internals`
    - `n/a`
  - Optional until historically verified.

## Normalization Rules

- `status`, `sprint`, and dates are canonical historical metadata and may be
  normalized automatically when backed by issue text, sprint docs, and git
  history.
- `task_type` may be alias-normalized:
  - `bug` → `bugfix`
  - `enhancement` → `feature`
  - `documentation` → `docs`
  - `infra` → `infrastructure`
  - `ui` → `feature`
- `area` and `language_feature` should be added conservatively.
  - If the historical record is unclear, leave them empty and surface the file
    in audit output instead of guessing.

## Relationship Fields

- `goal`
  - Canonical goal identifier.
  - Must match a markdown filename in `plan/goals/` without the `.md` suffix.
  - Example: `core-semantics` maps to `plan/goals/core-semantics.md`.
- `parent`
  - Optional numeric parent issue id.
- `depends_on`
  - Optional flat array of numeric issue ids.
- `blocked_by`
  - Optional blocker label or id.

## Provenance Fields

- `renumbered_from`
  - Optional original issue number when the historical record was split from an
    older duplicate-number ticket.

## Non-Issue Files

The following files are related planning artifacts but are not canonical issue
records:

- `plan/issues/SCHEMA.md`
- `plan/issues/AUDIT-2026-04-14.md`
- `plan/issues/backlog/backlog.md`
- `plan/log/issues-log.md`
- `plan/log/issues/82-findings.md`
- `plan/log/issues/analysis-2026-03-25.md`
- `plan/log/issues/sprint-1.md`
- `plan/log/issues/sprint-2.md`
- `plan/log/issues/sprint-3.md`
- `plan/log/retrospectives/*.md`

Any audit or dashboard tooling must exclude those files.

## Historical Caveat

Some historical records were reopened, superseded, or re-scoped over time. When
those later records had reused an older issue number, they were renumbered into
new unique ids and annotated with `renumbered_from`. Older issue numbers should
therefore be treated as provenance in historical docs, while current planning
and dashboards should use the canonical `id` in frontmatter.

Earlier historical labels such as `Session`, `Dep-driven`, `Wave`, and
`W6-Wave1` were normalized into synthetic sprint `0` so pre-sprint work can be
filtered consistently.
