#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = readFileSync(resolve(root, 'src/fixture.json'), 'utf8');
const installed = Object.fromEntries([
  '@a2ui/react', '@a2ui/web_core', 'react', 'react-dom', 'vite', '@playwright/test',
].map(name => [name, JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version]));
const expectedActions = [
  {name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit', context: {selection: 'alpha'}},
  {name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit', context: {selection: 'beta'}},
];
const runtimeErrors = [];
const checkpoints = [];
let server, browser;
try {
  server = await createServer({
    root,
    configFile: resolve(root, 'vite.config.mjs'),
    server: {port: 4181, host: '127.0.0.1', strictPort: true},
    logLevel: 'error',
  });
  await server.listen();
  browser = await chromium.launch({headless: true, timeout: 20000});
  const page = await browser.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));

  await page.goto('http://127.0.0.1:4181/', {waitUntil: 'domcontentloaded'});
  const button = page.getByRole('button', {name: 'Confirm'});
  await button.waitFor({state: 'visible'});
  await page.getByText('alpha', {exact: true}).waitFor({state: 'visible'});
  checkpoints.push({step: 'render', label: await button.innerText(), text: 'alpha'});

  // Use real browser pointer input, never DOM .click() or a direct binder call.
  await button.click({timeout: 7000});
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 1, null, {timeout: 5000});
  let trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, [expectedActions[0]]);
  checkpoints.push({step: 'pointer', action: trace.actions[0]});

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/', value: {selection: 'beta', confirmed: true},
    },
  }));
  await page.getByText('beta', {exact: true}).waitFor({state: 'visible'});
  checkpoints.push({step: 'agent-response', data: (await page.evaluate(() => window.__a2uiLab.trace())).data});

  await button.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 2, null, {timeout: 5000});
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions);
  checkpoints.push({step: 'keyboard-enter', action: trace.actions[1]});

  // Two live surfaces deliberately reuse the same Button and component IDs.
  // This exercises real React DOM routing, beyond the headless SDK action replay.
  const secondSurfaceId = 'parallel-surface';
  const parallelMessages = JSON.parse(fixture).map(({message}) => {
    const copy = structuredClone(message);
    for (const type of ['createSurface', 'updateComponents', 'updateDataModel']) {
      if (copy[type]) copy[type].surfaceId = secondSurfaceId;
    }
    if (copy.updateDataModel)
      copy.updateDataModel.value = {selection: 'gamma', confirmed: false};
    return copy;
  });
  await page.evaluate(messages => {
    for (const message of messages) window.__a2uiLab.applyMessage(message);
  }, parallelMessages);

  const parallelButton = button.nth(1);
  await parallelButton.waitFor({state: 'visible', timeout: 5000});
  await page.getByText('gamma', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await button.count(), 2, 'Both surfaces must mount distinct DOM Buttons');

  await parallelButton.click({timeout: 7000});
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 3, null, {timeout: 5000});
  expectedActions.push({
    name: 'confirm-choice', surfaceId: secondSurfaceId, sourceComponentId: 'submit',
    context: {selection: 'gamma'},
  });
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions, 'Parallel Button must route to its own surface');
  checkpoints.push({step: 'parallel-pointer', action: trace.actions[2], mountedButtons: 2});

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/', value: {selection: 'delta', confirmed: true},
    },
  }));
  await page.getByText('delta', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await page.getByText('gamma', {exact: true}).count(), 1,
    'Updating the first surface must not overwrite the parallel surface');
  await button.first().click({timeout: 7000});
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 4, null, {timeout: 5000});
  const originalAfterUpdate = {
    name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit',
    context: {selection: 'delta'},
  };
  expectedActions.push(originalAfterUpdate);
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions, 'Original Button must use only its own updated data');
  checkpoints.push({step: 'isolated-update', action: trace.actions[3], parallelText: 'gamma'});

  await page.evaluate(surfaceId => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId},
  }), secondSurfaceId);
  await parallelButton.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await button.count(), 1, 'Deleting one surface must preserve the other DOM Button');
  await page.getByText('delta', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await page.getByText('gamma', {exact: true}).count(), 0);
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions, 'Deleting one surface must emit no stale action');

  await button.click({timeout: 7000});
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 5, null, {timeout: 5000});
  expectedActions.push(originalAfterUpdate);
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions, 'Surviving surface must still dispatch after peer deletion');
  checkpoints.push({step: 'parallel-deletion-survival', action: trace.actions[4], mountedButtons: 1});

  // Deliver a stale response for the deleted peer followed by a valid response
  // in deterministic microtasks. A rejected message must not poison subsequent
  // updates, resurrect the peer's DOM, or change action routing.
  const deliveries = await page.evaluate(async () => {
    const messages = [
      {version: 'v0.9', updateDataModel: {
        surfaceId: 'parallel-surface', path: '/', value: {selection: 'stale'},
      }},
      {version: 'v0.9', updateDataModel: {
        surfaceId: 'action-replay', path: '/', value: {selection: 'epsilon', confirmed: true},
      }},
    ];
    return Promise.all(messages.map(message => Promise.resolve().then(() => {
      try {
        window.__a2uiLab.applyMessage(message);
        return {status: 'applied', data: window.__a2uiLab.trace().data};
      } catch {
        return {status: 'rejected', data: window.__a2uiLab.trace().data};
      }
    })));
  });
  assert.deepEqual(deliveries, [
    {status: 'rejected', data: {selection: 'delta', confirmed: true}},
    {status: 'applied', data: {selection: 'epsilon', confirmed: true}},
  ], 'A stale async peer update must fail without blocking a valid survivor update');
  await page.getByText('epsilon', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await button.count(), 1, 'Stale async update must not restore a deleted peer');
  assert.equal(await page.getByText('gamma', {exact: true}).count(), 0);
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length, 5,
    'SDK message delivery alone must not emit a Button action');

  await button.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 6, null, {timeout: 5000});
  expectedActions.push({
    name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit',
    context: {selection: 'epsilon'},
  });
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions,
    'Surviving keyboard Button must use its fresh data after a stale async rejection');
  checkpoints.push({step: 'async-stale-peer-recovery', deliveries: deliveries.map(({status}) => status),
    action: trace.actions[5], mountedButtons: 1});


  // A deleted peer ID can be reused by a new surface. The React DOM and event
  // binder must point at its fresh model rather than the old, detached one.
  const recreatedMessages = parallelMessages.map(message => {
    const copy = structuredClone(message);
    if (copy.updateDataModel)
      copy.updateDataModel.value = {selection: 'reborn', confirmed: false};
    return copy;
  });
  await page.evaluate(messages => {
    for (const message of messages) window.__a2uiLab.applyMessage(message);
  }, recreatedMessages);
  await button.nth(1).waitFor({state: 'visible', timeout: 5000});
  await page.getByText('reborn', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await button.count(), 2, 'Recreated peer must have a distinct live Button');
  assert.equal(await page.getByText('gamma', {exact: true}).count(), 0,
    'Recreated peer must not retain its deleted model data');
  assert.equal(await page.getByText('epsilon', {exact: true}).count(), 1,
    'Surviving peer data must be unaffected by surface ID reuse');

  await button.nth(1).click({timeout: 7000});
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 7, null, {timeout: 5000});
  expectedActions.push({
    name: 'confirm-choice', surfaceId: secondSurfaceId, sourceComponentId: 'submit',
    context: {selection: 'reborn'},
  });
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions,
    'Recreated Button action must bind fresh peer data with the reused IDs');
  checkpoints.push({step: 'recreated-peer-new-action', action: trace.actions[6], mountedButtons: 2});

  // Real Tab/Space input must reach the newly mounted peer and use its
  // current data, even though the surface and Button IDs were reused.
  await button.first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__a2uiLab.trace().actions.length === 8, null, {timeout: 5000});
  expectedActions.push({
    name: 'confirm-choice', surfaceId: secondSurfaceId, sourceComponentId: 'submit',
    context: {selection: 'reborn'},
  });
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions,
    'Tab/Space must route to the recreated peer rather than the surviving original');
  checkpoints.push({step: 'recreated-peer-tab-space', action: trace.actions[7], mountedButtons: 2});

  await page.evaluate(surfaceId => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId},
  }), secondSurfaceId);
  await page.getByText('reborn', {exact: true}).waitFor({state: 'detached', timeout: 5000});
  assert.equal(await button.count(), 1);
  assert.equal(await page.getByText('epsilon', {exact: true}).count(), 1);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions, expectedActions,
    'Second deletion must not leak a stale action');
  await page.keyboard.press('Space');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions, expectedActions,
    'Space after deleting the focused peer must not dispatch a stale action');

  const outDir = resolve(root, 'out');
  mkdirSync(outDir, {recursive: true});
  await page.screenshot({path: resolve(outDir, 'react-browser.png'), fullPage: true});

  // A late action after surface deletion must not target a stale DOM Button.
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId: 'action-replay'},
  }));
  await button.waitFor({state: 'detached', timeout: 5000});
  await page.keyboard.press('Enter');
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.equal(trace.data, null);
  assert.deepEqual(trace.actions, expectedActions);
  assert.deepEqual(trace.errors, []);
  assert.deepEqual(runtimeErrors, []);
  checkpoints.push({step: 'deleted-surface', buttonCount: await button.count(), actionCount: trace.actions.length});

  const report = {
    schemaVersion: 1,
    protocol: 'v0.9',
    harness: 'real React A2uiSurface + published core Custom Elements; Playwright Chromium pointer and keyboard',
    versions: installed,
    fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    checkpoints,
    actions: trace.actions,
    runtimeErrors,
    passed: true,
  };
  const target = resolve(outDir, 'react-browser-trace.json');
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log('Real A2UI React Chromium: ' + checkpoints.length + ' checkpoints / ' + trace.actions.length + ' agent events / no runtime errors / PASS');
  console.log('Trace: ' + target);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}
