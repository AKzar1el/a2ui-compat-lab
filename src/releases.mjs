import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const path = new URL('../fixtures/release-pairs.json', import.meta.url);

// npm can mention ERESOLVE in advisory text even when the actual error is a
// registry failure. Only its error-code line (or a legacy error heading) is
// authoritative for dependency-conflict classification.
const infrastructureCodes = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENOTCACHED', 'ENOTFOUND', 'ETIMEDOUT', 'E401', 'E403',
  'E429', 'E500', 'E502', 'E503', 'E504',
]);

export function classifyInstallResult(result) {
  const output = (result.stderr || '') + '\n' + (result.stdout || '');
  const codes = [...output.matchAll(/^\s*npm\s+(?:error|ERR!)\s+code\s+([A-Z][A-Z0-9_-]*)\s*$/gmi)];
  const npmErrorCode = codes.at(-1)?.[1]?.toUpperCase() ?? null;
  const runnerErrorCode = result.error?.code ?? null;
  if (runnerErrorCode === 'ETIMEDOUT') return {observed: 'infrastructure-error', failureKind: 'timeout', npmErrorCode};
  if (runnerErrorCode) return {observed: 'infrastructure-error', failureKind: 'runner-failure', npmErrorCode};
  if (result.signal) return {observed: 'infrastructure-error', failureKind: 'interrupted', npmErrorCode};
  if (result.status === 0) return {observed: 'resolves', failureKind: null, npmErrorCode};
  if (result.status === null) return {observed: 'infrastructure-error', failureKind: 'unknown-runner-state', npmErrorCode};
  if (infrastructureCodes.has(npmErrorCode)) return {observed: 'infrastructure-error', failureKind: 'registry-or-network', npmErrorCode};
  if (npmErrorCode === 'ERESOLVE' || (!npmErrorCode && /^\s*npm\s+(?:error|ERR!)\s+ERESOLVE(?:\s|$)/mi.test(output))) {
    return {observed: 'ERESOLVE', failureKind: 'dependency-conflict', npmErrorCode};
  }
  return {observed: 'install-error', failureKind: 'other-npm-error', npmErrorCode};
}

function nextAction(kind) {
  if (kind === 'registry-or-network') return 'Check npm registry access and retry; this does not prove a dependency conflict.';
  if (kind === 'timeout' || kind === 'interrupted') return 'Retry the bounded probe when the runner is available; compatibility remains unverified.';
  if (kind === 'runner-failure' || kind === 'unknown-runner-state') return 'Check local npm invocation and runner health before retrying.';
  if (kind === 'dependency-conflict') return 'Review the pinned peer dependency constraints before changing the expected baseline.';
  if (kind === 'other-npm-error') return 'Inspect the npm error output; do not classify this as a peer dependency conflict.';
  return null;
}

export function getReleaseCases() {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) throw new Error('Unsupported release-matrix manifest');
  for (const item of manifest.cases) {
    if (!item.id || !['resolves', 'ERESOLVE'].includes(item.expected)) throw new Error('Invalid release-matrix case');
    for (const [pkg, ver] of Object.entries(item.packages)) {
      if (!/^[@a-zA-Z0-9/._-]+$/.test(pkg) || !/^\d+\.\d+\.\d+$/.test(ver)) throw new Error('Package probes require pinned names and semver');
    }
  }
  return manifest.cases;
}

export function probeRelease(item, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'a2ui-compat-matrix-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'a2ui-compat-lab-clean-install',
      version: '0.0.0',
      private: true,
      dependencies: item.packages,
    }, null, 2) + '\n');
    // Package names and versions are validated and pinned; package lifecycle scripts are disabled.
    const npmArgs = ['install', '--package-lock-only', '--strict-peer-deps', '--ignore-scripts',
      '--no-audit', '--no-fund', '--progress=false', '--fetch-retries=0'];
    const runner = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(runner, npmArgs, {
      cwd: root, shell: process.platform === 'win32', encoding: 'utf8',
      timeout: options.timeoutMs ?? 120000, maxBuffer: 2_000_000,
    });
    const combined = (result.stderr || '') + '\n' + (result.stdout || '');
    const classification = classifyInstallResult(result);
    return {id: item.id, packages: item.packages, expected: item.expected, observed: classification.observed,
      matchesExpectation: classification.observed === item.expected, exitCode: result.status,
      signal: result.signal ?? null, errorCode: result.error?.code ?? null,
      npmErrorCode: classification.npmErrorCode, failureKind: classification.failureKind,
      nextAction: nextAction(classification.failureKind),
      diagnostic: [...new Set(combined.split(/\r?\n/).filter(line =>
        /npm\s+(?:ERR!|error)\s+(?:code\s+|ERESOLVE|network|fetch)|Could not resolve dependency|peer @a2ui\/web_core|Found: @a2ui\/web_core/i.test(line))
        .map(line => line.trim().slice(0, 260)))].slice(0, 7)};
  } finally {
    // The path is created by mkdtemp in the OS temp directory and never supplied by a user.
    rmSync(root, {recursive: true, force: true, maxRetries: 2});
  }
}

export function probeAllReleases(options = {}) {
  const rows = getReleaseCases().map(item => probeRelease(item, options));
  return {reportVersion: 1, kind: 'published-package-resolution', rows, ok: rows.every(row => row.matchesExpectation)};
}
