import {compile} from './src/index.ts';
import {readFileSync, writeFileSync, appendFileSync} from 'fs';
import {parseMeta, wrapTest, shouldSkip} from './tests/test262-runner.ts';

const LOG = '/tmp/hang-trace.log';
writeFileSync(LOG, 'STARTING\n');

const allTests = readFileSync('/tmp/expr-tests.txt', 'utf-8').trim().split('\n');

let tested = 0;
for (const testPath of allTests) {
  const relPath = testPath.replace('/workspace/test262/', '');
  const src = readFileSync(testPath, 'utf-8');
  const meta = parseMeta(src);
  const skip = shouldSkip(meta, src, relPath);
  if (skip.skip) continue;
  
  appendFileSync(LOG, `${tested}: ${relPath}\n`);
  const {source: w} = wrapTest(src, meta);
  try {
    compile(w, {fileName: 'test.ts', skipSemanticDiagnostics: true});
  } catch(e) {}
  tested++;
}
appendFileSync(LOG, `FINISHED: ${tested}\n`);
