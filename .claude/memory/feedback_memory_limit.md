---
name: Limit concurrent agents to prevent OOM
description: Container has 15GB visible RAM. 8 test262 workers use ~7GB. Max 4 dev agents + test262, or 7 agents without test262.
type: feedback
---

Container has 15GB visible RAM (20GB cgroup, ~5GB kernel overhead). Each test262 worker uses ~1GB, dev agents use ~1-2GB each.

**Why:** Test262 runs keep getting OOM-killed when too many dev agents are running concurrently. Memory drops to <300MB and processes get killed.

**How to apply:**
- Max 4 dev agents when test262 is running (4 agents × 2GB + 8 workers × 1GB = 16GB — tight)
- Max 7 dev agents without test262 running
- Always check `free -h` before launching agents
- Restart test262 AFTER agents complete, not during
