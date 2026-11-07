import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseJsonLines, replayV09} from '../src/replay.mjs';

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
