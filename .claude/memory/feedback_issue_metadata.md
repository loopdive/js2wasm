---
name: Issue metadata is mandatory
description: Every issue frontmatter must include lifecycle dates plus ES edition, language feature, and task type.
type: feedback
---

Every issue file in `plan/issues/` must include machine-readable metadata in
frontmatter, not just prose in the body.

Required fields:
- `created: YYYY-MM-DD`
- `updated: YYYY-MM-DD`
- `completed: YYYY-MM-DD` for done issues only
- `es_edition: <edition | multi | n/a>`
- `language_feature: <normalized-feature-slug>`
- `task_type: <bug | feature | test | refactor | planning>`

Why:
- dashboarding and backlog slicing need structured metadata
- sprint reporting should distinguish bug fixes from features/tests/planning
- edition/feature tagging makes it possible to answer “what ES2020 issues remain?”

Rules:
- `created` stays stable
- `updated` changes whenever issue content meaningfully changes
- `completed` is added on closure
- `language_feature` should be normalized and stable enough for machine filters
