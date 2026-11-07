import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseJsonLines, parseJsonLinesBytes, replayV09} from '../src/replay.mjs';

const messages = [
  {version: 'v0.9', createSurface: {surfaceId: 'replay', catalogId: '__BASIC_CATALOG__'}},
  {version: 'v0.9', updateComponents: {surfaceId: 'replay', components: [
    {id: 'root', component: 'Column', children: ['greeting', 'detail']},
    {id: 'greeting', component: 'Text', text: {path: '/title'}},
    {id: 'detail', component: 'Text', text: {path: '/body'}},
  ]}},
  {version: 'v0.9', updateDataModel: {surfaceId: 'replay', path: '/', value: {title: 'Hello', body: 'First'}}},
  {version: 'v0.9', updateDataModel: {surfaceId: 'replay', path: '/title', value: 'Updated'}},
  {version: 'v0.9', deleteSurface: {surfaceId: 'replay'}},
];

test('actual published A2UI v0.9 processor replays component, data and disposal lifecycle', () => {
  const result = replayV09(messages);
  assert.equal(result.snapshots.length, 5);
  assert.equal(result.snapshots[0].exists, true);
  assert.deepEqual(result.snapshots[1].components, ['root', 'greeting', 'detail']);
  assert.deepEqual(result.snapshots[2].data, {title: 'Hello', body: 'First'});
  assert.deepEqual(result.snapshots[3].data, {title: 'Updated', body: 'First'});
  assert.equal(result.snapshots[4].exists, false);
});

test('JSONL chunk boundaries do not change A2UI state sequence', () => {
  const jsonl = messages.map(x => JSON.stringify(x)).join('\n') + '\n';
  const tinyChunks = jsonl.match(/.{1,7}/gs) ?? [];
  const largerChunks = jsonl.match(/.{1,57}/gs) ?? [];
  const direct = replayV09(messages);
  assert.deepEqual(replayV09(parseJsonLines(tinyChunks)), direct);
  assert.deepEqual(replayV09(parseJsonLines(largerChunks)), direct);
});

test('incomplete and oversized JSONL messages fail closed', () => {
  assert.throws(() => parseJsonLines(['{"version":"v0.9"']), /Incomplete/);
  assert.throws(() => parseJsonLines(['{"oversized":"' + 'a'.repeat(200) + '"}\n'], {maxLineBytes: 100}), /exceeds/);
});

test('arbitrary UTF-8 byte boundaries preserve published A2UI SDK state and unicode', () => {
  const localized = structuredClone(messages);
  localized[2].updateDataModel.value = {title: 'Čebelica 🌍', body: 'こんにちは'};
  localized[3].updateDataModel.value = 'Здраво 👋';
  const bytes = Buffer.from(localized.map(JSON.stringify).join('\n') + '\n');
  const expected = replayV09(localized);
  assert.deepEqual(expected.snapshots[2].data, {title: 'Čebelica 🌍', body: 'こんにちは'});

  for (const size of [1, 2, 3, 4, 7, 57, bytes.length]) {
    const chunks = [];
    for (let index = 0; index < bytes.length; index += size)
      chunks.push(bytes.subarray(index, index + size));
    assert.deepEqual(replayV09(parseJsonLinesBytes(chunks)), expected, 'byte size ' + size);
  }
});

test('UTF-8 byte parser rejects invalid sequences, truncation and excess resources', () => {
  const line = Buffer.from('{"label":"é🌍"}\n');
  assert.deepEqual(parseJsonLinesBytes([line], {maxLineBytes: line.length - 1}), [{label: 'é🌍'}]);
  assert.throws(() => parseJsonLinesBytes([line], {maxLineBytes: line.length - 2}), /exceeds byte limit/);
  assert.throws(() => parseJsonLinesBytes([Uint8Array.from([0xc3, 0x28, 0x0a])]), /encoded data|UTF-8|valid for encoding/i);
  assert.throws(() => parseJsonLinesBytes([line.subarray(0, -1)]), /Incomplete trailing/);
  assert.throws(() => parseJsonLinesBytes(['{"text":"wrong input"}\n']), /Uint8Array or Buffer/);
  assert.throws(() => parseJsonLinesBytes([line], {maxMessages: 0}), /Invalid message limit/);
  assert.throws(() => parseJsonLinesBytes([line, line], {maxMessages: 1}), /count exceeds limit/);
  assert.deepEqual(parseJsonLinesBytes([Buffer.from('\r\n  \r\n{"ok":true}\r\n')]), [{ok: true}]);
});
