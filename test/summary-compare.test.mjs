import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const replay = fileURLToPath(new URL('../src/replay-file.mjs', import.meta.url));
const compare = fileURLToPath(new URL('../src/summary-compare.mjs', import.meta.url));
const sample = fileURLToPath(new URL('../fixtures/lifecycle-v09.jsonl', import.meta.url));

function run(cli, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function withReports(check) {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-safe-diff-'));
  try {
    const observed = run(replay, ['--input', sample, '--summary']);
    assert.equal(observed.status, 0, observed.stderr);
    const before = JSON.parse(observed.stdout);
    const beforePath = join(dir, 'before.json');
    const afterPath = join(dir, 'after.json');
    const compareReports = (after, extra = []) => {
      writeFileSync(beforePath, JSON.stringify(before));
      writeFileSync(afterPath, JSON.stringify(after));
      return run(compare, ['--before', beforePath, '--after', afterPath, ...extra]);
    };
    check({dir, before, beforePath, afterPath, compareReports});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('compares actual published-SDK safe summaries without revealing captured values', () => withReports(({before, compareReports}) => {
  const result = compareReports(structuredClone(before), ['--strict']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, 'a2ui-capture-structure-diff');
  assert.equal(report.result, 'MATCH');
  assert.equal(report.beforeEvents, 5);
  assert.equal(report.afterEvents, 5);
  assert.equal(report.changedSteps, 0);
  assert.deepEqual(report.differences, []);
  assert.doesNotMatch(result.stdout, /captureSha256|implementation|surfaceId|selection|Hello|First|dataModel/);
}));

test('detects bounded structural and verification drift with --strict', () => withReports(({before, compareReports}) => {
  const after = structuredClone(before);
  after.steps[2].componentCount += 1;
  after.steps[3].operation = 'deleteSurface';
  after.chunksVerified = !before.chunksVerified;
  const result = compareReports(after, ['--strict']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, 'DRIFT');
  assert.equal(report.verificationCoverageChanged, true);
  assert.equal(report.changedSteps, 2);
  assert.deepEqual(report.differences, [
    {index: 2, fields: ['componentCount']},
    {index: 3, fields: ['operation']},
  ]);
}));

test('reports added and missing steps rather than calling distinct sequences a match', () => withReports(({before, compareReports}) => {
  const after = structuredClone(before);
  after.steps.pop();
  after.events -= 1;
  let report = JSON.parse(compareReports(after, ['--strict']).stdout);
  assert.equal(report.result, 'DRIFT');
  assert.deepEqual(report.differences, [{index: 4, fields: ['stepRemoved']}]);

  const inserted = structuredClone(before);
  const last = structuredClone(inserted.steps.at(-1));
  last.index = inserted.steps.length;
  last.actionsEmitted = 0;
  inserted.steps.push(last);
  inserted.events++;
  report = JSON.parse(compareReports(inserted, ['--strict']).stdout);
  assert.deepEqual(report.differences, [{index: 5, fields: ['stepAdded']}]);
}));

test('rejects untrusted fields and invalid action counters without disclosing secrets', () => withReports(({before, compareReports}) => {
  const injected = structuredClone(before);
  injected.privateValue = 'PRIVATE_SUMMARY_SECRET_SENTINEL';
  let result = compareReports(injected, ['--strict']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /PRIVATE_SUMMARY_SECRET_SENTINEL|a2ui-safe-diff-/);

  const badAction = structuredClone(before);
  badAction.steps[2].actionsEmitted = 7;
  result = compareReports(badAction, ['--strict']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');

  const malformed = structuredClone(before);
  malformed.steps[0].operation = 'PRIVATE_SUMMARY_SECRET_SENTINEL';
  result = compareReports(malformed);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /PRIVATE_SUMMARY_SECRET_SENTINEL/);
}));


test('compares a new private JSONL capture directly to its saved structural baseline', () => withReports(({before, beforePath, dir}) => {
  writeFileSync(beforePath, JSON.stringify(before));
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  messages[2].updateDataModel.value.title = 'PRIVATE_DIRECT_CAPTURE_SENTINEL';
  const capture = join(dir, 'new-private-capture.jsonl');
  writeFileSync(capture, messages.map(JSON.stringify).join('\n') + '\n');

  let result = run(compare, ['--before', beforePath, '--after-capture', capture, '--strict']);
  assert.equal(result.status, 0, result.stderr);
  const match = JSON.parse(result.stdout);
  assert.equal(match.result, 'MATCH', 'Value changes alone are intentionally invisible');
  assert.equal(match.changedSteps, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_DIRECT_CAPTURE_SENTINEL|new-private-capture|surfaceId|dataModel/);
  assert.deepEqual(readdirSync(dir).sort(), ['before.json', 'new-private-capture.jsonl'].sort(),
    'The direct compare must not create intermediate raw or summary reports');

  const out = join(dir, 'result.json');
  result = run(compare, ['--before', beforePath, '--after-capture', capture, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const original = readFileSync(out, 'utf8');
  assert.equal(JSON.parse(original).result, 'MATCH');
  result = run(compare, ['--before', beforePath, '--after-capture', capture, '--out', out]);
  assert.equal(result.status, 2);
  assert.equal(readFileSync(out, 'utf8'), original, 'Existing comparison evidence is immutable');
}));

test('direct capture comparison detects an inserted lifecycle message via real SDK replay', () => withReports(({before, beforePath, dir}) => {
  writeFileSync(beforePath, JSON.stringify(before));
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  messages.splice(4, 0, structuredClone(messages[3]));
  const capture = join(dir, 'drifting.jsonl');
  writeFileSync(capture, messages.map(JSON.stringify).join('\n') + '\n');
  const result = run(compare, ['--before', beforePath, '--after-capture', capture, '--strict']);
  assert.equal(result.status, 1, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.equal(diff.result, 'DRIFT');
  assert.equal(diff.beforeEvents, 5);
  assert.equal(diff.afterEvents, 6);
  assert.deepEqual(diff.differences.map(item => item.index), [4, 5]);
  assert.doesNotMatch(result.stdout, /\"data\"|\"components\"|surfaceId|captureSha256/);
}));

test('direct capture comparison verifies optional chunks and redacts rejected inputs', () => withReports(({beforePath, dir}) => {
  const verified = run(replay, ['--input', sample, '--summary', '--verify-chunks']);
  assert.equal(verified.status, 0, verified.stderr);
  writeFileSync(beforePath, verified.stdout);
  let result = run(compare, ['--before', beforePath, '--after-capture', sample,
    '--verify-chunks', '--strict']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, 'MATCH');
  assert.equal(JSON.parse(result.stdout).afterChunksVerified, true);

  const secret = 'PRIVATE_DIRECT_ERROR_SENTINEL';
  const invalid = join(dir, secret + '.jsonl');
  writeFileSync(invalid, '{\"version\":\"v0.9\",\"token\":' + secret + '}\n');
  result = run(compare, ['--before', beforePath, '--after-capture', invalid]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /PRIVATE_DIRECT_ERROR_SENTINEL|a2ui-safe-diff-/);
  assert.match(result.stderr, /Cannot replay capture with pinned SDK/);

  for (const invalidArgs of [
    ['--before', beforePath, '--after', beforePath, '--after-capture', sample],
    ['--before', beforePath, '--after', beforePath, '--verify-chunks'],
    ['--before', beforePath, '--after-capture', sample, '--after-capture', sample],
  ]) {
    result = run(compare, invalidArgs);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
}));

test('writes drift evidence exclusively, preserves it on retries and hides paths', () => withReports(({dir, before, beforePath, afterPath, compareReports}) => {
  const after = structuredClone(before);
  after.steps[2].componentCount++;
  const out = join(dir, 'PRIVATE_SUMMARY_PATH_SENTINEL.json');
  let result = compareReports(after, ['--strict', '--out', out]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /PRIVATE_SUMMARY_PATH_SENTINEL|a2ui-safe-diff-/);
  const saved = readFileSync(out, 'utf8');
  assert.equal(JSON.parse(saved).result, 'DRIFT');
  result = run(compare, ['--before', beforePath, '--after', afterPath, '--out', out]);
  assert.equal(result.status, 2);
  assert.equal(readFileSync(out, 'utf8'), saved);
  assert.doesNotMatch(result.stderr, /PRIVATE_SUMMARY_PATH_SENTINEL|a2ui-safe-diff-/);

  result = run(compare, ['--before', join(dir, 'PRIVATE_SUMMARY_PATH_SENTINEL-missing.json'), '--after', afterPath]);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /PRIVATE_SUMMARY_PATH_SENTINEL|a2ui-safe-diff-/);
}));
