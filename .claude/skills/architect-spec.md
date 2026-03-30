---
name: architect-spec
description: Write an implementation spec for a hard issue. Read compiler source, identify exact functions/lines, design the fix, document edge cases.
---

# Write Implementation Spec

Any agent can use this skill to produce an architect-quality implementation plan for an issue.

## Steps

1. Read the issue file at `plan/issues/ready/{N}.md`

2. For each sub-pattern in the issue, find the codegen function:
```bash
# Search for relevant function names
grep -n "function compile.*{keyword}" src/codegen/*.ts
# Or search for the Wasm instruction that's wrong
grep -n "{wasm_op}" src/codegen/*.ts
```

3. Read the function and understand current behavior (what it emits and why it's wrong)

4. Design the fix — what instructions should be emitted instead

5. Write the spec in the issue file under `## Implementation Plan`:

```markdown
## Implementation Plan

### Root cause
[1-2 sentences]

### Work Item {letter}: {title} (~{N} CE)
**Patterns addressed**: {which sub-patterns from the breakdown}
**Risk**: {Low|Medium|High} — {why}
**Priority**: {1st|2nd|3rd}

#### Root cause
{specific function and line that emits wrong instructions}

#### Changes
**File: `src/codegen/{file}.ts`**
- Function `{name}` (line ~{N})
- {what to change and why}

#### Edge cases
- {case 1}
- {case 2}

#### Test
{specific test262 file to verify: before fix = CE, after fix = pass or runtime error}
```

6. Recommend which work items to do first (highest impact, lowest risk)

## Principles

- Every fix should be ~10-20 lines, purely additive
- No new repair passes — extend existing logic
- No instruction stream restructuring
- Each work item independently testable
- Prefer compile-time fixes over post-hoc repairs
