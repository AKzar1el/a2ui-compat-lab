import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
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
  assert.match(again.stderr, /EEXIST/);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).events, 5);
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

test('unknown, duplicate or absent flags exit with usage and no output', () => {
  for (const args of [[], ['--input'], ['--unknown', 'x'], ['--input', 'a', '--input', 'b']]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const help = invoke(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});
