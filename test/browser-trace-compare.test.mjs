import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compareBrowserTraces} from '../src/browser-trace-compare.mjs';

const cli = fileURLToPath(new URL('../src/browser-trace-compare.mjs', import.meta.url));

function trace() {
  return {
    schemaVersion: 1, protocol: 'v0.9', passed: true,
    harness: 'real React A2uiSurface + published core Custom Elements; Playwright Chromium pointer and keyboard',
    fixtureSha256: 'a'.repeat(64),
    versions: {'@a2ui/react': '0.14.0', '@a2ui/web_core': '0.14.0'},
    checkpoints: [{step: 'render', data: {selection: 'hello', retained: 1}},
      {step: 'pointer', actionCount: 1}],
    actions: [{name: 'submit', context: {selection: 'hello', retained: 1}}],
    runtimeErrors: [], consoleErrors: [],
    accessibilityFindings: [{id: 'textfield-missing-accessible-name', severity: 'warning', expectedName: 'Edit form'}],
  };
}

test('same actual-browser behavior matches even if object key order or SDK version differs', () => {
  const before = trace();
  const after = structuredClone(before);
  after.versions['@a2ui/react'] = '0.14.1';
  after.actions[0].context = {retained: 1, selection: 'hello'};
  after.checkpoints[0].data = {retained: 1, selection: 'hello'};
  const diff = compareBrowserTraces(before, after);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.changedFields, []);
  assert.equal(diff.beforeVersions['@a2ui/react'], '0.14.0');
  assert.equal(diff.afterVersions['@a2ui/react'], '0.14.1');
  assert.equal(diff.differences.actions.changedCount, 0);
});

test('real action, checkpoint, error and accessibility differences are independently visible', () => {
  const before = trace();
  const after = structuredClone(before);
  after.actions[0].context.selection = 'stale';
  after.checkpoints.push({step: 'new render'});
  after.consoleErrors.push('React render warning');
  after.accessibilityFindings = [];
  const diff = compareBrowserTraces(before, after);
  assert.equal(diff.ok, false);
  assert.equal(diff.candidateHealthy, false);
  assert.deepEqual(diff.changedFields,
    ['actions', 'checkpoints', 'consoleErrors', 'accessibilityFindings']);
  assert.deepEqual(diff.differences.actions.changedIndices, [0]);
  assert.deepEqual(diff.differences.checkpoints.changedIndices, [2]);
  assert.equal(diff.differences.consoleErrors.afterCount, 1);
  assert.equal(diff.differences.accessibilityFindings.afterCount, 0);
  assert.equal(JSON.stringify(diff).includes('stale'), false, 'comparison summary must not leak action context');
});

test('fixture mismatch and incomplete traces fail closed', () => {
  const baseline = trace();
  const changed = trace();
  changed.fixtureSha256 = 'b'.repeat(64);
  assert.throws(() => compareBrowserTraces(baseline, changed), /fixture SHA-256 differs/);
  assert.throws(() => compareBrowserTraces(baseline, {passed: true}), /Invalid after browser trace schema/);
  assert.throws(() => compareBrowserTraces(baseline, {...changed, checkpoints: [{bad: 1}]}),
    /Invalid after browser trace schema/);
});

test('CLI strict drift and exclusive output keep prior evidence intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-diff-'));
  try {
    const beforePath = join(dir, 'before.json');
    const afterPath = join(dir, 'after.json');
    const outPath = join(dir, 'comparison.json');
    const before = trace();
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(trace()));
    const match = spawnSync(process.execPath,
      [cli, '--before', beforePath, '--after', afterPath, '--strict',
        '--json', '--out', outPath], {encoding: 'utf8'});
    assert.equal(match.status, 0, match.stderr);
    assert.equal(JSON.parse(match.stdout).ok, true);
    const original = readFileSync(outPath, 'utf8');
    const repeat = spawnSync(process.execPath,
      [cli, '--before', beforePath, '--after', afterPath, '--out', outPath], {encoding: 'utf8'});
    assert.equal(repeat.status, 2);
    assert.match(repeat.stderr, /output exists/);
    assert.equal(readFileSync(outPath, 'utf8'), original);

    const candidate = trace();
    candidate.actions[0].context.selection = 'different';
    writeFileSync(afterPath, JSON.stringify(candidate));
    const drift = spawnSync(process.execPath,
      [cli, '--before', beforePath, '--after', afterPath, '--strict', '--json'], {encoding: 'utf8'});
    assert.equal(drift.status, 1, drift.stderr);
    assert.deepEqual(JSON.parse(drift.stdout).changedFields, ['actions']);
    const informational = spawnSync(process.execPath,
      [cli, '--before', beforePath, '--after', afterPath], {encoding: 'utf8'});
    assert.equal(informational.status, 0, informational.stderr);
    assert.match(informational.stdout, /DRIFT/);

    writeFileSync(afterPath, '{"sensitive":"private-data-that-must-not-leak"');
    const malformed = spawnSync(process.execPath,
      [cli, '--before', beforePath, '--after', afterPath], {encoding: 'utf8'});
    assert.equal(malformed.status, 2);
    assert.doesNotMatch(malformed.stderr, /private-data-that-must-not-leak/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('different rendering harnesses are incomparable, not a healthy match', () => {
  const baseline = trace();
  const different = structuredClone(baseline);
  different.harness = 'Other renderer with identical serialized checkpoints';
  assert.throws(() => compareBrowserTraces(baseline, different), /rendering harness differs/);
  assert.throws(() => compareBrowserTraces(baseline, {...different, harness: ''}), /Invalid after browser trace schema/);
});

test('malformed browser evidence cannot produce a false MATCH or echo raw provenance', () => {
  const baseline = trace();
  const invalid = [
    {...baseline, versions: {'@a2ui/react': {privateToken: 'DO_NOT_ECHO'}}},
    {...baseline, versions: {}},
    {...baseline, versions: {'@a2ui/react': 'DO_NOT_ECHO'}},
    {...baseline, actions: [null]},
    {...baseline, actions: [{name: ''}]},
    {...baseline, checkpoints: [null]},
    {...baseline, runtimeErrors: [null]},
    {...baseline, consoleErrors: [{message: 'DO_NOT_ECHO'}]},
    {...baseline, accessibilityFindings: [null]},
    {...baseline, accessibilityFindings: [{severity: 'warning'}]},
  ];
  for (const candidate of invalid) {
    assert.throws(() => compareBrowserTraces(baseline, candidate),
      error => /Invalid after browser trace schema; input contents omitted/.test(error.message) &&
        !error.message.includes('DO_NOT_ECHO'));
  }
});

test('PNG-only browser visual drift is detected even when action and Text checkpoints match', () => {
  const before = trace();
  const after = structuredClone(before);
  before.screenshotSha256 = 'a'.repeat(64);
  after.screenshotSha256 = 'b'.repeat(64);
  const changed = compareBrowserTraces(before, after);
  assert.equal(changed.candidateHealthy, true);
  assert.equal(changed.visualEvidence, 'both');
  assert.equal(changed.screenshotChanged, true);
  assert.deepEqual(changed.changedFields, ['screenshotSha256']);
  assert.equal(changed.ok, false);
  assert.equal(JSON.stringify(changed).includes('private'), false);

  after.screenshotSha256 = before.screenshotSha256.toUpperCase();
  const match = compareBrowserTraces(before, after);
  assert.equal(match.ok, true);
  assert.equal(match.visualEvidence, 'both');
  assert.equal(match.screenshotChanged, false);

  delete after.screenshotSha256;
  const partial = compareBrowserTraces(before, after);
  assert.equal(partial.ok, false, 'Missing candidate PNG must not match a captured baseline');
  assert.equal(partial.visualEvidence, 'partial');
  assert.deepEqual(partial.changedFields, ['screenshotSha256']);

  delete before.screenshotSha256;
  const legacy = compareBrowserTraces(before, after);
  assert.equal(legacy.ok, true, 'Two pre-digest traces must remain comparable');
  assert.equal(legacy.visualEvidence, 'legacy-unavailable');
});

test('invalid PNG digests fail closed with no untrusted contents in diagnostics', () => {
  const baseline = trace();
  for (const bad of ['not-a-digest', '', null, 123, {sensitive: 'PRIVATE_IMAGE'}]) {
    const candidate = {...trace(), screenshotSha256: bad};
    assert.throws(() => compareBrowserTraces(baseline, candidate),
      error => /Invalid after browser trace schema; input contents omitted/.test(error.message) &&
        !error.message.includes('PRIVATE_IMAGE'));
  }
});
