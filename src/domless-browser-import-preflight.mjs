#!/usr/bin/env node
// Probes published package entrypoints under Node's browser condition without a DOM.
// This is a portability signal, not a React Native or Hermes runtime simulation.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRIES = Object.freeze([
  {name: 'processing-api', specifier: '@a2ui/web_core/processing'},
  {name: 'basic-v1-catalog', specifier: '@a2ui/web_core/catalogs/basic/v1'},
  {name: 'v1-entrypoint', specifier: '@a2ui/web_core/v1_0'},
]);

export function classifyImportResult(child) {
  if (child.error?.code === 'ETIMEDOUT') return 'timeout';
  if (child.error) return 'runner-error';
  if (child.status === 0 && child.stdout === 'OK') return 'loaded';
  if (child.status === 4 && child.stdout === 'DOM_REQUIRED') return 'dom-required';
  return 'import-error';
}

function probeImport(specifier) {
  // Only fixed, audited SDK specifiers are used; input cannot request an
  // arbitrary module, local file, network endpoint or executable command.
  const script = `try {
    await import(${JSON.stringify(specifier)});
    process.stdout.write('OK');
  } catch (error) {
    if (error?.name === 'ReferenceError' &&
        error?.message === 'HTMLElement is not defined') {
      process.stdout.write('DOM_REQUIRED');
      process.exitCode = 4;
    } else {
      process.stdout.write('IMPORT_ERROR');
      process.exitCode = 5;
    }
  }`;
  const child = spawnSync(process.execPath,
    ['--conditions=browser', '--input-type=module', '--eval', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
      windowsHide: true, env: {...process.env, NODE_OPTIONS: ''},
    });
  return classifyImportResult(child);
}

export function inspectPublishedBrowserImports() {
  const packageInfo = JSON.parse(readFileSync(
    new URL('../node_modules/@a2ui/web_core/package.json', import.meta.url), 'utf8'));
  const cases = ENTRIES.map(({name, specifier}) => ({
    name, state: probeImport(specifier),
  }));
  return {
    schemaVersion: 1,
    sdk: '@a2ui/web_core',
    installedVersion: packageInfo.version,
    condition: 'Node.js browser export condition, no DOM',
    domlessReady: cases.every(item => item.state === 'loaded'),
    cases,
    limitations: 'Node.js import only; no React Native, Metro, Hermes, renderer or security certification.',
    upstreamIssue: 'https://github.com/a2ui-project/a2ui/issues/4238',
  };
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--strict')) {
    process.stderr.write('Usage: node src/domless-browser-import-preflight.mjs [--strict]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const report = inspectPublishedBrowserImports();
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.cases.some(item => !['loaded', 'dom-required'].includes(item.state)))
      process.exitCode = 2;
    else if (args[0] === '--strict' && !report.domlessReady)
      process.exitCode = 1;
  } catch {
    process.stderr.write('Unable to inspect the installed published SDK.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2));
