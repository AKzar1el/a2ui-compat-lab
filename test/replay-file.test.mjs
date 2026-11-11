import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../src/replay-file.mjs', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/lifecycle-v09.json', import.meta.url), 'utf8'));
const jsonl = Buffer.from(fixture.map(message => JSON.stringify(message)).join('\n') + '\n');

test('committed JSONL sample matches canonical lifecycle fixture exactly', () => {
  const sample = readFileSync(new URL('../fixtures/lifecycle-v09.jsonl', import.meta.url), 'utf8');
  assert.deepEqual(sample.trimEnd().split('\n').map(JSON.parse), fixture);
});

function inTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'a2ui-capture-'));
  try { run(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

test('replays a local v0.9 JSONL capture through the published processor without network', () => inTemp(dir => {
  const input = join(dir, 'capture.jsonl');
  writeFileSync(input, jsonl);
  const result = invoke(['--input', input]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocol, 'v0.9');
  assert.equal(report.events, 5);
  assert.equal(report.captureBytes, jsonl.length);
  assert.equal(report.captureSha256, createHash('sha256').update(jsonl).digest('hex'));
  assert.deepEqual(report.replay.snapshots[2].data, {title: 'Hello', body: 'First'});
  assert.equal(report.replay.snapshots.at(-1).exists, false);
  assert.equal(report.replay.actionCount, 0);
  assert.doesNotMatch(result.stdout, /C:\\Users|\/tmp\/a2ui-capture-/);
}));

test('writes deterministic reports explicitly and refuses to overwrite previous evidence', () => inTemp(dir => {
  const input = join(dir, 'capture.jsonl');
  const output = join(dir, 'nested', 'report.json');
  writeFileSync(input, jsonl);
  const first = invoke(['--input', input, '--out', output]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).events, 5);
  const again = invoke(['--input', input, '--out', output]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Capture report already exists/);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).events, 5);
}));

test('capture CLI redacts filesystem paths on success and failures', () => inTemp(dir => {
  const secret = 'PRIVATE_A2UI_PATH_SENTINEL';
  const missing = join(dir, secret, 'missing.jsonl');
  let result = invoke(['--input', missing]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Cannot inspect capture input; path omitted/);
  assert.doesNotMatch(result.stderr, /PRIVATE_A2UI_PATH_SENTINEL|a2ui-capture-/);

  const input = join(dir, 'input.jsonl');
  writeFileSync(input, jsonl);
  const output = join(dir, secret, 'report.json');
  result = invoke(['--input', input, '--out', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), 'Wrote capture replay report');
  assert.doesNotMatch(result.stderr, /PRIVATE_A2UI_PATH_SENTINEL|a2ui-capture-/);
  const original = readFileSync(output);
  result = invoke(['--input', input, '--out', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Capture report already exists/);
  assert.doesNotMatch(result.stderr, /PRIVATE_A2UI_PATH_SENTINEL|a2ui-capture-/);
  assert.deepEqual(readFileSync(output), original, 'Existing evidence must not be overwritten');

  const blockedParent = join(dir, secret + '-BLOCKED');
  writeFileSync(blockedParent, 'not a directory');
  result = invoke(['--input', input, '--out', join(blockedParent, 'report.json')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot prepare capture report directory; path omitted/);
  assert.doesNotMatch(result.stderr, /PRIVATE_A2UI_PATH_SENTINEL|a2ui-capture-/);
  const directoryTarget = join(dir, secret + '-DIRECTORY');
  mkdirSync(directoryTarget);
  result = invoke(['--input', input, '--out', directoryTarget]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Capture report already exists|Cannot write capture report/);
  assert.doesNotMatch(result.stderr, /PRIVATE_A2UI_PATH_SENTINEL|a2ui-capture-/);
}));

test('rejects large whitespace-padded frames before the old text parser can trim them', () => inTemp(dir => {
  const input = join(dir, 'padded.jsonl');
  const output = join(dir, 'must-not-exist.json');
  writeFileSync(input, Buffer.from('{"version":"v0.9"}' + ' '.repeat(262145) + '\n'));
  const result = invoke(['--input', input, '--out', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /untrimmed byte limit/);
  assert.equal(existsSync(output), false);
}));

test('rejects malformed UTF-8, partial JSONL and invalid JSON without publishing a trace', () => inTemp(dir => {
  const input = join(dir, 'invalid.jsonl');
  for (const [raw, error] of [
    [Buffer.from([0xff, 0x0a]), /encoded|UTF-8|valid/i],
    [Buffer.from('{"version":"v0.9"}'), /must end with a JSONL newline/],
    [Buffer.from('{"bad":}\n'), /JSON/],
  ]) {
    writeFileSync(input, raw);
    const result = invoke(['--input', input]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, error);
  }
}));

test('capture processing failures redact private JSONL and SDK input', () => inTemp(dir => {
  const input = join(dir, 'private.jsonl');
  const output = join(dir, 'must-not-exist.json');
  const secret = 'LEAK1234_PRIVATE_CAPTURE';
  const cases = [
    [Buffer.from('{"version":"v0.9","debug":' + secret + '}\n'),
      /Capture JSONL parsing failed; input contents omitted/],
    [Buffer.from(JSON.stringify({
      version: 'v0.9', updateDataModel: {
        surfaceId: secret, path: '/', value: {customerToken: secret},
      },
    }) + '\n'), /Capture SDK replay failed; input contents omitted/],
  ];
  for (const [raw, expected] of cases) {
    writeFileSync(input, raw);
    const result = invoke(['--input', input, '--out', output]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /LEAK1234|PRIVATE_CAPTURE/,
      'Capture content must never appear in CLI failure diagnostics');
    assert.equal(existsSync(output), false, 'Rejected captures must not publish a trace');
  }
}));

test('rejects oversized captures and excess empty frames before replay', () => inTemp(dir => {
  const input = join(dir, 'large.jsonl');
  writeFileSync(input, Buffer.alloc(4 * 1024 * 1024 + 1, 0x0a));
  let result = invoke(['--input', input]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /4 MiB/);
  writeFileSync(input, Buffer.from('\n'.repeat(10001)));
  result = invoke(['--input', input]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /10,000 JSONL frames/);
}));

test('opt-in transport byte replay preserves actual SDK state across Unicode splits', () => inTemp(dir => {
  const localized = structuredClone(fixture);
  localized[2].updateDataModel.value = {title: 'Čebelica 🌍', body: 'こんにちは'};
  localized[3].updateDataModel.value = 'Здраво 👋';
  const raw = Buffer.from(localized.map(message => JSON.stringify(message)).join('\n') + '\n');
  const input = join(dir, 'unicode.jsonl');
  writeFileSync(input, raw);
  const result = invoke(['--verify-chunks', '--input', input]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.allChunksMatch, true);
  assert.deepEqual(report.chunkTrials.map(trial => trial.chunkSizeBytes), [1, 7, 57, raw.length]);
  assert.ok(report.chunkTrials.every(trial => trial.matches));
  assert.equal(report.chunkTrials[0].chunks, raw.length);
  assert.deepEqual(report.replay.snapshots[2].data, {title: 'Čebelica 🌍', body: 'こんにちは'});
  const normal = invoke(['--input', input]);
  assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(report.replay, JSON.parse(normal.stdout).replay);
  assert.equal(Object.hasOwn(JSON.parse(normal.stdout), 'chunkTrials'), false);
}));

test('oversized opt-in byte replay fails closed without writing an artifact', () => inTemp(dir => {
  const input = join(dir, 'large.jsonl');
  const output = join(dir, 'must-not-exist.json');
  writeFileSync(input, Buffer.from('{}\n'.repeat(175000)));
  const result = invoke(['--input', input, '--verify-chunks', '--out', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Chunk verification is limited to captures of 512 KiB/);
  assert.equal(existsSync(output), false);
}));

test('opt-in safe capture summary is useful for sharing without replay values or identifiers', () => inTemp(dir => {
  const localized = structuredClone(fixture);
  localized[2].updateDataModel.value.title = 'PRIVATE_SUMMARY_VALUE_SENTINEL';
  const input = join(dir, 'private-capture.jsonl');
  const output = join(dir, 'review', 'safe-summary.json');
  writeFileSync(input, Buffer.from(localized.map(message => JSON.stringify(message)).join('\n') + '\n'));

  let result = invoke(['--input', input, '--summary', '--verify-chunks']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.kind, 'a2ui-capture-safe-summary');
  assert.equal(summary.protocol, 'v0.9');
  assert.equal(summary.events, 5);
  assert.equal(summary.chunksVerified, true);
  assert.equal(summary.steps.length, summary.events);
  assert.deepEqual(summary.steps.map(step => step.index), [0, 1, 2, 3, 4]);
  assert.equal(summary.steps.at(-1).surfacePresent, false);
  assert.ok(summary.steps.every(step => Number.isInteger(step.componentCount) &&
    Number.isInteger(step.actionCount)));
  assert.doesNotMatch(result.stdout, /PRIVATE_SUMMARY_VALUE_SENTINEL|captureSha256|implementation|surfaceId|updateDataModel|\"data\"|\"components\"/);

  result = invoke(['--input', input, '--summary', '--out', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).chunksVerified, false);
  const saved = readFileSync(output, 'utf8');
  result = invoke(['--input', input, '--summary', '--out', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Capture report already exists/);
  assert.equal(readFileSync(output, 'utf8'), saved);
}));

test('unknown, duplicate or absent flags exit with usage and no output', () => {
  for (const args of [[], ['--input'], ['--unknown', 'x'], ['--input', 'a', '--input', 'b'], ['--input', 'a', '--verify-chunks', '--verify-chunks']]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const help = invoke(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});
