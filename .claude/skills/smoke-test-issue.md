---
name: smoke-test-issue
description: Quick validation of whether an issue still reproduces against current main. Use before dispatching to avoid wasting cycles on already-fixed issues.
---

# Smoke Test Issue

Validates whether an issue's sample test cases still fail against current main.

## Usage

Provide the issue number. This skill reads the issue file and compiles 2-3 sample tests.

## Steps

1. Read the issue file at `plan/issues/ready/{N}.md`
2. Find the "Sample files" section — extract 2-3 test file paths
3. For each sample test, compile and run:

```bash
npx tsx -e "
import {compile} from './src/index.ts';
import {readFileSync} from 'fs';
import {parseMeta, wrapTest} from './tests/test262-runner.ts';
import {buildImports} from './src/runtime.ts';
const src = readFileSync('test262/test/[TEST_FILE]','utf-8');
const meta = parseMeta(src);
const {source:w} = wrapTest(src,meta);
const r = compile(w, {fileName:'test.ts'});
if (!r.success) { console.log('CE:', r.errors[0]?.message); process.exit(1); }
const imports = buildImports(r.imports, undefined, r.stringPool);
const {instance} = await WebAssembly.instantiate(r.binary, imports);
const ret = instance.exports.test();
console.log('Result:', ret === 1 ? 'PASS' : 'FAIL (returned ' + ret + ')');
"
```

4. Report results:
   - **All fail**: issue is real, ready to dispatch
   - **All pass**: issue is already fixed — close it, move to done/
   - **Mixed**: issue is partially fixed — update the issue with current status

## Output

Message with: `"Smoke test #N: [REAL|FIXED|PARTIAL] — [details]"`
