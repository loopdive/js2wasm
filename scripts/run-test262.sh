#!/bin/bash
# Full test262 pipeline with logging
# Usage: ./scripts/run-test262.sh

set +e  # don't exit on vitest "failure" (test failures are exit code 1)
LOGFILE="/workspace/benchmarks/results/test262-run.log"

log() { echo "$@" | tee -a "$LOGFILE"; }

echo "" > "$LOGFILE"
log "=== test262 run started at $(date) ==="
log "Git: $(git rev-parse --short HEAD)"

log ""
log "=== PRECOMPILE ==="
START=$(date +%s)
npx tsx scripts/precompile-tests.ts 2>&1 | tee -a "$LOGFILE"
END=$(date +%s)
log "Precompile took $((END - START))s"

log ""
# Truncate results JSONL before vitest (prevents duplicates from multi-fork writes)
> /workspace/benchmarks/results/test262-results.jsonl
log "=== VITEST ==="
START=$(date +%s)
npx vitest run tests/test262-chunk*.test.ts >> "$LOGFILE" 2>&1
END=$(date +%s)
log "Vitest took $((END - START))s"

log ""
log "=== RESULTS ==="
python3 -c "
import json
d = json.load(open('/workspace/benchmarks/results/test262-report.json'))
s = d['summary']
print(f'Total: {s[\"total\"]}')
print(f'Pass:  {s[\"pass\"]}')
print(f'Fail:  {s[\"fail\"]}')
print(f'CE:    {s[\"compile_error\"]}')
print(f'Skip:  {s[\"skip\"]}')
print(f'Rate:  {s[\"pass\"]/s[\"total\"]*100:.1f}%')
" | tee -a "$LOGFILE"

log ""
log "=== Finished at $(date) ==="
