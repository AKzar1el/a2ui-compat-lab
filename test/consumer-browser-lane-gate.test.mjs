import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseErrorBoundaryOptions} from '../src/browser-capture-error-boundary-compare.mjs';

const cli = fileURLToPath(new URL('../src/browser-capture-error-boundary-compare.mjs', import.meta.url));
const pinned = {dependencies: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.14.0'}};
const validLock = {
  lockfileVersion: 3,
  packages: {
    '': {dependencies: {...pinned.dependencies}},
    'node_modules/@a2ui/react': {version: '0.14.0'},
    'node_modules/@a2ui/web_core': {version: '0.14.0'},
  },
};

function invoke({manifest = pinned, protocol = 'v0.9', lockfile, extra = []} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-private-ci-lane-'));
  const manifestPath = join(dir, 'PRIVATE-MANIFEST-SECRET.json');
  const lockfilePath = join(dir, 'PRIVATE-LOCKFILE-SECRET.json');
  try {
    writeFileSync(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    if (lockfile !== undefined)
      writeFileSync(lockfilePath, typeof lockfile === 'string' ? lockfile : JSON.stringify(lockfile));
    return spawnSync(process.execPath, [cli,
      '--before-capture', join(dir, 'PRIVATE-BEFORE-SECRET.jsonl'),
      '--after-capture', join(dir, 'PRIVATE-AFTER-SECRET.jsonl'),
      '--require-no-observed-failures', '--compare-rendered-text', '--strict',
      '--consumer-manifest', manifestPath, '--consumer-protocol', protocol,
      ...(lockfile === undefined ? [] : ['--consumer-lockfile', lockfilePath]), ...extra],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 20000});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('opt-in Chromium lane gate refuses a 0.15 host before reading missing private captures', () => {
  const run = invoke({manifest: {name: 'PRIVATE-CUSTOMER-SECRET',
    peerDependencies: {'@a2ui/react': '^0.15.0', '@a2ui/web_core': '^0.15.0'}}});
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /sdk_generation_not_tested/);
  for (const secret of ['PRIVATE-CUSTOMER', 'PRIVATE-MANIFEST', 'PRIVATE-BEFORE']) {
    assert.equal(run.stderr.includes(secret), false);
  }
});

test('opt-in Chromium lane gate refuses v1.0 protocol without invoking replay', () => {
  const run = invoke({protocol: 'v1.0'});
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /protocol_outside_test_lane/);
  assert.equal(run.stdout, '');
});

test('stale npm lockfile cannot pass an exact declared 0.14.0 host', () => {
  const lock = structuredClone(validLock);
  lock.packages['node_modules/@a2ui/react'].version = '0.15.0';
  const run = invoke({lockfile: lock});
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /lockfile_sdk_mismatch/);
  assert.equal(run.stdout, '');
});

test('exact manifest and optional lockfile pass preflight and reach the replay boundary', () => {
  for (const options of [{}, {lockfile: validLock}]) {
    const run = invoke(options);
    // Intentionally missing private captures are rejected by Chromium replay,
    // not the consumer-version lane guard.
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /private Chromium error-boundary comparison refused/);
    assert.doesNotMatch(run.stderr, /unverified consumer SDK/);
  }
});

test('malformed private manifest or lockfile fail closed without leaking input', () => {
  for (const options of [
    {manifest: '{ "PRIVATE-MANIFEST-PAYLOAD": invalid'},
    {lockfile: '{ "PRIVATE-LOCKFILE-PAYLOAD": invalid'},
  ]) {
    const run = invoke(options);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    for (const secret of ['PRIVATE-MANIFEST', 'PRIVATE-LOCKFILE', 'PRIVATE-BEFORE']) {
      assert.equal(run.stderr.includes(secret), false);
    }
  }
});

test('partial, duplicate or orphaned consumer gate flags fail invocation validation', () => {
  const base = ['--before-capture', 'before.jsonl', '--after-capture', 'after.jsonl'];
  assert.throws(() => parseErrorBoundaryOptions([...base, '--consumer-protocol', 'v0.9']));
  assert.throws(() => parseErrorBoundaryOptions([...base, '--consumer-lockfile', 'package-lock.json']));
  assert.throws(() => parseErrorBoundaryOptions([...base, '--consumer-manifest', 'package.json']));
  assert.throws(() => parseErrorBoundaryOptions([...base, '--consumer-manifest', 'package.json',
    '--consumer-protocol', 'v0.9', '--consumer-protocol', 'v0.9']));
  const valid = parseErrorBoundaryOptions([...base, '--consumer-manifest', 'package.json',
    '--consumer-protocol', 'v0.9', '--consumer-lockfile', 'package-lock.json']);
  assert.equal(valid['consumer-protocol'], 'v0.9');
  assert.match(valid['consumer-lockfile'], /package-lock\.json$/);
});
