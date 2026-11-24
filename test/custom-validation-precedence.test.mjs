import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Catalog, createFunctionImplementation, NodeResolver, peekValue} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';
import {createTrustedV09Processor} from '../src/replay-catalogs.mjs';

test('pinned core 0.15.0 chooses explicit rule message for structured custom validation', () => {
  const id = 'https://example.invalid/a2ui/lab-check/v0_9';
  const check = createFunctionImplementation({
    ...basicCatalog.functions.get('required'), name: 'labCheck',
  }, ({value}) => ({valid: value === 'pass', message: 'function message', severity: 'error', code: 'LAB'}));
  const catalog = new Catalog(id, '0.9', [...basicCatalog.components.values()],
    [...basicCatalog.functions.values(), check], basicCatalog.themeSchema);
  const {processor} = createTrustedV09Processor({trustedCatalogs: [catalog]});
  const surfaceId = 'validation-precedence';
  const send = message => processor.processMessages([{version: 'v0.9', ...message}]);
  const errors = [];
  let subscription, resolver;
  try {
    send({createSurface: {surfaceId, catalogId: id}});
    const surface = processor.getSurface(surfaceId);
    assert.ok(surface);
    subscription = surface.onError.subscribe(error => errors.push(error));
    send({updateDataModel: {surfaceId, path: '/', value: {choice: 'fail'}}});
    resolver = new NodeResolver(surface);
    send({updateComponents: {surfaceId, components: [
      {id: 'root', component: 'Button', child: 'label',
        checks: [{condition: {call: 'labCheck', args: {value: {path: '/choice'}}}, message: 'rule message'}],
        action: {event: {name: 'submit-validation', context: {choice: {path: '/choice'}}}}},
      {id: 'label', component: 'Text', text: 'Submit validation'},
    ]}});
    const root = peekValue(resolver.rootNode);
    assert.ok(root);
    const expect = valid => {
      assert.equal(peekValue(resolver.rootNode), root);
      const props = peekValue(root.props);
      assert.equal(props.isValid, valid);
      assert.deepEqual(props.validationErrors, valid ? [] : ['rule message']);
      assert.deepEqual(props.validationResults.map(({valid, message, severity, code}) =>
        ({valid, message, severity, code})), valid ? [] :
        [{valid: false, message: 'rule message', severity: 'error', code: 'LAB'}]);
    };
    expect(false);
    send({updateDataModel: {surfaceId, path: '/choice', value: 'pass'}});
    expect(true);
    send({updateDataModel: {surfaceId, path: '/choice', value: 'fail'}});
    expect(false);
    assert.deepEqual(errors, []);
  } finally {
    subscription?.unsubscribe();
    resolver?.dispose();
    try { processor.model.dispose(); } finally { processor.dispose(); }
  }
});
