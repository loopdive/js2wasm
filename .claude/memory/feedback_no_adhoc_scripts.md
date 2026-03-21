---
name: No ad-hoc scripts
description: Never write ad-hoc scripts (Python, node -e, etc.) — always use existing project scripts and tools
type: feedback
---

Never write ad-hoc scripts to do things the project already has scripts for. Use the existing code.

- Report generation: `npx tsx scripts/run-test262.ts` (writes JSONL + report JSON)
- Graph generation: `npx tsx plan/generate-graph.ts`
- Tests: `npm test`
- For reading/analyzing data: use the Read tool, Grep, or Bash with simple jq/wc/grep

**Why:** Ad-hoc scripts duplicate logic, introduce format mismatches, and break things. The existing scripts are the source of truth.

**How to apply:** Before writing ANY script, check if an existing one already does it. If it does, run that. If it doesn't, extend the existing script rather than writing a throwaway.
