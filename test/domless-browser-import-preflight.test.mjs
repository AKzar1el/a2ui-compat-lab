import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  classifyImportResult, inspectPublishedBrowserImports,
} from '../src/domless-browser-import-preflight.mjs';

const cli = fileURLToPath(new URL('../src/domless-browser-import-preflight.mjs', import.meta.url));

test('published web_core 0.15 browser-condition imports reveal real no-DOM catalog boundary', () => {
  const report = inspectPublishedBrowserImports();
  assert.equal(report.installedVersion, '0.15.0');
  assert.equal(report.domlessReady, false);
  assert.deepEqual(report.cases, [
    {name: 'processing-api', state: 'loaded'},
    {name: 'basic-v1-catalog', state: 'dom-required'},
    {name: 'v1-entrypoint', state: 'dom-required'},
  ]);
  assert.match(report.limitations, /no React Native/);
});

test('strict CLI fails on the observed published no-DOM incompatibility without leaking a stack', () => {
  const child = spawnSync(process.execPath, [cli, '--strict'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.domlessReady, false);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes('node_modules'), false);
  assert.equal(child.stdout.includes('C:\\'), false);
});

test('non-strict CLI reports the observed boundary without treating it as CI failure', () => {
  const child = spawnSync(process.execPath, [cli], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).cases.length, 3);
});

test('invalid CLI flags and subprocess failures fail closed', () => {
  for (const args of [['--strict', '--strict'], ['--anything']]) {
    const child = spawnSync(process.execPath, [cli, ...args],
      {encoding: 'utf8', timeout: 5000, windowsHide: true});
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
  }
  assert.equal(classifyImportResult({error: {code: 'ETIMEDOUT'}}), 'timeout');
  assert.equal(classifyImportResult({error: {code: 'ENOENT'}}), 'runner-error');
  assert.equal(classifyImportResult({status: 5, stdout: 'IMPORT_ERROR'}), 'import-error');
  assert.equal(classifyImportResult({status: 0, stdout: 'OK'}), 'loaded');
});
