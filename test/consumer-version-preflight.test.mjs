import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateManifest} from '../src/consumer-version-preflight.mjs';

const cli = fileURLToPath(new URL('../src/consumer-version-preflight.mjs', import.meta.url));
const realRenderer = fileURLToPath(new URL('../renderer-react/package.json', import.meta.url));
const pinned = {dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.14.0'}};

function invoke(manifest, protocol = 'v0.9') {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-consumer-preflight-'));
  const path = join(dir, 'PRIVATE-PATH-package.json');
  try {
    writeFileSync(path, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    return spawnSync(process.execPath, [cli, '--manifest', path, '--protocol', protocol],
      {encoding: 'utf8', timeout: 5000});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('lab real published 0.14 React/core renderer declarations are eligible for v0.9 lane', () => {
  const manifest = JSON.parse(readFileSync(realRenderer, 'utf8'));
  const report = evaluateManifest(manifest, 'v0.9');
  assert.equal(report.reason, 'eligible_declared_pair');
  assert.equal(report.eligible, true);
  assert.equal(report.sdkDeclarations.react, 'exact-0.14.0');
  assert.equal(report.sdkDeclarations.webCore, 'exact-0.14.0');
  assert.match(report.limitations, /Declarations only/);
});

test('Kaltura-style published 0.15 peer ranges are flagged without pretending an upstream defect', () => {
  const manifest = {
    name: 'PRIVATE-CLIENT-SECRET-NAME',
    peerDependencies: {'@a2ui/react': '^0.15.0', '@a2ui/web_core': '^0.15.0'},
    devDependencies: {'@a2ui/react': '^0.15.0', '@a2ui/web_core': '^0.15.0'},
  };
  const run = invoke(manifest);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.eligible, false);
  assert.equal(report.reason, 'sdk_generation_not_tested');
  assert.deepEqual(report.sdkDeclarations, {react: '0.15-family', webCore: '0.15-family'});
  assert.equal(run.stdout.includes('PRIVATE-CLIENT-SECRET-NAME'), false);
  assert.equal(run.stdout.includes('PRIVATE-PATH'), false);
  assert.equal(run.stderr, '');
});

test('different declared React/core generations require a separate validated lane', () => {
  const report = evaluateManifest({
    dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.15.0'},
  }, 'v0.9');
  assert.equal(report.eligible, false);
  assert.equal(report.reason, 'sdk_generation_not_tested');
});

test('v1.0 capture protocol cannot inherit a v0.9 green check', () => {
  const run = invoke(pinned, 'v1.0');
  assert.equal(run.status, 1, run.stderr);
  assert.equal(JSON.parse(run.stdout).reason, 'protocol_outside_test_lane');
});

test('caret ranges and transitive-only manifests cannot pass a pinned-package preflight', () => {
  const ranged = evaluateManifest({
    dependencies: {'@a2ui/react': '^0.14.0', '@a2ui/web_core': '^0.14.0'},
  }, 'v0.9');
  assert.equal(ranged.reason, 'non_exact_sdk_pin');
  assert.equal(ranged.eligible, false);
  const absent = evaluateManifest({dependencies: {react: '19.2.0'}}, 'v0.9');
  assert.equal(absent.reason, 'missing_sdk_declaration');
});

test('conflicting dependency/peer declarations are not silently treated as exact pins', () => {
  const report = evaluateManifest({
    dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.14.0'},
    peerDependencies: {'@a2ui/react': '^0.15.0'},
  }, 'v0.9');
  assert.equal(report.reason, 'conflicting_declarations');
  assert.equal(report.eligible, false);
});

test('fixed diagnostic omits all private package names, arbitrary metadata and paths', () => {
  const run = invoke({...pinned, name: 'PRIVATE-SECRET-CLIENT', scripts: {private: 'SECRET-PAYLOAD'}});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).reason, 'eligible_declared_pair');
  assert.equal(run.stdout.includes('PRIVATE-SECRET'), false);
  assert.equal(run.stdout.includes('SECRET-PAYLOAD'), false);
  assert.equal(run.stdout.includes('PRIVATE-PATH'), false);
});

test('malformed input, duplicate flags and invalid dependency sections fail closed at exit 2', () => {
  const malformed = invoke('{ "name": "PRIVATE-SECRET", broken');
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr.includes('PRIVATE-SECRET'), false);
  const invalid = invoke({dependencies: 'PRIVATE-SECRET'});
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr.includes('PRIVATE-SECRET'), false);
  const duplicate = spawnSync(process.execPath,
    [cli, '--manifest', 'path', '--manifest', 'path', '--protocol', 'v0.9'],
    {encoding: 'utf8', timeout: 5000});
  assert.equal(duplicate.status, 2);
  assert.equal(duplicate.stdout, '');
});

test('missing manifest and oversized manifest are rejected without leaking file paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-private-missing-'));
  try {
    const path = join(dir, 'PRIVATE-SECRET.json');
    const missing = spawnSync(process.execPath,
      [cli, '--manifest', path, '--protocol', 'v0.9'],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.includes(path), false);
    writeFileSync(path, JSON.stringify({ignored: 'x'.repeat(135000)}));
    const large = spawnSync(process.execPath,
      [cli, '--manifest', path, '--protocol', 'v0.9'],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(large.status, 2);
    assert.equal(large.stderr.includes(path), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
