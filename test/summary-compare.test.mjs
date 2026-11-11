import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
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
