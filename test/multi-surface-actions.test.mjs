import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJsonLinesBytes, replayV09Actions} from '../src/replay.mjs';

const publishedButtonFixture = JSON.parse(
  readFileSync(new URL('../fixtures/action-v09.json', import.meta.url), 'utf8'),
);

function createButtonSurface(surfaceId, selection) {
  return publishedButtonFixture.slice(0, 3).map((source, index) => {
    const step = structuredClone(source);
    const operation = ['createSurface', 'updateComponents', 'updateDataModel'][index];
    step.message[operation].surfaceId = surfaceId;
    if (index === 2) step.message.updateDataModel.value.selection = selection;
    return step;
  });
}

const tap = surfaceId => ({tap: {surfaceId, componentId: 'submit'}});
const remove = surfaceId => ({message: {version: 'v0.9', deleteSurface: {surfaceId}}});
const replaceSelection = (surfaceId, selection) => ({
  message: {version: 'v0.9', updateDataModel: {
    surfaceId, path: '/', value: {selection, confirmed: true},
  }},
});
const emitted = (surfaceId, selection) => ({
  name: 'confirm-choice', surfaceId, sourceComponentId: 'submit',
  context: {selection},
});

function interleavedTimeline() {
  return [
    ...createButtonSurface('north', 'north-1'),
    ...createButtonSurface('south', 'south-1'),
    tap('north'),
    replaceSelection('south', 'south-2'),
    tap('south'),
    tap('north'),
    remove('north'),
    ...createButtonSurface('north', 'north-3'),
    tap('north'),
    tap('south'),
  ];
}

test('real SDK routes interleaved Button actions to their owning surface after delete/recreate', async () => {
  const result = await replayV09Actions(interleavedTimeline());
  assert.deepEqual(result.actions, [
    emitted('north', 'north-1'),
    emitted('south', 'south-2'),
    emitted('north', 'north-1'),
    emitted('north', 'north-3'),
    emitted('south', 'south-2'),
  ]);
  assert.equal(result.snapshots.length, 16);
  assert.equal(result.snapshots[10].exists, false, 'removed north surface stays absent');
  assert.deepEqual(result.snapshots[13].data, {selection: 'north-3', confirmed: false});
  assert.deepEqual(result.snapshots[14].data, {selection: 'north-3', confirmed: false});
  assert.deepEqual(result.snapshots[15].data, {selection: 'south-2', confirmed: true});
  assert.equal(result.snapshots[15].actionCount, 5);
});

test('byte-split JSONL replay preserves every multi-surface action and state snapshot', async () => {
  const steps = interleavedTimeline();
  const bytes = Buffer.from(steps.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
  const expected = await replayV09Actions(steps);
  for (const size of [1, 2, 7, 57, bytes.length]) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += size)
      chunks.push(bytes.subarray(offset, offset + size));
    const observed = await replayV09Actions(parseJsonLinesBytes(chunks));
    assert.deepEqual(observed, expected, 'UTF-8 byte chunk size ' + size);
  }
});

test('stale Button tap rejects instead of falling through to a surviving surface', async () => {
  const initial = [
    ...createButtonSurface('north', 'north-1'),
    ...createButtonSurface('south', 'south-1'),
    remove('north'),
  ];
  await assert.rejects(replayV09Actions([...initial, tap('north')]), /not an active Button/);
  const surviving = await replayV09Actions([...initial, tap('south')]);
  assert.deepEqual(surviving.actions, [emitted('south', 'south-1')]);
});
