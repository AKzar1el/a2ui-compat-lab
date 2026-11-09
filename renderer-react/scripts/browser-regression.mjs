#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {resolveBrowserEvidenceDir, assertBrowserEvidenceUnused, publishBrowserEvidence} from '../../src/browser-evidence.mjs';
import {createServer} from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolveBrowserEvidenceDir(root, process.argv.slice(2));
assertBrowserEvidenceUnused(outDir);
const fixture = readFileSync(resolve(root, 'src/fixture.json'), 'utf8');
const installed = Object.fromEntries([
  '@a2ui/react', '@a2ui/web_core', 'react', 'react-dom', 'vite', '@playwright/test',
].map(name => [name, JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version]));
const expectedActions = [
  {name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit', context: {selection: 'alpha'}},
  {name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit', context: {selection: 'beta'}},
];
const runtimeErrors = [];
const consoleErrors = [];
const checkpoints = [];
let server, browser;
try {
  server = await createServer({
    root,
    configFile: resolve(root, 'vite.config.mjs'),
    server: {port: 0, host: '127.0.0.1', strictPort: true},
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string' &&
    Number.isInteger(address.port) && address.port > 0,
  'Vite must bind an OS-assigned loopback port before the browser starts');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({headless: true, timeout: 20000});
  const context = await browser.newContext({serviceWorkers: 'block'});
  const deniedRequests = [];
  // Fail closed on unexpected browser HTTP(S) dependencies, not just page errors.
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) {
      deniedRequests.push(url);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(origin + '/', {waitUntil: 'domcontentloaded'});
  // pageerror does not catch console.error (including many React diagnostics).
  // Prove the listener is live before monitoring the actual renderer replay.
  const consoleProbeMarker = '__a2ui_browser_console_probe__';
  const consoleProbe = page.waitForEvent('console', {
    predicate: message => message.type() === 'error' && message.text() === consoleProbeMarker,
    timeout: 5000,
  });
  await page.evaluate(marker => console.error(marker), consoleProbeMarker);
  await consoleProbe;
  assert.deepEqual(consoleErrors, [consoleProbeMarker],
    'Console observer must see the controlled probe and no startup errors');
  consoleErrors.length = 0;
  checkpoints.push({step: 'browser-console-error-monitor', probeObserved: true});
  // Use a second LOOPBACK origin to exercise interception without network egress.
  const deniedProbe = 'http://127.0.0.1:1/__a2ui_browser_network_guard_probe__';
  // Chromium also logs a resource error for this deliberately aborted request.
  // Accept exactly that controlled diagnostic, not unrelated renderer errors.
  const blockedProbeConsole = page.waitForEvent('console', {
    predicate: message => message.type() === 'error' &&
      message.text() === 'Failed to load resource: net::ERR_FAILED',
    timeout: 5000,
  });
  await page.evaluate(async url => {
    try { await fetch(url); } catch { /* The request must be aborted. */ }
  }, deniedProbe);
  await blockedProbeConsole;
  assert.deepEqual(deniedRequests, [deniedProbe],
    'Chromium must abort an HTTP request outside the ephemeral Vite origin');
  assert.deepEqual(consoleErrors, ['Failed to load resource: net::ERR_FAILED'],
    'Only the deliberately aborted HTTP probe may log a resource failure');
  consoleErrors.length = 0;
  checkpoints.push({step: 'browser-http-isolation',
    offOriginProbeBlocked: true, expectedProbeConsoleError: true,
    unexpectedOffOriginRequests: 0});
  const button = page.getByRole('button', {name: 'Confirm'});
  await button.waitFor({state: 'visible'});
  await page.getByText('alpha', {exact: true}).waitFor({state: 'visible'});
  checkpoints.push({step: 'render', label: await button.innerText(), text: 'alpha'});

  // A rejected agent message must not corrupt the mounted React surface or actions.
  const beforeFault = await page.evaluate(() => window.__a2uiLab.trace());
  const fault = await page.evaluate(() => {
    try {
      window.__a2uiLab.applyMessage({
        version: 'v0.9',
        createSurface: {surfaceId: 'invalid-catalog-test', catalogId: 'not-in-basic-catalog'},
      });
      return {rejected: false};
    } catch (error) {
      return {
        rejected: true,
        name: String(error?.name ?? 'Error'),
        message: String(error?.message ?? error),
      };
    }
  });
  assert.equal(fault.rejected, true, 'Unknown catalog must be rejected by the published SDK');
  assert.deepEqual(await page.evaluate(() => window.__a2uiLab.trace()), beforeFault,
    'Rejected catalog must not mutate mounted surfaces, data, errors or actions');
  assert.equal(await button.count(), 1, 'Valid Button should remain mounted after rejection');
  await page.getByText('alpha', {exact: true}).waitFor({state: 'visible'});
  checkpoints.push({step: 'rejected-catalog-recovery', fault, stateUnchanged: true});

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

  // Reconstruct a JSONL agent update from actual UTF-8 transport bytes, then
  // exercise its rendered Text and real Button. Only complete newline-delimited
  // messages enter the published SDK; no partial chunk may mutate the model.
  for (const [chunkSize, selection] of [[1, 'café 🍵'], [7, 'música 🚀'], [57, 'über 🎯']]) {
    const message = {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {selection, confirmed: true},
      },
    };
    const bytes = [...Buffer.from(JSON.stringify(message) + '\n', 'utf8')];
    const streamed = await page.evaluate(({bytes, chunkSize}) => {
      const decoder = new TextDecoder('utf-8', {fatal: true});
      const before = JSON.stringify(window.__a2uiLab.trace().data);
      let carry = '';
      let applied = 0;
      let prematureMutation = false;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const finalChunk = offset + chunkSize >= bytes.length;
        carry += decoder.decode(Uint8Array.from(bytes.slice(offset, offset + chunkSize)),
          {stream: !finalChunk});
        const lines = carry.split('\n');
        carry = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          window.__a2uiLab.applyMessage(JSON.parse(line));
          applied++;
        }
        if (!finalChunk && JSON.stringify(window.__a2uiLab.trace().data) !== before)
          prematureMutation = true;
      }
      return {applied, carry, prematureMutation, data: window.__a2uiLab.trace().data};
    }, {bytes, chunkSize});
    assert.equal(streamed.applied, 1, 'Exactly one complete JSONL update should be applied');
    assert.equal(streamed.carry, '', 'Transport must not leave trailing partial data');
    assert.equal(streamed.prematureMutation, false,
      'No partial UTF-8 or JSONL chunk may mutate the published SDK state');
    assert.deepEqual(streamed.data, {selection, confirmed: true});
    await page.getByText(selection, {exact: true}).waitFor({state: 'visible', timeout: 5000});
    const previousCount = expectedActions.length;
    assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
      previousCount, 'Streaming an update alone must not emit an agent action');
    await button.click({timeout: 7000});
    await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
      previousCount + 1, {timeout: 5000});
    const action = {
      name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit',
      context: {selection},
    };
    expectedActions.push(action);
    trace = await page.evaluate(() => window.__a2uiLab.trace());
    assert.deepEqual(trace.actions, expectedActions,
      'Real Button must emit the latest Unicode data after streamed JSONL delivery');
    checkpoints.push({step: 'utf8-jsonl-browser-' + chunkSize, chunkSize, action});
  }

  // Stream a complete create/components/data lifecycle across arbitrary byte
  // boundaries, then delete the new surface after a real browser action.
  // This guards application framing order, not an SDK transport parser.
  const lifecycleSurfaceId = 'streamed-lifecycle';
  const lifecycleMessages = parallelMessages.map(message => {
    const copy = structuredClone(message);
    for (const kind of ['createSurface', 'updateComponents', 'updateDataModel']) {
      if (copy[kind]) copy[kind].surfaceId = lifecycleSurfaceId;
    }
    if (copy.updateDataModel)
      copy.updateDataModel.value = {selection: 'lifecycle 🌱', confirmed: false};
    return copy;
  });
  const lifecycleBytes = [...Buffer.from(
    lifecycleMessages.map(message => JSON.stringify(message)).join('\n') + '\n', 'utf8',
  )];
  const streamedLifecycle = await page.evaluate(bytes => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let carry = '';
    const kinds = [];
    for (let offset = 0; offset < bytes.length; offset += 5) {
      const last = offset + 5 >= bytes.length;
      carry += decoder.decode(Uint8Array.from(bytes.slice(offset, offset + 5)), {stream: !last});
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        window.__a2uiLab.applyMessage(message);
        kinds.push(Object.keys(message).find(key => key !== 'version'));
      }
    }
    return {kinds, carry};
  }, lifecycleBytes);
  assert.deepEqual(streamedLifecycle.kinds,
    ['createSurface', 'updateComponents', 'updateDataModel'],
    'Each lifecycle frame must reach the published SDK once and in order');
  assert.equal(streamedLifecycle.carry, '', 'Streamed lifecycle must end at a frame boundary');
  await page.getByText('lifecycle 🌱', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await button.count(), 2, 'Streamed lifecycle must render a second real Button');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    expectedActions.length, 'Streamed lifecycle alone must not emit an action');
  await button.nth(1).click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    expectedActions.length + 1, {timeout: 5000});
  expectedActions.push({
    name: 'confirm-choice', surfaceId: lifecycleSurfaceId, sourceComponentId: 'submit',
    context: {selection: 'lifecycle 🌱'},
  });
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Stream-created Button must route to its own fresh model');

  const deletionBytes = [...Buffer.from(JSON.stringify({
    version: 'v0.9', deleteSurface: {surfaceId: lifecycleSurfaceId},
  }) + '\n', 'utf8')];
  const deletion = await page.evaluate(bytes => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let carry = '';
    let applied = 0;
    for (let offset = 0; offset < bytes.length; offset += 2) {
      const last = offset + 2 >= bytes.length;
      carry += decoder.decode(Uint8Array.from(bytes.slice(offset, offset + 2)), {stream: !last});
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        window.__a2uiLab.applyMessage(JSON.parse(line));
        applied++;
      }
    }
    return {applied, carry};
  }, deletionBytes);
  assert.deepEqual(deletion, {applied: 1, carry: ''},
    'Streamed deletion must apply exactly once');
  await page.getByText('lifecycle 🌱', {exact: true}).waitFor({state: 'detached'});
  assert.equal(await button.count(), 1, 'Streamed deletion must preserve the original surface');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions, expectedActions,
    'Streamed deletion must not dispatch a stale action');
  checkpoints.push({step: 'utf8-jsonl-full-browser-lifecycle', kinds: streamedLifecycle.kinds,
    deletionCount: deletion.applied, action: expectedActions.at(-1)});

  // JSONL framing failures belong to the application transport, not the SDK.
  // A malformed complete frame must not mutate the live surface; the next
  // independently delimited valid frame must still render and dispatch.
  const recoveredSelection = 'resumed 🧩';
  const recoveredMessage = {
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/',
      value: {selection: recoveredSelection, confirmed: true},
    },
  };
  const recoveryBytes = [...Buffer.from(
    '{"version":"v0.9","updateDataModel":' + '\n' +
    JSON.stringify(recoveredMessage) + '\n', 'utf8',
  )];
  const recovery = await page.evaluate(bytes => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const before = JSON.stringify(window.__a2uiLab.trace().data);
    let carry = '';
    let rejected = 0;
    let applied = 0;
    let unchangedOnReject = true;
    for (let offset = 0; offset < bytes.length; offset += 3) {
      const finalChunk = offset + 3 >= bytes.length;
      carry += decoder.decode(Uint8Array.from(bytes.slice(offset, offset + 3)),
        {stream: !finalChunk});
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          rejected++;
          unchangedOnReject &&= JSON.stringify(window.__a2uiLab.trace().data) === before;
          continue;
        }
        window.__a2uiLab.applyMessage(message);
        applied++;
      }
    }
    return {rejected, applied, carry, unchangedOnReject, data: window.__a2uiLab.trace().data};
  }, recoveryBytes);
  assert.equal(recovery.rejected, 1, 'Malformed complete JSONL frame must be rejected');
  assert.equal(recovery.applied, 1, 'Subsequent well-formed frame must reach the SDK exactly once');
  assert.equal(recovery.carry, '', 'Recovery must leave no partial JSONL frame');
  assert.equal(recovery.unchangedOnReject, true,
    'Malformed transport frame must not mutate the published SDK model');
  assert.deepEqual(recovery.data, {selection: recoveredSelection, confirmed: true});
  await page.getByText(recoveredSelection, {exact: true}).waitFor({state: 'visible', timeout: 5000});
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    expectedActions.length, 'Transport rejection and recovery must not emit agent actions');
  await button.click({timeout: 7000});
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    expectedActions.length + 1, {timeout: 5000});
  expectedActions.push({
    name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit',
    context: {selection: recoveredSelection},
  });
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions, expectedActions,
    'Button after malformed JSONL recovery must dispatch only fresh valid data');
  checkpoints.push({step: 'malformed-jsonl-transport-recovery', rejected: recovery.rejected,
    applied: recovery.applied, action: expectedActions.at(-1)});


  // A corrupt multibyte UTF-8 transport frame must never reach the published
  // SDK or mutate its rendered surface. A fresh decoder can then replay a
  // valid Unicode frame and dispatch a real browser action with current data.
  const beforeBadUtf8 = await page.evaluate(() => window.__a2uiLab.trace());
  const badUtf8Bytes = Buffer.from(JSON.stringify({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/',
      value: {selection: 'damaged 🌋', confirmed: true},
    },
  }) + '\n', 'utf8');
  const emojiOffset = badUtf8Bytes.indexOf(Buffer.from('🌋', 'utf8'));
  assert.notEqual(emojiOffset, -1, 'Corruption must target a real multibyte character');
  badUtf8Bytes[emojiOffset + 1] = 0x28; // Invalid UTF-8 continuation byte.
  const corruptFrame = await page.evaluate(bytes => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let carry = '';
    let applied = 0;
    let rejected = false;
    try {
      for (let offset = 0; offset < bytes.length; offset++) {
        carry += decoder.decode(Uint8Array.of(bytes[offset]),
          {stream: offset !== bytes.length - 1});
        const lines = carry.split('\n');
        carry = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          window.__a2uiLab.applyMessage(JSON.parse(line));
          applied++;
        }
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      rejected = true;
    }
    return {rejected, applied};
  }, [...badUtf8Bytes]);
  assert.deepEqual(corruptFrame, {rejected: true, applied: 0},
    'Fatal UTF-8 decoder must reject the corrupt frame before SDK delivery');
  assert.deepEqual(await page.evaluate(() => window.__a2uiLab.trace()), beforeBadUtf8,
    'Corrupted transport bytes must preserve the mounted model and action history');
  await page.getByText(recoveredSelection, {exact: true}).waitFor({state: 'visible'});

  const utf8RecoveredSelection = 'restored 🌐';
  const goodUtf8Bytes = [...Buffer.from(JSON.stringify({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/',
      value: {selection: utf8RecoveredSelection, confirmed: true},
    },
  }) + '\n', 'utf8')];
  const recoveredUtf8 = await page.evaluate(bytes => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let carry = '';
    let applied = 0;
    for (let offset = 0; offset < bytes.length; offset++) {
      carry += decoder.decode(Uint8Array.of(bytes[offset]),
        {stream: offset !== bytes.length - 1});
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        window.__a2uiLab.applyMessage(JSON.parse(line));
        applied++;
      }
    }
    return {applied, carry};
  }, goodUtf8Bytes);
  assert.deepEqual(recoveredUtf8, {applied: 1, carry: ''},
    'Fresh decoder must apply exactly one valid frame after corruption');
  await page.getByText(utf8RecoveredSelection, {exact: true}).waitFor({state: 'visible'});
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    expectedActions.length, 'Corrupt and valid data frames must not generate actions');
  await button.click({timeout: 7000});
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    expectedActions.length + 1, {timeout: 5000});
  const recoveredUtf8Action = {
    name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit',
    context: {selection: utf8RecoveredSelection},
  };
  expectedActions.push(recoveredUtf8Action);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Post-corruption real Button must bind the latest valid Unicode data');
  checkpoints.push({step: 'invalid-utf8-transport-recovery', rejectedFrames: 1,
    appliedFrames: recoveredUtf8.applied, action: recoveredUtf8Action});

  // Deliver interleaved agent updates to two mounted React surfaces in a
  // single microtask burst. Actions must bind each surface's FINAL data,
  // not an intermediate model value or the other surface's value.
  const burstSurfaceId = 'burst-parallel';
  const burstMessages = parallelMessages.map(message => {
    const copy = structuredClone(message);
    for (const kind of ['createSurface', 'updateComponents', 'updateDataModel']) {
      if (copy[kind]) copy[kind].surfaceId = burstSurfaceId;
    }
    if (copy.updateDataModel)
      copy.updateDataModel.value = {selection: 'seed 🌿', confirmed: false};
    return copy;
  });
  await page.evaluate(messages => {
    for (const message of messages) window.__a2uiLab.applyMessage(message);
  }, burstMessages);
  await button.nth(1).waitFor({state: 'visible', timeout: 5000});
  await page.getByText('seed 🌿', {exact: true}).waitFor({state: 'visible'});

  const actionsBeforeBurst = expectedActions.length;
  const burstUpdates = [
    {surfaceId: 'action-replay', selection: 'first 🍃'},
    {surfaceId: burstSurfaceId, selection: 'second 🦋'},
    {surfaceId: 'action-replay', selection: 'third 🚀'},
    {surfaceId: burstSurfaceId, selection: 'fourth 🎻'},
    {surfaceId: 'action-replay', selection: 'final 🐙'},
    {surfaceId: burstSurfaceId, selection: 'final 🐝'},
  ];
  await page.evaluate(async updates => {
    await Promise.all(updates.map(({surfaceId, selection}) =>
      Promise.resolve().then(() => window.__a2uiLab.applyMessage({
        version: 'v0.9',
        updateDataModel: {surfaceId, path: '/', value: {selection, confirmed: true}},
      }))));
  }, burstUpdates);
  await page.getByText('final 🐙', {exact: true}).waitFor({state: 'visible'});
  await page.getByText('final 🐝', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await button.count(), 2, 'Both live Buttons must survive the update burst');
  for (const stale of ['first 🍃', 'second 🦋', 'third 🚀', 'fourth 🎻', 'seed 🌿']) {
    assert.equal(await page.getByText(stale, {exact: true}).count(), 0,
      'Burst must leave no intermediate Text in the rendered DOM');
  }
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeBurst, 'Agent model updates must never dispatch synthetic Button actions');

  await button.first().click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeBurst + 1, {timeout: 5000});
  const firstBurstAction = {
    name: 'confirm-choice', surfaceId: 'action-replay', sourceComponentId: 'submit',
    context: {selection: 'final 🐙'},
  };
  expectedActions.push(firstBurstAction);
  await button.nth(1).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeBurst + 2, {timeout: 5000});
  const secondBurstAction = {
    name: 'confirm-choice', surfaceId: burstSurfaceId, sourceComponentId: 'submit',
    context: {selection: 'final 🐝'},
  };
  expectedActions.push(secondBurstAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Pointer and keyboard actions must use isolated last-write-wins data');
  checkpoints.push({step: 'interleaved-live-surface-burst', updates: burstUpdates.length,
    pointerAction: firstBurstAction, keyboardAction: secondBurstAction, mountedButtons: 2});

  await page.evaluate(surfaceId => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId},
  }), burstSurfaceId);
  await button.nth(1).waitFor({state: 'detached', timeout: 5000});
  await page.getByText('final 🐙', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await button.count(), 1, 'Removing the burst peer must preserve the original');
  await page.keyboard.press('Enter');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Focused deleted peer must not emit a stale action');
  checkpoints.push({step: 'interleaved-burst-peer-delete', buttonCount: 1,
    actionCount: expectedActions.length});

  // Replacing a mounted component graph must remove the old Button and its
  // event binding, rather than leaving an obsolete action reachable by input.
  // This exercises a live published React renderer, not schema conformance.
  const actionsBeforeReplacement = expectedActions.length;
  const formerButton = page.getByRole('button', {name: 'Confirm', exact: true});
  await formerButton.waitFor({state: 'visible'});
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'action-replay',
      components: [
        {id: 'root', component: 'Column', children: ['status', 'new-submit']},
        {id: 'status', component: 'Text', text: {path: '/selection'}},
        {
          id: 'new-submit', component: 'Button', child: 'new-label', variant: 'primary',
          action: {event: {name: 'confirm-replacement',
            context: {selection: {path: '/selection'}}}},
        },
        {id: 'new-label', component: 'Text', text: 'Confirm replacement'},
      ],
    },
  }));
  const replacementButton = page.getByRole('button', {name: 'Confirm replacement', exact: true});
  await replacementButton.waitFor({state: 'visible', timeout: 5000});
  await formerButton.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 1,
    'Replacing component graph must leave exactly one live Button');
  await page.getByText('final 🐙', {exact: true}).waitFor({state: 'visible'});
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeReplacement, 'Component update alone must not emit an action');

  await replacementButton.click({timeout: 7000});
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeReplacement + 1, {timeout: 5000});
  const replacementPointerAction = {
    name: 'confirm-replacement', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: 'final 🐙'},
  };
  expectedActions.push(replacementPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'New pointer target must emit only the replacement event');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/',
      value: {selection: 'replaced 🍂', confirmed: true},
    },
  }));
  await page.getByText('replaced 🍂', {exact: true}).waitFor({state: 'visible'});
  await replacementButton.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeReplacement + 2, {timeout: 5000});
  const replacementKeyboardAction = {
    name: 'confirm-replacement', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: 'replaced 🍂'},
  };
  expectedActions.push(replacementKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Replacement keyboard action must use current data, not stale context');
  assert.deepEqual(runtimeErrors, [], 'Live component graph swap must not throw in Chromium');
  checkpoints.push({step: 'live-component-replacement-action-rebind',
    oldButtonRemoved: true, mountedButtons: 1,
    pointerAction: replacementPointerAction, keyboardAction: replacementKeyboardAction});

  // Replacing the event on an existing component ID is different from
  // mounting a new Button: the renderer may reuse its DOM and listener.
  // Both pointer and keyboard input must route to the new event definition.
  const actionsBeforeHotSwap = expectedActions.length;
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'action-replay',
      components: [
        {id: 'root', component: 'Column', children: ['status', 'new-submit']},
        {id: 'status', component: 'Text', text: {path: '/selection'}},
        {
          id: 'new-submit', component: 'Button', child: 'new-label', variant: 'primary',
          action: {event: {name: 'confirm-hot-swap',
            context: {selection: {path: '/selection'}}}},
        },
        {id: 'new-label', component: 'Text', text: 'Confirm updated'},
      ],
    },
  }));
  const hotSwapButton = page.getByRole('button', {name: 'Confirm updated', exact: true});
  await hotSwapButton.waitFor({state: 'visible', timeout: 5000});
  await replacementButton.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 1,
    'Stable-ID event replacement must not duplicate rendered Buttons');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeHotSwap, 'Hot-swapping a Button event must not fire it');

  await hotSwapButton.click({timeout: 7000});
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeHotSwap + 1, {timeout: 5000});
  const hotSwapPointerAction = {
    name: 'confirm-hot-swap', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: 'replaced 🍂'},
  };
  expectedActions.push(hotSwapPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Stable-ID Button must not retain its previous event handler');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/',
      value: {selection: 'refreshed 🌿', confirmed: true},
    },
  }));
  await page.getByText('refreshed 🌿', {exact: true}).waitFor({state: 'visible'});
  await hotSwapButton.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeHotSwap + 2, {timeout: 5000});
  const hotSwapKeyboardAction = {
    name: 'confirm-hot-swap', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: 'refreshed 🌿'},
  };
  expectedActions.push(hotSwapKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard action after stable-ID rebind must use current data');
  assert.deepEqual(runtimeErrors, [], 'Stable-ID event hot-swap must not throw in Chromium');
  checkpoints.push({step: 'stable-id-event-hot-swap', mountedButtons: 1,
    pointerAction: hotSwapPointerAction, keyboardAction: hotSwapKeyboardAction});

  // A temporary component-only update can remove the focused Button while
  // preserving its surface and model. Reintroducing the SAME component ID
  // must bind a fresh event, not resurrect the detached listener.
  const actionsBeforeDetach = expectedActions.length;
  await hotSwapButton.focus();
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'action-replay',
      components: [
        {id: 'root', component: 'Column', children: ['status']},
        {id: 'status', component: 'Text', text: {path: '/selection'}},
      ],
    },
  }));
  await hotSwapButton.waitFor({state: 'detached', timeout: 5000});
  await page.getByText('refreshed 🌿', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await page.getByRole('button').count(), 0,
    'Removing only the Button must preserve surface Text without a clickable control');
  await page.keyboard.press('Space');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeDetach, 'Space after focused Button detachment must not trigger a stale action');
  assert.deepEqual(runtimeErrors, [], 'Detaching a focused Button must not throw');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'action-replay',
      components: [
        {id: 'root', component: 'Column', children: ['status', 'new-submit']},
        {id: 'status', component: 'Text', text: {path: '/selection'}},
        {
          id: 'new-submit', component: 'Button', child: 'new-label', variant: 'primary',
          action: {event: {name: 'confirm-restored',
            context: {selection: {path: '/selection'}}}},
        },
        {id: 'new-label', component: 'Text', text: 'Confirm restored'},
      ],
    },
  }));
  const restoredButton = page.getByRole('button', {name: 'Confirm restored', exact: true});
  await restoredButton.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 1,
    'Reinserting an old component ID must create exactly one live Button');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeDetach, 'Reinsertion without user input must not emit actions');
  await restoredButton.click({timeout: 7000});
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeDetach + 1, {timeout: 5000});
  const restoredPointerAction = {
    name: 'confirm-restored', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: 'refreshed 🌿'},
  };
  expectedActions.push(restoredPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Remounted Button must not emit the obsolete hot-swap event');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/',
      value: {selection: 'restored 🍁', confirmed: true},
    },
  }));
  await page.getByText('restored 🍁', {exact: true}).waitFor({state: 'visible'});
  await restoredButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeDetach + 2, {timeout: 5000});
  const restoredKeyboardAction = {
    name: 'confirm-restored', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: 'restored 🍁'},
  };
  expectedActions.push(restoredKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Reinserted Button keyboard action must use updated model data');
  assert.deepEqual(runtimeErrors, [], 'Component detachment/remount must not throw in Chromium');
  checkpoints.push({step: 'focused-button-detach-reinsert', detachedButtonCount: 0,
    remountedButtonCount: 1, pointerAction: restoredPointerAction,
    keyboardAction: restoredKeyboardAction});

  // Keep the mounted-surface screenshot in memory until all remaining assertions pass.
  const screenshotBytes = await page.screenshot({fullPage: true});

  // Treat the data model as untrusted input, not executable HTML. This
  // exercises the rendered Text and a genuine Button action together; it
  // does not claim comprehensive XSS coverage or a new SDK vulnerability.
  const markupSelection = 'agent-data-marker <img src="data:image/png;base64,AA" ' +
    'onerror="window.__a2uiLabMarkupExecuted = true">';
  const actionsBeforeMarkup = expectedActions.length;
  await page.evaluate(value => {
    window.__a2uiLabMarkupExecuted = false;
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {selection: value, confirmed: true},
      },
    });
  }, markupSelection);
  await page.getByText(/agent-data-marker/).waitFor({state: 'visible', timeout: 5000});
  assert.equal(await page.locator('[onerror]').count(), 0,
    'Agent model Text must not install executable inline HTML event handlers');
  assert.equal(await page.evaluate(() => window.__a2uiLabMarkupExecuted), false,
    'Untrusted Text must not execute an injected image error handler');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeMarkup, 'Rendering untrusted Text must not dispatch an agent action');

  await restoredButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeMarkup + 1, {timeout: 5000});
  const markupAction = {
    name: 'confirm-restored', surfaceId: 'action-replay', sourceComponentId: 'new-submit',
    context: {selection: markupSelection},
  };
  expectedActions.push(markupAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Real Button must preserve agent-controlled Text as inert action data');
  assert.equal(await page.evaluate(() => window.__a2uiLabMarkupExecuted), false,
    'Pointer interaction must not trigger an injected HTML handler');
  assert.deepEqual(runtimeErrors, [], 'Agent markup containment must not throw in Chromium');
  checkpoints.push({step: 'agent-markup-text-action-containment',
    executableHandlerAttributes: 0, injectedHandlerExecuted: false,
    action: markupAction});

  // A leaf-level update must refresh rendered Text and event context without
  // replacing unrelated fields in the same published-SDK data model.
  const leafSelection = 'nested leaf 🌱';
  const actionsBeforeLeaf = expectedActions.length;
  await page.evaluate(value => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/selection', value,
    },
  }), leafSelection);
  await page.getByText(leafSelection, {exact: true}).waitFor({state: 'visible', timeout: 5000});
  const leafState = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(leafState.data, {selection: leafSelection, confirmed: true},
    'Leaf data update must preserve the existing sibling model value');
  assert.equal(leafState.actions.length, actionsBeforeLeaf,
    'Leaf model update must never dispatch a synthetic Button event');

  await restoredButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeLeaf + 1, {timeout: 5000});
  const leafAction = {
    name: 'confirm-restored', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: leafSelection},
  };
  expectedActions.push(leafAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Real keyboard action must bind the latest nested leaf update');
  checkpoints.push({step: 'nested-model-leaf-action-refresh', path: '/selection',
    siblingPreserved: true, action: leafAction});

  // An explicit empty-string leaf must clear the visible label without
  // retaining stale action context. This is distinct from deleting the field.
  const actionsBeforeClear = expectedActions.length;
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/selection', value: '',
    },
  }));
  await page.getByText(leafSelection, {exact: true}).waitFor({
    state: 'hidden', timeout: 5000,
  });
  const clearedState = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(clearedState.data, {selection: '', confirmed: true},
    'Clearing the selection must preserve the explicit empty value and sibling field');
  assert.equal(clearedState.actions.length, actionsBeforeClear,
    'Model clearing must never synthesize a Button action');

  await restoredButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeClear + 1, {timeout: 5000});
  const emptySelectionAction = {
    name: 'confirm-restored', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {selection: ''},
  };
  expectedActions.push(emptySelectionAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard action must use empty selection, not the stale leaf value');
  checkpoints.push({step: 'empty-string-leaf-action-refresh',
    path: '/selection', siblingPreserved: true, action: emptySelectionAction});
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
  assert.deepEqual(consoleErrors, [],
    'Real React browser replay must not hide console.error diagnostics');
  assert.deepEqual(deniedRequests, [deniedProbe],
    'No later renderer action may require an unapproved browser HTTP(S) origin');
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
    consoleErrors,
    passed: true,
  };
  const {tracePath} = publishBrowserEvidence(outDir, screenshotBytes, report);
  console.log('Real A2UI React Chromium: ' + checkpoints.length + ' checkpoints / ' + trace.actions.length + ' agent events / no runtime errors / PASS');
  console.log('Trace: ' + tracePath);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}
