import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectInstallation} from '../src/doctor.mjs';

function fixture({nodeVersion = '22.22.2', installed = '0.15.0', locked = '0.15.0',
  lockRootPin = '0.15.0', lockRootVersion = '0.1.0', malformedLock = false,
  dependencyName = '@a2ui/web_core', absentInstall = false} = {}) {
  const files = new Map([
    ['package.json', {name: 'a2ui-compat-lab', version: '0.1.0', engines: {node: '>=22'}, dependencies: {[dependencyName]: '0.15.0'}}],
    ['package-lock.json', {packages: {'': {version: lockRootVersion, dependencies: {[dependencyName]: lockRootPin}},
      ['node_modules/' + dependencyName]: {version: locked}}}],
    ['node_modules/' + dependencyName + '/package.json', {name: dependencyName, version: installed}],
  ]);
  if (absentInstall) files.delete('node_modules/' + dependencyName + '/package.json');
  return inspectInstallation({root: '/virtual', nodeVersion, loadJson(path) {
    const key = path.replaceAll('\\', '/').replace(/^\/virtual\//, '');
    if (malformedLock && key === 'package-lock.json') return {data: null, error: 'invalid-json'};
    const data = files.get(key);
    return data ? {data, error: null} : {data: null, error: 'missing'};
  }});
}

test('doctor validates exact installed, locked and manifest versions without network access', () => {
  const report = fixture();
  assert.equal(report.ok, true);
  assert.equal(report.node.ok, true);
  assert.equal(report.packages[0].name, '@a2ui/web_core');
  assert.deepEqual(report.packages[0].issues, []);
});

test('doctor fails closed when the locally installed SDK is absent', () => {
  const report = fixture({absentInstall: true});
  assert.equal(report.ok, false);
  assert.deepEqual(report.packages[0].issues, ['install-missing']);
});

test('doctor detects a mismatched lockfile and an installed-package version', () => {
  const report = fixture({locked: '0.14.0', installed: '0.14.0', lockRootPin: '0.14.0'});
  assert.equal(report.ok, false);
  assert.deepEqual(report.packages[0].issues, [
    'lock-version-mismatch', 'lock-direct-pin-mismatch', 'install-version-mismatch',
  ]);
});

test('doctor rejects unsupported Node runtime and malformed lockfile', () => {
  const report = fixture({nodeVersion: '20.11.1', malformedLock: true});
  assert.equal(report.ok, false);
  assert.equal(report.node.ok, false);
  assert.deepEqual(report.lockfile.issues, ['invalid-json']);
});

test('doctor never resolves invalid dependency paths outside the repository', () => {
  const report = fixture({dependencyName: '../../outside'});
  assert.equal(report.ok, false);
  assert.ok(report.packages[0].issues.includes('invalid-package-name'));
});

test('doctor catches lockfile project-version drift independently of installed SDK', () => {
  const report = fixture({lockRootVersion: '0.0.1'});
  assert.equal(report.ok, false);
  assert.deepEqual(report.lockfile.issues, ['project-version-mismatch']);
});
