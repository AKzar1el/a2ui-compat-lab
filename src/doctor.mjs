import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

function readJson(path) {
  try {
    return {data: JSON.parse(readFileSync(path, 'utf8')), error: null};
  } catch (error) {
    if (error?.code === 'ENOENT') return {data: null, error: 'missing'};
    if (error instanceof SyntaxError) return {data: null, error: 'invalid-json'};
    throw error;
  }
}

// Local-only readiness signal: no registry calls, subprocesses or generated files.
export function inspectInstallation({root = defaultRoot, nodeVersion = process.versions.node, loadJson = readJson} = {}) {
  const manifest = loadJson(join(root, 'package.json'));
  if (!manifest.data || typeof manifest.data !== 'object' || Array.isArray(manifest.data)) {
    throw new Error('Project manifest is ' + (manifest.error ?? 'invalid'));
  }
  const dependencies = manifest.data.dependencies ?? {};
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('Project dependencies must be an object');
  }
  const required = manifest.data.engines?.node ?? null;
  const supportedEngine = typeof required === 'string' ? /^>=(\d+)(?:\.(\d+))?$/.exec(required.trim()) : null;
  const installedNode = /^(\d+)\.(\d+)\./.exec(nodeVersion);
  const nodeOk = Boolean(supportedEngine && installedNode &&
    (Number(installedNode[1]) > Number(supportedEngine[1]) ||
      (Number(installedNode[1]) === Number(supportedEngine[1]) &&
       Number(installedNode[2]) >= Number(supportedEngine[2] ?? 0))));

  const lock = loadJson(join(root, 'package-lock.json'));
  const lockRoot = lock.data?.packages?.[''];
  const lockIssues = [];
  if (lock.error) lockIssues.push(lock.error);
  else if (!lockRoot || typeof lockRoot !== 'object') lockIssues.push('invalid-lock-root');
  else if (lockRoot.version !== manifest.data.version) lockIssues.push('project-version-mismatch');

  const packages = Object.entries(dependencies).map(([name, expected]) => {
    const issues = [];
    const safeName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) && !name.split('/').includes('..');
    const pinned = typeof expected === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected);
    if (!safeName) issues.push('invalid-package-name');
    if (!pinned) issues.push('not-exactly-pinned');
    const locked = safeName ? lock.data?.packages?.['node_modules/' + name]?.version ?? null : null;
    if (locked !== expected) issues.push('lock-version-mismatch');
    if (lockRoot?.dependencies?.[name] !== expected) issues.push('lock-direct-pin-mismatch');
    const installedFile = safeName ? loadJson(join(root, 'node_modules', ...name.split('/'), 'package.json')) : null;
    const installed = installedFile?.data?.version ?? null;
    if (installedFile?.error) issues.push('install-' + installedFile.error);
    else if (installed !== expected) issues.push('install-version-mismatch');
    return {name, expected, locked, installed, ok: issues.length === 0, issues};
  });

  const report = {
    reportVersion: 1,
    tool: {name: manifest.data.name, version: manifest.data.version},
    node: {actual: nodeVersion, required, ok: nodeOk},
    lockfile: {ok: lockIssues.length === 0, issues: lockIssues},
    packages,
  };
  report.ok = report.node.ok && report.lockfile.ok && packages.every(item => item.ok);
  return report;
}
