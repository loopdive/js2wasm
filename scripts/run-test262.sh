#!/bin/bash
# Full test262 pipeline with logging
# Usage: ./scripts/run-test262.sh

LOGFILE="/workspace/benchmarks/results/test262-run.log"
echo "=== test262 run started at $(date) ===" | tee "$LOGFILE"
echo "Git: $(git rev-parse --short HEAD)" | tee -a "$LOGFILE"

echo "" | tee -a "$LOGFILE"
echo "=== PRECOMPILE ===" | tee -a "$LOGFILE"
time npx tsx scripts/precompile-tests.ts 2>&1 | tee -a "$LOGFILE"

echo "" | tee -a "$LOGFILE"
echo "=== VITEST ===" | tee -a "$LOGFILE"
time npx vitest run tests/test262-vitest.test.ts 2>&1 | tee -a "$LOGFILE"

echo "" | tee -a "$LOGFILE"
echo "=== RESULTS ===" | tee -a "$LOGFILE"
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

echo "" | tee -a "$LOGFILE"
echo "=== Finished at $(date) ===" | tee -a "$LOGFILE"
