#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {startHarnessServer} from './harness-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/browser-capture-replay.mjs --input PRIVATE.jsonl [--input-format jsonl|copilotkit-operations|websocket-frames|websocket-transcript] [--accept-v091] [--compat-copilotkit-basic-catalog] [--expect-client-action-frame PRIVATE.json] [--compare-client-data-model] [--click-single-button | --press-single-button-enter | --click-button-index N | --press-button-index-enter N] [--action-after-event-index N | --action-step EVENT:BUTTON:click|enter|space ... | --stop-after-event-index N] [--report-first-error] [--inspect-loading-placeholders | --reject-loading-placeholders] [--out NEW-REPORT.json]';
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 100;
const MAX_BUTTON_INDEX = 31;
const MAX_ACTION_STEPS = 8;
const MAX_RENDERED_TEXT_BYTES = 128 * 1024;
const MAX_KEYBOARD_TABS = 64;
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];
// CopilotKit's pinned Python helper default differs from the published v0.14 basic catalog ID.
const COPILOTKIT_BASIC_CATALOG = 'https://a2ui.org/specification/v0_9/basic_catalog.json';
const PUBLISHED_BASIC_CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

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
  const parsed = {inputFormat: null, clickSingleButton: false, pressSingleButtonEnter: false,
    clickButtonIndex: null, pressButtonIndexEnter: null, actionAfterEventIndex: null,
    actionSteps: [], stopAfterEventIndex: null, reportFirstError: false, inspectLoadingPlaceholders: false, rejectLoadingPlaceholders: false,
    internalActionDigest: false, internalRenderedTextDigest: false,
    internalButtonStateDigest: false, internalButtonA11yDigest: false,
    internalButtonFocusDigest: false, internalButtonGeometryDigest: false,
    compatCopilotkitBasicCatalog: false, acceptV091: false,
    expectClientActionFrame: null, compareClientDataModel: false};
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
    } else if (arg === '--internal-rendered-text-digest' && !parsed.internalRenderedTextDigest) {
      parsed.internalRenderedTextDigest = true;
    } else if (arg === '--internal-button-state-digest' && !parsed.internalButtonStateDigest) {
      parsed.internalButtonStateDigest = true;
    } else if (arg === '--internal-button-a11y-digest' && !parsed.internalButtonA11yDigest) {
      parsed.internalButtonA11yDigest = true;
    } else if (arg === '--internal-button-focus-digest' && !parsed.internalButtonFocusDigest) {
      parsed.internalButtonFocusDigest = true;
    } else if (arg === '--internal-button-geometry-digest' && !parsed.internalButtonGeometryDigest) {
      parsed.internalButtonGeometryDigest = true;
    } else if (arg === '--report-first-error' && !parsed.reportFirstError) {
      parsed.reportFirstError = true;
    } else if (arg === '--inspect-loading-placeholders' && !parsed.inspectLoadingPlaceholders) {
      parsed.inspectLoadingPlaceholders = true;
    } else if (arg === '--reject-loading-placeholders' && !parsed.rejectLoadingPlaceholders) {
      parsed.rejectLoadingPlaceholders = true;
    } else if (arg === '--compat-copilotkit-basic-catalog' && !parsed.compatCopilotkitBasicCatalog) {
      parsed.compatCopilotkitBasicCatalog = true;
    } else if (arg === '--accept-v091' && !parsed.acceptV091) {
      parsed.acceptV091 = true;
    } else if (arg === '--input-format' && parsed.inputFormat === null &&
      ['jsonl', 'copilotkit-operations', 'websocket-frames', 'websocket-transcript'].includes(argv[i + 1])) {
      parsed.inputFormat = argv[++i];
    } else if (arg === '--compare-client-data-model' && !parsed.compareClientDataModel) {
      parsed.compareClientDataModel = true;
    } else if (arg === '--expect-client-action-frame' && parsed.expectClientActionFrame === null &&
      argv[i + 1] && !argv[i + 1].startsWith('--')) {
      parsed.expectClientActionFrame = resolve(argv[++i]);
    } else if ((arg === '--input' || arg === '--out') &&
      argv[i + 1] && !argv[i + 1].startsWith('--') && !parsed[arg.slice(2)]) {
      parsed[arg.slice(2)] = resolve(argv[++i]);
    } else {
      throw new Error(USAGE);
    }
  }
  parsed.inputFormat ??= 'jsonl';
  const actionModes = Number(parsed.clickSingleButton) + Number(parsed.pressSingleButtonEnter) +
    Number(parsed.clickButtonIndex !== null) + Number(parsed.pressButtonIndexEnter !== null);
  if (!parsed.input || actionModes > 1 ||
       (parsed.compatCopilotkitBasicCatalog && parsed.inputFormat !== 'copilotkit-operations') ||
       (parsed.acceptV091 && !['jsonl', 'websocket-frames', 'websocket-transcript'].includes(parsed.inputFormat)) ||
      (parsed.actionAfterEventIndex !== null && actionModes !== 1) ||
      (parsed.clickButtonIndex !== null && parsed.clickButtonIndex > MAX_BUTTON_INDEX) ||
      (parsed.pressButtonIndexEnter !== null && parsed.pressButtonIndexEnter > MAX_BUTTON_INDEX) ||
      (parsed.compareClientDataModel && parsed.expectClientActionFrame === null &&
        parsed.inputFormat !== 'websocket-transcript') ||
      (parsed.inputFormat === 'websocket-transcript' &&
        (!parsed.acceptV091 || (actionModes !== 1 && parsed.actionSteps.length === 0) ||
          parsed.expectClientActionFrame !== null || parsed.actionAfterEventIndex !== null ||
          parsed.reportFirstError ||
          parsed.stopAfterEventIndex !== null)) ||
      (parsed.expectClientActionFrame !== null &&
        (parsed.inputFormat !== 'websocket-frames' || actionModes !== 1 ||
          parsed.actionSteps.length > 0 || parsed.reportFirstError ||
          parsed.stopAfterEventIndex !== null)) ||
      parsed.actionSteps.length > MAX_ACTION_STEPS ||
      (parsed.actionSteps.length > 0 && (actionModes !== 0 || parsed.actionAfterEventIndex !== null)) ||
      (parsed.stopAfterEventIndex !== null &&
        (actionModes !== 0 || parsed.actionSteps.length > 0 || parsed.actionAfterEventIndex !== null)) ||
      (parsed.reportFirstError && (actionModes !== 0 || parsed.actionSteps.length > 0 ||
        parsed.stopAfterEventIndex !== null || parsed.actionAfterEventIndex !== null ||
        parsed.inspectLoadingPlaceholders || parsed.rejectLoadingPlaceholders ||
        parsed.internalActionDigest ||
        parsed.internalButtonStateDigest || parsed.internalButtonA11yDigest)) ||
      parsed.actionSteps.some((step, i) => step.buttonIndex > MAX_BUTTON_INDEX ||
        (i > 0 && step.eventIndex < parsed.actionSteps[i - 1].eventIndex)))
    throw new Error(USAGE);
  return parsed;
}

/** Strictly bounded local JSONL; no network, arbitrary commands or producer keys in output. */
// Explicit compatibility lane: published core 0.14 processes v0.9.1 messages,
// but the lab defaults to exact v0.9 capture validation.
const supportedCaptureVersion = (version, acceptV091 = false) =>
  version === 'v0.9' || (acceptV091 && version === 'v0.9.1');

export function decodeBrowserCapture(raw, acceptV091 = false) {
  if (typeof acceptV091 !== 'boolean') throw new Error('Invalid browser capture version option');
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
        !supportedCaptureVersion(message.version, acceptV091) ||
        OPERATIONS.filter(operation => Object.hasOwn(message, operation)).length !== 1)
      throw new Error('Invalid browser capture v0.9 message');
  }
  return events;
}

/** The public CopilotKit Python helper's saved v0.9 tool-result envelope.
 * In-memory normalization shares the strict existing JSONL browser validator. */
export function decodeCopilotKitBrowserCapture(raw, compatBasicCatalog = false) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX_INPUT_BYTES)
    throw new Error('Invalid CopilotKit browser capture size');
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
  } catch {
    throw new Error('Invalid CopilotKit browser capture encoding or JSON');
  }
  const messages = envelope?.a2ui_operations;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).length !== 1 || !Array.isArray(messages) ||
      messages.length < 1 || messages.length > MAX_EVENTS)
    throw new Error('Invalid CopilotKit browser capture envelope');
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        message.version !== 'v0.9' || Object.keys(message).length !== 2 ||
        OPERATIONS.filter(operation => Object.hasOwn(message, operation)).length !== 1 ||
        !OPERATIONS.some(operation => Object.hasOwn(message, operation) &&
          message[operation] && typeof message[operation] === 'object' &&
          !Array.isArray(message[operation])))
      throw new Error('Invalid CopilotKit browser capture operation');
  }
  // Change only the single documented producer default, only with opt-in,
  // and never modify the caller's captured input or other catalog identifiers.
  const replayMessages = compatBasicCatalog ? messages.map(message =>
    message.createSurface?.catalogId === COPILOTKIT_BASIC_CATALOG ?
      {...message, createSurface: {...message.createSurface, catalogId: PUBLISHED_BASIC_CATALOG}} : message) : messages;
  return decodeBrowserCapture(Buffer.from(replayMessages.map(message => JSON.stringify(message)).join('\n') + '\n'));
}

/** Server-to-client frames from the independent Go/React WebSocket producer.
 * This is an explicit transport import, not a network connection or a claim
 * that the producer's complete live application was executed here. */
export function decodeWebSocketBrowserCapture(raw, acceptV091 = false) {
  if (typeof acceptV091 !== 'boolean' || !Buffer.isBuffer(raw) ||
      raw.length < 2 || raw.length > MAX_INPUT_BYTES || raw.at(-1) !== 10)
    throw new Error('Invalid A2UI WebSocket capture size or option');
  const messages = [];
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let frameStart = 0;
  let frames = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 10) continue;
    if (i - frameStart > MAX_LINE_BYTES || ++frames > MAX_EVENTS * 2 + 2)
      throw new Error('Invalid A2UI WebSocket capture frame limit');
    let frame;
    try {
      frame = JSON.parse(decoder.decode(raw.subarray(frameStart, i)));
    } catch {
      throw new Error('Invalid A2UI WebSocket capture encoding or JSON');
    }
    frameStart = i + 1;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
        Object.keys(frame).length !== 2)
      throw new Error('Invalid A2UI WebSocket server frame');
    if (frame.kind === 'status' && ['thinking', 'idle'].includes(frame.state)) continue;
    if (frame.kind !== 'a2ui' || !frame.message ||
        typeof frame.message !== 'object' || Array.isArray(frame.message) ||
        messages.length >= MAX_EVENTS)
      throw new Error('Invalid A2UI WebSocket server frame');
    messages.push(frame.message);
  }
  if (!messages.length) throw new Error('Invalid A2UI WebSocket capture: no A2UI messages');
  // Reuse the exact existing JSONL and protocol validation. No private
  // values or server-provided error messages enter diagnostics.
  return decodeBrowserCapture(Buffer.from(messages.map(message =>
    JSON.stringify(message)).join('\n') + '\n'), acceptV091);
}

/** Developer-owned Go WebSocket transcript, with up to eight action turns.
 * Each outbound action follows server A2UI messages and receives a server
 * follow-up before the next action. This does not execute the Go producer. */
export function decodeWebSocketBrowserTranscript(raw, acceptV091 = false, includeDataModel = false) {
  if (acceptV091 !== true || typeof includeDataModel !== 'boolean' ||
      !Buffer.isBuffer(raw) || raw.length < 2 ||
      raw.length > MAX_INPUT_BYTES || raw.at(-1) !== 10)
    throw new Error('Invalid A2UI WebSocket transcript size or options');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const serverFrames = [];
  const actionFrames = [];
  let frameStart = 0;
  let frameCount = 0;
  let serverMessages = 0;
  let postActionMessages = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 10) continue;
    if (i - frameStart > MAX_LINE_BYTES || ++frameCount > MAX_EVENTS * 2 + MAX_ACTION_STEPS + 2)
      throw new Error('Invalid A2UI WebSocket transcript frame limit');
    const line = raw.subarray(frameStart, i);
    const serverLine = raw.subarray(frameStart, i + 1);
    frameStart = i + 1;
    let frame;
    try {
      frame = JSON.parse(decoder.decode(line));
    } catch {
      throw new Error('Invalid A2UI WebSocket transcript encoding or JSON');
    }
    if (frame?.kind === 'action') {
      if (serverMessages === 0 || actionFrames.length >= MAX_ACTION_STEPS ||
          (actionFrames.length > 0 && postActionMessages === 0))
        throw new Error('Invalid A2UI WebSocket transcript action ordering');
      const expected = decodeExpectedClientActionFrame(line, true, includeDataModel);
      actionFrames.push({
        actionAfterEventIndex: serverMessages - 1,
        expectedAction: includeDataModel ? expected.action : expected,
        expectedDataModel: includeDataModel ? expected.dataModel : undefined,
      });
      postActionMessages = 0;
      continue;
    }
    if (frame?.kind === 'a2ui') {
      serverMessages++;
      if (actionFrames.length > 0) postActionMessages++;
    }
    serverFrames.push(serverLine);
  }
  if (!actionFrames.length || postActionMessages === 0)
    throw new Error('Invalid A2UI WebSocket transcript: missing action or follow-up');
  // Reuse strict server/protocol validation; no private model or action
  // contents leave the comparison process.
  const messages = decodeWebSocketBrowserCapture(Buffer.concat(serverFrames), true);
  const single = actionFrames.length === 1 ? actionFrames[0] : null;
  return {
    messages, actionFrames,
    actionAfterEventIndex: single?.actionAfterEventIndex ?? null,
    expectedAction: single?.expectedAction ?? null,
    expectedDataModel: single?.expectedDataModel,
  };
}

/** An outbound Go client action is private, bounded comparison evidence only.
 * Compare only stable action fields by default. The optional full dataModel
 * parity remains in memory and does not execute a live backend turn. */
export function decodeExpectedClientActionFrame(raw, acceptV091 = false, includeDataModel = false) {
  if (typeof acceptV091 !== 'boolean' || typeof includeDataModel !== 'boolean' || !Buffer.isBuffer(raw) ||
      raw.length < 2 || raw.length > MAX_LINE_BYTES)
    throw new Error('Invalid expected client action frame size');
  let frame;
  try {
    frame = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
  } catch {
    throw new Error('Invalid expected client action frame encoding or JSON');
  }
  const message = frame?.message;
  const action = message?.action;
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
      frame.kind !== 'action' ||
      (includeDataModel && !Object.hasOwn(frame, 'dataModel')) ||
      Object.keys(frame).some(key => !['kind', 'message', 'dataModel'].includes(key)) ||
      !message || typeof message !== 'object' || Array.isArray(message) ||
      Object.keys(message).sort().join(',') !== 'action,version' ||
      !supportedCaptureVersion(message.version, acceptV091) ||
      !action || typeof action !== 'object' || Array.isArray(action) ||
      typeof action.name !== 'string' || !action.name ||
      typeof action.surfaceId !== 'string' || !action.surfaceId ||
      typeof action.sourceComponentId !== 'string' || !action.sourceComponentId ||
      !action.context || typeof action.context !== 'object' || Array.isArray(action.context) ||
      Object.keys(action).some(key =>
        !['name', 'surfaceId', 'sourceComponentId', 'context', 'timestamp'].includes(key)) ||
      (Object.hasOwn(action, 'timestamp') &&
        (typeof action.timestamp !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(action.timestamp) ||
          !Number.isFinite(Date.parse(action.timestamp)))))
    throw new Error('Invalid expected Go client action frame');
  // The Go producer serializes a wall-clock timestamp. Our real React/core
  // harness intentionally removes its own nondeterministic SDK timestamp.
  // Compare every stable semantic action field, never synthetic clock equality.
  const {timestamp: _timestamp, ...stableAction} = action;
  return includeDataModel ? {action: stableAction, dataModel: frame.dataModel} : stableAction;
}

function readExpectedClientActionFrame(path, acceptV091, includeDataModel = false) {
  try {
    const meta = statSync(path);
    if (!meta.isFile() || meta.size < 2 || meta.size > MAX_LINE_BYTES)
      throw new Error('Invalid expected action file');
    return decodeExpectedClientActionFrame(readFileSync(path), acceptV091, includeDataModel);
  } catch {
    // Paths and user-provided action values must never enter diagnostics.
    throw new Error('Invalid expected client action frame; path and contents omitted');
  }
}

function readCapture(input, inputFormat = 'jsonl', compatBasicCatalog = false,
  acceptV091 = false, compareDataModel = false) {
  try {
    const meta = statSync(input);
    if (!meta.isFile() || meta.size < 2 || meta.size > MAX_INPUT_BYTES)
      throw new Error('Invalid browser capture file');
    const raw = readFileSync(input);
    return inputFormat === 'copilotkit-operations' ?
      decodeCopilotKitBrowserCapture(raw, compatBasicCatalog) :
      inputFormat === 'websocket-frames' ?
        decodeWebSocketBrowserCapture(raw, acceptV091) :
      inputFormat === 'websocket-transcript' ?
        decodeWebSocketBrowserTranscript(raw, acceptV091, compareDataModel) :
        decodeBrowserCapture(raw, acceptV091);
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
  actionDigestKey = null, renderedTextDigestKey = null, buttonStateDigestKey = null,
  buttonA11yDigestKey = null, buttonFocusDigestKey = null,
  buttonGeometryDigestKey = null, surfaceErrorProbe = false,
  acceptV091 = false, expectedAction = null, expectedDataModel = undefined,
  expectedActionSequence = null, expectedDataModelSequence = null,
} = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_EVENTS)
    throw new Error('Invalid browser capture events');
  if (typeof acceptV091 !== 'boolean') throw new Error('Invalid browser capture version option');
  if (actionDigestKey !== null && !/^[a-f0-9]{64}$/.test(actionDigestKey))
    throw new Error('Invalid internal action digest key');
  if (renderedTextDigestKey !== null && !/^[a-f0-9]{64}$/.test(renderedTextDigestKey))
    throw new Error('Invalid internal rendered text digest key');
  if (buttonStateDigestKey !== null && !/^[a-f0-9]{64}$/.test(buttonStateDigestKey))
    throw new Error('Invalid internal Button-state digest key');
  if (buttonA11yDigestKey !== null && !/^[a-f0-9]{64}$/.test(buttonA11yDigestKey))
    throw new Error('Invalid internal Button accessibility digest key');
  if (buttonFocusDigestKey !== null && !/^[a-f0-9]{64}$/.test(buttonFocusDigestKey))
    throw new Error('Invalid internal Button focus digest key');
  if (buttonGeometryDigestKey !== null && !/^[a-f0-9]{64}$/.test(buttonGeometryDigestKey))
    throw new Error('Invalid internal Button geometry digest key');
  if (typeof reportFirstError !== 'boolean')
    throw new Error('Invalid first-error reporting mode');
  if (typeof surfaceErrorProbe !== 'boolean')
    throw new Error('Invalid internal surface error probe');
  const actionModes = Number(clickSingleButton) + Number(pressSingleButtonEnter) +
    Number(clickButtonIndex !== null) + Number(pressButtonIndexEnter !== null);
  if (expectedDataModel !== undefined && expectedAction === null)
    throw new Error('Expected client data model requires an expected action');
  if (expectedAction !== null &&
      (!expectedAction || typeof expectedAction !== 'object' || Array.isArray(expectedAction) ||
        actionModes !== 1 || actionSteps.length !== 0 || reportFirstError ||
        stopAfterEventIndex !== null))
    throw new Error('Expected client action requires one Chromium activation');
  if (expectedActionSequence !== null &&
      (!Array.isArray(expectedActionSequence) || expectedActionSequence.length < 2 ||
        expectedActionSequence.length > MAX_ACTION_STEPS || actionModes !== 0 ||
        expectedAction !== null || expectedDataModel !== undefined ||
        reportFirstError || stopAfterEventIndex !== null ||
        actionSteps.length !== expectedActionSequence.length ||
        expectedActionSequence.some(action =>
          !action || typeof action !== 'object' || Array.isArray(action)) ||
        (expectedDataModelSequence !== null &&
          (!Array.isArray(expectedDataModelSequence) ||
            expectedDataModelSequence.length !== expectedActionSequence.length))))
    throw new Error('Invalid multi-turn client action plan');
  if (expectedDataModelSequence !== null && expectedActionSequence === null)
    throw new Error('Multi-turn data model requires expected actions');
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
      inspectLoadingPlaceholders || rejectLoadingPlaceholders || actionDigestKey !== null ||
      buttonStateDigestKey !== null ||
      buttonA11yDigestKey !== null))
    throw new Error('Error-event diagnostics cannot activate controls or combine replay modes');
  if (buttonFocusDigestKey !== null && (actionModes !== 0 || actionSteps.length > 0 ||
      actionAfterEventIndex !== null))
    throw new Error('Focus comparison cannot activate browser controls');
  if (buttonGeometryDigestKey !== null && (actionModes !== 0 || actionSteps.length > 0 ||
      actionAfterEventIndex !== null))
    throw new Error('Geometry comparison cannot activate browser controls');
  const replayedMessages = stopAfterEventIndex === null
    ? messages : messages.slice(0, stopAfterEventIndex + 1);
  if (!replayedMessages.some(message => message && typeof message === 'object' &&
      supportedCaptureVersion(message.version, acceptV091) && Object.hasOwn(message, 'createSurface')))
    throw new Error('Browser capture requires a createSurface event');
  let server;
  let browser;
  const runtimeErrors = [];
  const consoleErrors = [];
  let deniedRequests = 0;
  let deniedSockets = 0;
  let currentEventIndex = null;
  try {
    server = await startHarnessServer();
    const origin = server.origin;
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
    let observedClientDataModel;
    const activateButton = async (
      targetIndex = selectedIndex,
      keyboardKey = (pressSingleButtonEnter || pressButtonIndexEnter !== null) ? 'Enter' : null,
      scripted = false,
    ) => {
      // The Go client includes the complete model observed at dispatch time.
      // Capture only inside this process before the real Chromium activation.
      const expectedForStep = expectedActionSequence?.[actionsVerified] ?? expectedAction;
      if (expectedDataModel !== undefined || expectedDataModelSequence !== null)
        observedClientDataModel = await page.evaluate(surfaceId =>
          window.__a2uiLab.trace(surfaceId).data, expectedForStep.surfaceId);
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
      if (expectedActionSequence !== null) {
        const emitted = (await page.evaluate(() => window.__a2uiLab.trace())).actions[before];
        if (canonicalActionJSON(emitted) !== canonicalActionJSON(expectedForStep))
          throw new Error('Chromium action did not match the expected client frame');
        if (expectedDataModelSequence !== null &&
            canonicalActionJSON(observedClientDataModel) !==
              canonicalActionJSON(expectedDataModelSequence[actionsVerified]))
          throw new Error('Chromium data model did not match the expected client frame');
      }
      actionBeforeCount = before;
      actionsVerified++;
    };
    const steps = [];
    const trackLoadingPlaceholders = inspectLoadingPlaceholders || rejectLoadingPlaceholders;
    let loadingPlaceholderEvents = 0;
    const renderedTextDigests = [];
    const buttonStateDigests = [];
    const buttonFocusDigests = [];
    const buttonGeometryDigests = [];
    const buttonA11yDigests = [];
    const declaredButtonA11yDigests = [];
    const declaredLabelsBySurface = new Map();
    for (let index = 0; index < replayedMessages.length; index++) {
      currentEventIndex = index;
      const message = replayedMessages[index];
      const operation = OPERATIONS.find(key => Object.hasOwn(message, key));
      if (!supportedCaptureVersion(message.version, acceptV091) || !operation)
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
      if (renderedTextDigestKey) {
        // The comparator sends a fresh HMAC key and discards these transient digests.
        const visibleText = await page.locator('section[aria-label="Real A2UI surface"]').innerText();
        if (Buffer.byteLength(visibleText, 'utf8') > MAX_RENDERED_TEXT_BYTES)
          throw new Error('Browser capture visible text exceeded the comparison limit');
        renderedTextDigests.push(createHmac('sha256', Buffer.from(renderedTextDigestKey, 'hex'))
          .update(visibleText, 'utf8').digest('hex'));
      }
      if (buttonStateDigestKey) {
        // Snapshot actual accessible Button control enablement at the agent
        // event boundary. Do not read labels, IDs, attributes or input values.
        const disabledStates = await page.getByRole('button').evaluateAll(buttons =>
          buttons.map(button => button.matches(':disabled') ||
            button.getAttribute('aria-disabled') === 'true'));
        if (disabledStates.length > MAX_BUTTON_INDEX + 1)
          throw new Error('Browser capture Button-state comparison exceeded limit');
        buttonStateDigests.push(createHmac('sha256',
          Buffer.from(buttonStateDigestKey, 'hex'))
          .update(JSON.stringify(disabledStates)).digest('hex'));
      }
      if (buttonGeometryDigestKey) {
        // Compare observed Chromium Button positions at a fixed viewport.
        // Only quantized x/y/width/height are hashed; no names, IDs or DOM text.
        const rectangles = await page.getByRole('button').evaluateAll(buttons =>
          buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map(value => {
              if (!Number.isFinite(value) || Math.abs(value) > 100000)
                throw new Error('Invalid Chromium Button geometry');
              return Math.round(value);
            });
          }));
        if (rectangles.length > MAX_BUTTON_INDEX + 1)
          throw new Error('Browser capture Button geometry comparison exceeded limit');
        buttonGeometryDigests.push(createHmac('sha256',
          Buffer.from(buttonGeometryDigestKey, 'hex'))
          .update(JSON.stringify(rectangles)).digest('hex'));
      }
      if (buttonFocusDigestKey) {
        // Measure real Chromium Tab reachability, not inferred tabindex or
        // disabled attributes. The fixed anchor resets traversal per event.
        // Do not activate buttons or export private names/DOM identifiers.
        const buttons = page.getByRole('button');
        const count = await buttons.count();
        if (count > MAX_BUTTON_INDEX + 1)
          throw new Error('Browser capture Button focus comparison exceeded limit');
        const tabOrder = [];
        if (count > 0) {
          await page.evaluate(() => {
            const anchor = document.createElement('span');
            anchor.tabIndex = -1;
            document.body.prepend(anchor);
            window.__a2uiFocusAnchor = anchor;
            anchor.focus();
          });
          try {
            for (let attempt = 0; attempt < Math.min(MAX_KEYBOARD_TABS, count * 2 + 4); attempt++) {
              await page.keyboard.press('Tab');
              const indexOfFocused = await buttons.evaluateAll(items =>
                items.indexOf(document.activeElement));
              if (indexOfFocused < 0) continue;
              if (tabOrder.includes(indexOfFocused)) break;
              tabOrder.push(indexOfFocused);
            }
          } finally {
            await page.evaluate(() => {
              window.__a2uiFocusAnchor?.remove();
              delete window.__a2uiFocusAnchor;
            });
          }
        }
        const focusTrace = await page.evaluate(() => window.__a2uiLab.trace());
        if (focusTrace.actions.length !== trace.actions.length ||
            focusTrace.errors.length !== trace.errors.length)
          throw new Error('Browser capture focus probe changed replay behavior');
        buttonFocusDigests.push(createHmac('sha256',
          Buffer.from(buttonFocusDigestKey, 'hex'))
          .update(JSON.stringify(tabOrder)).digest('hex'));
      }
      if (buttonA11yDigestKey) {
        // Hash A2UI's declared accessibility labels separately from the
        // actual Chromium accessibility tree. A pinned renderer may ignore
        // one of these labels; source drift must not be called DOM drift.
        if (operation === 'createSurface')
          declaredLabelsBySurface.set(message.createSurface.surfaceId, new Map());
        if (operation === 'updateComponents' &&
            Array.isArray(message.updateComponents.components)) {
          const surface = message.updateComponents.surfaceId;
          const labels = declaredLabelsBySurface.get(surface) ?? new Map();
          for (const component of message.updateComponents.components) {
            if (component?.component !== 'Button') continue;
            if (Object.hasOwn(component.accessibility ?? {}, 'label'))
              labels.set(component.id, component.accessibility.label);
            else labels.delete(component.id);
          }
          declaredLabelsBySurface.set(surface, labels);
        }
        if (operation === 'deleteSurface')
          declaredLabelsBySurface.delete(message.deleteSurface.surfaceId);
        // Capture-local surface/component identifiers are not accessibility
        // semantics. Compare label order only so private ID renames match.
        const declared = [...declaredLabelsBySurface.values()]
          .map(labels => [...labels.values()]);
        declaredButtonA11yDigests.push(createHmac('sha256',
          Buffer.from(buttonA11yDigestKey, 'hex'))
          .update('declared-button-accessibility-v1:')
          .update(JSON.stringify(declared)).digest('hex'));
        // Playwright's accessibility snapshot contains private accessible
        // names. HMAC each ordered Button snapshot in memory, never the report.
        const buttons = await page.getByRole('button').all();
        if (buttons.length > MAX_BUTTON_INDEX + 1)
          throw new Error('Browser capture Button accessibility comparison exceeded limit');
        const snapshots = [];
        let totalSnapshotBytes = 0;
        for (const button of buttons) {
          const snapshot = await button.ariaSnapshot();
          const byteLength = Buffer.byteLength(snapshot, 'utf8');
          totalSnapshotBytes += byteLength;
          if (byteLength > 4096 || totalSnapshotBytes > MAX_RENDERED_TEXT_BYTES)
            throw new Error('Browser capture Button accessibility snapshot exceeded limit');
          snapshots.push(snapshot);
        }
        buttonA11yDigests.push(createHmac('sha256',
          Buffer.from(buttonA11yDigestKey, 'hex'))
          .update(JSON.stringify(snapshots)).digest('hex'));
      }
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
    if (expectedAction !== null && (final.actions.length !== 1 ||
        canonicalActionJSON(final.actions[0]) !== canonicalActionJSON(expectedAction)))
      throw new Error('Chromium action did not match the expected client frame');
    if (expectedDataModel !== undefined &&
        canonicalActionJSON(observedClientDataModel) !== canonicalActionJSON(expectedDataModel))
      throw new Error('Chromium data model did not match the expected client frame');
    if (expectedActionSequence !== null && final.actions.length !== expectedActionSequence.length)
      throw new Error('Chromium action count did not match the expected client frames');
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
      ...(expectedAction !== null || expectedActionSequence !== null ?
        {expectedClientActionMatched: true} : {}),
      ...(expectedDataModel !== undefined || expectedDataModelSequence !== null ?
        {expectedClientDataModelMatched: true} : {}),
      // Never persist or publish this digest; the parent drops it before report validation.
      ...(actionDigestKey ? {
        __privateActionDigest: createHmac('sha256', Buffer.from(actionDigestKey, 'hex'))
          .update(canonicalActionJSON(final.actions)).digest('hex'),
        // Transient keyed digests locate action drift; the parent discards them.
        __privateActionDigests: final.actions.map(action =>
          createHmac('sha256', Buffer.from(actionDigestKey, 'hex'))
            .update(canonicalActionJSON(action)).digest('hex')),
      } : {}),
      ...(renderedTextDigestKey ? {__privateRenderedTextDigests: renderedTextDigests} : {}),
      ...(buttonStateDigestKey ? {__privateButtonStateDigests: buttonStateDigests} : {}),
      ...(buttonFocusDigestKey ? {__privateButtonFocusDigests: buttonFocusDigests} : {}),
      ...(buttonGeometryDigestKey ? {__privateButtonGeometryDigests: buttonGeometryDigests} : {}),
      ...(buttonA11yDigestKey ? {__privateButtonA11yDigests: buttonA11yDigests,
        __privateDeclaredButtonA11yDigests: declaredButtonA11yDigests} : {}),
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
      const actionKey = args.internalActionDigest
        ? process.env.A2UI_PRIVATE_ACTION_DIGEST_KEY : null;
      const textKey = args.internalRenderedTextDigest
        ? process.env.A2UI_PRIVATE_RENDERED_TEXT_DIGEST_KEY : null;
      const buttonStateKey = args.internalButtonStateDigest
        ? process.env.A2UI_PRIVATE_BUTTON_STATE_DIGEST_KEY : null;
      const buttonA11yKey = args.internalButtonA11yDigest
        ? process.env.A2UI_PRIVATE_BUTTON_A11Y_DIGEST_KEY : null;
      const buttonFocusKey = args.internalButtonFocusDigest
        ? process.env.A2UI_PRIVATE_BUTTON_FOCUS_DIGEST_KEY : null;
      const buttonGeometryKey = args.internalButtonGeometryDigest
        ? process.env.A2UI_PRIVATE_BUTTON_GEOMETRY_DIGEST_KEY : null;
      if ((args.internalActionDigest || args.internalRenderedTextDigest ||
          args.internalButtonStateDigest || args.internalButtonA11yDigest ||
          args.internalButtonFocusDigest || args.internalButtonGeometryDigest) &&
          (args.out ||
            (args.internalActionDigest && !/^[a-f0-9]{64}$/.test(actionKey ?? '')) ||
            (args.internalRenderedTextDigest && !/^[a-f0-9]{64}$/.test(textKey ?? '')) ||
            (args.internalButtonStateDigest && !/^[a-f0-9]{64}$/.test(buttonStateKey ?? '')) ||
            (args.internalButtonA11yDigest && !/^[a-f0-9]{64}$/.test(buttonA11yKey ?? '')) ||
            (args.internalButtonFocusDigest && !/^[a-f0-9]{64}$/.test(buttonFocusKey ?? '')) ||
            (args.internalButtonGeometryDigest && !/^[a-f0-9]{64}$/.test(buttonGeometryKey ?? ''))))
        throw new Error('Internal comparison digest must be pipe-only with valid ephemeral keys');
      const capture = readCapture(args.input, args.inputFormat,
        args.compatCopilotkitBasicCatalog, args.acceptV091, args.compareClientDataModel);
      const transcriptMode = args.inputFormat === 'websocket-transcript';
      const multiTurn = transcriptMode && capture.actionFrames.length > 1;
      if (transcriptMode && (multiTurn !== (args.actionSteps.length > 0) ||
          (multiTurn && (args.actionSteps.length !== capture.actionFrames.length ||
            args.actionSteps.some((step, index) =>
              step.eventIndex !== capture.actionFrames[index].actionAfterEventIndex)))))
        throw new Error('Transcript actions require exactly matching explicit action steps');
      const expectedFrame = transcriptMode ? capture : args.expectClientActionFrame ?
        readExpectedClientActionFrame(args.expectClientActionFrame,
          args.acceptV091, args.compareClientDataModel) : null;
      const report = await runBrowserCapture(transcriptMode ? capture.messages : capture,
        {acceptV091: args.acceptV091,
           clickSingleButton: args.clickSingleButton, pressSingleButtonEnter: args.pressSingleButtonEnter,
          clickButtonIndex: args.clickButtonIndex, pressButtonIndexEnter: args.pressButtonIndexEnter,
          actionAfterEventIndex: transcriptMode ? capture.actionAfterEventIndex :
            args.actionAfterEventIndex, actionSteps: args.actionSteps,
          stopAfterEventIndex: args.stopAfterEventIndex, reportFirstError: args.reportFirstError,
          inspectLoadingPlaceholders: args.inspectLoadingPlaceholders,
          rejectLoadingPlaceholders: args.rejectLoadingPlaceholders,
          actionDigestKey: actionKey, renderedTextDigestKey: textKey,
          buttonStateDigestKey: buttonStateKey, buttonA11yDigestKey: buttonA11yKey,
          buttonFocusDigestKey: buttonFocusKey,
          buttonGeometryDigestKey: buttonGeometryKey,
          expectedAction: transcriptMode ? expectedFrame.expectedAction :
            args.compareClientDataModel ? expectedFrame.action : expectedFrame,
          expectedDataModel: args.compareClientDataModel ?
            (transcriptMode ? expectedFrame.expectedDataModel : expectedFrame.dataModel) : undefined,
          expectedActionSequence: multiTurn ? capture.actionFrames.map(frame => frame.expectedAction) : null,
          expectedDataModelSequence: multiTurn && args.compareClientDataModel ?
            capture.actionFrames.map(frame => frame.expectedDataModel) : null});
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
