import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseJsonLines, parseJsonLinesBytes, replayV09Actions} from '../src/replay.mjs';

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

test('orphaned Button components cannot produce fake renderer action evidence', async () => {
  const orphan = structuredClone(steps.slice(0, 4));
  // The published processor registers this Button, but the rendered root cannot reach it.
  orphan[1].message.updateComponents.components[0].children = ['status'];
  await assert.rejects(replayV09Actions(orphan), /not an active Button/);

  const linkedViaOrphan = structuredClone(orphan);
  linkedViaOrphan[1].message.updateComponents.components.push({
    id: 'detached-container', component: 'Column', children: ['submit'],
  });
  await assert.rejects(replayV09Actions(linkedViaOrphan), /not an active Button/);

  // A later partial update can detach a previously rendered Button without deleting its model.
  const stale = structuredClone(steps.slice(0, 3));
  stale.push({message: {version: 'v0.9', updateComponents: {
    surfaceId: 'action-replay',
    components: [{id: 'root', component: 'Column', children: ['status']}],
  }}});
  stale.push({tap: {surfaceId: 'action-replay', componentId: 'submit'}});
  await assert.rejects(replayV09Actions(stale), /not an active Button/);

  const reachable = structuredClone(orphan);
  reachable[1].message.updateComponents.components[0].children = ['status', 'submit'];
  const output = await replayV09Actions(reachable);
  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].sourceComponentId, 'submit');

  // Basic Catalog supports structural child slots beyond Column.children.
  for (const root of [
    {id: 'root', component: 'Card', child: 'submit'},
    {id: 'root', component: 'Tabs', tabs: [{title: 'Confirm', child: 'submit'}]},
    {id: 'root', component: 'Modal', trigger: 'submit', content: 'label'},
  ]) {
    const nested = structuredClone(orphan);
    nested[1].message.updateComponents.components[0] = root;
    const trace = await replayV09Actions(nested);
    assert.equal(trace.actions.length, 1, root.component);
    assert.equal(trace.actions[0].sourceComponentId, 'submit', root.component);
  }
});

test('rooted Button with failed checks cannot be tapped in headless replay', async () => {
  const disabled = structuredClone(steps.slice(0, 3));
  disabled[1].message.updateComponents.components.find(item => item.id === 'submit').checks = [
    {condition: {call: 'required', args: {value: {path: '/approval'}}}, message: 'Approval required'},
  ];
  disabled[2].message.updateDataModel.value.approval = '';
  const tap = {tap: {surfaceId: 'action-replay', componentId: 'submit'}};
  await assert.rejects(replayV09Actions([...disabled, tap]), /Button failed validation checks/);

  const enabled = structuredClone(disabled);
  enabled[2].message.updateDataModel.value.approval = 'yes';
  const accepted = await replayV09Actions([...enabled, tap]);
  assert.equal(accepted.actions.length, 1);
  assert.equal(accepted.actions[0].name, 'confirm-choice');

  // Changing the model after one valid click must disable the next click.
  const disabledAgain = [...enabled, tap, {message: {
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/approval', value: '',
    },
  }}, tap];
  await assert.rejects(replayV09Actions(disabledAgain), /Button failed validation checks/);
});

test('malformed interaction envelopes fail closed instead of silently skipping input', async () => {
  await assert.rejects(replayV09Actions([{tap: {componentId: 'submit'}}]), /must name a surface/);
  await assert.rejects(replayV09Actions([{message: {}, tap: {}}]), /exactly one/);
  await assert.rejects(replayV09Actions([{unknown: {}}]), /exactly one/);
  await assert.rejects(replayV09Actions([null]), /Invalid replay step/);
});


test('UTF-8 byte chunk boundaries preserve non-ASCII Button action contexts', async () => {
  const unicode = structuredClone(steps);
  unicode[2].message.updateDataModel.value.selection = 'Čebelica 🌍';
  unicode[4].message.updateDataModel.value.selection = 'こんにちは 👋';
  const expected = await replayV09Actions(unicode);
  assert.deepEqual(expected.actions.map(action => action.context.selection),
    ['Čebelica 🌍', 'こんにちは 👋']);
  const bytes = Buffer.from(unicode.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  for (const size of [1, 2, 3, 7, 57, bytes.length]) {
    const chunks = [];
    for (let index = 0; index < bytes.length; index += size)
      chunks.push(bytes.subarray(index, index + size));
    assert.deepEqual(await replayV09Actions(parseJsonLinesBytes(chunks)), expected,
      'byte chunk size ' + size);
  }
});

test('action report includes deterministic Unicode byte-stream trial evidence', () => {
  const script = fileURLToPath(new URL('../src/replay-action-report.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const report = JSON.parse(result.stdout);
  assert.equal(report.allMatch, true);
  assert.equal(report.chunkTrials.length, 4);
  assert.deepEqual(report.byteChunkTrials.map(trial => trial.chunkSizeBytes),
    [1, 2, 3, 7, 57, report.byteChunkTrials.at(-1).chunkSizeBytes]);
  assert.ok(report.byteChunkTrials.every(trial => trial.matches));
  assert.deepEqual(report.unicodeTrace.actions.map(action => action.context.selection),
    ['Čebelica 🌍', 'こんにちは 👋']);
  assert.match(report.unicodeFixtureSha256, /^[0-9a-f]{64}$/);
});
