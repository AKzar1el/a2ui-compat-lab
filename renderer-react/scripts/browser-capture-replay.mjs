#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/browser-capture-replay.mjs --input PRIVATE.jsonl [--click-single-button | --press-single-button-enter | --click-button-index N | --press-button-index-enter N] [--action-after-event-index N] [--out NEW-REPORT.json]';
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 100;
const MAX_BUTTON_INDEX = 31;
const MAX_KEYBOARD_TABS = 64;
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];

export function parseBrowserCaptureOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const parsed = {clickSingleButton: false, pressSingleButtonEnter: false,
    clickButtonIndex: null, pressButtonIndexEnter: null, actionAfterEventIndex: null};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--click-single-button' && !parsed.clickSingleButton) {
      parsed.clickSingleButton = true;
    } else if (arg === '--press-single-button-enter' && !parsed.pressSingleButtonEnter) {
      parsed.pressSingleButtonEnter = true;
    } else if ((arg === '--click-button-index' || arg === '--press-button-index-enter') &&
      /^(0|[1-9][0-9]?)$/.test(argv[i + 1] ?? '')) {
      const key = arg === '--click-button-index' ? 'clickButtonIndex' : 'pressButtonIndexEnter';
      if (parsed[key] !== null) throw new Error(USAGE);
      parsed[key] = Number(argv[++i]);
    } else if (arg === '--action-after-event-index' &&
      /^(0|[1-9][0-9]?)$/.test(argv[i + 1] ?? '') && parsed.actionAfterEventIndex === null) {
      parsed.actionAfterEventIndex = Number(argv[++i]);
    } else if ((arg === '--input' || arg === '--out') &&
      argv[i + 1] && !argv[i + 1].startsWith('--') && !parsed[arg.slice(2)]) {
      parsed[arg.slice(2)] = resolve(argv[++i]);
    } else {
      throw new Error(USAGE);
    }
  }
  const actionModes = Number(parsed.clickSingleButton) + Number(parsed.pressSingleButtonEnter) +
    Number(parsed.clickButtonIndex !== null) + Number(parsed.pressButtonIndexEnter !== null);
  if (!parsed.input || actionModes > 1 ||
      (parsed.actionAfterEventIndex !== null && actionModes !== 1) ||
      (parsed.clickButtonIndex !== null && parsed.clickButtonIndex > MAX_BUTTON_INDEX) ||
      (parsed.pressButtonIndexEnter !== null && parsed.pressButtonIndexEnter > MAX_BUTTON_INDEX))
    throw new Error(USAGE);
  return parsed;
}

/** Strictly bounded local JSONL; no network, arbitrary commands or producer keys in output. */
export function decodeBrowserCapture(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX_INPUT_BYTES ||
      raw.at(-1) !== 10)
    throw new Error('Invalid browser capture size or JSONL newline');
  const lines = [];
  let previous = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 10) continue;
    if (i - previous > MAX_LINE_BYTES || lines.length >= MAX_EVENTS)
      throw new Error('Invalid browser capture line or event count');
    lines.push(raw.subarray(previous, i));
    previous = i + 1;
  }
  let events;
  try {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    events = lines.map(line => JSON.parse(decoder.decode(line)));
  } catch {
    throw new Error('Invalid browser capture UTF-8 or JSONL');
  }
  for (const message of events) {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        message.version !== 'v0.9' ||
        OPERATIONS.filter(operation => Object.hasOwn(message, operation)).length !== 1)
      throw new Error('Invalid browser capture v0.9 message');
  }
  return events;
}

function readCapture(input) {
  try {
    const meta = statSync(input);
    if (!meta.isFile() || meta.size < 2 || meta.size > MAX_INPUT_BYTES)
      throw new Error('Invalid browser capture file');
    return decodeBrowserCapture(readFileSync(input));
  } catch {
    throw new Error('Invalid browser capture input; path and contents omitted');
  }
}

/** Replays developer-provided messages in a real published React/Chromium renderer. */
export async function runBrowserCapture(messages, {
  clickSingleButton = false, pressSingleButtonEnter = false,
  clickButtonIndex = null, pressButtonIndexEnter = null, actionAfterEventIndex = null,
} = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_EVENTS)
    throw new Error('Invalid browser capture events');
  const actionModes = Number(clickSingleButton) + Number(pressSingleButtonEnter) +
    Number(clickButtonIndex !== null) + Number(pressButtonIndexEnter !== null);
  if (actionModes > 1) throw new Error('Choose exactly one browser action mode');
  for (const index of [clickButtonIndex, pressButtonIndexEnter]) {
    if (index !== null && (!Number.isSafeInteger(index) || index < 0 || index > MAX_BUTTON_INDEX))
      throw new Error('Invalid browser button index');
  }
  if (actionAfterEventIndex !== null &&
      (!Number.isSafeInteger(actionAfterEventIndex) || actionAfterEventIndex < 0 ||
       actionAfterEventIndex >= messages.length || actionModes !== 1))
    throw new Error('Invalid browser action event index or missing action mode');
  if (!messages.some(message => message && typeof message === 'object' &&
      message.version === 'v0.9' && Object.hasOwn(message, 'createSurface')))
    throw new Error('Browser capture requires a createSurface event');
  let server;
  let browser;
  const runtimeErrors = [];
  const consoleErrors = [];
  let deniedRequests = 0;
  let deniedSockets = 0;
  try {
    server = await createServer({
      root, configFile: resolve(root, 'vite.config.mjs'),
      server: {port: 0, host: '127.0.0.1', strictPort: true},
      logLevel: 'silent',
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string' && address.port > 0);
    const origin = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({headless: true, timeout: 20000});
    const context = await browser.newContext({serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) {
        deniedRequests++;
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await context.routeWebSocket('**/*', socket => {
      if (new URL(socket.url()).origin === origin.replace(/^http:/, 'ws:')) {
        socket.connectToServer();
      } else {
        deniedSockets++;
        socket.close({code: 1008, reason: 'Offline browser capture replay'});
      }
    });
    const page = await context.newPage();
    page.on('pageerror', () => runtimeErrors.push('runtime'));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push('console');
    });
    await page.goto(origin + '/?capture=1', {waitUntil: 'domcontentloaded'});
    await page.locator('section[aria-label="Real A2UI surface"]').waitFor({state: 'attached', timeout: 10000});
    await page.waitForFunction(() => Boolean(window.__a2uiLab?.trace), null, {timeout: 10000});
    // React useEffect subscribes to surface creation after initial paint.
    await page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // A selected event boundary allows an action before a later deletion.
    const selectedIndex = clickSingleButton || pressSingleButtonEnter ? 0 :
      clickButtonIndex !== null ? clickButtonIndex : pressButtonIndexEnter;
    let keyboardFocusVerified = false;
    let actionBeforeCount = null;
    const activateButton = async () => {
      const before = (await page.evaluate(() => window.__a2uiLab.trace())).actions.length;
      const buttons = page.getByRole('button');
      const count = await buttons.count();
      if ((clickSingleButton || pressSingleButtonEnter) && count !== 1)
        throw new Error('Action mode requires exactly one rendered button');
      if (selectedIndex >= count)
        throw new Error('Action mode button index is outside rendered range');
      const selected = buttons.nth(selectedIndex);
      try {
        if (pressSingleButtonEnter || pressButtonIndexEnter !== null) {
          for (let attempt = 0; attempt < MAX_KEYBOARD_TABS; attempt++) {
            await page.keyboard.press('Tab');
            keyboardFocusVerified = await selected.evaluate(button => document.activeElement === button);
            if (keyboardFocusVerified) break;
          }
          if (!keyboardFocusVerified) throw new Error('No keyboard focus');
          await page.keyboard.press('Enter');
        } else {
          await selected.click({timeout: 7000});
        }
      } catch {
        // Playwright diagnostics may include private DOM labels/IDs.
        throw new Error('Browser capture action target was not reachable');
      }
      try {
        await page.waitForFunction(n => window.__a2uiLab.trace().actions.length === n,
          before + 1, {timeout: 5000});
      } catch {
        throw new Error('Browser capture action did not emit exactly one event');
      }
      actionBeforeCount = before;
    };
    const steps = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const operation = OPERATIONS.find(key => Object.hasOwn(message, key));
      if (message.version !== 'v0.9' || !operation)
        throw new Error('Invalid browser capture event');
      try {
        await page.evaluate(value => window.__a2uiLab.applyMessage(value), message);
      } catch {
        // SDK exception messages can embed private surface IDs or model values.
        throw new Error(operation === 'createSurface'
          ? 'Browser capture createSurface was not mounted'
          : 'Browser capture SDK rejected an event');
      }
      await page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const trace = await page.evaluate(() => window.__a2uiLab.trace());
      if (operation === 'createSurface' &&
          !trace.surfaceIds.includes(message.createSurface.surfaceId))
        throw new Error('Browser capture createSurface was not mounted');
      steps.push({
        index, operation, surfaceCount: trace.surfaceIds.length,
        visibleButtonCount: await page.getByRole('button').count(),
        actionCount: trace.actions.length,
      });
      if (runtimeErrors.length || consoleErrors.length || deniedRequests || deniedSockets)
        throw new Error('Chromium reported replay errors or denied network traffic');
      if (index === actionAfterEventIndex) await activateButton();
    }
    if (selectedIndex !== null && actionAfterEventIndex === null)
      await activateButton();
    const final = await page.evaluate(() => window.__a2uiLab.trace());
    if (runtimeErrors.length || consoleErrors.length || deniedRequests || deniedSockets)
      throw new Error('Chromium reported runtime, console or network errors');
    if (selectedIndex !== null && final.actions.length !== actionBeforeCount + 1)
      throw new Error('Expected exactly one browser action');
    return {
      schemaVersion: 1,
      kind: 'a2ui-react-capture-browser-replay',
      protocol: 'v0.9',
      renderer: '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0',
      events: messages.length,
      steps,
      clickSingleButton,
      pressSingleButtonEnter,
      clickButtonIndex,
      pressButtonIndexEnter,
      actionAfterEventIndex,
      keyboardFocusVerified,
      actionsEmitted: final.actions.length,
      note: 'Real local Chromium renderer; counts/operation order only, not anonymity or SDK parity',
    };
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}

function saveReport(path, content) {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, content, {flag: 'wx'});
  } catch {
    throw new Error('Cannot write browser capture report; path omitted or already exists');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseBrowserCaptureOptions(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      const report = await runBrowserCapture(readCapture(args.input),
        {clickSingleButton: args.clickSingleButton, pressSingleButtonEnter: args.pressSingleButtonEnter,
          clickButtonIndex: args.clickButtonIndex, pressButtonIndexEnter: args.pressButtonIndexEnter,
          actionAfterEventIndex: args.actionAfterEventIndex});
      const json = JSON.stringify(report, null, 2) + '\n';
      if (args.out) saveReport(args.out, json);
      else process.stdout.write(json);
    }
  } catch {
    // SDK errors and browser diagnostics can quote private model values.
    console.error('A2UI browser capture replay refused; input paths and contents omitted');
    process.exitCode = 2;
  }
}
