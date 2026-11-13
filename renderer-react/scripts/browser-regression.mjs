#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {resolveBrowserEvidenceDir, assertBrowserEvidenceUnused, publishBrowserEvidence} from '../../src/browser-evidence.mjs';
import {createServer} from 'vite';
import {decodeBrowserCapture, parseBrowserCaptureOptions, runBrowserCapture} from './browser-capture-replay.mjs';
import {compareBrowserCaptureSummaries} from '../../src/browser-capture-summary-compare.mjs';
import {testDirectBrowserCaptureBaseline} from './browser-capture-baseline-regression.mjs';

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
  // Playwright's HTTP route does not cover WebSocket handshakes. Keep Vite's
  // same-origin HMR socket, but never connect an off-origin socket to a server.
  const deniedWebSockets = [];
  const allowedSocketOrigin = origin.replace(/^http:/, 'ws:');
  await context.routeWebSocket('**/*', socket => {
    if (new URL(socket.url()).origin === allowedSocketOrigin) {
      socket.connectToServer();
      return;
    }
    deniedWebSockets.push(socket.url());
    return socket.close({code: 1008, reason: 'A2UI offline browser replay'});
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
  // A second localhost port is intentionally off-origin, even on loopback.
  // RouteWebSocket must close the synthetic socket without reaching that port.
  const deniedSocketProbe = 'ws://127.0.0.1:1/__a2ui_browser_websocket_guard_probe__';
  const blockedSocket = await page.evaluate(url => new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error('WebSocket guard probe timed out')), 5000);
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', event => {
      clearTimeout(timeout);
      resolve({code: event.code});
    }, {once: true});
  }), deniedSocketProbe);
  assert.notEqual(blockedSocket.code, 1000,
    'Off-origin WebSocket must not complete a normal successful connection');
  assert.deepEqual(deniedWebSockets, [deniedSocketProbe],
    'Playwright must intercept the off-origin WebSocket before any network connection');
  assert.ok(consoleErrors.every(message => message.includes(deniedSocketProbe)),
    'Only diagnostics from the controlled WebSocket probe may be ignored');
  consoleErrors.length = 0;
  checkpoints.push({step: 'browser-websocket-isolation',
    offOriginProbeBlocked: true, unexpectedOffOriginSockets: 0});
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


  // A nested JSON Pointer binding must follow a leaf update without losing
  // siblings or carrying stale action context across React re-renders.
  const nestedBefore = expectedActions.length;
  await page.evaluate(() => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'action-replay',
        components: [
          {id: 'root', component: 'Column', children: ['status', 'new-submit']},
          {id: 'status', component: 'Text', text: {path: '/form/label'}},
          {
            id: 'new-submit', component: 'Button', child: 'new-label',
            variant: 'primary', action: {event: {name: 'confirm-nested',
              context: {label: {path: '/form/label'}, selection: {path: '/selection'}}}},
          },
          {id: 'new-label', component: 'Text', text: 'Confirm nested model'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {selection: '', confirmed: true, form: {label: 'before 🌿', retained: 7}},
      },
    });
  });
  const nestedButton = page.getByRole('button', {name: 'Confirm nested model', exact: true});
  await nestedButton.waitFor({state: 'visible', timeout: 5000});
  await restoredButton.waitFor({state: 'detached', timeout: 5000});
  await page.getByText('before 🌿', {exact: true}).waitFor({state: 'visible'});
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {selection: '', confirmed: true, form: {label: 'before 🌿', retained: 7}});
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    nestedBefore, 'Mounting a nested binding and setting its model must not emit an action');

  await nestedButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    nestedBefore + 1, {timeout: 5000});
  const nestedInitialAction = {
    name: 'confirm-nested', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: 'before 🌿', selection: ''},
  };
  expectedActions.push(nestedInitialAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Pointer action must resolve the nested model before its leaf update');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/form/label', value: 'after 🧭',
    },
  }));
  await page.getByText('after 🧭', {exact: true}).waitFor({state: 'visible', timeout: 5000});
  await page.getByText('before 🌿', {exact: true}).waitFor({state: 'hidden'});
  const nestedUpdated = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(nestedUpdated.data,
    {selection: '', confirmed: true, form: {label: 'after 🧭', retained: 7}},
    'Nested leaf update must preserve its sibling and unrelated root fields');
  assert.equal(nestedUpdated.actions.length, nestedBefore + 1,
    'Nested leaf update must not create an unsolicited action');

  await nestedButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    nestedBefore + 2, {timeout: 5000});
  const nestedUpdatedAction = {
    name: 'confirm-nested', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: 'after 🧭', selection: ''},
  };
  expectedActions.push(nestedUpdatedAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Real keyboard action must use the latest nested leaf, not stale context');
  checkpoints.push({step: 'nested-object-leaf-action-binding',
    path: '/form/label', siblingPreserved: true,
    pointerAction: nestedInitialAction, keyboardAction: nestedUpdatedAction});

  // A real text input must write back into the published data model. The
  // same path also drives visible Text and a Button's action context; an
  // agent update must later flow in the opposite direction to the input.
  const formActionsBefore = expectedActions.length;
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'action-replay',
      components: [
        {id: 'root', component: 'Column', children: ['status', 'editor', 'new-submit']},
        {id: 'status', component: 'Text', text: {path: '/form/label'}},
        {
          id: 'editor', component: 'TextField', label: 'Edit form label',
          value: {path: '/form/label'}, variant: 'shortText',
        },
        {
          id: 'new-submit', component: 'Button', child: 'new-label',
          variant: 'primary', action: {event: {name: 'submit-edited-form',
            context: {label: {path: '/form/label'}}}},
        },
        {id: 'new-label', component: 'Text', text: 'Submit edited form'},
      ],
    },
  }));
  const formInput = page.getByRole('textbox').first();
  const formButton = page.getByRole('button', {name: 'Submit edited form', exact: true});
  await formButton.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await formInput.count(), 1, 'Exactly one real TextField must be mounted');
  await formInput.waitFor({state: 'visible', timeout: 5000});
  await nestedButton.waitFor({state: 'detached', timeout: 5000});
  // The published catalog TextField declares a label. Record whether the
  // *rendered browser role* exposes it rather than inferring from the schema.
  const expectedTextFieldName = 'Edit form label';
  const namedTextbox = page.getByRole('textbox', {name: expectedTextFieldName, exact: true});
  const initialNamedTextboxCount = await namedTextbox.count();
  assert.ok(initialNamedTextboxCount === 0 || initialNamedTextboxCount === 1,
    'One TextField must not resolve to multiple identically named textboxes');
  const initialTextboxRole = await formInput.ariaSnapshot();
  assert.equal(typeof initialTextboxRole, 'string',
    'Chromium must expose the TextField accessibility role snapshot');
  const accessibilityFindings = [];
  if (initialNamedTextboxCount === 0) {
    accessibilityFindings.push({
      id: 'textfield-missing-accessible-name', catalogComponentId: 'editor',
      severity: 'warning', expectedName: expectedTextFieldName,
      observedRoleSnapshot: initialTextboxRole,
    });
  }
  assert.equal(await formInput.inputValue(), 'after 🧭',
    'TextField must initially read the existing nested model value');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    formActionsBefore, 'Mounting an editor must not dispatch an action');

  const browserEditedLabel = 'typed in Chromium 🖊';
  await formInput.fill(browserEditedLabel);
  await page.getByText(browserEditedLabel, {exact: true}).waitFor({
    state: 'visible', timeout: 5000,
  });
  const browserEditedTrace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(browserEditedTrace.data,
    {selection: '', confirmed: true, form: {label: browserEditedLabel, retained: 7}},
    'Real text input must update the shared model without dropping siblings');
  assert.equal(browserEditedTrace.actions.length, formActionsBefore,
    'Typing alone must not dispatch a server-bound agent action');

  await formButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    formActionsBefore + 1, {timeout: 5000});
  const editedFormAction = {
    name: 'submit-edited-form', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: browserEditedLabel},
  };
  expectedActions.push(editedFormAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Real pointer action must send user-edited, not initial, form data');

  const agentEditedLabel = 'agent updated label 🌙';
  await page.evaluate(value => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/form/label', value,
    },
  }), agentEditedLabel);
  await page.getByText(agentEditedLabel, {exact: true}).waitFor({
    state: 'visible', timeout: 5000,
  });
  await page.waitForFunction(value =>
    document.querySelector('input')?.value === value, agentEditedLabel, {timeout: 5000});
  assert.equal(await formInput.inputValue(), agentEditedLabel,
    'Agent leaf update must flow back into the live TextField');
  const updatedNamedTextboxCount = await namedTextbox.count();
  assert.equal(updatedNamedTextboxCount, initialNamedTextboxCount,
    'Agent re-render must not change whether the TextField exposes its declared accessible name');
  checkpoints.push({
    step: 'textfield-accessible-name-probe',
    expectedName: expectedTextFieldName,
    browserRoleBefore: initialTextboxRole,
    browserRoleAfter: await formInput.ariaSnapshot(),
    accessibleNameMatched: initialNamedTextboxCount === 1,
    accessibleNameStableAfterModelUpdate: true,
  });
  const agentEditedTrace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(agentEditedTrace.data,
    {selection: '', confirmed: true, form: {label: agentEditedLabel, retained: 7}},
    'Agent leaf update must preserve browser-edited form siblings');
  assert.equal(agentEditedTrace.actions.length, formActionsBefore + 1,
    'Agent model update must not synthesize a form submission');

  await formButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    formActionsBefore + 2, {timeout: 5000});
  const agentUpdatedFormAction = {
    name: 'submit-edited-form', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: agentEditedLabel},
  };
  expectedActions.push(agentUpdatedFormAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard submission must use agent-updated live form state');
  checkpoints.push({step: 'textfield-two-way-form-action-replay',
    path: '/form/label', siblingPreserved: true,
    pointerAction: editedFormAction, keyboardAction: agentUpdatedFormAction});

  // Distinct live surfaces may reuse every component ID and the same model
  // path. Real typing and actions must never cross the surface boundary.
  const parallelFormSurfaceId = 'parallel-form-peer';
  const primaryBeforePeer = (await page.evaluate(() => window.__a2uiLab.trace())).data;
  const parallelFormsBefore = expectedActions.length;
  await page.evaluate(surfaceId => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      createSurface: {surfaceId, catalogId: '__BASIC_CATALOG__'},
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateComponents: {
        surfaceId,
        components: [
          {id: 'root', component: 'Column', children: ['status', 'editor', 'new-submit']},
          {id: 'status', component: 'Text', text: {path: '/form/label'}},
          {
            id: 'editor', component: 'TextField', label: 'Edit form label',
            value: {path: '/form/label'}, variant: 'shortText',
          },
          {
            id: 'new-submit', component: 'Button', child: 'new-label',
            variant: 'primary', action: {event: {name: 'submit-edited-form',
              context: {label: {path: '/form/label'}}}},
          },
          {id: 'new-label', component: 'Text', text: 'Submit peer form'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateDataModel: {
        surfaceId, path: '/',
        value: {selection: 'peer-only', form: {label: 'peer initial 🌱', retained: 9}},
      },
    });
  }, parallelFormSurfaceId);
  const liveEditors = page.getByRole('textbox');
  const peerEditor = liveEditors.nth(1);
  const peerFormButton = page.getByRole('button', {name: 'Submit peer form', exact: true});
  await peerEditor.waitFor({state: 'visible', timeout: 5000});
  await peerFormButton.waitFor({state: 'visible', timeout: 5000});
  await page.getByText('peer initial 🌱', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await liveEditors.count(), 2,
    'Parallel surfaces with reused component IDs must mount two independent TextFields');
  assert.equal(await peerEditor.inputValue(), 'peer initial 🌱');
  assert.equal(await formInput.inputValue(), agentEditedLabel,
    'Creating a peer TextField must not overwrite the primary input');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data, primaryBeforePeer,
    'Creating a peer surface must not change the primary model');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    parallelFormsBefore, 'Mounting a peer form must not dispatch an action');

  const peerTypedLabel = 'peer entered 🌸';
  await peerEditor.fill(peerTypedLabel);
  await page.getByText(peerTypedLabel, {exact: true}).waitFor({state: 'visible'});
  assert.equal(await formInput.inputValue(), agentEditedLabel,
    'Typing into a peer TextField must not alter the primary TextField');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data, primaryBeforePeer,
    'Peer input must not mutate the primary data model');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    parallelFormsBefore, 'Typing into the peer must not synthesize a Button event');

  await peerFormButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    parallelFormsBefore + 1, {timeout: 5000});
  const peerFormAction = {
    name: 'submit-edited-form', surfaceId: parallelFormSurfaceId,
    sourceComponentId: 'new-submit', context: {label: peerTypedLabel},
  };
  expectedActions.push(peerFormAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Peer Button must dispatch its own typed data under the peer surface ID');

  const primaryTypedLabel = 'primary entered 🌟';
  await formInput.fill(primaryTypedLabel);
  await page.getByText(primaryTypedLabel, {exact: true}).waitFor({state: 'visible'});
  assert.equal(await peerEditor.inputValue(), peerTypedLabel,
    'Typing in the primary form must preserve the peer input');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {selection: '', confirmed: true, form: {label: primaryTypedLabel, retained: 7}},
    'Primary typing must update only its own nested model and preserve siblings');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    parallelFormsBefore + 1, 'Primary typing must not emit an unsolicited action');

  await formButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    parallelFormsBefore + 2, {timeout: 5000});
  const primaryFormAction = {
    name: 'submit-edited-form', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: primaryTypedLabel},
  };
  expectedActions.push(primaryFormAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Primary Button must dispatch its own edited value without peer leakage');

  await page.evaluate(surfaceId => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId},
  }), parallelFormSurfaceId);
  await peerEditor.waitFor({state: 'detached', timeout: 5000});
  await peerFormButton.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await liveEditors.count(), 1,
    'Deleting the peer must remove its real input, not only its Button');
  assert.equal(await formInput.inputValue(), primaryTypedLabel,
    'Deleting the peer must not discard the surviving form input');
  await formButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    parallelFormsBefore + 3, {timeout: 5000});
  expectedActions.push(primaryFormAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'After peer deletion keyboard action must still use surviving form data');
  checkpoints.push({step: 'parallel-textfield-model-action-isolation',
    reusedComponentIds: true, mountedEditors: 1, peerDeleted: true,
    peerPointerAction: peerFormAction, primaryPointerAction: primaryFormAction,
    survivorKeyboardAction: primaryFormAction});

  // Recreating a deleted form under its old surface ID must allocate fresh
  // model state and event bindings, rather than revive typed input or actions.
  const rebornInitialLabel = 'reborn seed 🌳';
  const rebornAgentLabel = 'reborn update 🌊';
  const actionsBeforeRebirth = expectedActions.length;
  await page.evaluate(({surfaceId, label}) => {
    for (const message of [
      {version: 'v0.9',
        createSurface: {surfaceId, catalogId: '__BASIC_CATALOG__'}},
      {version: 'v0.9',
        updateComponents: {surfaceId, components: [
          {id: 'root', component: 'Column', children: ['status', 'editor', 'new-submit']},
          {id: 'status', component: 'Text', text: {path: '/form/label'}},
          {id: 'editor', component: 'TextField', label: 'Edit form label',
            value: {path: '/form/label'}, variant: 'shortText'},
          {id: 'new-submit', component: 'Button', child: 'new-label',
            variant: 'primary', action: {event: {name: 'submit-reborn-form',
              context: {label: {path: '/form/label'}}}}},
          {id: 'new-label', component: 'Text', text: 'Submit reborn form'},
        ]}},
      {version: 'v0.9',
        updateDataModel: {surfaceId, path: '/', value: {
          selection: 'reborn-only', form: {label, retained: 11},
        }}},
    ]) window.__a2uiLab.applyMessage(message);
  }, {surfaceId: parallelFormSurfaceId, label: rebornInitialLabel});
  const rebornButton = page.getByRole('button', {name: 'Submit reborn form', exact: true});
  await rebornButton.waitFor({state: 'visible', timeout: 5000});
  await page.getByText(rebornInitialLabel, {exact: true}).waitFor({state: 'visible'});
  assert.equal(await liveEditors.count(), 2,
    'Recreated form must mount one new editor beside the surviving primary');
  assert.equal(await peerEditor.inputValue(), rebornInitialLabel,
    'Recreated editor must use its fresh agent value, not previously typed text');
  assert.equal(await formInput.inputValue(), primaryTypedLabel,
    'Recreating the peer must preserve the surviving editor');
  const rebornSnapshot = await page.evaluate(id => window.__a2uiLab.trace(id),
    parallelFormSurfaceId);
  assert.deepEqual(rebornSnapshot.data,
    {selection: 'reborn-only', form: {label: rebornInitialLabel, retained: 11}},
    'Recreated surface must have fresh model state and a preserved sibling');
  assert.deepEqual(rebornSnapshot.actions, expectedActions,
    'Recreating a surface must not replay a stale action');

  await rebornButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeRebirth + 1, {timeout: 5000});
  const rebornKeyboardAction = {
    name: 'submit-reborn-form', surfaceId: parallelFormSurfaceId,
    sourceComponentId: 'new-submit', context: {label: rebornInitialLabel},
  };
  expectedActions.push(rebornKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Reused surface ID must dispatch only the new event definition');

  await page.evaluate(({surfaceId, label}) => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {surfaceId, path: '/form/label', value: label},
  }), {surfaceId: parallelFormSurfaceId, label: rebornAgentLabel});
  await page.getByText(rebornAgentLabel, {exact: true}).waitFor({state: 'visible'});
  await page.waitForFunction(value =>
    [...document.querySelectorAll('input')].some(node => node.value === value),
    rebornAgentLabel, {timeout: 5000});
  assert.equal(await peerEditor.inputValue(), rebornAgentLabel,
    'Agent update must refresh a recreated TextField in the real browser');
  assert.deepEqual((await page.evaluate(id => window.__a2uiLab.trace(id),
    parallelFormSurfaceId)).data,
    {selection: 'reborn-only', form: {label: rebornAgentLabel, retained: 11}},
    'Recreated model leaf update must preserve unrelated nested data');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {selection: '', confirmed: true, form: {label: primaryTypedLabel, retained: 7}},
    'Recreated peer agent update must not affect the primary surface');

  await rebornButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeRebirth + 2, {timeout: 5000});
  const rebornPointerAction = {
    name: 'submit-reborn-form', surfaceId: parallelFormSurfaceId,
    sourceComponentId: 'new-submit', context: {label: rebornAgentLabel},
  };
  expectedActions.push(rebornPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Recreated pointer event must use fresh agent-updated context');

  await page.evaluate(surfaceId => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId},
  }), parallelFormSurfaceId);
  await rebornButton.waitFor({state: 'detached', timeout: 5000});
  await peerEditor.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await liveEditors.count(), 1, 'Reborn editor must fully unmount');
  assert.equal((await page.evaluate(id => window.__a2uiLab.trace(id).data,
    parallelFormSurfaceId)), null, 'Second deletion must remove the recreated model');
  assert.equal(await formInput.inputValue(), primaryTypedLabel,
    'Second peer deletion must leave the surviving form intact');
  checkpoints.push({step: 'textfield-surface-id-rebirth',
    surfaceIdReused: true, freshModel: true, peerDeletedAgain: true,
    keyboardAction: rebornKeyboardAction, agentUpdatedPointerAction: rebornPointerAction});

  // Removing a focused editor while preserving its surface must detach the
  // old input. Restoring that component ID must use current agent data and
  // a fresh DOM binding, not an obsolete browser draft or stale action.
  const actionsBeforeEditorRemount = expectedActions.length;
  const focusedDraft = 'focused draft 🪁';
  await formInput.fill(focusedDraft);
  await page.getByText(focusedDraft, {exact: true}).waitFor({state: 'visible'});
  await formInput.focus();
  assert.equal(await formInput.evaluate(node => document.activeElement === node), true,
    'The old TextField must actually own browser focus before it is removed');
  const oldEditorNode = await formInput.elementHandle();
  assert.ok(oldEditorNode, 'Focused editor must expose a real Chromium input element');
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {surfaceId: 'action-replay', components: [
      {id: 'root', component: 'Column', children: ['status', 'new-submit']},
      {id: 'status', component: 'Text', text: {path: '/form/label'}},
      {id: 'new-submit', component: 'Button', child: 'new-label',
        variant: 'primary', action: {event: {name: 'submit-edited-form',
          context: {label: {path: '/form/label'}}}}},
      {id: 'new-label', component: 'Text', text: 'Submit edited form'},
    ]},
  }));
  await formInput.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await page.getByRole('textbox').count(), 0,
    'Removing only the focused TextField must unmount its real browser input');
  assert.equal(await oldEditorNode.evaluate(node => node.isConnected), false,
    'The old focused editor node must not remain attached to the document');
  assert.equal(await page.evaluate(() => document.activeElement?.isConnected), true,
    'Deleting a focused TextField must not retain a detached focus target');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeEditorRemount, 'Removing a focused editor must emit no action');

  const agentWhileDetached = 'agent while editor absent 🪐';
  await page.evaluate(value => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {surfaceId: 'action-replay', path: '/form/label', value},
  }), agentWhileDetached);
  await page.getByText(agentWhileDetached, {exact: true}).waitFor({state: 'visible'});
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {selection: '', confirmed: true, form: {label: agentWhileDetached, retained: 7}},
    'Model changes while the editor is absent must retain unrelated form data');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeEditorRemount, 'Agent leaf updates must not synthesize submissions');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateComponents: {surfaceId: 'action-replay', components: [
      {id: 'root', component: 'Column', children: ['status', 'editor', 'new-submit']},
      {id: 'status', component: 'Text', text: {path: '/form/label'}},
      {id: 'editor', component: 'TextField', label: 'Edit form label',
        value: {path: '/form/label'}, variant: 'shortText'},
      {id: 'new-submit', component: 'Button', child: 'new-label',
        variant: 'primary', action: {event: {name: 'submit-edited-form',
          context: {label: {path: '/form/label'}}}}},
      {id: 'new-label', component: 'Text', text: 'Submit edited form'},
    ]},
  }));
  const remountedEditor = page.getByRole('textbox').first();
  await remountedEditor.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await page.getByRole('textbox').count(), 1,
    'Restoring the focused editor must mount exactly one new input');
  assert.equal(await remountedEditor.inputValue(), agentWhileDetached,
    'Restored TextField must use the agent value, never the detached draft');
  assert.equal(await oldEditorNode.evaluate(node => node.isConnected), false,
    'Remount must not reuse the detached input node');
  const remountedDraft = 'fresh editor draft 🌾';
  await remountedEditor.fill(remountedDraft);
  await page.getByText(remountedDraft, {exact: true}).waitFor({state: 'visible'});
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {selection: '', confirmed: true, form: {label: remountedDraft, retained: 7}},
    'Restored editor must reconnect two-way binding without losing model siblings');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeEditorRemount, 'Typing in a remounted editor must not emit Button actions');
  await formButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeEditorRemount + 1, {timeout: 5000});
  const remountedPointerAction = {
    name: 'submit-edited-form', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: remountedDraft},
  };
  expectedActions.push(remountedPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Remounted Button must dispatch fresh browser-edited context');

  const latestAgentValue = 'restored agent leaf ☄️';
  await page.evaluate(value => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {surfaceId: 'action-replay', path: '/form/label', value},
  }), latestAgentValue);
  await page.getByText(latestAgentValue, {exact: true}).waitFor({state: 'visible'});
  assert.equal(await remountedEditor.inputValue(), latestAgentValue,
    'Remounted editor must continue reflecting later agent updates');
  await formButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeEditorRemount + 2, {timeout: 5000});
  const remountedKeyboardAction = {
    name: 'submit-edited-form', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {label: latestAgentValue},
  };
  expectedActions.push(remountedKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard action after remount must use latest agent-bound data');
  checkpoints.push({step: 'focused-textfield-detach-remount',
    oldNodeDetached: true, oneRestoredEditor: true, staleDraftDiscarded: true,
    pointerAction: remountedPointerAction, keyboardAction: remountedKeyboardAction});

  // Array-indexed model paths must bind the same value through actual React
  // Text, TextField and Button actions without overwriting adjacent items.
  const indexedActionsBefore = expectedActions.length;
  const indexedInitial = 'first item 🐢';
  const indexedPeer = 'second item 🐇';
  await page.evaluate(({first, second}) => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateComponents: {
        surfaceId: 'action-replay', components: [
          {id: 'root', component: 'Column', children: ['status', 'editor', 'new-submit']},
          {id: 'status', component: 'Text', text: {path: '/items/0/title'}},
          {id: 'editor', component: 'TextField', label: 'Edit first item',
            value: {path: '/items/0/title'}, variant: 'shortText'},
          {id: 'new-submit', component: 'Button', child: 'new-label',
            variant: 'primary', action: {event: {name: 'submit-indexed-item',
              context: {first: {path: '/items/0/title'},
                second: {path: '/items/1/title'}}}}},
          {id: 'new-label', component: 'Text', text: 'Submit indexed item'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {items: [{title: first}, {title: second}], retained: false},
      },
    });
  }, {first: indexedInitial, second: indexedPeer});
  const indexedInput = page.getByRole('textbox');
  const indexedButton = page.getByRole('button', {name: 'Submit indexed item', exact: true});
  await indexedButton.waitFor({state: 'visible', timeout: 5000});
  await indexedInput.waitFor({state: 'visible', timeout: 5000});
  await page.getByText(indexedInitial, {exact: true}).waitFor({state: 'visible'});
  assert.equal(await indexedInput.count(), 1, 'Indexed form must mount exactly one TextField');
  assert.equal(await indexedInput.inputValue(), indexedInitial);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {items: [{title: indexedInitial}, {title: indexedPeer}], retained: false});
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    indexedActionsBefore, 'Creating the array form must not emit an action');

  const indexedTyped = 'edited item 🌻';
  await indexedInput.fill(indexedTyped);
  await page.getByText(indexedTyped, {exact: true}).waitFor({state: 'visible'});
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {items: [{title: indexedTyped}, {title: indexedPeer}], retained: false},
    'Typing through index zero must preserve the adjacent item and root sibling');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    indexedActionsBefore, 'Typing alone must never emit an indexed Button event');
  await indexedButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    indexedActionsBefore + 1, {timeout: 5000});
  const indexedPointerAction = {
    name: 'submit-indexed-item', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {first: indexedTyped, second: indexedPeer},
  };
  expectedActions.push(indexedPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Indexed Button must resolve both array element values');

  const indexedAgent = 'agent item 🧭';
  await page.evaluate(value => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/items/0/title', value,
    },
  }), indexedAgent);
  await page.getByText(indexedAgent, {exact: true}).waitFor({state: 'visible'});
  assert.equal(await indexedInput.inputValue(), indexedAgent,
    'Agent leaf update must update the real indexed TextField');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {items: [{title: indexedAgent}, {title: indexedPeer}], retained: false},
    'Updating array index zero must preserve index one and root sibling');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    indexedActionsBefore + 1, 'Agent indexed update must not synthesize a Button action');
  await indexedButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    indexedActionsBefore + 2, {timeout: 5000});
  const indexedKeyboardAction = {
    name: 'submit-indexed-item', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {first: indexedAgent, second: indexedPeer},
  };
  expectedActions.push(indexedKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard submission must use the latest indexed model value');
  checkpoints.push({step: 'indexed-array-textfield-action-replay', peerPreserved: true,
    pointerAction: indexedPointerAction, keyboardAction: indexedKeyboardAction});

  // The agent may structurally replace the items array after the user has
  // edited it. Existing mounted React bindings and action contexts must
  // follow the NEW indices rather than retain the previous values.
  const indexedNodeBeforeReorder = await indexedInput.elementHandle();
  assert.ok(indexedNodeBeforeReorder, 'Indexed input must be mounted before array replacement');
  await page.evaluate(({first, second}) => window.__a2uiLab.applyMessage({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: 'action-replay', path: '/items',
      value: [{title: second}, {title: first}],
    },
  }), {first: indexedAgent, second: indexedPeer});
  await page.getByText(indexedPeer, {exact: true}).waitFor({state: 'visible', timeout: 5000});
  await page.waitForFunction(expected => document.querySelector('input')?.value === expected,
    indexedPeer, {timeout: 5000});
  assert.equal(await indexedInput.inputValue(), indexedPeer,
    'Mounted TextField must follow the new index-zero value after an array reorder');
  assert.equal(await indexedNodeBeforeReorder.evaluate(node => node.isConnected), true,
    'Data-only array replacement should preserve the mounted input node');
  assert.equal(await indexedInput.count(), 1,
    'Array replacement must not duplicate or drop the mounted editor');
  await indexedNodeBeforeReorder.dispose();
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {items: [{title: indexedPeer}, {title: indexedAgent}], retained: false},
    'Array replacement must reorder both items without losing unrelated root data');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    indexedActionsBefore + 2, 'Agent array replacement must not dispatch a synthetic action');

  const indexedReorderedAction = {
    name: 'submit-indexed-item', surfaceId: 'action-replay',
    sourceComponentId: 'new-submit', context: {first: indexedPeer, second: indexedAgent},
  };
  await indexedButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    indexedActionsBefore + 3, {timeout: 5000});
  expectedActions.push(indexedReorderedAction);
  await indexedButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    indexedActionsBefore + 4, {timeout: 5000});
  expectedActions.push(indexedReorderedAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Reordered array indices must resolve fresh context on pointer and keyboard actions');
  checkpoints.push({step: 'indexed-array-structural-reorder-rebind',
    sameInputNode: true, peerAndRootPreserved: true,
    reorderedPointerAction: indexedReorderedAction,
    reorderedKeyboardAction: indexedReorderedAction});

  // Falsy JSON scalars are valid action-context values, not absent bindings.
  // Rebind a mounted Button to two additional model paths and exercise real
  // pointer and keyboard input against published React/core 0.14.
  const actionsBeforeScalars = expectedActions.length;
  await page.evaluate(() => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'action-replay',
        components: [
          {id: 'root', component: 'Column', children: ['status', 'new-submit']},
          {id: 'status', component: 'Text', text: {path: '/selection'}},
          {
            id: 'new-submit', component: 'Button', child: 'new-label', variant: 'primary',
            action: {event: {name: 'confirm-scalars', context: {
              selection: {path: '/selection'},
              count: {path: '/count'},
              enabled: {path: '/enabled'},
            }}},
          },
          {id: 'new-label', component: 'Text', text: 'Confirm scalar values'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {selection: 'scalar binding', confirmed: true, count: 0, enabled: false},
      },
    });
  });
  const scalarButton = page.getByRole('button', {name: 'Confirm scalar values', exact: true});
  await scalarButton.waitFor({state: 'visible', timeout: 5000});
  await restoredButton.waitFor({state: 'detached', timeout: 5000});
  await page.getByText('scalar binding', {exact: true}).waitFor({state: 'visible'});
  assert.equal(await page.getByRole('button').count(), 1,
    'Rebinding scalar contexts must retain exactly one live Button');
  const initialScalarState = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(initialScalarState.data,
    {selection: 'scalar binding', confirmed: true, count: 0, enabled: false},
    'Published model must preserve explicit numeric zero and boolean false');
  assert.equal(initialScalarState.actions.length, actionsBeforeScalars,
    'Component and model updates alone must not emit actions');

  await scalarButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeScalars + 1, {timeout: 5000});
  const falsyScalarAction = {
    name: 'confirm-scalars', surfaceId: 'action-replay', sourceComponentId: 'new-submit',
    context: {selection: 'scalar binding', count: 0, enabled: false},
  };
  expectedActions.push(falsyScalarAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Pointer action must retain 0 and false, not omit falsy context values');

  await page.evaluate(() => {
    for (const [path, value] of [['/count', 3], ['/enabled', true]]) {
      window.__a2uiLab.applyMessage({
        version: 'v0.9',
        updateDataModel: {surfaceId: 'action-replay', path, value},
      });
    }
  });
  const updatedScalarState = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(updatedScalarState.data,
    {selection: 'scalar binding', confirmed: true, count: 3, enabled: true},
    'Changing scalar leaves must preserve unrelated model fields');
  assert.equal(updatedScalarState.actions.length, actionsBeforeScalars + 1,
    'Changing scalar leaves must not emit a synthetic action');
  await scalarButton.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeScalars + 2, {timeout: 5000});
  const updatedScalarAction = {
    name: 'confirm-scalars', surfaceId: 'action-replay', sourceComponentId: 'new-submit',
    context: {selection: 'scalar binding', count: 3, enabled: true},
  };
  expectedActions.push(updatedScalarAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard action must read fresh scalar leaves from the published model');
  checkpoints.push({step: 'falsy-scalar-context-rebind',
    pointerAction: falsyScalarAction, keyboardAction: updatedScalarAction,
    siblingPreserved: true, mountedButtons: 1});
  // Reordering two mounted sibling Buttons must update the actual DOM order
  // without swapping their stable component IDs or action data bindings.
  const reorderBefore = expectedActions.length;
  await page.evaluate(() => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateComponents: {
        surfaceId: 'action-replay', components: [
          {id: 'root', component: 'Column', children: ['pick-left', 'pick-right']},
          {id: 'pick-left', component: 'Button', child: 'pick-left-label',
            action: {event: {name: 'choose-left',
              context: {value: {path: '/left'}}}}},
          {id: 'pick-left-label', component: 'Text', text: 'Pick left'},
          {id: 'pick-right', component: 'Button', child: 'pick-right-label',
            action: {event: {name: 'choose-right',
              context: {value: {path: '/right'}}}}},
          {id: 'pick-right-label', component: 'Text', text: 'Pick right'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {left: 'west seed', right: 'east seed', retained: 'unchanged'},
      },
    });
  });
  const leftSibling = page.getByRole('button', {name: 'Pick left', exact: true});
  const rightSibling = page.getByRole('button', {name: 'Pick right', exact: true});
  await leftSibling.waitFor({state: 'visible', timeout: 5000});
  await rightSibling.waitFor({state: 'visible', timeout: 5000});
  await scalarButton.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 2,
    'Rebinding the surface must mount exactly two sibling Buttons');
  const originalPositions = [await leftSibling.boundingBox(), await rightSibling.boundingBox()];
  assert.ok(originalPositions[0] && originalPositions[1] &&
    originalPositions[0].y < originalPositions[1].y,
  'The first sibling Button must render before its peer in the Column');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    reorderBefore, 'Mounting sibling Buttons must not emit a synthetic action');

  await leftSibling.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    reorderBefore + 1, {timeout: 5000});
  const initialLeftAction = {
    name: 'choose-left', surfaceId: 'action-replay',
    sourceComponentId: 'pick-left', context: {value: 'west seed'},
  };
  expectedActions.push(initialLeftAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'First sibling pointer action must use its own component and model path');

  // Only the parent changes: both published SDK child nodes retain their IDs.
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateComponents: {
      surfaceId: 'action-replay',
      components: [{id: 'root', component: 'Column',
        children: ['pick-right', 'pick-left']}],
    },
  }));
  let swappedPositions;
  for (let attempt = 0; attempt < 20; attempt++) {
    swappedPositions = [await leftSibling.boundingBox(), await rightSibling.boundingBox()];
    if (swappedPositions[0] && swappedPositions[1] &&
        swappedPositions[1].y < swappedPositions[0].y) break;
    await page.waitForTimeout(50);
  }
  assert.ok(swappedPositions[0] && swappedPositions[1] &&
    swappedPositions[1].y < swappedPositions[0].y,
  'Reordering only the root must swap actual sibling Button visual positions');
  assert.equal(await page.getByRole('button').count(), 2,
    'Sibling reorder must not duplicate or drop either Button');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    reorderBefore + 1, 'Reordering components must not emit a synthetic action');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/right', value: 'east updated',
    },
  }));
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {left: 'west seed', right: 'east updated', retained: 'unchanged'},
    'Updating a reordered sibling path must preserve the peer and root model field');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    reorderBefore + 1, 'Agent data updates must not dispatch a sibling action');
  await rightSibling.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    reorderBefore + 2, {timeout: 5000});
  const updatedRightAction = {
    name: 'choose-right', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'east updated'},
  };
  expectedActions.push(updatedRightAction);
  await leftSibling.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    reorderBefore + 3, {timeout: 5000});
  const preservedLeftAction = {
    name: 'choose-left', surfaceId: 'action-replay',
    sourceComponentId: 'pick-left', context: {value: 'west seed'},
  };
  expectedActions.push(preservedLeftAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Reordered pointer and keyboard events must retain component-specific fresh data');
  checkpoints.push({step: 'sibling-buttons-reorder-action-isolation',
    realDomOrderChanged: true, oneReorderedModelLeaf: true,
    firstAction: initialLeftAction, rightKeyboardAction: updatedRightAction,
    leftPointerAction: preservedLeftAction});

  // An agent may replace a live Button's action while retaining its component ID.
  // Prove that both physical input paths route to the new event and fresh model.
  const reboundStart = expectedActions.length;
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateComponents: {
      surfaceId: 'action-replay', components: [{
        id: 'pick-right', component: 'Button', child: 'pick-right-label',
        action: {event: {name: 'choose-right-rebound', context: {
          value: {path: '/left'}, peer: {path: '/right'},
        }}},
      }],
    },
  }));
  await rightSibling.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 2,
    'Rebinding one Button action must preserve both mounted siblings');
  assert.equal(await leftSibling.count(), 1,
    'An unaffected sibling must remain independently mounted after rebinding');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length, reboundStart,
    'Agent component replacement must not synthesize an action');
  await rightSibling.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    reboundStart + 1, {timeout: 5000});
  const reboundPointerAction = {
    name: 'choose-right-rebound', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'west seed', peer: 'east updated'},
  };
  expectedActions.push(reboundPointerAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Pointer must use the replaced action name and context, not a stale closure');

  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/left', value: 'west rebound',
    },
  }));
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {left: 'west rebound', right: 'east updated', retained: 'unchanged'},
    'Action rebinding must not change unrelated model values');
  await rightSibling.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    reboundStart + 2, {timeout: 5000});
  const reboundKeyboardAction = {
    name: 'choose-right-rebound', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'west rebound', peer: 'east updated'},
  };
  expectedActions.push(reboundKeyboardAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Keyboard must dispatch the new action using the updated model');
  await leftSibling.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    reboundStart + 3, {timeout: 5000});
  const unaffectedSiblingAction = {
    name: 'choose-left', surfaceId: 'action-replay',
    sourceComponentId: 'pick-left', context: {value: 'west rebound'},
  };
  expectedActions.push(unaffectedSiblingAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Rebinding the peer must not replace the untouched sibling action');
  checkpoints.push({step: 'mounted-button-action-name-rebind',
    pointerAction: reboundPointerAction, keyboardAction: reboundKeyboardAction,
    unaffectedSiblingAction});

  // A focused Button should keep its physical node and keyboard route when
  // the agent replaces only its event definition under the same component ID.
  await rightSibling.focus();
  const focusedRightHandle = await rightSibling.elementHandle();
  assert.ok(focusedRightHandle, 'The live right Button must exist before focused rebinding');
  assert.equal(await focusedRightHandle.evaluate(element => document.activeElement === element),
    true, 'Keyboard focus must be on the right Button before rebinding');
  const beforeFocusedRebind = expectedActions.length;
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateComponents: {
      surfaceId: 'action-replay', components: [{
        id: 'pick-right', component: 'Button', child: 'pick-right-label',
        action: {event: {name: 'choose-right-focused', context: {
          value: {path: '/right'}, peer: {path: '/left'},
        }}},
      }],
    },
  }));
  await rightSibling.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await focusedRightHandle.evaluate(element =>
    element.isConnected && document.activeElement === element), true,
  'Action-only update must preserve the same connected, focused DOM Button');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeFocusedRebind, 'Rebinding a focused Button must not synthesize an action');
  await page.keyboard.press('Space');
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    beforeFocusedRebind + 1, {timeout: 5000});
  const focusedRebindAction = {
    name: 'choose-right-focused', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'east updated', peer: 'west rebound'},
  };
  expectedActions.push(focusedRebindAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Space without refocusing must dispatch only the newly bound action');
  await focusedRightHandle.dispose();
  checkpoints.push({step: 'focused-button-action-rebind-no-refocus',
    retainedPhysicalFocus: true, keyboardAction: focusedRebindAction});

  // Native Space activation happens on keyup, but an agent may replace the
  // focused Button's action between keydown and keyup. The release must route
  // exactly one current action rather than a stale pre-update event.
  const heldSpaceButton = await rightSibling.elementHandle();
  assert.ok(heldSpaceButton, 'Right Button must be mounted before held Space');
  await rightSibling.focus();
  const actionsBeforeHeldSpace = expectedActions.length;
  await page.keyboard.down('Space');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeHeldSpace, 'Space keydown must not activate the Button before keyup');
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateComponents: {
      surfaceId: 'action-replay', components: [{
        id: 'pick-right', component: 'Button', child: 'pick-right-label',
        action: {event: {name: 'choose-right-on-release', context: {
          value: {path: '/right'}, peer: {path: '/left'},
        }}},
      }],
    },
  }));
  assert.equal(await heldSpaceButton.evaluate(element =>
    element.isConnected && document.activeElement === element), true,
  'Agent action update during a held Space must preserve physical DOM focus');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforeHeldSpace, 'Agent update during a held key must not synthesize a click');
  await page.keyboard.up('Space');
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    actionsBeforeHeldSpace + 1, {timeout: 5000});
  const heldSpaceAction = {
    name: 'choose-right-on-release', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'east updated', peer: 'west rebound'},
  };
  expectedActions.push(heldSpaceAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Held Space release must dispatch one newly bound action with fresh data');
  await heldSpaceButton.dispose();
  checkpoints.push({step: 'held-space-keyup-after-live-action-swap',
    retainedPhysicalFocus: true, keyboardAction: heldSpaceAction});

  // A transport message may finish while the user holds Space. The native
  // keyup action must consume the complete UTF-8 model update, not the value
  // captured before keydown or a partial JSONL frame.
  const heldStreamButton = await rightSibling.elementHandle();
  assert.ok(heldStreamButton, 'Streamed Space test requires a mounted Button');
  await rightSibling.focus();
  const beforeHeldStream = expectedActions.length;
  await page.keyboard.down('Space');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeHeldStream, 'Held Space keydown must not prematurely dispatch');
  const heldStreamValue = 'east while Space held 🌐';
  const heldStreamLine = JSON.stringify({version: 'v0.9', updateDataModel: {
    surfaceId: 'action-replay', path: '/right', value: heldStreamValue,
  }}) + '\n';
  const heldStreamResult = await page.evaluate(bytes => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let carry = '';
    let applied = 0;
    let premature = false;
    for (let offset = 0; offset < bytes.length; offset += 2) {
      const end = Math.min(offset + 2, bytes.length);
      carry += decoder.decode(Uint8Array.from(bytes.slice(offset, end)),
        {stream: end < bytes.length});
      const newline = carry.indexOf('\n');
      if (newline !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (line) {
          window.__a2uiLab.applyMessage(JSON.parse(line));
          applied++;
        }
      }
      if (end < bytes.length && window.__a2uiLab.trace().data.right !== 'east updated')
        premature = true;
    }
    return {applied, carry, premature, data: window.__a2uiLab.trace().data};
  }, Array.from(new TextEncoder().encode(heldStreamLine)));
  assert.deepEqual({applied: heldStreamResult.applied, carry: heldStreamResult.carry,
    premature: heldStreamResult.premature}, {applied: 1, carry: '', premature: false},
  'Only the complete UTF-8 JSONL frame may mutate a held-key model');
  assert.deepEqual(heldStreamResult.data,
    {left: 'west rebound', right: heldStreamValue, retained: 'unchanged'},
    'Agent model must be current before the keyup action');
  assert.equal(await heldStreamButton.evaluate(node =>
    node.isConnected && document.activeElement === node), true,
  'Streamed model update must preserve native focus and the same live Button');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeHeldStream, 'Streaming during a held key must not synthesize an action');
  await page.keyboard.up('Space');
  await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
    beforeHeldStream + 1, {timeout: 5000});
  const heldStreamAction = {
    name: 'choose-right-on-release', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right',
    context: {value: heldStreamValue, peer: 'west rebound'},
  };
  expectedActions.push(heldStreamAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Native Space release must dispatch exactly one fully streamed Unicode value');
  await heldStreamButton.dispose();
  checkpoints.push({step: 'held-space-keyup-after-utf8-jsonl-model-stream',
    chunkBytes: 2, retainedPhysicalFocus: true, keyboardAction: heldStreamAction});
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/right', value: 'east updated',
    },
  }));


  // An agent can change a Button's action while its physical mouse button
  // remains down. The browser's later click must use the live handler, not
  // the event definition that existed when the pointer press began.
  const pointerRebindHandle = await rightSibling.elementHandle();
  assert.ok(pointerRebindHandle, 'Right Button must exist before held pointer rebind');
  const pointerRebindBox = await rightSibling.boundingBox();
  assert.ok(pointerRebindBox && pointerRebindBox.width > 0 && pointerRebindBox.height > 0,
    'Held-pointer target must have visible nonzero bounds');
  await page.mouse.move(pointerRebindBox.x + pointerRebindBox.width / 2,
    pointerRebindBox.y + pointerRebindBox.height / 2);
  const actionsBeforePointerRebind = expectedActions.length;
  await page.mouse.down();
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforePointerRebind, 'Physical pointer down must not dispatch a click');
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateComponents: {
      surfaceId: 'action-replay', components: [{
        id: 'pick-right', component: 'Button', child: 'pick-right-label',
        action: {event: {name: 'choose-right-on-pointer-release', context: {
          value: {path: '/right'}, peer: {path: '/left'},
        }}},
      }],
    },
  }));
  assert.equal(await pointerRebindHandle.evaluate(element => element.isConnected), true,
    'Action-only update during held pointer must preserve the pressed DOM Button');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    actionsBeforePointerRebind, 'Agent update during a held pointer must not synthesize an action');
  await page.mouse.up();
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforePointerRebind + 1, {timeout: 5000});
  const pointerReleaseAction = {
    name: 'choose-right-on-pointer-release', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'east updated', peer: 'west rebound'},
  };
  expectedActions.push(pointerReleaseAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Physical mouse release must dispatch exactly one newly bound action');
  await pointerRebindHandle.dispose();
  checkpoints.push({step: 'held-pointer-up-after-live-action-swap',
    retainedPressedDomNode: true, pointerAction: pointerReleaseAction});

  // A streaming agent model update can arrive between native pointerdown and
  // pointerup. The eventual click must resolve current data, never the model
  // that was present when the physical button was pressed.
  const modelPressHandle = await rightSibling.elementHandle();
  assert.ok(modelPressHandle, 'Right Button must exist before held-pointer model update');
  const modelPressBox = await rightSibling.boundingBox();
  assert.ok(modelPressBox && modelPressBox.width > 0 && modelPressBox.height > 0,
    'Held-pointer model-update target must have nonzero visible bounds');
  await page.mouse.move(modelPressBox.x + modelPressBox.width / 2,
    modelPressBox.y + modelPressBox.height / 2);
  const beforeHeldModelUpdate = expectedActions.length;
  await page.mouse.down();
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeHeldModelUpdate, 'Pointer down before model update must not dispatch an action');
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/right', value: 'east during press',
    },
  }));
  assert.equal(await modelPressHandle.evaluate(element => element.isConnected), true,
    'Model-only update during pointerdown must retain the pressed DOM Button');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).data,
    {left: 'west rebound', right: 'east during press', retained: 'unchanged'},
    'Model update must be visible to the action binder before pointer release');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeHeldModelUpdate, 'Streaming data update must not synthesize a Button action');
  await page.mouse.up();
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    beforeHeldModelUpdate + 1, {timeout: 5000});
  const modelPressAction = {
    name: 'choose-right-on-pointer-release', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right',
    context: {value: 'east during press', peer: 'west rebound'},
  };
  expectedActions.push(modelPressAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Pointer release must use freshly streamed model state exactly once');
  await modelPressHandle.dispose();
  checkpoints.push({step: 'held-pointer-up-after-model-stream',
    retainedPressedDomNode: true, pointerAction: modelPressAction});
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', updateDataModel: {
      surfaceId: 'action-replay', path: '/right', value: 'east updated',
    },
  }));

  // Hold both currently mounted sibling nodes: an earlier scalarButton
  // locator was already detached by the preceding component replacement.
  const mountedSiblingHandles = [
    await leftSibling.elementHandle(),
    await rightSibling.elementHandle(),
  ];
  assert.ok(mountedSiblingHandles.every(Boolean),
    'Both reordered sibling Buttons must still be mounted before surface deletion');
  // Releasing a physical pointer press after the agent deletes its Button
  // must not emit a stale click or resurrect the component.
  const pressedButtonBox = await rightSibling.boundingBox();
  assert.ok(pressedButtonBox && pressedButtonBox.width > 0 && pressedButtonBox.height > 0,
    'The live right sibling needs nonzero bounds before a physical pointer press');
  await page.mouse.move(pressedButtonBox.x + pressedButtonBox.width / 2,
    pressedButtonBox.y + pressedButtonBox.height / 2);
  const beforeInterruptedPointer = expectedActions.length;
  await page.mouse.down();
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeInterruptedPointer, 'Pointer down alone must not emit a Button click');
  // A late action after surface deletion must not target either live DOM Button.
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId: 'action-replay'},
  }));
  await leftSibling.waitFor({state: 'detached', timeout: 5000});
  await rightSibling.waitFor({state: 'detached', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 0,
    'Deleting the surface must remove both live reordered sibling Buttons');
  await page.mouse.up();
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Pointer release after deleting the pressed Button must not emit a stale action');
  checkpoints.push({step: 'pointer-up-after-pressed-surface-delete',
    deletedButtons: 2, actionCount: expectedActions.length});
  for (const handle of mountedSiblingHandles) {
    assert.equal(await handle.evaluate(element => element.isConnected), false,
      'Deleted sibling Button nodes must be physically detached from the DOM');
    await handle.dispose();
  }
  await page.keyboard.press('Enter');
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.equal(trace.data, null);
  assert.deepEqual(trace.actions, expectedActions);
  assert.deepEqual(deniedRequests, [deniedProbe],
    'Entire browser replay must not attempt any other off-origin HTTP request');
  assert.deepEqual(deniedWebSockets, [deniedSocketProbe],
    'Entire browser replay must not attempt any other off-origin WebSocket');
  assert.deepEqual(trace.errors, []);
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(consoleErrors, [],
    'Real React browser replay must not hide console.error diagnostics');
  assert.deepEqual(deniedRequests, [deniedProbe],
    'No later renderer action may require an unapproved browser HTTP(S) origin');
  checkpoints.push({step: 'deleted-surface', buttonCount: await page.getByRole('button').count(), actionCount: trace.actions.length});

  // An agent may start a second session using the deleted surface and component
  // IDs. Real Chromium must route only the new generation's model and actions.
  const actionsBeforeRecreation = expectedActions.length;
  await page.evaluate(() => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9', createSurface: {
        surfaceId: 'action-replay', catalogId: '__BASIC_CATALOG__',
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateComponents: {
        surfaceId: 'action-replay', components: [
          {id: 'root', component: 'Column', children: ['pick-right']},
          {id: 'pick-right', component: 'Button', child: 'pick-right-label',
            action: {event: {name: 'choose-right-recreated',
              context: {value: {path: '/right'}}}}},
          {id: 'pick-right-label', component: 'Text', text: 'Recreated choice'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {
        surfaceId: 'action-replay', path: '/',
        value: {right: 'second generation', retained: 'fresh'},
      },
    });
  });
  const recreatedButton = page.getByRole('button', {name: 'Recreated choice', exact: true});
  await recreatedButton.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await page.getByRole('button').count(), 1,
    'Recreating a deleted surface must mount only its new Button');
  const recreatedTrace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(recreatedTrace.surfaceIds, ['action-replay'],
    'Recreating the same surface ID must not leave a duplicate surface');
  assert.deepEqual(recreatedTrace.data, {right: 'second generation', retained: 'fresh'},
    'Recreated surface must expose only the new generation data');
  assert.equal(recreatedTrace.actions.length, actionsBeforeRecreation,
    'Recreation and model initialization must not synthesize stale actions');
  const recreatedAction = {
    name: 'choose-right-recreated', surfaceId: 'action-replay',
    sourceComponentId: 'pick-right', context: {value: 'second generation'},
  };
  await recreatedButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeRecreation + 1, {timeout: 5000});
  expectedActions.push(recreatedAction);
  await recreatedButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    actionsBeforeRecreation + 2, {timeout: 5000});
  expectedActions.push(recreatedAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Recreated Button pointer and keyboard events must use only fresh bindings');
  // Space activates a native Button on keyup. If the agent deletes the
  // focused, recreated surface while Space is held, its pending native
  // keyup must not dispatch a ghost action into the deleted generation.
  await recreatedButton.focus();
  await page.keyboard.down('Space');
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Held Space keydown must not emit a premature action');
  await page.evaluate(() => window.__a2uiLab.applyMessage({
    version: 'v0.9', deleteSurface: {surfaceId: 'action-replay'},
  }));
  await recreatedButton.waitFor({state: 'detached', timeout: 5000});
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Deleting the focused Button must not synthesize an action');
  await page.keyboard.up('Space');
  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions,
    'Space keyup after deleting the focused recreated Button must not emit a ghost action');
  assert.equal(trace.data, null, 'Second deletion must clear recreated surface model');
  assert.deepEqual(trace.surfaceIds, [], 'Second deletion must remove reused surface ID');
  assert.deepEqual(trace.actions, expectedActions, 'Second deletion must not emit stale actions');
  assert.deepEqual(trace.errors, [], 'Recreated surface must not trigger SDK errors');
  assert.deepEqual(runtimeErrors, [], 'Recreated surface must not trigger browser runtime errors');
  assert.deepEqual(consoleErrors, [], 'Recreated surface must not trigger browser console errors');
  assert.deepEqual(deniedRequests, [deniedProbe], 'Recreation must not introduce network requests');
  assert.deepEqual(deniedWebSockets, [deniedSocketProbe], 'Recreation must not open new WebSockets');
  checkpoints.push({step: 'same-id-surface-recreate-action-isolation',
    newGenerationModel: true, recreatedPointerAndKeyboard: recreatedAction,
    secondTeardownComplete: true});
  checkpoints.push({step: 'held-space-keyup-after-recreated-surface-delete',
    focusedButtonDetached: true, noGhostAction: true});

  // A pointer press can outlive an entire A2UI surface generation. If an
  // agent deletes and immediately recreates the same surface/component IDs
  // before mouseup, the release must not activate either generation.
  const beforeGenerationRace = expectedActions.length;
  await page.evaluate(() => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9', createSurface: {
        surfaceId: 'action-replay', catalogId: '__BASIC_CATALOG__',
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateComponents: {
        surfaceId: 'action-replay', components: [
          {id: 'root', component: 'Column', children: ['submit']},
          {id: 'submit', component: 'Button', child: 'label',
            action: {event: {name: 'old-generation',
              context: {value: {path: '/selection'}}}}},
          {id: 'label', component: 'Text', text: 'Retiring choice'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {
        surfaceId: 'action-replay', path: '/', value: {selection: 'retired'},
      },
    });
  });
  const retiringButton = page.getByRole('button', {name: 'Retiring choice', exact: true});
  await retiringButton.waitFor({state: 'visible', timeout: 5000});
  const retiringHandle = await retiringButton.elementHandle();
  assert.ok(retiringHandle, 'Retiring Button must exist before physical pointerdown');
  const retiringBox = await retiringButton.boundingBox();
  assert.ok(retiringBox && retiringBox.width > 0 && retiringBox.height > 0,
    'Retiring Button must have visible nonzero bounds');
  await page.mouse.move(retiringBox.x + retiringBox.width / 2,
    retiringBox.y + retiringBox.height / 2);
  await page.mouse.down();
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeGenerationRace, 'Old-generation pointerdown alone must not dispatch');
  await page.evaluate(() => {
    window.__a2uiLab.applyMessage({
      version: 'v0.9', deleteSurface: {surfaceId: 'action-replay'},
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', createSurface: {
        surfaceId: 'action-replay', catalogId: '__BASIC_CATALOG__',
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateComponents: {
        surfaceId: 'action-replay', components: [
          {id: 'root', component: 'Column', children: ['submit']},
          {id: 'submit', component: 'Button', child: 'label',
            action: {event: {name: 'new-generation',
              context: {value: {path: '/selection'}}}}},
          {id: 'label', component: 'Text', text: 'Replacement choice'},
        ],
      },
    });
    window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {
        surfaceId: 'action-replay', path: '/', value: {selection: 'fresh 🌱'},
      },
    });
  });
  const replacementGenerationButton = page.getByRole('button',
    {name: 'Replacement choice', exact: true});
  await retiringButton.waitFor({state: 'detached', timeout: 5000});
  await replacementGenerationButton.waitFor({state: 'visible', timeout: 5000});
  assert.equal(await retiringHandle.evaluate(element => element.isConnected), false,
    'Old-generation DOM Button must be physically detached');
  assert.equal(await page.getByRole('button').count(), 1,
    'Recreated generation must mount one, not two Buttons');
  assert.equal((await page.evaluate(() => window.__a2uiLab.trace())).actions.length,
    beforeGenerationRace, 'Recreation during pointerhold must not synthesize an action');
  await page.mouse.up();
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Mouseup after replacement must not activate old or new generation');
  await retiringHandle.dispose();
  await replacementGenerationButton.click({timeout: 7000});
  await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
    beforeGenerationRace + 1, {timeout: 5000});
  const generationAction = {
    name: 'new-generation', surfaceId: 'action-replay', sourceComponentId: 'submit',
    context: {value: 'fresh 🌱'},
  };
  expectedActions.push(generationAction);
  assert.deepEqual((await page.evaluate(() => window.__a2uiLab.trace())).actions,
    expectedActions, 'Fresh pointerdown/click must route only to new-generation model');
  assert.deepEqual(runtimeErrors, [], 'Generation replacement must not throw in Chromium');
  assert.deepEqual(consoleErrors, [], 'Generation replacement must not log React errors');
  checkpoints.push({step: 'pointerup-after-same-id-generation-replacement',
    noGhostAction: true, oldNodeDetached: true, newPointerAction: generationAction});

  trace = await page.evaluate(() => window.__a2uiLab.trace());
  assert.deepEqual(trace.actions, expectedActions,
    'Published replay report must include the final recreated-generation action');
  assert.deepEqual(trace.errors, [], 'Final generation must leave no SDK errors');
  assert.deepEqual(deniedRequests, [deniedProbe],
    'Recreation must not trigger off-origin HTTP requests');
  assert.deepEqual(deniedWebSockets, [deniedSocketProbe],
    'Recreation must not open off-origin WebSockets');

  const report = {
    schemaVersion: 1,
    protocol: 'v0.9',
    harness: 'real React A2uiSurface + published core Custom Elements; Playwright Chromium pointer and keyboard',
    versions: installed,
    fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    // Hash the previously captured PNG bytes; this is evidence integrity, not a pixel diff.
    screenshotSha256: createHash('sha256').update(screenshotBytes).digest('hex'),
    checkpoints,
    actions: trace.actions,
    runtimeErrors,
    consoleErrors,
    // Non-blocking observed renderer discrepancies are kept distinct from
    // functional replay failures; newer published SDKs may resolve them.
    accessibilityFindings,
    passed: true,
  };
  const {tracePath, screenshotPath} = publishBrowserEvidence(outDir, screenshotBytes, report);
  assert.equal(createHash('sha256').update(readFileSync(screenshotPath)).digest('hex'),
    report.screenshotSha256, 'Published PNG must agree with its saved browser trace digest');
  console.log('Real A2UI React Chromium: ' + checkpoints.length + ' checkpoints / ' + trace.actions.length + ' agent events / no runtime errors / PASS');
  console.log('Trace: ' + tracePath);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

// Exercise the same private-JSONL user path with real Chromium, not a mocked DOM.
const exampleMessages = JSON.parse(fixture).map(entry => entry.message);
const encodedExample = Buffer.from(exampleMessages.map(message => JSON.stringify(message)).join('\n') + '\n');
const decodedExample = decodeBrowserCapture(encodedExample);
assert.deepEqual(decodedExample, exampleMessages);
// First-observed event diagnostics must isolate a real Chromium SDK error
// without echoing caller-controlled payloads or claiming the error's cause.
assert.equal(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--report-first-error']).reportFirstError, true);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--report-first-error', '--click-single-button']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--report-first-error', '--stop-after-event-index', '1']), /Usage:/);
const firstErrorReport = await runBrowserCapture(decodedExample,
  {reportFirstError: true, surfaceErrorProbe: true});
assert.equal(firstErrorReport.firstObservedFailureEventIndex, 0,
  'A published SDK surface error at the first event must be localized');
assert.equal(firstErrorReport.kind, 'a2ui-react-capture-event-diagnostic');
assert.equal(firstErrorReport.processedEventCount, 0);
assert.doesNotMatch(JSON.stringify(firstErrorReport),
  /action-replay|alpha|Confirm|selection|surfaceId|stack|Error:/,
  'A failure-event diagnostic must not echo private values or SDK errors');
const firstErrorSuccess = await runBrowserCapture(decodedExample, {reportFirstError: true});
assert.equal(firstErrorSuccess.firstObservedFailureEventIndex, null,
  'A successful real Chromium replay has no observed failing boundary');
assert.equal(firstErrorSuccess.events, decodedExample.length);
// A later malformed programmatic event must not be confused with the first
// valid Chromium events. The public CLI rejects such a malformed JSONL upfront.
const invalidLateMessage = {version: 'v0.8', updateDataModel: {
  surfaceId: 'private-surface', path: '/private', value: 'private-content',
}};
const lateFailureReport = await runBrowserCapture([...decodedExample, invalidLateMessage],
  {reportFirstError: true});
assert.equal(lateFailureReport.firstObservedFailureEventIndex, decodedExample.length);
assert.equal(lateFailureReport.processedEventCount, decodedExample.length);
assert.doesNotMatch(JSON.stringify(lateFailureReport), /private-surface|private-content|\\/private/,
  'Later failure reports must not expose malformed event payloads');
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--report-first-error', '--report-first-error']), /Usage:/);
// A developer can isolate a failing private capture prefix without copying its
// JSONL into smaller files or activating any captured controls.
assert.equal(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--stop-after-event-index', '1']).stopAfterEventIndex, 1);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--stop-after-event-index', '01']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--stop-after-event-index', '1', '--click-single-button']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--stop-after-event-index', '1', '--action-step', '1:0:click']), /Usage:/);
const prefixCaptureReport = await runBrowserCapture(decodedExample, {stopAfterEventIndex: 1});
assert.equal(prefixCaptureReport.events, 2);
assert.deepEqual(prefixCaptureReport.steps.map(step => step.operation),
  ['createSurface', 'updateComponents']);
assert.equal(prefixCaptureReport.steps.at(-1).visibleButtonCount, 1);
assert.equal(prefixCaptureReport.actionsEmitted, 0);
assert.doesNotMatch(JSON.stringify(prefixCaptureReport),
  /action-replay|alpha|Confirm|selection|surfaceId/,
  'Prefix replay must not publish private model values or identifiers');
await assert.rejects(runBrowserCapture(decodedExample, {stopAfterEventIndex: 3}),
  {message: 'Invalid browser capture stop event index'});
await assert.rejects(runBrowserCapture(decodedExample,
  {stopAfterEventIndex: 1, clickSingleButton: true}),
  {message: 'Prefix replay cannot activate browser controls'});
assert.throws(() => decodeBrowserCapture(Buffer.from('{"version":"v0.9"}')), /Invalid browser capture/,
  'Non-newline-terminated captures must fail closed');
const browserCaptureReport = await runBrowserCapture(decodedExample, {clickSingleButton: true});
assert.equal(browserCaptureReport.kind, 'a2ui-react-capture-browser-replay');
assert.equal(browserCaptureReport.events, 3);
assert.deepEqual(browserCaptureReport.steps.map(step => step.operation),
  ['createSurface', 'updateComponents', 'updateDataModel']);
assert.equal(browserCaptureReport.steps.at(-1).surfaceCount, 1);
assert.equal(browserCaptureReport.steps.at(-1).visibleButtonCount, 1);
assert.equal(browserCaptureReport.actionsEmitted, 1,
  'One real Chromium pointer action must reach the published SDK');
assert.equal(browserCaptureReport.clickSingleButton, true);
// Inspect intermediate DOM at each agent event boundary, not just final UI.
// This is a heuristic for the published React DeferredChild debug placeholder.
// Capture-created surfaces must not silently lose published SDK onError events.
await assert.rejects(runBrowserCapture(decodedExample, {surfaceErrorProbe: true}),
  {message: 'Browser capture renderer reported surface errors'},
  'A real SDK surface error must fail closed without exposing its payload');
const loadingOptions = parseBrowserCaptureOptions(['--input', 'private.jsonl', '--inspect-loading-placeholders']);
assert.equal(loadingOptions.inspectLoadingPlaceholders, true);
const loadingReport = await runBrowserCapture(decodedExample, {inspectLoadingPlaceholders: true});
assert.ok(loadingReport.steps[0].loadingPlaceholderCount >= 1,
  'A createSurface-only frame must expose the published renderer loading placeholder');
assert.equal(loadingReport.steps.at(-1).loadingPlaceholderCount, 0,
  'After the root and children arrive there must be no loading placeholders');
assert.equal(loadingReport.loadingPlaceholderEvents, 1);
assert.doesNotMatch(JSON.stringify(loadingReport),
  /action-replay|alpha|Confirm|selection|surfaceId|Loading root/,
  'Streaming placeholder evidence must contain counts, not private DOM text or IDs');
assert.equal(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--reject-loading-placeholders']).rejectLoadingPlaceholders, true);
await assert.rejects(runBrowserCapture(decodedExample, {rejectLoadingPlaceholders: true}),
  {message: 'Browser capture displayed a transient loading placeholder'});
assert.equal(Object.hasOwn(browserCaptureReport.steps[0], 'loadingPlaceholderCount'), false,
  'Default report fields must remain backward compatible');
const keyboardCaptureReport = await runBrowserCapture(decodedExample, {pressSingleButtonEnter: true});
assert.equal(keyboardCaptureReport.actionsEmitted, 1,
  'One Tab-to-Button Enter activation must reach the real published renderer');
assert.equal(keyboardCaptureReport.pressSingleButtonEnter, true);
assert.equal(keyboardCaptureReport.keyboardFocusVerified, true);
assert.equal(keyboardCaptureReport.clickSingleButton, false);

// These two reports came from actual published React/Chromium runs above.
assert.equal(compareBrowserCaptureSummaries(browserCaptureReport,
  structuredClone(browserCaptureReport)).ok, true);
const browserModeDrift = compareBrowserCaptureSummaries(browserCaptureReport, keyboardCaptureReport);
assert.equal(browserModeDrift.ok, false);
assert.ok(browserModeDrift.changedSummaryFields.includes('keyboardFocusVerified'));
const browserButtonDrift = structuredClone(browserCaptureReport);
browserButtonDrift.steps.at(-1).visibleButtonCount++;
const browserCountDiff = compareBrowserCaptureSummaries(browserCaptureReport, browserButtonDrift);
assert.deepEqual(browserCountDiff.changedSteps,
  [{index: 2, fields: ['visibleButtonCount']}]);
assert.doesNotMatch(JSON.stringify(browserCountDiff),
  /action-replay|alpha|Confirm|selection|surfaceId/,
  'Browser differential output must be structural only');
assert.equal(parseBrowserCaptureOptions(['--input', 'private.jsonl', '--click-button-index', '0']).clickButtonIndex, 0);
assert.equal(parseBrowserCaptureOptions(['--input', 'private.jsonl', '--press-button-index-enter', '1']).pressButtonIndexEnter, 1);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl', '--click-button-index', '01']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl', '--click-button-index', '32']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--click-single-button', '--click-button-index', '0']), /Usage:/);
// A real two-Button capture exercises targeted pointer and physical keyboard input.
const twoButtonMessages = structuredClone(decodedExample);
const twoButtonComponents = twoButtonMessages[1].updateComponents.components;
twoButtonComponents.find(component => component.id === 'root').children.push('submit-second');
const secondButton = structuredClone(twoButtonComponents.find(component => component.id === 'submit'));
secondButton.id = 'submit-second';
secondButton.child = 'label-second';
secondButton.action.event.name = 'private-second-action';
twoButtonComponents.push(secondButton, {id: 'label-second', component: 'Text', text: 'Private second label'});
// Multiple user actions can be replayed in order before the next agent event.
const sameBoundaryPlan = [
  {eventIndex: 2, buttonIndex: 1, mode: 'click'},
  {eventIndex: 2, buttonIndex: 0, mode: 'enter'},
];
assert.deepEqual(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '2:1:click', '--action-step', '2:0:enter']).actionSteps, sameBoundaryPlan);
const sameBoundaryReport = await runBrowserCapture(twoButtonMessages, {actionSteps: sameBoundaryPlan});
assert.equal(sameBoundaryReport.actionsVerified, 2);
assert.equal(sameBoundaryReport.actionsEmitted, 2,
  'Two distinct real Chromium activations at one event boundary must both dispatch');
assert.equal(sameBoundaryReport.keyboardFocusVerified, true);
assert.deepEqual(sameBoundaryReport.actionSteps, sameBoundaryPlan);
assert.equal(compareBrowserCaptureSummaries(sameBoundaryReport,
  structuredClone(sameBoundaryReport)).ok, true);
assert.doesNotMatch(JSON.stringify(sameBoundaryReport),
  /private-second-action|Private second label|submit-second|selection|surfaceId/,
  'Repeated-boundary replay reports must omit private action names and labels');
// Developer-owned captures may require physical Space rather than Enter.
// This exercises a real focused Chromium Button, not synthetic DOM click().
const spaceBoundaryPlan = [
  {eventIndex: 2, buttonIndex: 1, mode: 'space'},
  {eventIndex: 2, buttonIndex: 0, mode: 'click'},
];
assert.deepEqual(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '2:1:space', '--action-step', '2:0:click']).actionSteps, spaceBoundaryPlan);
const spaceBoundaryReport = await runBrowserCapture(twoButtonMessages, {actionSteps: spaceBoundaryPlan});
assert.equal(spaceBoundaryReport.actionsVerified, 2);
assert.equal(spaceBoundaryReport.actionsEmitted, 2,
  'Chromium Space and click must each dispatch exactly one action at one boundary');
assert.equal(spaceBoundaryReport.keyboardFocusVerified, true);
assert.deepEqual(spaceBoundaryReport.actionSteps, spaceBoundaryPlan);
assert.equal(compareBrowserCaptureSummaries(spaceBoundaryReport,
  structuredClone(spaceBoundaryReport)).ok, true);
assert.doesNotMatch(JSON.stringify(spaceBoundaryReport),
  /private-second-action|Private second label|submit-second|selection|surfaceId/,
  'Space replay report must not expose private event names, labels or model values');
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '2:0:escape']), /Usage:/);
// A valid action before deletion must be testable even when no Button survives.
const timedMessages = [...structuredClone(decodedExample), {
  version: 'v0.9', deleteSurface: {surfaceId: decodedExample[0].createSurface.surfaceId},
}];
await assert.rejects(runBrowserCapture(timedMessages, {clickButtonIndex: 0}),
  {message: 'Action mode button index is outside rendered range'});
const timedPointer = await runBrowserCapture(timedMessages,
  {clickButtonIndex: 0, actionAfterEventIndex: 2});
assert.equal(timedPointer.actionsEmitted, 1);
assert.equal(timedPointer.actionAfterEventIndex, 2);
assert.equal(timedPointer.steps.at(-1).surfaceCount, 0);
assert.equal(timedPointer.steps[2].actionCount, 0);
assert.equal(timedPointer.steps[3].actionCount, 1);
const timedKeyboard = await runBrowserCapture(timedMessages,
  {pressButtonIndexEnter: 0, actionAfterEventIndex: 2});
assert.equal(timedKeyboard.actionsEmitted, 1);
assert.equal(timedKeyboard.keyboardFocusVerified, true);
// An interactive capture can include Button -> agent update -> Button -> deletion.
// Both actions must be genuine Chromium input at their own event boundaries.
const sequenceMessages = [...structuredClone(decodedExample), {
  version: 'v0.9', updateDataModel: {
    surfaceId: decodedExample[0].createSurface.surfaceId, path: '/',
    value: {selection: 'updated-between-actions', confirmed: true},
  },
}, {version: 'v0.9', deleteSurface: {surfaceId: decodedExample[0].createSurface.surfaceId}}];
const sequencePlan = [
  {eventIndex: 2, buttonIndex: 0, mode: 'click'},
  {eventIndex: 3, buttonIndex: 0, mode: 'enter'},
];
assert.deepEqual(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '2:0:click', '--action-step', '3:0:enter']).actionSteps, sequencePlan);
const sequenceReport = await runBrowserCapture(sequenceMessages, {actionSteps: sequencePlan});
assert.equal(sequenceReport.actionsEmitted, 2);
assert.equal(sequenceReport.actionsVerified, 2);
assert.deepEqual(sequenceReport.actionSteps, sequencePlan);
assert.equal(sequenceReport.keyboardFocusVerified, true);
assert.deepEqual(sequenceReport.steps.map(step => step.actionCount), [0, 0, 0, 1, 2]);
assert.equal(sequenceReport.steps.at(-1).surfaceCount, 0);
assert.doesNotMatch(JSON.stringify(sequenceReport),
  /updated-between-actions|action-replay|selection|surfaceId/,
  'A multi-action replay report must exclude values and identifiers');
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '2:0:click', '--click-button-index', '0']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '2:32:click']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-step', '02:0:enter']), /Usage:/);
await assert.rejects(runBrowserCapture(sequenceMessages,
  {actionSteps: [sequencePlan[1], sequencePlan[0]]}),
  {message: 'Invalid browser action plan'});
await assert.rejects(runBrowserCapture(sequenceMessages,
  {actionSteps: [{eventIndex: -1, buttonIndex: 0, mode: 'click'}]}),
  {message: 'Invalid browser action plan'});
await assert.rejects(runBrowserCapture(sequenceMessages,
  {actionSteps: [{eventIndex: 4, buttonIndex: 0, mode: 'click'}]}),
  {message: 'Browser capture action target was not reachable'});
await assert.rejects(runBrowserCapture(sequenceMessages,
  {actionSteps: sequencePlan, clickSingleButton: true}),
  {message: 'Choose exactly one browser action mode'});
assert.doesNotMatch(JSON.stringify(timedKeyboard),
  /action-replay|alpha|Confirm|selection|surfaceId/,
  'Timed browser evidence must not expose private capture values or IDs');
assert.equal(parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--click-button-index', '0', '--action-after-event-index', '2']).actionAfterEventIndex, 2);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--action-after-event-index', '2']), /Usage:/);
assert.throws(() => parseBrowserCaptureOptions(['--input', 'private.jsonl',
  '--click-button-index', '0', '--action-after-event-index', '100']), /Usage:/);
await assert.rejects(runBrowserCapture(timedMessages,
  {clickButtonIndex: 0, actionAfterEventIndex: timedMessages.length}),
  {message: 'Invalid browser action event index or missing action mode'});
await assert.rejects(runBrowserCapture(timedMessages, {actionAfterEventIndex: 2}),
  {message: 'Invalid browser action event index or missing action mode'});
const indexedPointerReport = await runBrowserCapture(twoButtonMessages, {clickButtonIndex: 1});
assert.equal(indexedPointerReport.steps.at(-1).visibleButtonCount, 2);
assert.equal(indexedPointerReport.actionsEmitted, 1,
  'Indexed pointer activation must emit exactly one real SDK action');
assert.equal(indexedPointerReport.clickButtonIndex, 1);
const indexedKeyboardReport = await runBrowserCapture(twoButtonMessages, {pressButtonIndexEnter: 1});
assert.equal(indexedKeyboardReport.steps.at(-1).visibleButtonCount, 2);
assert.equal(indexedKeyboardReport.actionsEmitted, 1,
  'Indexed Tab/Enter activation must emit exactly one real SDK action');
assert.equal(indexedKeyboardReport.keyboardFocusVerified, true);
assert.equal(indexedKeyboardReport.pressButtonIndexEnter, 1);
assert.doesNotMatch(JSON.stringify(indexedKeyboardReport),
  /private-second-action|Private second label|submit-second|action-replay|alpha|surfaceId/,
  'Indexed replay report must not leak private IDs, values or button labels');
await assert.rejects(runBrowserCapture(twoButtonMessages, {clickButtonIndex: 2}),
  {message: 'Action mode button index is outside rendered range'});
await assert.rejects(runBrowserCapture(twoButtonMessages, {clickButtonIndex: -1}),
  {message: 'Invalid browser button index'});
await assert.rejects(runBrowserCapture(twoButtonMessages,
  {clickButtonIndex: 1, pressButtonIndexEnter: 0}),
  {message: 'Choose exactly one browser action mode'});
assert.doesNotMatch(JSON.stringify(keyboardCaptureReport), /action-replay|alpha|Confirm|selection|surfaceId/,
  'Keyboard browser capture evidence must exclude model values and identifiers');
await assert.rejects(
  runBrowserCapture(decodedExample, {clickSingleButton: true, pressSingleButtonEnter: true}),
  {message: 'Choose exactly one browser action mode'},
  'Mutually exclusive action modes must be enforced');
assert.doesNotMatch(JSON.stringify(browserCaptureReport), /action-replay|alpha|Confirm|selection|surfaceId/,
  'A browser capture structural report must not publish model values or identifiers');
// A capture with no initial surface cannot establish a real renderer replay.
await assert.rejects(
  runBrowserCapture([{version: 'v0.9', updateDataModel: {
    surfaceId: 'unmounted', path: '/', value: {privateValue: 'do-not-echo'},
  }}]),
  {message: 'Browser capture requires a createSurface event'},
  'A partial capture that mounts no surface must not report a successful replay',
);
await assert.rejects(
  runBrowserCapture([{version: 'v0.9', createSurface: {
    surfaceId: 'custom-only', catalogId: 'unknown-custom-catalog',
  }}]),
  {message: 'Browser capture createSurface was not mounted'},
  'Unsupported custom catalogs must not produce a green Chromium replay report',
);
await assert.rejects(
  runBrowserCapture([
    {version: 'v0.9', createSurface: {
      surfaceId: 'valid-mounted', catalogId: '__BASIC_CATALOG__',
    }},
    {version: 'v0.9', updateDataModel: {
      surfaceId: 'not-created-private-id', path: '/', value: {secret: 'private-marker'},
    }},
  ]),
  {message: 'Browser capture SDK rejected an event'},
  'Published SDK exception text with private surface IDs must be redacted for programmatic callers',
);
testDirectBrowserCaptureBaseline(encodedExample, browserCaptureReport, {
  capture: Buffer.from(twoButtonMessages.map(message => JSON.stringify(message)).join('\n') + '\n'),
  report: sameBoundaryReport,
});
console.log('Developer JSONL capture -> React Chromium + real Button: PASS');
