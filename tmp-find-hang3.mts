import {compile} from './src/index.ts';
import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'fs';
import {parseMeta, wrapTest, shouldSkip} from './tests/test262-runner.ts';

const LOG = '/tmp/hang-trace3.log';
writeFileSync(LOG, 'STARTING\n');

// Read ALL test files
const listFile = '/tmp/all-tests.txt';
const allTests = readFileSync(listFile, 'utf-8').trim().split('\n');
appendFileSync(LOG, `Total: ${allTests.length}\n`);

let tested = 0;
for (const testPath of allTests) {
  const relPath = testPath.replace('/workspace/test262/', '');
  let src: string;
  try { src = readFileSync(testPath, 'utf-8'); } catch { continue; }
  const meta = parseMeta(src);
  const skip = shouldSkip(meta, src, relPath);
  if (skip.skip) continue;
  
  const {source: w} = wrapTest(src, meta);
  appendFileSync(LOG, `${tested}: ${relPath}\n`);
  try {
    compile(w, {fileName: 'test.ts', skipSemanticDiagnostics: true});
  } catch(e) {}
  tested++;
}
appendFileSync(LOG, `FINISHED: ${tested}\n`);
