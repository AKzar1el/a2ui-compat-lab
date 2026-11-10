import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyInstallResult, getReleaseCases} from '../src/releases.mjs';

test('published release probes are fixed, isolated and semver-pinned', () => {
  const rows = getReleaseCases();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.id), ['a2ui-react-webcore-0.14', 'a2ui-react-webcore-0.15']);
  assert.deepEqual(rows.map(row => row.expected), ['resolves', 'ERESOLVE']);
  for (const row of rows) {
    assert.ok(row.packages['@a2ui/react']);
    assert.ok(row.packages['@a2ui/web_core']);
    assert.ok(Object.values(row.packages).every(version => /^\d+\.\d+\.\d+$/.test(version)));
  }
});


test('release matrix rejects empty cases and probes that omit the actual SDK pair', () => {
  const cases = getReleaseCases();
  const manifest = rows => ({schemaVersion: 1, cases: rows});
  const valid = structuredClone(cases[0]);
  assert.throws(() => getReleaseCases(manifest([])), /release.matrix/i,
    'an empty matrix must never be a vacuous green');
  assert.throws(() => getReleaseCases(manifest([{
    ...valid, packages: {'react': '19.2.0', 'react-dom': '19.2.0'},
  }])), /release.matrix/i, 'an npm install without either SDK is not a valid A2UI probe');
  assert.throws(() => getReleaseCases(manifest([{
    ...valid, packages: {'@a2ui/react': '0.14.0', react: '19.2.0'},
  }])), /release.matrix/i, 'both published SDKs must be present');
  assert.throws(() => getReleaseCases(manifest([{...valid, packages: {}}])), /release.matrix/i);
  assert.throws(() => getReleaseCases(manifest([{...valid, packages: null}])), /release.matrix/i);
});

test('release matrix rejects duplicate or malformed cases before npm is invoked', () => {
  const cases = getReleaseCases();
  const manifest = rows => ({schemaVersion: 1, cases: rows});
  const first = structuredClone(cases[0]);
  assert.throws(() => getReleaseCases(manifest([first, {...first}])), /release.matrix/i,
    'duplicate IDs erase one-to-one baseline identity');
  assert.throws(() => getReleaseCases(manifest([null])), /release.matrix/i);
  assert.throws(() => getReleaseCases(manifest([{...first, id: ' '}])) , /release.matrix/i);
  assert.throws(() => getReleaseCases(manifest([{...first, expected: 'unknown'}])), /release.matrix/i);
});

test('a real npm dependency-conflict code is distinguished from advisory text', () => {
  assert.deepEqual(classifyInstallResult({status: 1, stderr: 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree'}),
    {observed: 'ERESOLVE', failureKind: 'dependency-conflict', npmErrorCode: 'ERESOLVE'});
  assert.deepEqual(classifyInstallResult({status: 1, stderr: 'npm ERR! ERESOLVE unable to resolve dependency tree'}),
    {observed: 'ERESOLVE', failureKind: 'dependency-conflict', npmErrorCode: null});
  assert.deepEqual(classifyInstallResult({status: 1, stderr: 'npm error package graph mentions ERESOLVE in a suggestion'}),
    {observed: 'install-error', failureKind: 'other-npm-error', npmErrorCode: null});
});

test('network errors never masquerade as an expected ERESOLVE baseline', () => {
  const result = classifyInstallResult({status: 1, stderr: 'npm error code ENOTFOUND\nnpm error ERESOLVE may be mentioned in help text'});
  assert.deepEqual(result, {observed: 'infrastructure-error', failureKind: 'registry-or-network', npmErrorCode: 'ENOTFOUND'});
  const offline = classifyInstallResult({status: 1, stderr: 'npm ERR! code ENOTCACHED'});
  assert.equal(offline.observed, 'infrastructure-error');
});

test('runner timeouts and process failures override stale npm output', () => {
  const timedOut = classifyInstallResult({status: null, signal: 'SIGTERM', error: {code: 'ETIMEDOUT'}, stderr: 'npm error code ERESOLVE'});
  assert.deepEqual(timedOut, {observed: 'infrastructure-error', failureKind: 'timeout', npmErrorCode: 'ERESOLVE'});
  assert.equal(classifyInstallResult({status: null, error: {code: 'ENOENT'}, stderr: 'npm error code ERESOLVE'}).failureKind, 'runner-failure');
  assert.equal(classifyInstallResult({status: null, signal: 'SIGTERM'}).failureKind, 'interrupted');
  assert.equal(classifyInstallResult({status: null}).failureKind, 'unknown-runner-state');
});

test('successful and other-failure probes have stable machine-readable outcomes', () => {
  assert.deepEqual(classifyInstallResult({status: 0, stdout: 'added 0 packages'}),
    {observed: 'resolves', failureKind: null, npmErrorCode: null});
  assert.deepEqual(classifyInstallResult({status: 1, stderr: 'npm ERR! code ETARGET'}),
    {observed: 'install-error', failureKind: 'other-npm-error', npmErrorCode: 'ETARGET'});
});
