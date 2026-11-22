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

test('tap envelopes reject unknown fields before any Button action can be misdirected', async () => {
  const setup = steps.slice(0, 3);
  const target = {surfaceId: 'action-replay', componentId: 'submit'};
  const accepted = await replayV09Actions([...setup, {tap: target}]);
  assert.equal(accepted.actions.length, 1);

  // A typo must not silently fall back to an ID-only tap on a valid static Button.
  await assert.rejects(
    replayV09Actions([...setup, {tap: {...target, basePth: '/items/0'}}]),
    /Tap contains unrecognized fields/,
  );
  await assert.rejects(
    replayV09Actions([...setup, {tap: {...target, ignored: true}}]),
    /Tap contains unrecognized fields/,
  );
  await assert.rejects(
    replayV09Actions([...setup, {tap: ['action-replay', 'submit']}]),
    /Tap contains unrecognized fields/,
  );
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

  // A closed Modal's content is not rendered; there is no headless open step.
  const closedModal = structuredClone(orphan);
  closedModal[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Modal', trigger: 'status', content: 'submit',
  };
  await assert.rejects(replayV09Actions(closedModal), /not an active Button/);
  const nestedClosed = structuredClone(closedModal);
  nestedClosed[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Card', child: 'modal',
  };
  nestedClosed[1].message.updateComponents.components.push({
    id: 'modal', component: 'Modal', trigger: 'status', content: 'submit',
  });
  await assert.rejects(replayV09Actions(nestedClosed), /not an active Button/);

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

test('inactive Tabs content cannot produce fake headless Button action evidence', async () => {
  const hidden = structuredClone(steps.slice(0, 4));
  hidden[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Tabs', tabs: [
      {title: 'Visible', child: 'status'},
      {title: 'Inactive', child: 'submit'},
    ],
  };
  await assert.rejects(replayV09Actions(hidden), /not an active Button/);

  const nested = structuredClone(hidden);
  nested[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Card', child: 'tab-stack',
  };
  nested[1].message.updateComponents.components.push({
    id: 'tab-stack', component: 'Tabs', tabs: [
      {title: 'Visible', child: 'status'},
      {title: 'Inactive', child: 'submit'},
    ],
  });
  await assert.rejects(replayV09Actions(nested), /not an active Button/);

  // The first tab is rendered immediately without requiring a tab-switch action.
  const visible = structuredClone(hidden);
  visible[1].message.updateComponents.components[0].tabs = [
    {title: 'Visible', child: 'submit'},
    {title: 'Inactive', child: 'status'},
  ];
  const accepted = await replayV09Actions(visible);
  assert.equal(accepted.actions.length, 1);
  assert.equal(accepted.actions[0].sourceComponentId, 'submit');

  // A later component update must invalidate an initially reachable Button.
  const switchedByUpdate = structuredClone(visible.slice(0, 3));
  switchedByUpdate.push({message: {version: 'v0.9', updateComponents: {
    surfaceId: 'action-replay', components: [{
      id: 'root', component: 'Tabs', tabs: [
        {title: 'Visible', child: 'status'},
        {title: 'Inactive', child: 'submit'},
      ],
    }],
  }}});
  switchedByUpdate.push({tap: {surfaceId: 'action-replay', componentId: 'submit'}});
  await assert.rejects(replayV09Actions(switchedByUpdate), /not an active Button/);
});

test('rooted Button with failed checks cannot be tapped in headless replay', async () => {
  const disabled = structuredClone(steps.slice(0, 3));
  disabled[1].message.updateComponents.components.find(item => item.id === 'submit').checks = [
    {condition: {call: 'required', args: {value: {path: '/approval'}}}, message: 'Approval required'},
  ];
  disabled[2].message.updateDataModel.value.approval = '';
  const tap = {tap: {surfaceId: 'action-replay', componentId: 'submit'}};
  await assert.rejects(replayV09Actions([...disabled, tap]), /Button failed validation checks/);

  // No checks means no validation result: a normal Button is still tappable.
  const withoutChecks = structuredClone(disabled);
  delete withoutChecks[1].message.updateComponents.components.find(item => item.id === 'submit').checks;
  assert.equal((await replayV09Actions([...withoutChecks, tap])).actions.length, 1);
  const emptyChecks = structuredClone(disabled);
  emptyChecks[1].message.updateComponents.components.find(item => item.id === 'submit').checks = [];
  assert.equal((await replayV09Actions([...emptyChecks, tap])).actions.length, 1);

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

test('published SDK template Button replay selects only an explicit live row instance', async () => {
  const template = values => {
    const seeded = structuredClone(steps.slice(0, 3));
    seeded[1].message.updateComponents.components[0].children = {
      componentId: 'submit', path: '/items',
    };
    const button = seeded[1].message.updateComponents.components.find(c => c.id === 'submit');
    button.action.event.context.selection = {path: 'choice'};
    seeded[2].message.updateDataModel.value = {
      items: values.map(choice => ({choice})),
    };
    return seeded;
  };
  const tap = basePath => ({tap: {
    surfaceId: 'action-replay', componentId: 'submit', basePath,
  }});

  const twoRows = template(['alpha', 'beta']);
  await assert.rejects(replayV09Actions([...twoRows, {
    tap: {surfaceId: 'action-replay', componentId: 'submit'},
  }]), /not an active Button/);
  // Each published Basic Catalog layout materializes the same row-scoped child list.
  for (const layout of ['Row', 'List']) {
    const variant = template(['alpha', 'beta']);
    variant[1].message.updateComponents.components[0].component = layout;
    assert.deepEqual((await replayV09Actions([...variant, tap('/items/1')]))
      .actions.map(action => action.context.selection), ['beta'], layout);
  }
  const selected = await replayV09Actions([...twoRows, tap('/items/1')]);
  assert.deepEqual(selected.actions.map(action => action.context.selection), ['beta']);
  assert.equal(selected.snapshots.at(-1).basePath, '/items/1');
  assert.deepEqual((await replayV09Actions([...twoRows, tap('/items/0')]))
    .actions.map(action => action.context.selection), ['alpha']);

  await assert.rejects(replayV09Actions([...template([]), tap('/items/0')]), /not an active Button/);
  await assert.rejects(replayV09Actions([...template(['alpha']), tap('/items/1')]), /not an active Button/);
  await assert.rejects(replayV09Actions([...twoRows, tap('/items/01')]), /not an active Button/);
  await assert.rejects(replayV09Actions([...twoRows, tap('items/1')]), /absolute template instance path/);

  const nested = template(['alpha', 'beta']);
  nested[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Card', child: 'rows',
  };
  nested[1].message.updateComponents.components.push({
    id: 'rows', component: 'Column', children: {componentId: 'submit', path: '/items'},
  });
  assert.deepEqual((await replayV09Actions([...nested, tap('/items/1')]))
    .actions.map(action => action.context.selection), ['beta']);
});

test('template Button replay checks fresh membership after deletion and row reorder', async () => {
  const seeded = structuredClone(steps.slice(0, 3));
  seeded[1].message.updateComponents.components[0].children = {
    componentId: 'submit', path: '/items',
  };
  seeded[1].message.updateComponents.components.find(c => c.id === 'submit')
    .action.event.context.selection = {path: 'choice'};
  seeded[2].message.updateDataModel.value = {
    items: [{choice: 'alpha'}, {choice: 'beta'}],
  };
  const tap = {tap: {surfaceId: 'action-replay', componentId: 'submit', basePath: '/items/1'}};
  const replaceItems = value => ({message: {
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/items', value,
    },
  }});
  await assert.rejects(replayV09Actions([
    ...seeded, replaceItems([{choice: 'alpha'}]), tap,
  ]), /not an active Button/);

  const reordered = await replayV09Actions([
    ...seeded, tap, replaceItems([{choice: 'beta'}, {choice: 'alpha'}]), tap,
  ]);
  // The same numeric path now denotes the new row at that index, not the old record.
  assert.deepEqual(reordered.actions.map(action => action.context.selection), ['beta', 'alpha']);
  const detached = {message: {version: 'v0.9', updateComponents: {
    surfaceId: 'action-replay',
    components: [{id: 'root', component: 'Column', children: ['label']}],
  }}};
  await assert.rejects(replayV09Actions([...seeded, detached, tap]), /not an active Button/);
});

test('templated instances under closed Modal or inactive Tabs remain unclickable', async () => {
  const make = () => {
    const seeded = structuredClone(steps.slice(0, 3));
    seeded[1].message.updateComponents.components[0] = {
      id: 'root', component: 'Card', child: 'rows',
    };
    seeded[1].message.updateComponents.components.push({
      id: 'rows', component: 'Column', children: {componentId: 'submit', path: '/items'},
    });
    seeded[1].message.updateComponents.components.find(c => c.id === 'submit')
      .action.event.context.selection = {path: 'choice'};
    seeded[2].message.updateDataModel.value = {items: [{choice: 'alpha'}]};
    return seeded;
  };
  const tap = {tap: {surfaceId: 'action-replay', componentId: 'submit', basePath: '/items/0'}};
  const closed = make();
  closed[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Modal', trigger: 'label', content: 'rows',
  };
  await assert.rejects(replayV09Actions([...closed, tap]), /not an active Button/);
  const tabs = make();
  tabs[1].message.updateComponents.components[0] = {
    id: 'root', component: 'Tabs', tabs: [
      {title: 'Visible', child: 'label'}, {title: 'Hidden', child: 'rows'},
    ],
  };
  await assert.rejects(replayV09Actions([...tabs, tap]), /not an active Button/);
});
