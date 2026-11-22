#!/usr/bin/env node
// Probes published package entrypoints under Node's browser condition without a DOM.
// This is a portability signal, not a React Native or Hermes runtime simulation.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// The proposed upstream v1 API must expose usable component, function and theme entrypoints.
const REQUIRED_BASIC_V1_EXPORTS = Object.freeze([
  'ButtonApi', 'TextApi', 'BASIC_COMPONENTS', 'BASIC_FUNCTIONS',
  'BASIC_FUNCTION_APIS', 'BasicCatalogThemeSchema', 'createBasicCatalogFunctions',
]);

const ENTRIES = Object.freeze([
  {name: 'processing-api', specifier: '@a2ui/web_core/processing'},
  {name: 'basic-v1-api', specifier: '@a2ui/web_core/catalogs/basic/v1/api'},
  {name: 'basic-v1-catalog', specifier: '@a2ui/web_core/catalogs/basic/v1'},
  {name: 'v1-entrypoint', specifier: '@a2ui/web_core/v1_0'},
]);

export function classifyImportResult(child) {
  if (child.error?.code === 'ETIMEDOUT') return 'timeout';
  if (child.error) return 'runner-error';
  if (child.status === 0 && child.stdout === 'OK') return 'loaded';
  if (child.status === 4 && child.stdout === 'DOM_REQUIRED') return 'dom-required';
  if (child.status === 6 && child.stdout === 'NOT_EXPORTED') return 'not-exported';
  if (child.status === 7 && child.stdout === 'INCOMPLETE_API') return 'incomplete-api';
  return 'import-error';
}

// A DOM-free import is not usable processing unless it exposes the public lifecycle API.
export function hasRequiredProcessingExports(exported) {
  const Processor = exported?.MessageProcessor;
  return typeof Processor === 'function' &&
    typeof Processor.prototype?.processMessages === 'function' &&
    typeof Processor.prototype?.getSurface === 'function';
}

export function hasRequiredBasicV1Exports(exported) {
  return exported !== null && typeof exported === 'object' &&
    REQUIRED_BASIC_V1_EXPORTS.every(name => Object.hasOwn(exported, name)) &&
    Array.isArray(exported.BASIC_COMPONENTS) && exported.BASIC_COMPONENTS.length >= 18 &&
    exported.BASIC_COMPONENTS.includes(exported.ButtonApi) &&
    Array.isArray(exported.BASIC_FUNCTIONS) && exported.BASIC_FUNCTIONS.length > 0 &&
    Array.isArray(exported.BASIC_FUNCTION_APIS) && exported.BASIC_FUNCTION_APIS.length > 0 &&
    typeof exported.createBasicCatalogFunctions === 'function';
}

function probeImport(specifier, installRoot) {
  // Only fixed, audited SDK specifiers are used; input cannot request an
  // arbitrary module, local file, network endpoint or executable command.
  const script = `try {
    const exported = await import(${JSON.stringify(specifier)});
    if (${specifier === ENTRIES[0].specifier} || ${specifier === ENTRIES[1].specifier}) {
      const {hasRequiredProcessingExports, hasRequiredBasicV1Exports} =
        await import(${JSON.stringify(import.meta.url)});
      const usable = ${specifier === ENTRIES[0].specifier}
        ? hasRequiredProcessingExports(exported) : hasRequiredBasicV1Exports(exported);
      if (!usable) {
        process.stdout.write('INCOMPLETE_API');
        process.exitCode = 7;
      } else {
        process.stdout.write('OK');
      }
    } else {
      process.stdout.write('OK');
    }
  } catch (error) {
    if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      process.stdout.write('NOT_EXPORTED');
      process.exitCode = 6;
    } else if (error?.name === 'ReferenceError' &&
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
      cwd: installRoot, encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
      windowsHide: true, env: {...process.env, NODE_OPTIONS: ''},
    });
  return classifyImportResult(child);
}

export function summarizeDomlessReadiness(cases) {
  const processingReady = cases.some(item => item.name === 'processing-api' && item.state === 'loaded');
  const apiReady = cases.some(item => item.name === 'basic-v1-api' && item.state === 'loaded');
  const domlessReady = processingReady && apiReady;
  return {
    domlessReady,
    preferredEntrypoint: domlessReady ? '@a2ui/web_core/catalogs/basic/v1/api' : null,
  };
}

export function inspectPublishedBrowserImports(installRoot = ROOT) {
  // A direct SDK install is required: never attribute an ancestor's package
  // metadata to a consumer whose dependency graph was not verified.
  const manifest = JSON.parse(readFileSync(resolve(installRoot, 'package.json'), 'utf8'));
  const declared = ['dependencies', 'devDependencies', 'peerDependencies']
    .some(section => typeof manifest[section]?.['@a2ui/web_core'] === 'string');
  if (!declared) throw new Error('Missing direct web_core declaration');
  const packageInfo = JSON.parse(readFileSync(
    resolve(installRoot, 'node_modules/@a2ui/web_core/package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageInfo.version))
    throw new Error('Invalid installed SDK version');
  const cases = ENTRIES.map(({name, specifier}) => ({
    name, state: probeImport(specifier, installRoot),
  }));
  return {
    schemaVersion: 1,
    sdk: '@a2ui/web_core',
    installedVersion: packageInfo.version,
    target: resolve(installRoot) === resolve(ROOT) ? 'lab' : 'consumer',
    condition: 'Node.js browser export condition, no DOM',
    ...summarizeDomlessReadiness(cases),
    cases,
    limitations: 'Node.js import only; no React Native, Metro, Hermes, renderer or security certification.',
    upstreamIssue: 'https://github.com/a2ui-project/a2ui/issues/4238',
  };
}

function main(args) {
  let strict = false;
  let projectRoot = null;
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict' && !strict) {
      strict = true;
    } else if (args[i] === '--project-root' && projectRoot === null &&
        args[i + 1] && !args[i + 1].startsWith('--')) {
      projectRoot = resolve(args[++i]);
    } else {
      invalid = true;
      break;
    }
  }
  if (invalid) {
    process.stderr.write('Usage: node src/domless-browser-import-preflight.mjs [--strict] [--project-root DIR]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const report = inspectPublishedBrowserImports(projectRoot ?? ROOT);
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.cases.some(item => !['loaded', 'dom-required', 'not-exported', 'incomplete-api'].includes(item.state)))
      process.exitCode = 2;
    else if (strict && !report.domlessReady)
      process.exitCode = 1;
  } catch {
    process.stderr.write('Unable to inspect the selected installed SDK.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2));
