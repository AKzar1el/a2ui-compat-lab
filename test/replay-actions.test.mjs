import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJsonLines, replayV09Actions} from '../src/replay.mjs';

const steps = JSON.parse(readFileSync(new URL('../fixtures/action-v09.json', import.meta.url), 'utf8'));

test('published v0.9 SDK binds Button action, resolves current data, and relays agent response', async () => {
  const trace = await replayV09Actions(steps);
  assert.equal(trace.snapshots.length, 7);
  assert.deepEqual(trace.snapshots[1].components, ['root', 'status', 'submit', 'label']);
  assert.deepEqual(trace.snapshots[2].data, {selection: 'alpha', confirmed: false});
  assert.equal(trace.snapshots[3].actionCount, 1);
  assert.deepEqual(trace.snapshots[4].data, {selection: 'beta', confirmed: true});
  assert.equal(trace.snapshots[5].actionCount, 2);
  assert.equal(trace.snapshots[6].exists, false);
  assert.deepEqual(trace.actions, [
    {name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit', context: {selection: 'alpha'}},
    {name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit', context: {selection: 'beta'}},
  ]);
  assert.ok(trace.actions.every(action => !Object.hasOwn(action, 'timestamp')));
});

test('JSONL stream boundaries do not change A2UI interaction and data snapshots', async () => {
  const jsonl = steps.map(x => JSON.stringify(x)).join('\n') + '\n';
  const baseline = await replayV09Actions(steps);
  for (const size of [1, 7, 57, jsonl.length]) {
    const chunks = [];
    for (let i = 0; i < jsonl.length; i += size) chunks.push(jsonl.slice(i, i + size));
    assert.deepEqual(await replayV09Actions(parseJsonLines(chunks)), baseline, 'chunk size ' + size);
  }
});

test('interactions fail closed for missing, deleted, or non-Button components', async () => {
  const setup = steps.slice(0, 3);
  await assert.rejects(replayV09Actions([...setup, {tap: {surfaceId: 'action-replay', componentId: 'missing'}}]), /not an active Button/);
  await assert.rejects(replayV09Actions([...setup, {tap: {surfaceId: 'action-replay', componentId: 'status'}}]), /not an active Button/);
  await assert.rejects(replayV09Actions([...steps, {tap: {surfaceId: 'action-replay', componentId: 'submit'}}]), /not an active Button/);
  await assert.rejects(replayV09Actions([{tap: {surfaceId: 'action-replay', componentId: 'submit'}}]), /not an active Button/);
});

test('malformed interaction envelopes fail closed instead of silently skipping input', async () => {
  await assert.rejects(replayV09Actions([{tap: {componentId: 'submit'}}]), /must name a surface/);
  await assert.rejects(replayV09Actions([{message: {}, tap: {}}]), /exactly one/);
  await assert.rejects(replayV09Actions([{unknown: {}}]), /exactly one/);
  await assert.rejects(replayV09Actions([null]), /Invalid replay step/);
});
