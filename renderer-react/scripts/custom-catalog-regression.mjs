import assert from 'node:assert/strict';

const catalogId = 'https://example.invalid/a2ui/lab-react/v0_9';
const surfaceId = 'trusted-custom-react';

export async function testTrustedCustomCatalogBrowserReplay(context, origin) {
  const page = await context.newPage();
  const runtimeErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const send = message => page.evaluate(message => window.__a2uiLab.applyMessage(message),
    {version: 'v0.9', ...message});
  const trace = () => page.evaluate(id => window.__a2uiLab.trace(id), surfaceId);
  const open = async suffix => {
    await page.goto(origin + '/?capture=1' + suffix, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.__a2uiLab?.applyMessage),
      null, {timeout: 10000});
  };
  try {
    // The identical catalog ID is unavailable in ordinary capture mode.
    await open('');
    const rejected = await page.evaluate(({surfaceId, catalogId}) => {
      try {
        window.__a2uiLab.applyMessage({version: 'v0.9',
          createSurface: {surfaceId, catalogId}});
      } catch {
        // The published SDK may throw or report the failure via its error channel.
      }
      return !window.__a2uiLab.trace(surfaceId).surfaceIds.includes(surfaceId);
    }, {surfaceId, catalogId});
    assert.equal(rejected, true);
    assert.equal(await page.getByTestId('lab-custom-confirm').count(), 0);

    await open('&trusted-custom-catalog=1');
    // Do not mix expected negative-mode SDK logging into the positive test.
    runtimeErrors.length = 0;
    consoleErrors.length = 0;

    await send({createSurface: {surfaceId: 'basic-control', catalogId: '__BASIC_CATALOG__'}});
    await send({updateComponents: {surfaceId: 'basic-control', components: [
      {id: 'root', component: 'Text', text: 'Basic catalog control'},
    ]}});
    await page.getByText('Basic catalog control', {exact: true}).waitFor({state: 'visible'});
    await send({createSurface: {surfaceId, catalogId}});
    await send({updateComponents: {surfaceId, components: [
      {id: 'root', component: 'LabConfirm', child: 'label',
        action: {event: {name: 'confirm-custom', context: {selection: {path: '/choice'}}}}},
      {id: 'label', component: 'Text', text: 'Confirm custom'},
    ]}});
    await send({updateDataModel: {surfaceId, path: '/', value: {choice: 'alpha'}}});
    const button = page.getByTestId('lab-custom-confirm');
    await button.waitFor({state: 'visible', timeout: 10000});
    assert.equal(await button.innerText(), 'Confirm custom');
    await button.click();
    await page.waitForFunction(id => window.__a2uiLab.trace(id).actions.length === 1,
      surfaceId, {timeout: 10000});
    await send({updateDataModel: {surfaceId, path: '/choice', value: 'beta'}});
    await button.click();
    await page.waitForFunction(id => window.__a2uiLab.trace(id).actions.length === 2,
      surfaceId, {timeout: 10000});
    const {actions, errors} = await trace();
    assert.deepEqual(actions.map(action => ({
      name: action.name, surfaceId: action.surfaceId, sourceComponentId: action.sourceComponentId,
      selection: action.context.selection,
    })), ['alpha', 'beta'].map(selection => ({
      name: 'confirm-custom', surfaceId, sourceComponentId: 'root', selection,
    })));
    assert.deepEqual(errors, []);
    // Use a second component update so the original unconstrained pointer
    // controls remain intact. Subsequent model-only updates must change validity.
    await send({updateComponents: {surfaceId, components: [
      {id: 'root', component: 'LabConfirm', child: 'label',
        checks: [{condition: {call: 'required', args: {value: {path: '/choice'}}},
          message: 'Choice required'}],
        action: {event: {name: 'confirm-custom', context: {selection: {path: '/choice'}}}}},
    ]}});
    const waitDisabled = disabled => page.waitForFunction(
      disabled => document.querySelector('[data-testid="lab-custom-confirm"]')?.disabled === disabled,
      disabled, {timeout: 10000});
    const expectSelections = async selections => {
      assert.deepEqual((await trace()).actions, selections.map(selection => ({
        name: 'confirm-custom', surfaceId, sourceComponentId: 'root', context: {selection},
      })));
    };
    const tryDisabledInput = async selections => {
      await waitDisabled(true);
      const bounds = await button.boundingBox();
      assert.ok(bounds, 'Disabled custom button must remain visible');
      // A locator click waits for enabled state; use actual pointer coordinates.
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      assert.equal(await button.evaluate(element => {
        element.focus();
        return document.activeElement === element;
      }), false, 'Native disabled custom button must reject focus');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await expectSelections(selections);
    };
    await send({updateDataModel: {surfaceId, path: '/choice', value: ''}});
    await tryDisabledInput(['alpha', 'beta']);
    await send({updateDataModel: {surfaceId, path: '/choice', value: 'gamma'}});
    await waitDisabled(false);
    await expectSelections(['alpha', 'beta']);
    await button.focus();
    assert.equal(await button.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(id => window.__a2uiLab.trace(id).actions.length === 3,
      surfaceId, {timeout: 10000});
    await expectSelections(['alpha', 'beta', 'gamma']);
    await send({updateDataModel: {surfaceId, path: '/choice', value: 'delta'}});
    await waitDisabled(false);
    await expectSelections(['alpha', 'beta', 'gamma']);
    await button.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(id => window.__a2uiLab.trace(id).actions.length === 4,
      surfaceId, {timeout: 10000});
    await expectSelections(['alpha', 'beta', 'gamma', 'delta']);
    await send({updateDataModel: {surfaceId, path: '/choice', value: ''}});
    await tryDisabledInput(['alpha', 'beta', 'gamma', 'delta']);
    assert.deepEqual((await trace()).errors, []);
    await send({deleteSurface: {surfaceId}});
    await button.waitFor({state: 'detached', timeout: 10000});
    assert.equal((await trace()).surfaceIds.includes(surfaceId), false);
    await page.getByText('Basic catalog control', {exact: true}).waitFor({state: 'visible'});
    assert.deepEqual(runtimeErrors, []);
    assert.deepEqual(consoleErrors, []);
    const surfaceIsolation = await testConcurrentCustomSurfaces(context, origin);
    return {unregisteredCatalogRejected: true, customDomRendered: true,
      physicalClicks: 2, keyboardActivations: 2, disabledInputAttempts: 2,
      selections: ['alpha', 'beta', 'gamma', 'delta'], customSurfaceDeleted: true,
      basicCatalogStillRendered: true, surfaceIsolation};
  } finally {
    await page.close();
  }
}

async function testConcurrentCustomSurfaces(context, origin) {
  const page = await context.newPage();
  const runtimeErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const send = message => page.evaluate(message => window.__a2uiLab.applyMessage(message),
    {version: 'v0.9', ...message});
  const trace = id => page.evaluate(id => window.__a2uiLab.trace(id), id);
  const first = 'custom-isolation-a';
  const second = 'custom-isolation-b';
  const basic = 'custom-isolation-basic';
  const expectedActions = [];
  const createCustom = async (id, label, choice) => {
    await send({createSurface: {surfaceId: id, catalogId}});
    await send({updateComponents: {surfaceId: id, components: [
      {id: 'root', component: 'LabConfirm', child: 'label',
        checks: [{condition: {call: 'required', args: {value: {path: '/choice'}}},
          message: 'Choice required'}],
        action: {event: {name: 'confirm-custom', context: {selection: {path: '/choice'}}}}},
      {id: 'label', component: 'Text', text: label},
    ]}});
    await send({updateDataModel: {surfaceId: id, path: '/', value: {choice}}});
    const button = page.getByRole('button', {name: label, exact: true});
    await button.waitFor({state: 'visible', timeout: 10000});
    assert.equal(await button.getAttribute('data-testid'), 'lab-custom-confirm');
    return button;
  };
  const click = async (button, id, selection) => {
    await button.click();
    expectedActions.push({name: 'confirm-custom', surfaceId: id,
      sourceComponentId: 'root', context: {selection}});
    await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
      expectedActions.length, {timeout: 10000});
    assert.deepEqual((await trace(id)).actions, expectedActions);
  };
  const waitDisabled = async (button, disabled) => {
    // Locator assertions are scoped by accessible name, not a global component ID.
    const handle = await button.elementHandle({timeout: 10000});
    assert.ok(handle);
    try {
      await page.waitForFunction(({element, disabled}) => element.disabled === disabled,
        {element: handle, disabled}, {timeout: 10000});
    } finally {
      await handle.dispose();
    }
  };
  try {
    await page.goto(origin + '/?capture=1&trusted-custom-catalog=1',
      {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.__a2uiLab?.applyMessage),
      null, {timeout: 10000});
    await send({createSurface: {surfaceId: basic, catalogId: '__BASIC_CATALOG__'}});
    await send({updateComponents: {surfaceId: basic, components: [
      {id: 'root', component: 'Text', text: 'Basic isolation control'},
    ]}});
    await page.getByText('Basic isolation control', {exact: true}).waitFor({state: 'visible'});
    const a = await createCustom(first, 'Confirm surface A', 'alpha');
    const b = await createCustom(second, 'Confirm surface B', 'beta');
    assert.deepEqual((await trace(first)).surfaceIds, [first, second, basic].sort());
    assert.equal(await page.getByTestId('lab-custom-confirm').count(), 2);
    assert.deepEqual((await trace(first)).data, {choice: 'alpha'});
    assert.deepEqual((await trace(second)).data, {choice: 'beta'});
    await click(a, first, 'alpha');
    await click(b, second, 'beta');

    // The two surfaces intentionally reuse component IDs and binding paths.
    await send({updateDataModel: {surfaceId: first, path: '/choice', value: ''}});
    await waitDisabled(a, true);
    await waitDisabled(b, false);
    assert.deepEqual((await trace(second)).data, {choice: 'beta'});
    const bounds = await a.boundingBox();
    assert.ok(bounds);
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    assert.deepEqual((await trace(first)).actions, expectedActions);

    const survivingButton = await b.elementHandle({timeout: 10000});
    assert.ok(survivingButton);
    try {
      await send({deleteSurface: {surfaceId: first}});
      await a.waitFor({state: 'detached', timeout: 10000});
      assert.deepEqual((await trace(second)).surfaceIds, [second, basic].sort());
      assert.equal(await b.evaluate((element, previous) => element === previous,
        survivingButton), true, 'Deleting A must not remount B');
      await click(b, second, 'beta');

      // Reusing the deleted surface ID must create fresh local data and actions.
      const freshA = await createCustom(first, 'Confirm recreated A', 'gamma');
      assert.deepEqual((await trace(first)).data, {choice: 'gamma'});
      assert.deepEqual((await trace(second)).data, {choice: 'beta'});
      assert.equal(await a.count(), 0);
      assert.equal(await b.evaluate((element, previous) => element === previous,
        survivingButton), true, 'Recreating A must not remount B');
      assert.deepEqual((await trace(first)).actions, expectedActions);
      await click(freshA, first, 'gamma');
      await click(b, second, 'beta');
    } finally {
      await survivingButton.dispose();
    }
    await send({updateComponents: {surfaceId: basic, components: [
      {id: 'root', component: 'Text', text: 'Basic isolation control updated'},
    ]}});
    await page.getByText('Basic isolation control updated', {exact: true}).waitFor({state: 'visible'});
    assert.equal(await page.getByTestId('lab-custom-confirm').count(), 2);
    assert.deepEqual((await trace(first)).actions, expectedActions);
    assert.deepEqual((await trace(first)).errors, []);
    assert.deepEqual(runtimeErrors, []);
    assert.deepEqual(consoleErrors, []);
    return {sameCatalogConcurrentSurfaces: 2, physicalClicks: 5,
      disabledPointerSuppressed: true, survivingDomIdentityPreserved: true,
      deletedSurfaceIdRecreated: true, basicControlUpdated: true};
  } finally {
    await page.close();
  }
}
