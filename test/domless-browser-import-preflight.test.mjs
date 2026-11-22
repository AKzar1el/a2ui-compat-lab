import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  classifyImportResult, hasRequiredBasicV1Exports,
  inspectPublishedBrowserImports, summarizeDomlessReadiness,
} from '../src/domless-browser-import-preflight.mjs';

const cli = fileURLToPath(new URL('../src/domless-browser-import-preflight.mjs', import.meta.url));

test('published web_core 0.15 browser-condition imports reveal real no-DOM catalog boundary', () => {
  const report = inspectPublishedBrowserImports();
  assert.equal(report.installedVersion, '0.15.0');
  assert.equal(report.domlessReady, false);
  assert.equal(report.preferredEntrypoint, null);
  assert.deepEqual(report.cases, [
    {name: 'processing-api', state: 'loaded'},
    {name: 'basic-v1-api', state: 'not-exported'},
    {name: 'basic-v1-catalog', state: 'dom-required'},
    {name: 'v1-entrypoint', state: 'dom-required'},
  ]);
  assert.match(report.limitations, /no React Native/);
});

test('future v1 catalog export contract rejects importable stubs and incomplete APIs', () => {
  const ButtonApi = {};
  const complete = {
    ButtonApi, TextApi: {}, BASIC_COMPONENTS: [ButtonApi, ...Array.from({length: 17}, () => ({}))],
    BASIC_FUNCTIONS: [{}], BASIC_FUNCTION_APIS: [{}], BasicCatalogThemeSchema: {},
    createBasicCatalogFunctions: () => ({}),
  };
  assert.equal(hasRequiredBasicV1Exports(complete), true);
  assert.equal(hasRequiredBasicV1Exports({}), false);
  assert.equal(hasRequiredBasicV1Exports({...complete, BASIC_COMPONENTS: []}), false);
  assert.equal(hasRequiredBasicV1Exports({...complete, BASIC_COMPONENTS: Array(18).fill({})}), false);
  assert.equal(hasRequiredBasicV1Exports({...complete, BASIC_FUNCTIONS: []}), false);
  assert.equal(hasRequiredBasicV1Exports({...complete, BASIC_FUNCTION_APIS: []}), false);
  assert.equal(hasRequiredBasicV1Exports({...complete, createBasicCatalogFunctions: null}), false);
  const {BasicCatalogThemeSchema, ...missingTheme} = complete;
  assert.equal(hasRequiredBasicV1Exports(missingTheme), false);
});

test('future API import alone is insufficient without the required proposed export contract', () => {
  const loaded = [
    {name: 'processing-api', state: 'loaded'},
    {name: 'basic-v1-api', state: 'loaded'},
    {name: 'basic-v1-catalog', state: 'dom-required'},
    {name: 'v1-entrypoint', state: 'dom-required'},
  ];
  assert.deepEqual(summarizeDomlessReadiness(loaded), {
    domlessReady: true,
    preferredEntrypoint: '@a2ui/web_core/catalogs/basic/v1/api',
  });
  assert.equal(summarizeDomlessReadiness(loaded.map(item =>
    item.name === 'basic-v1-api' ? {...item, state: 'incomplete-api'} : item)).domlessReady, false);
  assert.equal(summarizeDomlessReadiness(loaded.map(item =>
    item.name === 'processing-api' ? {...item, state: 'import-error'} : item)).domlessReady, false);
  assert.equal(classifyImportResult({status: 7, stdout: 'INCOMPLETE_API'}), 'incomplete-api');
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
  assert.equal(JSON.parse(child.stdout).cases.length, 4);
});

test('invalid CLI flags and subprocess failures fail closed', () => {
  for (const args of [['--strict', '--strict'], ['--anything'], ['--project-root'], ['--project-root', '.', '--project-root', '.']]) {
    const child = spawnSync(process.execPath, [cli, ...args],
      {encoding: 'utf8', timeout: 5000, windowsHide: true});
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
  }
  assert.equal(classifyImportResult({error: {code: 'ETIMEDOUT'}}), 'timeout');
  assert.equal(classifyImportResult({error: {code: 'ENOENT'}}), 'runner-error');
  assert.equal(classifyImportResult({status: 5, stdout: 'IMPORT_ERROR'}), 'import-error');
  assert.equal(classifyImportResult({status: 6, stdout: 'NOT_EXPORTED'}), 'not-exported');
  assert.equal(classifyImportResult({status: 0, stdout: 'OK'}), 'loaded');
});


test('explicit consumer root probes its own SDK instead of the lab dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-consumer-root-'));
  const sdk = join(root, 'node_modules', '@a2ui', 'web_core');
  try {
    mkdirSync(sdk, {recursive: true});
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'temporary-a2ui-consumer', private: true,
      dependencies: {'@a2ui/web_core': '9.9.9'},
    }));
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({
      name: '@a2ui/web_core', version: '9.9.9', type: 'module',
      exports: {
        './processing': './processing.mjs',
        './catalogs/basic/v1/api': './api.mjs',
        './catalogs/basic/v1': './legacy.mjs',
        './v1_0': './legacy.mjs',
      },
    }));
    writeFileSync(join(sdk, 'processing.mjs'), 'export const processor = true;\n');
    writeFileSync(join(sdk, 'legacy.mjs'), 'export class Legacy extends HTMLElement {}\n');
    const apiFile = join(sdk, 'api.mjs');
    writeFileSync(apiFile, [
      'export const ButtonApi = {};',
      'export const TextApi = {};',
      'export const BASIC_COMPONENTS = [ButtonApi, ...Array.from({length: 17}, () => ({}))];',
      'export const BASIC_FUNCTIONS = [{}];',
      'export const BASIC_FUNCTION_APIS = [{}];',
      'export const BasicCatalogThemeSchema = {};',
      'export function createBasicCatalogFunctions() { return {}; }',
    ].join('\n'));
    const run = args => spawnSync(process.execPath, [cli, '--project-root', root, ...args], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    const supported = run(['--strict']);
    assert.equal(supported.status, 0, supported.stderr);
    const ready = JSON.parse(supported.stdout);
    assert.equal(ready.target, 'consumer');
    assert.equal(ready.installedVersion, '9.9.9');
    assert.equal(ready.domlessReady, true);
    assert.deepEqual(ready.cases.map(item => item.state),
      ['loaded', 'loaded', 'dom-required', 'dom-required']);
    assert.equal(supported.stdout.includes(root), false);
    assert.equal(supported.stderr, '');
    writeFileSync(apiFile, 'export const ButtonApi = {};\n');
    const incomplete = run(['--strict']);
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.equal(JSON.parse(incomplete.stdout).cases[1].state, 'incomplete-api');
    assert.equal(incomplete.stdout.includes(root), false);
    writeFileSync(join(root, 'package.json'), JSON.stringify({private: true}));
    const undeclared = run([]);
    assert.equal(undeclared.status, 2);
    assert.equal(undeclared.stdout, '');
    assert.equal(undeclared.stderr.includes(root), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
