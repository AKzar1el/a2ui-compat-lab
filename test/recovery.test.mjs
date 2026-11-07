import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parseJsonLines, replayV09Recoverable} from '../src/replay.mjs';

const messages = JSON.parse(readFileSync(new URL('../fixtures/recovery-v09.json', import.meta.url), 'utf8'));

test('published A2UI processor isolates invalid lifecycle messages and recovers', () => {
  const result = replayV09Recoverable(messages);
  assert.equal(result.safeToContinue, true);
  assert.equal(result.halted, false);
  assert.equal(result.events.length, 13);
  assert.equal(result.appliedCount, 10);
  assert.equal(result.rejectedCount, 3);
  assert.deepEqual(result.events.filter(event => event.outcome === 'rejected').map(event => event.index), [3, 5, 9]);
  for (const index of [3, 5, 9]) {
    assert.equal(result.events[index].errorSource, 'sdk');
    assert.equal(result.events[index].mutationOnReject, false);
  }
  assert.match(result.events[3].error.message, /Surface not found/);
  assert.match(result.events[5].error.message, /Catalog not found/);
  assert.match(result.events[9].error.message, /Surface not found/);
  assert.deepEqual(result.events[4].state.components, ['root', 'status']);
  assert.deepEqual(result.events[4].state.data, {value: 'healthy', alive: true});
  assert.equal(result.events[8].state.exists, false);
  assert.equal(result.events[9].state.exists, false);
  assert.deepEqual(result.events[11].state.data, {value: 'recreated'});
  assert.deepEqual(result.events[11].state.components, []);
  assert.deepEqual(result.events[12].state.data, {value: 'still-born'});
  assert.equal(result.actionCount, 0);
});

test('recovery trace is invariant across JSONL chunk boundaries', () => {
  const raw = messages.map(message => JSON.stringify(message)).join('\n') + '\n';
  const expected = replayV09Recoverable(messages);
  for (const chunkSize of [1, 7, 57, raw.length]) {
    const chunks = [];
    for (let i = 0; i < raw.length; i += chunkSize) chunks.push(raw.slice(i, i + chunkSize));
    assert.deepEqual(replayV09Recoverable(parseJsonLines(chunks)), expected);
  }
});

test('invalid non-operation payloads are traceable without poisoning following valid messages', () => {
  const sequence = [null, {}, messages[0], messages[2]];
  const report = replayV09Recoverable(sequence);
  assert.deepEqual(report.events.map(event => event.outcome), ['rejected', 'rejected', 'applied', 'applied']);
  assert.deepEqual(report.events.slice(0, 2).map(event => event.errorSource), ['input', 'input']);
  assert.equal(report.safeToContinue, true);
  assert.equal(report.events[3].state.data.value, 'initial');
  assert.throws(() => replayV09Recoverable('not-an-array'), /array/);
});

test('offline recovery report exposes pinned SDK observations as JSON', () => {
  const result = spawnSync(process.execPath, ['src/recovery-report.mjs'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sdk, '@a2ui/web_core@0.15.0');
  assert.equal(report.replay.rejectedCount, 3);
  assert.equal(report.allMatch, true);
  assert.equal(report.matchesExpectedRejections, true);
  assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
});

test('offline recovery CLI rejects incomplete or unrelated options before writing', () => {
  for (const args of [['--out'], ['--unknown'], ['--out', 'out/recovery.json', 'extra']]) {
    const result = spawnSync(process.execPath, ['src/recovery-report.mjs', ...args], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
  }
});
