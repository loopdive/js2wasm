import {compile} from './src/index.ts';
import {readFileSync, writeFileSync, appendFileSync} from 'fs';
import {parseMeta, wrapTest, shouldSkip} from './tests/test262-runner.ts';

const LOG = '/tmp/hang-trace2.log';
writeFileSync(LOG, '');
const allTests = readFileSync('/tmp/expr-tests.txt', 'utf-8').trim().split('\n');
// Start from test 6592 (after last completed)
let tested = 0;
for (let i = 0; i < allTests.length; i++) {
  const testPath = allTests[i];
  const relPath = testPath.replace('/workspace/test262/', '');
  const src = readFileSync(testPath, 'utf-8');
  const meta = parseMeta(src);
  const skip = shouldSkip(meta, src, relPath);
  if (skip.skip) continue;
  tested++;
  if (tested <= 6591) continue; // Skip already-completed tests
  appendFileSync(LOG, `${tested}: ${relPath}\n`);
  const {source: w} = wrapTest(src, meta);
  try {
    compile(w, {fileName: 'test.ts', skipSemanticDiagnostics: true});
  } catch(e) {}
}
appendFileSync(LOG, `FINISHED: ${tested}\n`);
