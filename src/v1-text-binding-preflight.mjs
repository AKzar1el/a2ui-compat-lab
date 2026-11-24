#!/usr/bin/env node
// Local-only migration signal for one known published v1 Text-binding mismatch.
// A plain object with "path" or "call" is legal v1 literal data: report a
// candidate, never claim the capture is invalid or that intent is knowable.
import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_FRAMES = 1000;
const MAX_CANDIDATE_LOCATIONS = 32;
const INPUT_VALUE_COMPONENTS = ['TextField', 'CheckBox', 'Slider', 'ChoicePicker', 'DateTimeInput'];
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];
const USAGE = 'Usage: node src/v1-text-binding-preflight.mjs --input PRIVATE.jsonl [--strict] [--include-input-values] [--include-event-context]';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only recognizable v0.9 directive *shapes* in Text.text count. A producer
// might intentionally display one of these objects literally at v1.0.
export function possibleLegacyTextDirective(value) {
  if (!isRecord(value) || Object.hasOwn(value, '@path') || Object.hasOwn(value, '@call'))
    return null;
  // Only read own data descriptors: inherited or accessor-backed properties
  // must not run application code during programmatic inspection.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  const ownData = key => {
    if (!Object.hasOwn(descriptors, key)) return undefined;
    const descriptor = descriptors[key];
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const path = ownData('path');
  if (keys.length === 1 && keys[0] === 'path' &&
      typeof path === 'string' && path.length > 0)
    return 'path';
  const call = ownData('call');
  const args = ownData('args');
  const catalogId = ownData('catalogId');
  if (typeof call === 'string' && call.length > 0 &&
      keys.every(key => ['call', 'args', 'catalogId'].includes(key)) &&
      (args === undefined || isRecord(args)) &&
      (catalogId === undefined || typeof catalogId === 'string'))
    return 'call';
  return null;
}

// The exported inspector also accepts in-memory objects. Reject accessors,
 // non-JSON-like objects and cycles without invoking user-defined getters.
 // Parsed JSONL is acyclic, but these checks protect programmatic callers.
const MAX_EVENT_CONTEXT_DEPTH = 12;
const MAX_EVENT_CONTEXT_NODES = 2048;

function visitEventContext(context, onCandidate) {
  const ancestors = new Set();
  let visited = 0;
  function visit(value, depth) {
    if (++visited > MAX_EVENT_CONTEXT_NODES)
      throw new Error('Button event context exceeds node limit');
    if (depth > MAX_EVENT_CONTEXT_DEPTH)
      throw new Error('Button event context exceeds depth limit');
    if (value === null || typeof value !== 'object') return;
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null)
      throw new Error('Unsupported Button event context object');
    if (ancestors.has(value))
      throw new Error('Cyclic Button event context');
    if (isArray && value.length > MAX_EVENT_CONTEXT_NODES)
      throw new Error('Button event context exceeds node limit');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))
        throw new Error('Unsupported Button event context property');
    }
    // The root is a name->context map, not itself a dynamic binding.
    if (depth > 0 && !isArray) {
      const kind = possibleLegacyTextDirective(value);
      if (kind) onCandidate(kind);
    }
    ancestors.add(value);
    // Traverse own enumerable data properties only. Array length is excluded.
    // Ancestor-only cycle detection counts repeated acyclic aliases separately.
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.enumerable) visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(context, 0);
}

export function inspectV1TextBindings(messages, {includeInputValues = false, includeEventContext = false} = {}) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_FRAMES)
    throw new Error('Unsupported capture event count');
  const counts = {legacyPathLike: 0, legacyCallLike: 0};
  let textComponents = 0;
  let inputValueComponents = 0;
  let inputValueCandidateCount = 0;
  let buttonEventContexts = 0;
  let eventContextCandidateCount = 0;
  const eventContextCandidateKinds = {path: 0, call: 0};
  const inputValueCandidatesByComponent = Object.fromEntries(
    INPUT_VALUE_COMPONENTS.map(component => [component, 0]));
  const candidateLocations = [];
  for (const [frameIndex, message] of messages.entries()) {
    if (!isRecord(message) || message.version !== '1.0' ||
        OPERATIONS.filter(operation => Object.hasOwn(message, operation)).length !== 1)
      throw new Error('Unsupported v1.0 surface message');
    const isUpdate = Object.hasOwn(message, 'updateComponents');
    const isCreate = Object.hasOwn(message, 'createSurface');
    if (!isUpdate && !isCreate) continue;
    const components = (isUpdate ? message.updateComponents : message.createSurface)?.components;
    // Inline components are optional on createSurface, but required in updates.
    if (isCreate && components === undefined) continue;
    if (!Array.isArray(components))
      throw new Error('Unsupported v1.0 component list');
    for (const [componentIndex, component] of components.entries()) {
      if (!isRecord(component)) throw new Error('Unsupported v1.0 component');
      if (component.component === 'Text') {
        textComponents++;
        const kind = possibleLegacyTextDirective(component.text);
        if (kind === 'path') counts.legacyPathLike++;
        if (kind === 'call') counts.legacyCallLike++;
        if (kind && candidateLocations.length < MAX_CANDIDATE_LOCATIONS)
          candidateLocations.push({lineNumber: frameIndex + 1, componentIndex, kind});
        continue;
      }
      if (includeEventContext && component.component === 'Button') {
        const context = component.action?.event?.context;
        if (isRecord(context)) {
          buttonEventContexts++;
          // Only the owning Button's structural coordinates are released, not
          // private context keys or values, even when candidates are nested.
          const recordedKinds = new Set();
          visitEventContext(context, kind => {
            eventContextCandidateCount++;
            eventContextCandidateKinds[kind]++;
            if (recordedKinds.has(kind)) return;
            recordedKinds.add(kind);
            if (candidateLocations.length < MAX_CANDIDATE_LOCATIONS)
              candidateLocations.push({lineNumber: frameIndex + 1, componentIndex,
                kind: kind === 'path' ? 'buttonEventContextPath' : 'buttonEventContextCall'});
          });
        }
      }
      if (!includeInputValues || !INPUT_VALUE_COMPONENTS.includes(component.component))
        continue;
      inputValueComponents++;
      // v1 literal objects remain legal; only an exact legacy path shape is advisory.
      if (possibleLegacyTextDirective(component.value) !== 'path') continue;
      inputValueCandidateCount++;
      inputValueCandidatesByComponent[component.component]++;
      if (candidateLocations.length < MAX_CANDIDATE_LOCATIONS)
        candidateLocations.push({lineNumber: frameIndex + 1, componentIndex,
          kind: 'inputValuePath'});
    }
  }
  const textCandidateCount = counts.legacyPathLike + counts.legacyCallLike;
  const candidateCount = textCandidateCount + inputValueCandidateCount + eventContextCandidateCount;
  const candidateKinds = includeInputValues || includeEventContext
    ? {legacyPathLike: counts.legacyPathLike + inputValueCandidateCount + eventContextCandidateKinds.path,
      legacyCallLike: counts.legacyCallLike + eventContextCandidateKinds.call}
    : counts;
  return {
    schemaVersion: includeEventContext ? 3 : includeInputValues ? 2 : 1,
    kind: includeInputValues || includeEventContext
      ? 'a2ui-v1-binding-migration-preflight'
      : 'a2ui-v1-text-binding-migration-preflight',
    protocol: '1.0',
    surfaceMessages: messages.length,
    textComponents,
    candidateCount,
    candidateKinds,
    ...(includeInputValues ? {
      textCandidateCount,
      textCandidateKinds: counts,
      inputValueComponents,
      inputValueCandidateCount,
      inputValueCandidatesByComponent,
    } : {}),
    ...(includeEventContext ? {buttonEventContexts, eventContextCandidateCount,
      eventContextCandidateKinds} : {}),
    candidateLocations,
    candidateLocationsOmitted: candidateCount - candidateLocations.length,
    result: candidateCount
      ? 'review_ambiguous_legacy_shapes'
      : includeInputValues || includeEventContext
        ? 'no_legacy_binding_shapes_detected' : 'no_legacy_text_shapes_detected',
    recommendation: candidateCount
      ? includeEventContext
        ? includeInputValues
          ? 'Review Text, input value and Button event context path/call objects. If bindings were intended, migrate to @path/@call; literal objects may be intentional.'
          : 'Review Text and Button event context path/call objects. If bindings were intended, migrate to @path/@call; literal objects may be intentional.'
        : includeInputValues
          ? 'Review Text path/call and input value path objects. If bindings were intended, migrate to @path/@call; literal objects may be intentional.'
        : 'If a Text value was intended as a binding or call, migrate path/call to @path/@call. Plain objects may be intentional v1 literals.'
      : includeEventContext
        ? 'No v0.9-shaped Text or bounded nested Button event context path/call bindings detected.'
        : includeInputValues
          ? 'No v0.9-shaped Text or supported input value bindings detected.'
        : 'No v0.9-shaped Text bindings detected in the inspected messages.',
    limitations: includeEventContext
      ? 'Heuristic for Text.text and bounded nested Button.action.event.context values (at most 12 levels and 2048 visited nodes per Button; plus five input slots if enabled); no browser dispatch, schema conformance, intent or customer certification.'
      : includeInputValues
        ? 'Heuristic for Text.text and five named input value slots only; no renderer, two-way writeback, schema conformance, intent or customer certification.'
      : 'Heuristic for Text.text only; no renderer, other component slot, schema conformance, intent or customer compatibility certification.',
  };
}

export function parseCapture(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 1 || raw.length > MAX_CAPTURE_BYTES)
    throw new Error('Capture size outside 1 byte to 1 MiB');
  let start = 0;
  let frames = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 10) continue;
    if (i - start > MAX_FRAME_BYTES) throw new Error('Capture frame exceeds 128 KiB');
    if (++frames > MAX_FRAMES) throw new Error('Capture exceeds 1000 frames');
    start = i + 1;
  }
  if (start !== raw.length || frames === 0)
    throw new Error('Capture must end in a JSONL newline');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  return text.split('\n').slice(0, -1).map(line => JSON.parse(line));
}

function main(args) {
  let strict = false;
  let includeInputValues = false;
  let includeEventContext = false;
  let input = null;
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict' && !strict) strict = true;
    else if (args[i] === '--include-input-values' && !includeInputValues)
      includeInputValues = true;
    else if (args[i] === '--include-event-context' && !includeEventContext)
      includeEventContext = true;
    else if (args[i] === '--input' && input === null && args[i + 1] &&
             !args[i + 1].startsWith('--')) input = resolve(args[++i]);
    else throw new Error(USAGE);
  }
  if (!input) throw new Error(USAGE);
  let raw;
  try {
    const stat = statSync(input);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CAPTURE_BYTES)
      throw new Error('size');
    raw = readFileSync(input);
  } catch {
    throw new Error('Capture input unavailable or outside 1 byte to 1 MiB; path omitted');
  }
  // Parsing/SDK-like validation errors can include private capture contents.
  // Do not forward their messages into CLI output.
  let report;
  try {
    report = inspectV1TextBindings(parseCapture(raw), {includeInputValues, includeEventContext});
  } catch {
    throw new Error('Invalid or unsupported v1.0 JSONL surface capture; contents omitted');
  }
  process.stdout.write(JSON.stringify(report) + '\n');
  if (strict && report.candidateCount > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(error.message.startsWith('Usage:') ? error.message + '\n' :
      'A2UI v1 Text preflight failed: ' + error.message + '\n');
    process.exitCode = 2;
  }
}
