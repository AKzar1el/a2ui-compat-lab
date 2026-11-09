import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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

test('optional PNG byte verification detects an altered screenshot despite identical trace JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-png-'));
  try {
    // Tiny public-domain 1x1 PNG: actual binary evidence, never an HTTP dependency.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64');
    const hash = createHash('sha256').update(png).digest('hex');
    const beforeTrace = join(dir, 'before.json');
    const afterTrace = join(dir, 'after.json');
    const beforePng = join(dir, 'before.png');
    const afterPng = join(dir, 'after.png');
    const withPng = ['--before', beforeTrace, '--after', afterTrace,
      '--before-png', beforePng, '--after-png', afterPng, '--strict', '--json'];
    writeFileSync(beforeTrace, JSON.stringify({...trace(), screenshotSha256: hash}));
    writeFileSync(afterTrace, JSON.stringify({...trace(), screenshotSha256: hash}));
    writeFileSync(beforePng, png);
    writeFileSync(afterPng, png);

    const verified = spawnSync(process.execPath, [cli, ...withPng], {encoding: 'utf8'});
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).pngArtifactsVerified, true);
    assert.equal(JSON.parse(verified.stdout).ok, true);

    // Without this opt-in check, matching JSON digests alone cannot establish
    // that the two saved screenshot files are still the bytes that were captured.
    writeFileSync(afterPng, Buffer.concat([png, Buffer.from('PRIVATE_IMAGE_TRAILER')]));
    const tampered = spawnSync(process.execPath, [cli, ...withPng], {encoding: 'utf8'});
    assert.equal(tampered.status, 2);
    assert.match(tampered.stderr, /after PNG SHA-256 mismatch/);
    assert.doesNotMatch(tampered.stderr, /PRIVATE_IMAGE_TRAILER/);
    const jsonOnly = spawnSync(process.execPath,
      [cli, '--before', beforeTrace, '--after', afterTrace, '--json'], {encoding: 'utf8'});
    assert.equal(jsonOnly.status, 0, jsonOnly.stderr);
    assert.equal(JSON.parse(jsonOnly.stdout).pngArtifactsVerified, false);

    writeFileSync(afterPng, Buffer.from('PRIVATE_IMAGE_NOT_PNG'));
    const invalidSignature = spawnSync(process.execPath, [cli, ...withPng], {encoding: 'utf8'});
    assert.equal(invalidSignature.status, 2);
    assert.match(invalidSignature.stderr, /Invalid after PNG signature/);
    assert.doesNotMatch(invalidSignature.stderr, /PRIVATE_IMAGE_NOT_PNG/);

    const incomplete = spawnSync(process.execPath,
      [cli, '--before', beforeTrace, '--after', afterTrace,
        '--before-png', beforePng], {encoding: 'utf8'});
    assert.equal(incomplete.status, 2);
    assert.match(incomplete.stderr, /Usage:/);

    writeFileSync(afterPng, png);
    writeFileSync(afterTrace, JSON.stringify(trace()));
    const legacy = spawnSync(process.execPath, [cli, ...withPng], {encoding: 'utf8'});
    assert.equal(legacy.status, 2);
    assert.match(legacy.stderr, /Missing after screenshot SHA-256/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});


test('Markdown browser comparison is reviewable, redacted, strict and never overwrites prior evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-markdown-'));
  try {
    const before = join(dir, 'old.json');
    const after = join(dir, 'new.json');
    const output = join(dir, 'review.md');
    const baseline = trace();
    const candidate = trace();
    candidate.versions['@a2ui/react'] = '0.14.1';
    candidate.actions[0].context.selection = 'PRIVATE_ACTION_CONTEXT_DO_NOT_PRINT';
    writeFileSync(before, JSON.stringify(baseline));
    writeFileSync(after, JSON.stringify(candidate));
    const flags = ['--before', before, '--after', after, '--markdown'];
    const drift = spawnSync(process.execPath,
      [cli, ...flags, '--strict', '--out', output], {encoding: 'utf8'});
    assert.equal(drift.status, 1, drift.stderr);
    assert.equal(drift.stdout, readFileSync(output, 'utf8'));
    assert.match(drift.stderr, /Wrote comparison report/);
    assert.doesNotMatch(drift.stderr, /a2ui-browser-markdown-/,
      'Successful Markdown export must not expose the local report path');
    assert.match(drift.stdout, /# A2UI real-browser regression comparison/);
    assert.match(drift.stdout, /\*\*Result:\*\* DRIFT/);
    assert.match(drift.stdout, /\| actions \| 1 \| 1 \| 1 \| 0 \|/);
    assert.match(drift.stdout, /\| \x60@a2ui\/react\x60 \| \x600\.14\.0\x60 \| \x600\.14\.1\x60 \|/);
    assert.match(drift.stdout, /saved artifact bytes verified: no/);
    assert.doesNotMatch(drift.stdout, /PRIVATE_ACTION_CONTEXT_DO_NOT_PRINT/);
    assert.doesNotMatch(drift.stdout, /a2ui-browser-markdown-/,
      'Comparison should not echo local file paths');

    const saved = readFileSync(output, 'utf8');
    const repeated = spawnSync(process.execPath,
      [cli, ...flags, '--out', output], {encoding: 'utf8'});
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /output exists/);
    assert.equal(readFileSync(output, 'utf8'), saved);

    candidate.actions = structuredClone(baseline.actions);
    writeFileSync(after, JSON.stringify(candidate));
    const match = spawnSync(process.execPath,
      [cli, ...flags, '--strict'], {encoding: 'utf8'});
    assert.equal(match.status, 0, match.stderr);
    assert.match(match.stdout, /\*\*Result:\*\* MATCH/);
    assert.match(match.stdout, /\*\*Changed fields:\*\* none/);

    const exclusive = spawnSync(process.execPath,
      [cli, ...flags, '--json'], {encoding: 'utf8'});
    assert.equal(exclusive.status, 2, 'Markdown and JSON must be exclusive');
    assert.match(exclusive.stderr, /Usage:/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('failed report output never prints private paths or damages previous files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-browser-output-redaction-'));
  try {
    const before = join(dir, 'baseline.json');
    const after = join(dir, 'candidate.json');
    writeFileSync(before, JSON.stringify(trace()));
    writeFileSync(after, JSON.stringify(trace()));
    const directoryTarget = join(dir, 'PRIVATE_REPORT_DIRECTORY');
    mkdirSync(directoryTarget);
    const blockedParent = join(dir, 'PRIVATE_BLOCKED_PARENT');
    writeFileSync(blockedParent, 'original user file');
    // O_EXCL already reports EEXIST for a directory. An overlong basename
    // specifically exercises the native write-failure path on Linux CI.
    const overlongName = join(dir, 'PRIVATE_LONG_FILENAME_' + 'x'.repeat(280) + '.md');
    for (const [target, expected] of [
      [directoryTarget, /Comparison output exists; choose a new --out path/],
      [overlongName, /Cannot write comparison output; path omitted/],
      [join(blockedParent, 'report.md'),
        /Cannot prepare comparison output directory; path omitted/],
    ]) {
      const result = spawnSync(process.execPath, [
        cli, '--before', before, '--after', after, '--markdown', '--out', target,
      ], {encoding: 'utf8'});
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '', 'Do not publish a partial Markdown report');
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /PRIVATE_|a2ui-browser-output-redaction-/,
        'Filesystem failure must not leak an absolute output path');
    }
    assert.equal(readFileSync(blockedParent, 'utf8'), 'original user file');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
