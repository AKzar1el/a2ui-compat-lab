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

test('two private JSONL captures compare their observed structure without intermediate reports', () => withReports(({dir}) => {
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  messages[2].updateDataModel.value.title = 'PRIVATE_PAIR_VALUE_SENTINEL';
  const candidate = join(dir, 'PRIVATE_PAIR_PATH_SENTINEL.jsonl');
  writeFileSync(candidate, messages.map(JSON.stringify).join('\n') + '\n');

  let result = run(compare, ['--before-capture', sample, '--after-capture', candidate, '--strict']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, 'MATCH', 'Value changes alone must not be treated as structural drift');
  assert.equal(report.beforeEvents, 5);
  assert.equal(report.afterEvents, 5);
  assert.equal(report.changedSteps, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PAIR_VALUE_SENTINEL|PRIVATE_PAIR_PATH_SENTINEL|surfaceId|captureSha256/);
  assert.deepEqual(readdirSync(dir), ['PRIVATE_PAIR_PATH_SENTINEL.jsonl'],
    'No raw or summary intermediate files should be materialized');

  result = run(compare, ['--before-capture', sample, '--after-capture', candidate, '--verify-chunks', '--strict']);
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.beforeChunksVerified, true);
  assert.equal(verified.afterChunksVerified, true);
  assert.equal(verified.verificationCoverageChanged, false);
}));

test('two-capture comparison detects real lifecycle drift and refuses untrusted inputs', () => withReports(({dir, beforePath}) => {
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  messages.splice(4, 0, structuredClone(messages[3]));
  const candidate = join(dir, 'drifting-private.jsonl');
  writeFileSync(candidate, messages.map(JSON.stringify).join('\n') + '\n');
  let result = run(compare, ['--before-capture', sample, '--after-capture', candidate, '--strict']);
  assert.equal(result.status, 1, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.equal(diff.result, 'DRIFT');
  assert.equal(diff.beforeEvents, 5);
  assert.equal(diff.afterEvents, 6);
  assert.deepEqual(diff.differences.map(entry => entry.index), [4, 5]);

  const privateName = 'PRIVATE_PAIR_ERROR_SENTINEL';
  const invalid = join(dir, privateName + '.jsonl');
  writeFileSync(invalid, '{"bad":PRIVATE_PAIR_ERROR_SENTINEL}\n');
  result = run(compare, ['--before-capture', invalid, '--after-capture', sample]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /PRIVATE_PAIR_ERROR_SENTINEL|a2ui-safe-diff-/);

  const baseline = run(replay, ['--input', sample, '--summary']);
  assert.equal(baseline.status, 0, baseline.stderr);
  writeFileSync(beforePath, baseline.stdout);
  for (const args of [
    ['--before', beforePath, '--before-capture', sample, '--after-capture', sample],
    ['--before-capture', sample, '--after', beforePath, '--after-capture', sample],
    ['--before', beforePath, '--after', beforePath, '--verify-chunks'],
  ]) {
    result = run(compare, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
}));


test('CopilotKit operation envelopes compare directly with private JSONL without writing unwrapped captures', () => withReports(({dir}) => {
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  messages[2].updateDataModel.value.title = 'PRIVATE_COPILOTKIT_SUMMARY_VALUE';
  const wrapped = join(dir, 'PRIVATE_COPILOTKIT_SUMMARY_PATH.json');
  writeFileSync(wrapped, JSON.stringify({a2ui_operations: messages}));

  let result = run(compare, ['--before-capture', sample, '--after-capture', wrapped,
    '--after-format', 'copilotkit-operations', '--verify-chunks', '--strict']);
  assert.equal(result.status, 0, result.stderr);
  let diff = JSON.parse(result.stdout);
  assert.equal(diff.result, 'MATCH', 'A value-only change must not count as structural drift');
  assert.equal(diff.beforeEvents, 5);
  assert.equal(diff.afterEvents, 5);
  assert.equal(diff.beforeChunksVerified, true);
  assert.equal(diff.afterChunksVerified, true);
  assert.doesNotMatch(result.stdout + result.stderr,
    /PRIVATE_COPILOTKIT_SUMMARY|surfaceId|captureSha256|"data"/);
  assert.deepEqual(readdirSync(dir), ['PRIVATE_COPILOTKIT_SUMMARY_PATH.json'],
    'The adapter must not write private intermediate JSONL or summaries');

  result = run(compare, ['--before-capture', wrapped, '--before-format', 'copilotkit-operations',
    '--after-capture', sample, '--strict']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, 'MATCH');

  messages.splice(4, 0, structuredClone(messages[3]));
  writeFileSync(wrapped, JSON.stringify({a2ui_operations: messages}));
  result = run(compare, ['--before-capture', sample, '--after-capture', wrapped,
    '--after-format', 'copilotkit-operations', '--strict']);
  assert.equal(result.status, 1, result.stderr);
  diff = JSON.parse(result.stdout);
  assert.equal(diff.result, 'DRIFT');
  assert.equal(diff.afterEvents, 6);
  assert.deepEqual(diff.differences.map(entry => entry.index), [4, 5]);
}));

test('CopilotKit comparison input format fails closed for invalid flags, versions and private inputs', () => withReports(({dir}) => {
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const privateName = 'PRIVATE_COPILOTKIT_REJECTION_SENTINEL';
  const wrapped = join(dir, privateName + '.json');
  const out = join(dir, 'should-not-exist.json');
  messages[0] = {...messages[0], version: 'v1.0'};
  writeFileSync(wrapped, JSON.stringify({a2ui_operations: messages, secret: privateName}));
  let result = run(compare, ['--before-capture', sample, '--after-capture', wrapped,
    '--after-format', 'copilotkit-operations', '--out', out]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Cannot replay capture with pinned SDK/);
  assert.doesNotMatch(result.stderr, /PRIVATE_COPILOTKIT_REJECTION_SENTINEL|a2ui-safe-diff-/);
  assert.deepEqual(readdirSync(dir).sort(), [privateName + '.json'],
    'Invalid input must not materialize the report');

  for (const invalid of [
    ['--before-capture', sample, '--after-capture', sample, '--after-format', 'v1.0'],
    ['--before-capture', sample, '--after-capture', sample, '--before-format', 'copilotkit-operations', '--before-format', 'jsonl'],
    ['--before-capture', sample, '--after', wrapped, '--after-format', 'copilotkit-operations'],
    ['--before', wrapped, '--before-format', 'copilotkit-operations', '--after-capture', sample],
  ]) {
    result = run(compare, invalid);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
}));


test('ephemeral target parity detects valid multi-surface routing drift missed by structural summaries', () => withReports(({dir}) => {
  const create = surfaceId => ({version: 'v0.9', createSurface: {
    surfaceId, catalogId: '__BASIC_CATALOG__',
  }});
  const remove = surfaceId => ({version: 'v0.9', deleteSurface: {surfaceId}});
  const beforeCapture = join(dir, 'PRIVATE_ROUTING_BEFORE.jsonl');
  const afterCapture = join(dir, 'PRIVATE_ROUTING_AFTER.jsonl');
  writeFileSync(beforeCapture, [create('PRIVATE_ALPHA'), create('PRIVATE_BETA'), remove('PRIVATE_BETA')]
    .map(JSON.stringify).join('\n') + '\n');
  writeFileSync(afterCapture, [create('PRIVATE_ALPHA'), create('PRIVATE_BETA'), remove('PRIVATE_ALPHA')]
    .map(JSON.stringify).join('\n') + '\n');

  const args = ['--before-capture', beforeCapture, '--after-capture', afterCapture, '--strict'];
  const legacy = run(compare, args);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).result, 'MATCH',
    'Legacy per-target summaries intentionally omit surface identity');

  const keyed = run(compare, [...args, '--compare-surface-targets', '--verify-chunks']);
  assert.equal(keyed.status, 1, keyed.stderr);
  const report = JSON.parse(keyed.stdout);
  assert.equal(report.result, 'DRIFT');
  assert.equal(report.surfaceTargetsCompared, true);
  assert.equal(report.changedSteps, 1);
  assert.deepEqual(report.differences, [{index: 2, fields: ['surfaceTarget']}]);
  assert.doesNotMatch(keyed.stdout + keyed.stderr,
    /PRIVATE_ALPHA|PRIVATE_BETA|PRIVATE_ROUTING_|surfaceId|captureSha256|[a-f0-9]{64}/);
  assert.deepEqual(readdirSync(dir).sort(),
    ['PRIVATE_ROUTING_BEFORE.jsonl', 'PRIVATE_ROUTING_AFTER.jsonl'].sort(),
    'Private digests and raw intermediate reports must never be saved');
}));

test('private target parity matches identical capture and CopilotKit envelope routing', () => withReports(({dir}) => {
  const messages = readFileSync(sample, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const wrapped = join(dir, 'PRIVATE_COPILOTKIT_TARGET.json');
  writeFileSync(wrapped, JSON.stringify({a2ui_operations: messages}));
  const result = run(compare, ['--before-capture', sample,
    '--after-capture', wrapped, '--after-format', 'copilotkit-operations',
    '--compare-surface-targets', '--strict']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, 'MATCH');
  assert.equal(report.surfaceTargetsCompared, true);
  assert.doesNotMatch(result.stdout + result.stderr,
    /PRIVATE_COPILOTKIT_TARGET|surfaceId|captureSha256|[a-f0-9]{64}/);
  assert.deepEqual(readdirSync(dir), ['PRIVATE_COPILOTKIT_TARGET.json']);
}));

test('private routing comparison rejects saved-summary use, duplicate flags and unkeyed child output', () => withReports(({beforePath, dir}) => {
  const baseline = run(replay, ['--input', sample, '--summary']);
  assert.equal(baseline.status, 0, baseline.stderr);
  writeFileSync(beforePath, baseline.stdout);
  for (const args of [
    ['--before', beforePath, '--after-capture', sample, '--compare-surface-targets'],
    ['--before-capture', sample, '--after', beforePath, '--compare-surface-targets'],
    ['--before', beforePath, '--after', beforePath, '--compare-surface-targets'],
    ['--before-capture', sample, '--after-capture', sample,
      '--compare-surface-targets', '--compare-surface-targets'],
  ]) {
    const result = run(compare, args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage:/);
  }
  const internal = run(replay, ['--input', sample, '--summary', '--internal-surface-target-digests']);
  assert.equal(internal.status, 1);
  assert.equal(internal.stdout, '');
  assert.doesNotMatch(internal.stderr, /PRIVATE_|surfaceId|captureSha256/);
  assert.deepEqual(readdirSync(dir), ['before.json']);
}));
