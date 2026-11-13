#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compareBrowserCaptureSummaries} from './browser-capture-summary-compare.mjs';

const USAGE = 'Usage: node src/browser-capture-error-boundary-compare.mjs --before-capture PRIVATE-OLD.jsonl --after-capture PRIVATE-NEW.jsonl [--strict] [--require-no-observed-failures] [--format json|markdown|junit] [--out NEW-REPORT]';
const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'renderer-react');
const RENDERER_SCRIPT = resolve(RENDERER_DIR, 'scripts/browser-capture-replay.mjs');
const RENDERER = '@a2ui/react@0.14.0 + @a2ui/web_core@0.14.0';
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_EVENTS = 100;
const DIAGNOSTIC_NOTE = 'First observed failure event, not proven cause; structural metadata is not anonymized';
const invalid = () => new Error('Invalid private capture comparison; paths and contents omitted');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseErrorBoundaryOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const args = {strict: false, requireNoObservedFailures: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict' && !args.strict) args.strict = true;
    else if (arg === '--require-no-observed-failures' && !args.requireNoObservedFailures)
      args.requireNoObservedFailures = true;
    else if (arg === '--format' && !Object.hasOwn(args, 'format') &&
      ['json', 'markdown', 'junit'].includes(argv[i + 1])) args.format = argv[++i];
    else if (['--before-capture', '--after-capture', '--out'].includes(arg) &&
      !Object.hasOwn(args, arg.slice(2)) && argv[i + 1] &&
      !argv[i + 1].startsWith('--')) args[arg.slice(2)] = resolve(argv[++i]);
    else throw invalid();
  }
  if (!args['before-capture'] || !args['after-capture']) throw invalid();
  return args;
}

// Validate the fixed output of the published React/Chromium replay child before
// retaining any data. A failed event and a malformed input are never conflated.
function parseObservedBoundary(report, exitStatus) {
  if (!isRecord(report) || report.schemaVersion !== 1 ||
      report.protocol !== 'v0.9' || report.renderer !== RENDERER ||
      !Number.isSafeInteger(report.events) || report.events < 1 ||
      report.events > MAX_EVENTS)
    throw invalid();

  if (report.kind === 'a2ui-react-capture-event-diagnostic') {
    if (exitStatus !== 1 ||
        Object.keys(report).sort().join(',') !== [
          'events', 'firstObservedFailureEventIndex', 'kind', 'note',
          'processedEventCount', 'protocol', 'renderer', 'schemaVersion',
        ].sort().join(',') ||
        report.note !== DIAGNOSTIC_NOTE ||
        !Number.isSafeInteger(report.firstObservedFailureEventIndex) ||
        report.firstObservedFailureEventIndex < 0 ||
        report.firstObservedFailureEventIndex >= report.events ||
        report.processedEventCount !== report.firstObservedFailureEventIndex)
      throw invalid();
    return {events: report.events, index: report.firstObservedFailureEventIndex};
  }

  if (report.kind !== 'a2ui-react-capture-browser-replay' || exitStatus !== 0 ||
      !Object.hasOwn(report, 'firstObservedFailureEventIndex') ||
      report.firstObservedFailureEventIndex !== null)
    throw invalid();

  const {firstObservedFailureEventIndex, ...cleanReport} = report;
  // Reuse the existing strict structural schema validator; a successful
  // diagnostic is a normal browser replay report plus one null sentinel.
  compareBrowserCaptureSummaries(cleanReport, cleanReport);
  return {events: report.events, index: null};
}

function runDiagnostic(capturePath) {
  let child;
  try {
    child = spawnSync(process.execPath,
      [RENDERER_SCRIPT, '--input', capturePath, '--report-first-error'], {
        cwd: RENDERER_DIR, shell: false, windowsHide: true,
        encoding: 'utf8', timeout: 120000, maxBuffer: MAX_OUTPUT_BYTES,
      });
  } catch {
    throw invalid();
  }
  // Exit 1 is permitted ONLY for the validated fixed-schema event diagnostic.
  // Exit 2, timeouts, missing executables and malformed JSON all fail closed.
  if (child.error || ![0, 1].includes(child.status) ||
      typeof child.stdout !== 'string' || !child.stdout.length ||
      Buffer.byteLength(child.stdout, 'utf8') > MAX_OUTPUT_BYTES)
    throw invalid();
  try {
    return parseObservedBoundary(JSON.parse(child.stdout), child.status);
  } catch {
    throw invalid();
  }
}

export function compareErrorBoundaries(before, after, {requireNoObservedFailures = false} = {}) {
  if (typeof requireNoObservedFailures !== 'boolean' ||
      !isRecord(before) || !isRecord(after) ||
      !Number.isSafeInteger(before.events) || !Number.isSafeInteger(after.events) ||
      before.events < 1 || after.events < 1 ||
      before.events > MAX_EVENTS || after.events > MAX_EVENTS ||
      [before, after].some(item => item.index !== null &&
        (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= item.events)))
    throw invalid();
  const sameBoundary = before.index === after.index;
  const sameCount = before.events === after.events;
  const observedFailuresAbsent = before.index === null && after.index === null;
  return {
    schemaVersion: 1,
    kind: 'a2ui-react-capture-error-boundary-diff',
    protocol: 'v0.9',
    renderer: RENDERER,
    ok: sameBoundary && sameCount && (!requireNoObservedFailures || observedFailuresAbsent),
    beforeEvents: before.events,
    afterEvents: after.events,
    eventCountParity: sameCount ? 'match' : 'drift',
    errorBoundaryParity: sameBoundary ? 'match' : 'drift',
    ...(requireNoObservedFailures ? {requireNoObservedFailures, observedFailuresAbsent} : {}),
    beforeFirstObservedFailureEventIndex: before.index,
    afterFirstObservedFailureEventIndex: after.index,
    note: 'Observed Chromium failure indices only; matching failures may have different causes and do not mean healthy or anonymous',
  };
}

/** Only comparator-owned, fixed-schema values appear in these CI artifacts. */
export function formatErrorBoundaryReport(result, format = 'json') {
  if (!['json', 'markdown', 'junit'].includes(format) || !isRecord(result) ||
      result.kind !== 'a2ui-react-capture-error-boundary-diff' ||
      result.schemaVersion !== 1 || result.protocol !== 'v0.9' ||
      result.renderer !== RENDERER || typeof result.ok !== 'boolean' ||
      !['match', 'drift'].includes(result.eventCountParity) ||
      !['match', 'drift'].includes(result.errorBoundaryParity) ||
      (Object.hasOwn(result, 'observedFailuresAbsent') &&
        (result.requireNoObservedFailures !== true ||
          typeof result.observedFailuresAbsent !== 'boolean')))
    throw invalid();
  if (format === 'json') return JSON.stringify(result, null, 2) + '\n';
  if (format === 'markdown') return [
    '## A2UI Chromium first-error boundary comparison',
    '',
    '**Result:** ' + (result.ok ? 'MATCH' : 'DRIFT'),
    '**Event counts:** ' + result.beforeEvents + ' before / ' + result.afterEvents + ' after',
    '**Event count parity:** ' + result.eventCountParity.toUpperCase(),
    '**Observed failure-boundary parity:** ' + result.errorBoundaryParity.toUpperCase(),
    '**First observed failure event indices:** ' +
      String(result.beforeFirstObservedFailureEventIndex) + ' before / ' +
      String(result.afterFirstObservedFailureEventIndex) + ' after',
    ...(result.requireNoObservedFailures ? [
      '**Opt-in no-observed-failures policy:** ' +
        (result.observedFailuresAbsent ? 'PASS' : 'FAIL'),
    ] : []),
    '',
    '_Observed error boundaries do not prove cause or health; event metadata may be sensitive and is not anonymized._',
    '',
  ].join('\n');
  const checks = [
    {name: 'event-count-parity', pass: result.eventCountParity === 'match',
      message: 'event count drift'},
    {name: 'error-boundary-parity', pass: result.errorBoundaryParity === 'match',
      message: 'observed error boundary drift'},
    ...(result.requireNoObservedFailures ? [{
      name: 'observed-failure-policy', pass: result.observedFailuresAbsent,
      message: 'observed replay failures',
    }] : []),
  ];
  // Every JUnit failure is a separate assertion, including two identical
  // failing replays when the health policy is enabled.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuite name="a2ui-react-capture-error-boundary" tests="' + checks.length +
      '" failures="' + checks.filter(check => !check.pass).length + '" errors="0">',
    ...checks.map(check => '  <testcase classname="a2ui.react.error-boundary" name="' +
      check.name + '"' + (check.pass ? ' />' : '><failure message="' +
        check.message + '" /></testcase>')),
    '</testsuite>',
    '',
  ].join('\n');
}

function exclusiveWrite(path, content) {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, content, {flag: 'wx'});
  } catch {
    throw invalid();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseErrorBoundaryOptions(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      const before = runDiagnostic(args['before-capture']);
      const after = runDiagnostic(args['after-capture']);
      const result = compareErrorBoundaries(before, after,
        {requireNoObservedFailures: args.requireNoObservedFailures});
      const content = formatErrorBoundaryReport(result, args.format);
      if (args.out) exclusiveWrite(args.out, content);
      else process.stdout.write(content);
      if (args.strict && !result.ok) process.exitCode = 1;
    }
  } catch {
    // No thrown parser, SDK, Chromium, path or subprocess content is echoed.
    console.error('A2UI private Chromium error-boundary comparison refused; paths and contents omitted');
    process.exitCode = 2;
  }
}
