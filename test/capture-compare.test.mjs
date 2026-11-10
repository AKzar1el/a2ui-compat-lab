import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareCaptureReports} from '../src/capture-compare.mjs';

const replayCli = fileURLToPath(new URL('../src/replay-file.mjs', import.meta.url));
const diffCli = fileURLToPath(new URL('../src/capture-compare-cli.mjs', import.meta.url));
const capture = fileURLToPath(new URL('../fixtures/lifecycle-v09.jsonl', import.meta.url));

function run(cli, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function actualReport() {
  const output = run(replayCli, ['--input', capture]);
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
}
function withReports(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-compare-'));
  try { fn(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('compares an actual pinned SDK replay of a committed capture without network', () => {
  const report = actualReport();
  const result = compareCaptureReports(report, structuredClone(report));
  assert.equal(result.ok, true);
  assert.equal(result.events, 5);
  assert.deepEqual(result.differences, []);
  assert.equal(result.actionCountChanged, false);
});

test('detects state, component and action drift without exposing captured values', () => {
  const before = actualReport();
  const after = structuredClone(before);
  after.replay.snapshots[2].data = {title: 'PRIVATE_TEST_SENTINEL', body: 'changed'};
  after.replay.snapshots[2].components.push('new-button');
  after.replay.snapshots[4].actionCount = 1;
  after.replay.actionCount = 1;
  after.implementation = '@a2ui/web_core@future-synthetic';
  const result = compareCaptureReports(before, after);
  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [
    {index: 2, fields: ['components', 'data']},
    {index: 4, fields: ['actionCount']},
  ]);
  assert.equal(result.actionCountChanged, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_SENTINEL/);
});

test('refuses different captures and structurally invalid reports', () => {
  const before = actualReport();
  const changes = [
    report => { report.captureSha256 = 'f'.repeat(64); },
    report => { report.captureBytes += 1; },
    report => { report.events += 1; },
    report => { report.replay.snapshots.pop(); },
    report => { report.replay.snapshots[1].index = 99; },
    report => { report.replay.snapshots[4].exists = false; report.replay.snapshots[4].data = {leak: true}; },
  ];
  for (const change of changes) {
    const after = structuredClone(before);
    change(after);
    assert.throws(() => compareCaptureReports(before, after), /different captures|inconsistent|malformed|deleted surface/);
  }
});

test('missing snapshot data cannot produce a false MATCH in identical incomplete capture reports', () => {
  const observed = actualReport();
  assert.ok(observed.replay.snapshots.every(s => Object.hasOwn(s, 'data')),
    'published-SDK capture producer must serialize explicit data for each step');
  for (const index of [0, 2, observed.replay.snapshots.length - 1]) {
    const incomplete = structuredClone(observed);
    delete incomplete.replay.snapshots[index].data;
    assert.throws(() => compareCaptureReports(incomplete, structuredClone(incomplete)),
      /malformed replay snapshot/, 'missing data at step ' + index + ' must fail closed');
  }
  const undefinedData = structuredClone(observed);
  undefinedData.replay.snapshots[2].data = undefined;
  assert.throws(() => compareCaptureReports(undefinedData, structuredClone(undefinedData)),
    /malformed replay snapshot/);
});

test('identically duplicated capture component IDs cannot falsely compare as MATCH', () => {
  const observed = actualReport();
  const index = observed.replay.snapshots.findIndex(s => s.exists && s.components.length > 0);
  assert.ok(index >= 0, 'published SDK replay must expose a populated component Map');
  const duplicate = structuredClone(observed);
  const ids = duplicate.replay.snapshots[index].components;
  ids.push(ids[0]);
  assert.throws(() => compareCaptureReports(duplicate, structuredClone(duplicate)),
    /malformed replay snapshot at index/,
    'SDK Map keys are unique; two matching impossible captures must be refused');
});

test('CLI produces stable machine-readable results and distinguishes drift from refusal', () => withReports(dir => {
  const report = actualReport();
  const oldFile = join(dir, 'old.json');
  const newFile = join(dir, 'new.json');
  writeFileSync(oldFile, JSON.stringify(report));
  writeFileSync(newFile, JSON.stringify(report));
  let result = run(diffCli, ['--before', oldFile, '--after', newFile, '--strict', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const changed = structuredClone(report);
  changed.replay.snapshots[2].data = {body: 'PRIVATE_TEST_SENTINEL'};
  writeFileSync(newFile, JSON.stringify(changed));
  result = run(diffCli, ['--before', oldFile, '--after', newFile, '--strict', '--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).differingSteps, 1);
  assert.doesNotMatch(result.stdout, /PRIVATE_TEST_SENTINEL/);
  result = run(diffCli, ['--before', oldFile, '--after', newFile, '--json']);
  assert.equal(result.status, 0);
  changed.captureSha256 = 'f'.repeat(64);
  writeFileSync(newFile, JSON.stringify(changed));
  result = run(diffCli, ['--before', oldFile, '--after', newFile, '--strict']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /different captures/);
}));

test('CLI rejects invalid options, malformed JSON and oversized reports', () => withReports(dir => {
  const input = join(dir, 'bad.json');
  writeFileSync(input, '{not valid');
  for (const args of [[], ['--before', input], ['--before', input, '--after', input, '--json', '--json']]) {
    const result = run(diffCli, args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  let result = run(diffCli, ['--before', input, '--after', input]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /JSON|Unexpected/);
  writeFileSync(input, ' '.repeat(8 * 1024 * 1024 + 1));
  result = run(diffCli, ['--before', input, '--after', input]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /8 MiB/);
  assert.match(run(diffCli, ['--help']).stdout, /Usage:/);
}));

test('malformed capture and action reports never echo confidential JSON in diagnostics', () => withReports(dir => {
  const good = join(dir, 'good.json');
  const malformed = join(dir, 'private.json');
  writeFileSync(good, JSON.stringify(actualReport()));
  writeFileSync(malformed, 'SECRET_CAPTURE_CONTEXT_TEST_NOT_JSON');
  for (const mode of [[], ['--actions']]) {
    for (const [before, after] of [[good, malformed], [malformed, good]]) {
      const result = run(diffCli, [...mode, '--before', before, '--after', after, '--strict', '--json']);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Report is not valid JSON/);
      assert.doesNotMatch(result.stderr, /SECRET_/);
    }
  }
}));


test('capture comparison refuses lossy UTF-8 replacement in either input', () => withReports(dir => {
  const good = join(dir, 'good.json');
  const corrupt = join(dir, 'corrupt.json');
  const report = actualReport();
  writeFileSync(good, JSON.stringify(report));
  const bytes = Buffer.from(JSON.stringify({
    ...report, implementation: 'PRIVATE_CAPTURE_UTF8_MARKER',
  }));
  const index = bytes.indexOf(Buffer.from('PRIVATE_CAPTURE_UTF8_MARKER'));
  assert.ok(index > 0);
  bytes[index] = 0xff;
  writeFileSync(corrupt, bytes);
  for (const [before, after] of [[corrupt, good], [good, corrupt], [corrupt, corrupt]]) {
    const result = run(diffCli, ['--before', before, '--after', after, '--strict', '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Report is not valid UTF-8/);
    assert.doesNotMatch(result.stderr, /RIVATE_CAPTURE_UTF8_MARKER/);
  }
}));
