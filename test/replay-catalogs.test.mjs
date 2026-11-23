import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Catalog, ComponentContext, GenericBinder} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';
import {createTrustedV09Processor, replayV09WithTrustedCatalogs} from '../src/replay-catalogs.mjs';

const customId = 'https://example.invalid/a2ui/catalog/hotgrid';
const makeCatalog = (id = customId, version = '0.9') =>
  new Catalog(id, version, [
    ...basicCatalog.components.values(),
    {...basicCatalog.components.get('Text'), name: 'HotGrid'},
  ], [...basicCatalog.functions.values()], basicCatalog.themeSchema);

const create = catalogId => ({version: 'v0.9', createSurface: {
  surfaceId: 'custom-replay', catalogId,
}});
const update = {version: 'v0.9', updateComponents: {
  surfaceId: 'custom-replay',
  components: [
    {id: 'root', component: 'Column', children: ['grid']},
    {id: 'grid', component: 'HotGrid', text: 'three rows'},
  ],
}};
const data = {version: 'v0.9', updateDataModel: {
  surfaceId: 'custom-replay', path: '/', value: {rows: 3},
}};

test('default basic replay remains available without custom executable code', () => {
  const result = replayV09WithTrustedCatalogs([create('__BASIC_CATALOG__')]);
  assert.deepEqual(result.registeredCatalogIds, [basicCatalog.id]);
  assert.deepEqual(result.snapshots[0].components, []);
  assert.equal(result.snapshots[0].exists, true);
  assert.throws(() => replayV09WithTrustedCatalogs([create(customId)]),
    /Unregistered catalog ID/);
});

test('opt-in custom Catalog processes real published-SDK components and data', () => {
  const result = replayV09WithTrustedCatalogs([create(customId), update, data],
    {trustedCatalogs: [makeCatalog()]});
  assert.deepEqual(result.registeredCatalogIds, [basicCatalog.id, customId]);
  assert.deepEqual(result.snapshots[1].components, ['root', 'grid']);
  assert.deepEqual(result.snapshots[2].data, {rows: 3});
  assert.equal(result.snapshots.every(s => s.exists), true);
  assert.throws(() => replayV09WithTrustedCatalogs([create(customId + '/wrong')],
    {trustedCatalogs: [makeCatalog()]}), /Unregistered catalog ID/);
});

test('all catalog ID collisions and untrusted registration fail before SDK construction', () => {
  const a = makeCatalog();
  const b = makeCatalog();
  const cases = [
    [basicCatalog],
    [makeCatalog(basicCatalog.id)],
    [a, a],
    [a, b],
    [a, makeCatalog(basicCatalog.id)],
    [makeCatalog(basicCatalog.id), a],
  ];
  for (const catalogs of cases)
    assert.throws(() => createTrustedV09Processor({trustedCatalogs: catalogs}),
      /Duplicate catalog ID/);
  assert.throws(() => createTrustedV09Processor({trustedCatalogs: [{}]}),
    /Catalog instances/);
  assert.throws(() => createTrustedV09Processor({trustedCatalogs: 'invalid'}),
    /trustedCatalogs/);
  assert.throws(() => createTrustedV09Processor({trustedCatalogs: [makeCatalog('')]}),
    /nonempty own ID/);
  assert.throws(() => createTrustedV09Processor({trustedCatalogs: [makeCatalog('other', '1.0')]}),
    /v0.9 protocol/);
});

test('trusted processor can emit a real Button event through the published binder', async () => {
  const actions = [];
  const {processor, registeredCatalogIds} = createTrustedV09Processor({
    trustedCatalogs: [makeCatalog()],
    onAction: action => actions.push(action),
  });
  let binder;
  try {
    const steps = JSON.parse(readFileSync(new URL('../fixtures/action-v09.json', import.meta.url)));
    for (const step of steps.slice(0, 3)) {
      const message = structuredClone(step.message);
      if (message.createSurface) message.createSurface.catalogId = customId;
      processor.processMessages([message]);
    }
    const surface = processor.getSurface('action-replay');
    assert.ok(surface);
    assert.deepEqual(registeredCatalogIds, [basicCatalog.id, customId]);
    binder = new GenericBinder(new ComponentContext(surface, 'submit'),
      makeCatalog().components.get('Button'));
    binder.subscribe(() => {});
    assert.equal(typeof binder.snapshot.action, 'function');
    await binder.snapshot.action();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'confirm-choice');
    assert.deepEqual(actions[0].context, {selection: 'alpha'});
  } finally {
    binder?.dispose();
    try { processor.model.dispose(); } finally { processor.dispose(); }
  }
});

test('invalid messages fail closed with finite input limits', () => {
  assert.throws(() => replayV09WithTrustedCatalogs([]), /1-1000/);
  assert.throws(() => replayV09WithTrustedCatalogs(Array(1001).fill(create(customId))),
    /1-1000/);
  assert.throws(() => replayV09WithTrustedCatalogs([{version: 'v1.0'}]),
    /Unsupported v0.9/);
});
