#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/browser-capture-replay.mjs --input PRIVATE.jsonl [--click-single-button] [--out NEW-REPORT.json]';
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 100;
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];

function options(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const parsed = {clickSingleButton: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--click-single-button' && !parsed.clickSingleButton) {
      parsed.clickSingleButton = true;
    } else if ((arg === '--input' || arg === '--out') &&
      argv[i + 1] && !argv[i + 1].startsWith('--') && !parsed[arg.slice(2)]) {
      parsed[arg.slice(2)] = resolve(argv[++i]);
    } else {
      throw new Error(USAGE);
    }
  }
  if (!parsed.input) throw new Error(USAGE);
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
export async function runBrowserCapture(messages, {clickSingleButton = false} = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_EVENTS)
    throw new Error('Invalid browser capture events');
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
    }
    const before = (await page.evaluate(() => window.__a2uiLab.trace())).actions.length;
    if (clickSingleButton) {
      const buttons = page.getByRole('button');
      if (await buttons.count() !== 1)
        throw new Error('Click mode requires exactly one rendered button');
      await buttons.first().click({timeout: 7000});
      await page.waitForFunction(count => window.__a2uiLab.trace().actions.length === count,
        before + 1, {timeout: 5000});
    }
    const final = await page.evaluate(() => window.__a2uiLab.trace());
    if (runtimeErrors.length || consoleErrors.length || deniedRequests || deniedSockets)
      throw new Error('Chromium reported runtime, console or network errors');
    if (clickSingleButton && final.actions.length !== before + 1)
      throw new Error('Expected exactly one browser action');
    return {
      schemaVersion: 1,
      kind: 'a2ui-react-capture-browser-replay',
      protocol: 'v0.9',
      renderer: '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0',
      events: messages.length,
      steps,
      clickSingleButton,
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
    const args = options(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      const report = await runBrowserCapture(readCapture(args.input),
        {clickSingleButton: args.clickSingleButton});
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
