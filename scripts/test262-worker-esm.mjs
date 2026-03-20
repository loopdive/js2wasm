import { register } from 'node:module';
register('tsx', import.meta.url);

const { workerData, parentPort } = await import('worker_threads');
const { runTest262File } = await import('../tests/test262-runner.ts');

const { filePath, category } = workerData;
const relPath = filePath.replace(/.*test262\/test\//, '');

try {
  const result = await runTest262File(filePath, category);
  parentPort.postMessage({
    file: result.file, category: result.category, status: result.status,
    ...(result.error ? { error: result.error.substring(0, 300) } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.timing ? { timing: result.timing } : {}),
  });
} catch (e) {
  parentPort.postMessage({
    file: relPath, category, status: 'compile_error',
    error: String(e).substring(0, 300),
  });
}
