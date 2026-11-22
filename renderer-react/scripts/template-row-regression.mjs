import assert from 'node:assert/strict';

// This uses published React/core 0.14 in actual Chromium. It is intentionally
// separate from the 0.15 headless GenericBinder replay acceptance tests.
export async function testTemplateRowBrowserReplay(context, origin) {
  const page = await context.newPage();
  const runtimeErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const surfaceId = 'template-row-browser';
  const buttons = page.getByRole('button', {name: 'Choose row'});
  const trace = () => page.evaluate(id => window.__a2uiLab.trace(id), surfaceId);
  const putRows = rows => page.evaluate(({id, rows}) => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateDataModel: {surfaceId: id, path: '/', value: {items: rows}},
    });
  }, {id: surfaceId, rows});
  const waitForButtonCount = async count => {
    // Playwright locators pierce open shadow roots; document.querySelectorAll
    // would miss native buttons rendered inside the published A2UI elements.
    if (count > 0) await buttons.nth(count - 1).waitFor({state: 'visible', timeout: 10000});
    await buttons.nth(count).waitFor({state: 'detached', timeout: 10000});
    assert.equal(await buttons.count(), count);
  };
  const assertSelections = async values => {
    await page.waitForFunction(({id, count}) =>
      window.__a2uiLab.trace(id).actions.length === count,
    {id: surfaceId, count: values.length}, {timeout: 10000});
    const actual = (await trace()).actions;
    assert.deepEqual(actual.map(action => action.context.selection), values);
    assert.ok(actual.every(action =>
      action.name === 'choose-row' &&
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
            children: {componentId: 'submit', path: '/items'}},
          {id: 'submit', component: 'Button', child: 'label',
            variant: 'primary', action: {event: {name: 'choose-row',
              context: {selection: {path: 'choice'}}}}},
          {id: 'label', component: 'Text', text: 'Choose row'},
        ]},
      });
    }, surfaceId);
    await page.waitForFunction(id =>
      window.__a2uiLab.trace(id).components.includes('submit'),
    surfaceId, {timeout: 10000});
    await putRows([]);
    await waitForButtonCount(0);

    await putRows([{choice: 'alpha'}, {choice: 'beta'}]);
    await buttons.nth(1).waitFor({state: 'visible', timeout: 10000});
    await waitForButtonCount(2);
    await buttons.nth(1).click();
    await assertSelections(['beta']);

    // Deleting the second row must remove its physical click target.
    await putRows([{choice: 'alpha'}]);
    await waitForButtonCount(1);
    assert.equal(await buttons.nth(1).count(), 0);
    await buttons.first().click();
    await assertSelections(['beta', 'alpha']);

    // Numeric instance paths follow the current index, not a durable row ID.
    await putRows([{choice: 'beta'}, {choice: 'alpha'}]);
    await waitForButtonCount(2);
    await buttons.nth(1).click();
    await assertSelections(['beta', 'alpha', 'alpha']);
    await buttons.nth(0).click();
    await assertSelections(['beta', 'alpha', 'alpha', 'beta']);

    await putRows([]);
    await waitForButtonCount(0);
    assert.equal((await trace()).actions.length, 4);
    assert.deepEqual(runtimeErrors, [], 'Template replay must not throw in Chromium');
    assert.deepEqual(consoleErrors, [], 'Template replay must not log browser errors');
    assert.deepEqual((await trace()).errors, [], 'Published surface must report no errors');
    return {zeroRowButtons: 0, maxRenderedButtons: 2,
      physicalClicks: 4, actionSelections: ['beta', 'alpha', 'alpha', 'beta'],
      deletionAndIndexReorderChecked: true, runtimeErrors: 0, consoleErrors: 0};
  } finally {
    await page.close();
  }
}
