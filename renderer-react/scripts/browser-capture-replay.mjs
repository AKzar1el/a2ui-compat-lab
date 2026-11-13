#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/browser-capture-replay.mjs --input PRIVATE.jsonl [--click-single-button | --press-single-button-enter | --click-button-index N | --press-button-index-enter N] [--action-after-event-index N | --action-step EVENT:BUTTON:click|enter|space ... | --stop-after-event-index N] [--report-first-error] [--inspect-loading-placeholders | --reject-loading-placeholders] [--out NEW-REPORT.json]';
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 100;
const MAX_BUTTON_INDEX = 31;
const MAX_ACTION_STEPS = 8;
const MAX_KEYBOARD_TABS = 64;
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];

// JSON object member insertion order is not action semantics. Sort nested
// object keys before ephemeral parity HMACs; preserve action/array order.
function canonicalActionJSON(value) {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.keys(nested).sort().map(key => [key, nested[key]]))
      : nested);
}

export function parseBrowserCaptureOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const parsed = {clickSingleButton: false, pressSingleButtonEnter: false,
    clickButtonIndex: null, pressButtonIndexEnter: null, actionAfterEventIndex: null,
    actionSteps: [], stopAfterEventIndex: null, reportFirstError: false, inspectLoadingPlaceholders: false, rejectLoadingPlaceholders: false,
    internalActionDigest: false};
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
    } else if (arg === '--stop-after-event-index' &&
      /^(0|[1-9][0-9]?)$/.test(argv[i + 1] ?? '') && parsed.stopAfterEventIndex === null) {
      parsed.stopAfterEventIndex = Number(argv[++i]);
    } else if (arg === '--action-step' &&
      /^(0|[1-9][0-9]?):(0|[1-9][0-9]?):(click|enter|space)$/.test(argv[i + 1] ?? '')) {
      const [, eventIndex, buttonIndex, mode] =
        argv[++i].match(/^(0|[1-9][0-9]?):(0|[1-9][0-9]?):(click|enter|space)$/);
      parsed.actionSteps.push({eventIndex: Number(eventIndex), buttonIndex: Number(buttonIndex), mode});
    } else if (arg === '--internal-action-digest' && !parsed.internalActionDigest) {
      // Internal one-run transport: only the comparator injects a fresh key.
      parsed.internalActionDigest = true;
    } else if (arg === '--report-first-error' && !parsed.reportFirstError) {
      parsed.reportFirstError = true;
    } else if (arg === '--inspect-loading-placeholders' && !parsed.inspectLoadingPlaceholders) {
      parsed.inspectLoadingPlaceholders = true;
    } else if (arg === '--reject-loading-placeholders' && !parsed.rejectLoadingPlaceholders) {
      parsed.rejectLoadingPlaceholders = true;
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
      (parsed.pressButtonIndexEnter !== null && parsed.pressButtonIndexEnter > MAX_BUTTON_INDEX) ||
      parsed.actionSteps.length > MAX_ACTION_STEPS ||
      (parsed.actionSteps.length > 0 && (actionModes !== 0 || parsed.actionAfterEventIndex !== null)) ||
      (parsed.stopAfterEventIndex !== null &&
        (actionModes !== 0 || parsed.actionSteps.length > 0 || parsed.actionAfterEventIndex !== null)) ||
      (parsed.reportFirstError && (actionModes !== 0 || parsed.actionSteps.length > 0 ||
        parsed.stopAfterEventIndex !== null || parsed.actionAfterEventIndex !== null ||
        parsed.inspectLoadingPlaceholders || parsed.rejectLoadingPlaceholders || parsed.internalActionDigest)) ||
      parsed.actionSteps.some((step, i) => step.buttonIndex > MAX_BUTTON_INDEX ||
        (i > 0 && step.eventIndex < parsed.actionSteps[i - 1].eventIndex)))
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
  actionSteps = [], stopAfterEventIndex = null, reportFirstError = false,
  inspectLoadingPlaceholders = false, rejectLoadingPlaceholders = false,
  actionDigestKey = null, surfaceErrorProbe = false,
} = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_EVENTS)
    throw new Error('Invalid browser capture events');
  if (actionDigestKey !== null && !/^[a-f0-9]{64}$/.test(actionDigestKey))
    throw new Error('Invalid internal action digest key');
  if (typeof reportFirstError !== 'boolean')
    throw new Error('Invalid first-error reporting mode');
  if (typeof surfaceErrorProbe !== 'boolean')
    throw new Error('Invalid internal surface error probe');
  const actionModes = Number(clickSingleButton) + Number(pressSingleButtonEnter) +
    Number(clickButtonIndex !== null) + Number(pressButtonIndexEnter !== null);
  if (!Array.isArray(actionSteps) || actionSteps.length > MAX_ACTION_STEPS ||
      actionSteps.some((step, index) => !step || typeof step !== 'object' ||
        Array.isArray(step) || Object.keys(step).sort().join(',') !== 'buttonIndex,eventIndex,mode' ||
        !Number.isSafeInteger(step.eventIndex) || step.eventIndex < 0 ||
        step.eventIndex >= messages.length || !Number.isSafeInteger(step.buttonIndex) ||
        step.buttonIndex < 0 || step.buttonIndex > MAX_BUTTON_INDEX ||
        !['click', 'enter', 'space'].includes(step.mode) ||
        (index > 0 && step.eventIndex < actionSteps[index - 1].eventIndex)) ||
      (actionSteps.length > 0 && actionAfterEventIndex !== null))
    throw new Error('Invalid browser action plan');
  if (actionModes > 1 || (actionSteps.length > 0 && actionModes !== 0))
    throw new Error('Choose exactly one browser action mode');
  for (const index of [clickButtonIndex, pressButtonIndexEnter]) {
    if (index !== null && (!Number.isSafeInteger(index) || index < 0 || index > MAX_BUTTON_INDEX))
      throw new Error('Invalid browser button index');
  }
  if (actionAfterEventIndex !== null &&
      (!Number.isSafeInteger(actionAfterEventIndex) || actionAfterEventIndex < 0 ||
       actionAfterEventIndex >= messages.length || actionModes !== 1))
    throw new Error('Invalid browser action event index or missing action mode');
  if (stopAfterEventIndex !== null &&
      (!Number.isSafeInteger(stopAfterEventIndex) || stopAfterEventIndex < 0 ||
       stopAfterEventIndex >= messages.length))
    throw new Error('Invalid browser capture stop event index');
  if (stopAfterEventIndex !== null &&
      (actionModes !== 0 || actionSteps.length > 0 || actionAfterEventIndex !== null))
    throw new Error('Prefix replay cannot activate browser controls');
  if (reportFirstError && (actionModes !== 0 || actionSteps.length > 0 ||
      stopAfterEventIndex !== null || actionAfterEventIndex !== null ||
      inspectLoadingPlaceholders || rejectLoadingPlaceholders || actionDigestKey !== null))
    throw new Error('Error-event diagnostics cannot activate controls or combine replay modes');
  const replayedMessages = stopAfterEventIndex === null
    ? messages : messages.slice(0, stopAfterEventIndex + 1);
  if (!replayedMessages.some(message => message && typeof message === 'object' &&
      message.version === 'v0.9' && Object.hasOwn(message, 'createSurface')))
    throw new Error('Browser capture requires a createSurface event');
  let server;
  let browser;
  const runtimeErrors = [];
  const consoleErrors = [];
  let deniedRequests = 0;
  let deniedSockets = 0;
  let currentEventIndex = null;
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
    await page.goto(origin + '/?capture=1' +
      (surfaceErrorProbe ? '&surface-error-probe=1' : ''), {waitUntil: 'domcontentloaded'});
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
    let actionsVerified = 0;
    const activateButton = async (
      targetIndex = selectedIndex,
      keyboardKey = (pressSingleButtonEnter || pressButtonIndexEnter !== null) ? 'Enter' : null,
      scripted = false,
    ) => {
      const before = (await page.evaluate(() => window.__a2uiLab.trace())).actions.length;
      const buttons = page.getByRole('button');
      const count = await buttons.count();
      if ((clickSingleButton || pressSingleButtonEnter) && count !== 1)
        throw new Error('Action mode requires exactly one rendered button');
      if (targetIndex >= count)
        throw new Error(scripted ? 'Browser capture action target was not reachable' :
          'Action mode button index is outside rendered range');
      const selected = buttons.nth(targetIndex);
      try {
        if (keyboardKey) {
          for (let attempt = 0; attempt < MAX_KEYBOARD_TABS; attempt++) {
            await page.keyboard.press('Tab');
            keyboardFocusVerified = await selected.evaluate(button => document.activeElement === button);
            if (keyboardFocusVerified) break;
          }
          if (!keyboardFocusVerified) throw new Error('No keyboard focus');
          await page.keyboard.press(keyboardKey);
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
      actionsVerified++;
    };
    const steps = [];
    const trackLoadingPlaceholders = inspectLoadingPlaceholders || rejectLoadingPlaceholders;
    let loadingPlaceholderEvents = 0;
    for (let index = 0; index < replayedMessages.length; index++) {
      currentEventIndex = index;
      const message = replayedMessages[index];
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
      if (trace.errors.length > 0)
        throw new Error('Browser capture renderer reported surface errors');
      if (operation === 'createSurface' &&
          !trace.surfaceIds.includes(message.createSurface.surfaceId))
        throw new Error('Browser capture createSurface was not mounted');
      if (actionSteps.length > 0 && trace.actions.length !== actionsVerified)
        throw new Error('Unexpected Chromium action between planned steps');
      // Count only visible leaf-level React loading placeholders, never their
      // producer-controlled text or IDs. This is a heuristic, not a catalog parser.
      const loadingPlaceholderCount = trackLoadingPlaceholders ? await page.evaluate(() => {
        const surface = document.querySelector('section[aria-label="Real A2UI surface"]');
        if (!surface) return 0;
        return [...surface.querySelectorAll('div')].filter(node =>
          node.childElementCount === 0 && node.getClientRects().length > 0 &&
          /^\[Loading [^\[\]\r\n]{1,128}\.\.\.\]$/.test(node.textContent?.trim() ?? '')).length;
      }) : null;
      if (loadingPlaceholderCount > 0) loadingPlaceholderEvents++;
      steps.push({
        ...(trackLoadingPlaceholders ? {loadingPlaceholderCount} : {}),
        index, operation, surfaceCount: trace.surfaceIds.length,
        visibleButtonCount: await page.getByRole('button').count(),
        actionCount: trace.actions.length,
      });
      if (runtimeErrors.length || consoleErrors.length || deniedRequests || deniedSockets)
        throw new Error('Chromium reported replay errors or denied network traffic');
      if (rejectLoadingPlaceholders && loadingPlaceholderCount > 0)
        throw new Error('Browser capture displayed a transient loading placeholder');
      // Preserve the supplied order when multiple user actions share a single agent boundary.
      const scriptedActions = actionSteps.filter(step => step.eventIndex === index);
      for (const scriptedAction of scriptedActions)
        await activateButton(scriptedAction.buttonIndex,
          scriptedAction.mode === 'click' ? null : scriptedAction.mode === 'enter' ? 'Enter' : 'Space',
          true);
      if (!scriptedActions.length && index === actionAfterEventIndex) await activateButton();
    }
    currentEventIndex = null;
    if (selectedIndex !== null && actionAfterEventIndex === null)
      await activateButton();
    const final = await page.evaluate(() => window.__a2uiLab.trace());
    if (final.errors.length > 0)
      throw new Error('Browser capture renderer reported surface errors');
    if (runtimeErrors.length || consoleErrors.length || deniedRequests || deniedSockets)
      throw new Error('Chromium reported runtime, console or network errors');
    if (selectedIndex !== null && final.actions.length !== actionBeforeCount + 1)
      throw new Error('Expected exactly one browser action');
    if (actionSteps.length > 0 && final.actions.length !== actionsVerified)
      throw new Error('Expected exactly one browser action per planned step');
    return {
      schemaVersion: 1,
      kind: 'a2ui-react-capture-browser-replay',
      protocol: 'v0.9',
      renderer: '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0',
      events: replayedMessages.length,
      steps,
      ...(trackLoadingPlaceholders ? {loadingPlaceholderEvents} : {}),
      clickSingleButton,
      pressSingleButtonEnter,
      clickButtonIndex,
      pressButtonIndexEnter,
      actionAfterEventIndex,
      actionSteps,
      actionsVerified,
      keyboardFocusVerified,
      actionsEmitted: final.actions.length,
      // Never persist or publish this digest; the parent drops it before report validation.
      ...(actionDigestKey ? {
        __privateActionDigest: createHmac('sha256', Buffer.from(actionDigestKey, 'hex'))
          .update(canonicalActionJSON(final.actions)).digest('hex'),
        // Transient keyed digests locate action drift; the parent discards them.
        __privateActionDigests: final.actions.map(action =>
          createHmac('sha256', Buffer.from(actionDigestKey, 'hex'))
            .update(canonicalActionJSON(action)).digest('hex')),
      } : {}),
      ...(reportFirstError ? {firstObservedFailureEventIndex: null} : {}),
      note: 'Real local Chromium renderer; counts/operation order only, not anonymity or SDK parity',
    };
  } catch (error) {
    if (!reportFirstError || currentEventIndex === null) throw error;
    // The index is where failure was observed, not proof this message caused it.
    // Never serialize browser exceptions, SDK data, surface IDs or input paths.
    return {
      schemaVersion: 1,
      kind: 'a2ui-react-capture-event-diagnostic',
      protocol: 'v0.9',
      renderer: '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0',
      events: messages.length,
      processedEventCount: currentEventIndex,
      firstObservedFailureEventIndex: currentEventIndex,
      note: 'First observed failure event, not proven cause; structural metadata is not anonymized',
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
      const digestKey = args.internalActionDigest ? process.env.A2UI_PRIVATE_ACTION_DIGEST_KEY : null;
      if (args.internalActionDigest && (args.out || !/^[a-f0-9]{64}$/.test(digestKey ?? '')))
        throw new Error('Internal action digest must be pipe-only with a valid ephemeral key');
      const report = await runBrowserCapture(readCapture(args.input),
        {clickSingleButton: args.clickSingleButton, pressSingleButtonEnter: args.pressSingleButtonEnter,
          clickButtonIndex: args.clickButtonIndex, pressButtonIndexEnter: args.pressButtonIndexEnter,
          actionAfterEventIndex: args.actionAfterEventIndex, actionSteps: args.actionSteps,
          stopAfterEventIndex: args.stopAfterEventIndex, reportFirstError: args.reportFirstError,
          inspectLoadingPlaceholders: args.inspectLoadingPlaceholders,
          rejectLoadingPlaceholders: args.rejectLoadingPlaceholders,
          actionDigestKey: digestKey});
      const json = JSON.stringify(report, null, 2) + '\n';
      if (args.out) saveReport(args.out, json);
      else process.stdout.write(json);
      if (args.reportFirstError && report.firstObservedFailureEventIndex !== null)
        process.exitCode = 1;
    }
  } catch {
    // SDK errors and browser diagnostics can quote private model values.
    console.error('A2UI browser capture replay refused; input paths and contents omitted');
    process.exitCode = 2;
  }
}
