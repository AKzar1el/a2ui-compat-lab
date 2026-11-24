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
    return {unregisteredCatalogRejected: true, customDomRendered: true,
      physicalClicks: 2, keyboardActivations: 2, disabledInputAttempts: 2,
      selections: ['alpha', 'beta', 'gamma', 'delta'], customSurfaceDeleted: true,
      basicCatalogStillRendered: true};
  } finally {
    await page.close();
  }
}
