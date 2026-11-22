import assert from 'node:assert/strict';

// Verify two levels of published v0.9 template expansion in real Chromium,
// not merely direct GenericBinder actions from a headless processor.
export async function testNestedTemplateRowBrowserReplay(context, origin) {
  const page = await context.newPage();
  const runtimeErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const surfaceId = 'nested-row-browser';
  const buttons = page.getByRole('button', {name: 'Select nested item'});
  const trace = () => page.evaluate(id => window.__a2uiLab.trace(id), surfaceId);
  const setGroups = groups => page.evaluate(({id, groups}) => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateDataModel: {surfaceId: id, path: '/', value: {groups}},
    });
  }, {id: surfaceId, groups});
  const waitForCount = async count => {
    if (count) await buttons.nth(count - 1).waitFor({state: 'visible', timeout: 10000});
    await buttons.nth(count).waitFor({state: 'detached', timeout: 10000});
    assert.equal(await buttons.count(), count);
  };
  const expectActions = async selections => {
    await page.waitForFunction(({id, count}) =>
      window.__a2uiLab.trace(id).actions.length === count,
    {id: surfaceId, count: selections.length}, {timeout: 10000});
    const actions = (await trace()).actions;
    assert.deepEqual(actions.map(action => action.context.selection), selections);
    assert.ok(actions.every(action =>
      action.name === 'choose-nested-item' &&
      action.surfaceId === surfaceId &&
      action.sourceComponentId === 'submit'));
  };
  try {
    await page.goto(origin + '/?capture=1', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.__a2uiLab?.applyMessage),
      null, {timeout: 10000});
    await page.evaluate(id => {
      window.__a2uiLab.applyMessage({
        version: 'v0.9',
        createSurface: {surfaceId: id, catalogId: '__BASIC_CATALOG__'},
      });
      window.__a2uiLab.applyMessage({
        version: 'v0.9',
        updateComponents: {surfaceId: id, components: [
          {id: 'root', component: 'Column',
            children: {componentId: 'group', path: '/groups'}},
          {id: 'group', component: 'Column',
            children: {componentId: 'submit', path: 'items'}},
          {id: 'submit', component: 'Button', child: 'label',
            variant: 'primary', action: {event: {name: 'choose-nested-item',
              context: {selection: {path: 'choice'}}}}},
          {id: 'label', component: 'Text', text: 'Select nested item'},
        ]},
      });
    }, surfaceId);
    await setGroups([]);
    await waitForCount(0);

    await setGroups([{items: [{choice: 'alpha'}, {choice: 'beta'}]}]);
    await waitForCount(2);
    await buttons.nth(1).click();
    await expectActions(['beta']);

    await setGroups([
      {items: [{choice: 'alpha'}, {choice: 'beta'}]},
      {items: [{choice: 'gamma'}]},
    ]);
    await waitForCount(3);
    await buttons.nth(2).click();
    await expectActions(['beta', 'gamma']);

    // Removing the first group must detach both of its rendered Button instances.
    await setGroups([{items: [{choice: 'gamma'}]}]);
    await waitForCount(1);
    await buttons.first().click();
    await expectActions(['beta', 'gamma', 'gamma']);

    // Repeated component IDs must resolve against current nested group and row indices.
    await setGroups([
      {items: [{choice: 'gamma'}, {choice: 'beta'}]},
      {items: [{choice: 'alpha'}]},
    ]);
    await waitForCount(3);
    await buttons.nth(1).click();
    await expectActions(['beta', 'gamma', 'gamma', 'beta']);
    await buttons.nth(2).click();
    await expectActions(['beta', 'gamma', 'gamma', 'beta', 'alpha']);

    await setGroups([]);
    await waitForCount(0);
    assert.equal((await trace()).actions.length, 5);
    assert.deepEqual(runtimeErrors, [], 'Nested template replay must not throw');
    assert.deepEqual(consoleErrors, [], 'Nested template replay must not log browser errors');
    assert.deepEqual((await trace()).errors, [], 'Nested surface must report no SDK errors');
    return {zeroGroupButtons: 0, maxRenderedButtons: 3, physicalClicks: 5,
      selections: ['beta', 'gamma', 'gamma', 'beta', 'alpha'],
      nestedGroupDeletionAndReorderChecked: true, runtimeErrors: 0, consoleErrors: 0};
  } finally {
    await page.close();
  }
}
