import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const path = new URL('../fixtures/release-pairs.json', import.meta.url);

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
    const outcome = result.status === 0 ? 'resolves' : /\bERESOLVE\b/.test(combined) ? 'ERESOLVE' : 'infrastructure-error';
    return {id: item.id, packages: item.packages, expected: item.expected, observed: outcome,
      matchesExpectation: outcome === item.expected, exitCode: result.status,
      signal: result.signal ?? null, errorCode: result.error?.code ?? null,
      diagnostic: [...new Set(combined.split(/\r?\n/).filter(line =>
        /ERESOLVE|Could not resolve dependency|peer @a2ui\/web_core|Found: @a2ui\/web_core/.test(line))
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
