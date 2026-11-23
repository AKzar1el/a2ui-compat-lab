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
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];
const USAGE = 'Usage: node src/v1-text-binding-preflight.mjs --input PRIVATE.jsonl [--strict]';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only recognizable v0.9 directive *shapes* in Text.text count. A producer
// might intentionally display one of these objects literally at v1.0.
export function possibleLegacyTextDirective(value) {
  if (!isRecord(value) || Object.hasOwn(value, '@path') || Object.hasOwn(value, '@call'))
    return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'path' &&
      typeof value.path === 'string' && value.path.length > 0)
    return 'path';
  if (typeof value.call === 'string' && value.call.length > 0 &&
      keys.every(key => ['call', 'args', 'catalogId'].includes(key)) &&
      (value.args === undefined || isRecord(value.args)) &&
      (value.catalogId === undefined || typeof value.catalogId === 'string'))
    return 'call';
  return null;
}

export function inspectV1TextBindings(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_FRAMES)
    throw new Error('Unsupported capture event count');
  const counts = {legacyPathLike: 0, legacyCallLike: 0};
  let textComponents = 0;
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
      if (component.component !== 'Text') continue;
      textComponents++;
      const kind = possibleLegacyTextDirective(component.text);
      if (kind === 'path') counts.legacyPathLike++;
      if (kind === 'call') counts.legacyCallLike++;
      if (kind && candidateLocations.length < MAX_CANDIDATE_LOCATIONS)
        candidateLocations.push({lineNumber: frameIndex + 1, componentIndex, kind});
    }
  }
  const candidateCount = counts.legacyPathLike + counts.legacyCallLike;
  return {
    schemaVersion: 1,
    kind: 'a2ui-v1-text-binding-migration-preflight',
    protocol: '1.0',
    surfaceMessages: messages.length,
    textComponents,
    candidateCount,
    candidateKinds: counts,
    candidateLocations,
    candidateLocationsOmitted: candidateCount - candidateLocations.length,
    result: candidateCount ? 'review_ambiguous_legacy_shapes' : 'no_legacy_text_shapes_detected',
    recommendation: candidateCount
      ? 'If a Text value was intended as a binding or call, migrate path/call to @path/@call. Plain objects may be intentional v1 literals.'
      : 'No v0.9-shaped Text bindings detected in the inspected messages.',
    limitations: 'Heuristic for Text.text only; no renderer, other component slot, schema conformance, intent or customer compatibility certification.',
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
  let input = null;
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict' && !strict) strict = true;
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
    report = inspectV1TextBindings(parseCapture(raw));
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
