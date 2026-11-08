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
