#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compareBrowserCaptureSummaries} from './browser-capture-summary-compare.mjs';

const USAGE = 'Usage: node src/browser-capture-error-boundary-compare.mjs --before-capture PRIVATE-OLD.jsonl --after-capture PRIVATE-NEW.jsonl [--strict] [--require-no-observed-failures] [--compare-rendered-text] [--compare-button-geometry] [--format json|markdown|junit] [--out NEW-REPORT | --report-dir NEW-DIRECTORY]';
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
  const args = {strict: false, requireNoObservedFailures: false, compareRenderedText: false, compareButtonGeometry: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict' && !args.strict) args.strict = true;
    else if (arg === '--require-no-observed-failures' && !args.requireNoObservedFailures)
      args.requireNoObservedFailures = true;
    else if (arg === '--compare-rendered-text' && !args.compareRenderedText)
      args.compareRenderedText = true;
    else if (arg === '--compare-button-geometry' && !args.compareButtonGeometry)
      args.compareButtonGeometry = true;
    else if (arg === '--format' && !Object.hasOwn(args, 'format') &&
      ['json', 'markdown', 'junit'].includes(argv[i + 1])) args.format = argv[++i];
    else if (['--before-capture', '--after-capture', '--out', '--report-dir'].includes(arg) &&
      !Object.hasOwn(args, arg.slice(2)) && argv[i + 1] &&
      !argv[i + 1].startsWith('--')) args[arg.slice(2)] = resolve(argv[++i]);
    else throw invalid();
  }
  if (!args['before-capture'] || !args['after-capture'] ||
      (args['report-dir'] && (args.out || Object.hasOwn(args, 'format'))) ||
      ((args.compareRenderedText || args.compareButtonGeometry) && !args.requireNoObservedFailures)) throw invalid();
  return args;
}

// Validate the fixed output of the published React/Chromium replay child before
// retaining any data. A failed event and a malformed input are never conflated.
function parseObservedBoundary(report, exitStatus, textDigestEnabled = false, geometryDigestEnabled = false) {
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
    return {events: report.events, index: report.firstObservedFailureEventIndex,
      digests: null, geometryDigests: null};
  }

  if (report.kind !== 'a2ui-react-capture-browser-replay' || exitStatus !== 0 ||
      !Object.hasOwn(report, 'firstObservedFailureEventIndex') ||
      report.firstObservedFailureEventIndex !== null)
    throw invalid();

  const {firstObservedFailureEventIndex, __privateRenderedTextDigests,
    __privateButtonGeometryDigests, ...cleanReport} = report;
  const digests = textDigestEnabled ? __privateRenderedTextDigests : null;
  const geometryDigests = geometryDigestEnabled ? __privateButtonGeometryDigests : null;
  const validDigests = value => Array.isArray(value) && value.length === report.events &&
    value.every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  if ((textDigestEnabled ? !validDigests(digests) : __privateRenderedTextDigests !== undefined) ||
      (geometryDigestEnabled ? !validDigests(geometryDigests) :
        __privateButtonGeometryDigests !== undefined)) throw invalid();
  // Strictly validate the normal replay schema after discarding transient HMACs.
  compareBrowserCaptureSummaries(cleanReport, cleanReport);
  return {events: report.events, index: null, digests, geometryDigests};
}

function runDiagnostic(capturePath, textDigestKey = null, geometryDigestKey = null) {
  let child;
  try {
    child = spawnSync(process.execPath,
      [RENDERER_SCRIPT, '--input', capturePath, '--report-first-error',
        ...(textDigestKey ? ['--internal-rendered-text-digest'] : []),
        ...(geometryDigestKey ? ['--internal-button-geometry-digest'] : [])], {
        cwd: RENDERER_DIR, shell: false, windowsHide: true,
        encoding: 'utf8', timeout: 120000, maxBuffer: MAX_OUTPUT_BYTES,
        ...((textDigestKey || geometryDigestKey) ? {env: {...process.env,
          ...(textDigestKey ? {A2UI_PRIVATE_RENDERED_TEXT_DIGEST_KEY: textDigestKey} : {}),
          ...(geometryDigestKey ? {A2UI_PRIVATE_BUTTON_GEOMETRY_DIGEST_KEY: geometryDigestKey} : {})}} : {}),
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
    return parseObservedBoundary(JSON.parse(child.stdout), child.status,
      Boolean(textDigestKey), Boolean(geometryDigestKey));
  } catch {
    throw invalid();
  }
}

export function compareErrorBoundaries(before, after,
  {requireNoObservedFailures = false, compareRenderedText = false,
    compareButtonGeometry = false} = {}) {
  if (typeof requireNoObservedFailures !== 'boolean' ||
      !isRecord(before) || !isRecord(after) ||
      !Number.isSafeInteger(before.events) || !Number.isSafeInteger(after.events) ||
      before.events < 1 || after.events < 1 ||
      before.events > MAX_EVENTS || after.events > MAX_EVENTS ||
      [before, after].some(item => item.index !== null &&
        (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= item.events)))
    throw invalid();
  if (typeof compareRenderedText !== 'boolean' ||
      (compareRenderedText && (!requireNoObservedFailures || [before, after].some(item =>
        item.index === null ? (!Array.isArray(item.digests) ||
          item.digests.length !== item.events || item.digests.some(digest =>
            typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) :
          item.digests !== null))) ||
      typeof compareButtonGeometry !== 'boolean' ||
      (compareButtonGeometry && (!requireNoObservedFailures || [before, after].some(item =>
        item.index === null ? (!Array.isArray(item.geometryDigests) ||
          item.geometryDigests.length !== item.events || item.geometryDigests.some(digest =>
            typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) :
          item.geometryDigests !== null)))) throw invalid();
  const textAvailable = before.index === null && after.index === null;
  const firstTextDrift = compareRenderedText && textAvailable ?
    Array.from({length: Math.max(before.events, after.events)}, (_, i) => i)
      .find(i => before.digests[i] !== after.digests[i]) : undefined;
  const textParity = !textAvailable ? 'unavailable' :
    firstTextDrift === undefined ? 'match' : 'drift';
  const firstGeometryDrift = compareButtonGeometry && textAvailable ?
    Array.from({length: Math.max(before.events, after.events)}, (_, i) => i)
      .find(i => before.geometryDigests[i] !== after.geometryDigests[i]) : undefined;
  const geometryParity = !textAvailable ? 'unavailable' :
    firstGeometryDrift === undefined ? 'match' : 'drift';
  const sameBoundary = before.index === after.index;
  const sameCount = before.events === after.events;
  const observedFailuresAbsent = before.index === null && after.index === null;
  return {
    schemaVersion: 1,
    kind: 'a2ui-react-capture-error-boundary-diff',
    protocol: 'v0.9',
    renderer: RENDERER,
    ok: sameBoundary && sameCount && (!requireNoObservedFailures || observedFailuresAbsent) &&
      (!compareRenderedText || textParity === 'match') &&
      (!compareButtonGeometry || geometryParity === 'match'),
    beforeEvents: before.events,
    afterEvents: after.events,
    eventCountParity: sameCount ? 'match' : 'drift',
    errorBoundaryParity: sameBoundary ? 'match' : 'drift',
    ...(requireNoObservedFailures ? {requireNoObservedFailures, observedFailuresAbsent} : {}),
    ...(compareRenderedText ? {renderedTextParity: textParity,
      ...(firstTextDrift === undefined ? {} : {firstDifferentRenderedTextEventIndex: firstTextDrift})} : {}),
    ...(compareButtonGeometry ? {buttonGeometryParity: geometryParity,
      ...(firstGeometryDrift === undefined ? {} :
        {firstDifferentButtonGeometryEventIndex: firstGeometryDrift})} : {}),
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
          typeof result.observedFailuresAbsent !== 'boolean')) ||
      (Object.hasOwn(result, 'renderedTextParity') &&
        (result.requireNoObservedFailures !== true ||
         !['match', 'drift', 'unavailable'].includes(result.renderedTextParity))) ||
      (Object.hasOwn(result, 'buttonGeometryParity') &&
        (result.requireNoObservedFailures !== true ||
         !['match', 'drift', 'unavailable'].includes(result.buttonGeometryParity))))
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
    ...(result.renderedTextParity ? [
      '**Real Chromium rendered Text parity:** ' + result.renderedTextParity.toUpperCase(),
      ...(Number.isSafeInteger(result.firstDifferentRenderedTextEventIndex) ? [
        '**First differing rendered Text event index:** ' +
          result.firstDifferentRenderedTextEventIndex] : []),
    ] : []),
    ...(result.buttonGeometryParity ? [
      '**Real Chromium Button geometry parity:** ' + result.buttonGeometryParity.toUpperCase(),
      ...(Number.isSafeInteger(result.firstDifferentButtonGeometryEventIndex) ? [
        '**First differing Button geometry event index:** ' +
          result.firstDifferentButtonGeometryEventIndex] : []),
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
    ...(result.renderedTextParity ? [{name: 'rendered-text-parity',
      pass: result.renderedTextParity === 'match',
      message: result.renderedTextParity === 'unavailable'
        ? 'rendered Text unavailable due to observed replay failure' : 'rendered Text drift',
    }] : []),
    ...(result.buttonGeometryParity ? [{name: 'button-geometry-parity',
      pass: result.buttonGeometryParity === 'match',
      message: result.buttonGeometryParity === 'unavailable'
        ? 'Button geometry unavailable due to observed replay failure' : 'Button geometry drift',
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

/** A new directory is the exclusive CI-artifact boundary; never reuse evidence. */
function writeReportDirectory(dir, result) {
  // Format everything first so a validation error cannot leave a partial suite.
  const files = [
    ['comparison.json', formatErrorBoundaryReport(result, 'json')],
    ['comparison.md', formatErrorBoundaryReport(result, 'markdown')],
    ['comparison.xml', formatErrorBoundaryReport(result, 'junit')],
  ];
  try {
    mkdirSync(dirname(dir), {recursive: true});
    mkdirSync(dir); // EEXIST (including symlinks) refuses overwrite.
    for (const [name, content] of files)
      writeFileSync(join(dir, name), content, {flag: 'wx'});
  } catch {
    // If disk IO fails after creating the directory, leave any partial
    // evidence intact for manual inspection rather than deleting it.
    throw invalid();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseErrorBoundaryOptions(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      if (args['report-dir'] && existsSync(args['report-dir'])) throw invalid();
      // One ephemeral key shared by both Chromium children, never logged or persisted.
      const textKey = args.compareRenderedText ? randomBytes(32).toString('hex') : null;
      const geometryKey = args.compareButtonGeometry ? randomBytes(32).toString('hex') : null;
      const before = runDiagnostic(args['before-capture'], textKey, geometryKey);
      const after = runDiagnostic(args['after-capture'], textKey, geometryKey);
      const result = compareErrorBoundaries(before, after,
        {requireNoObservedFailures: args.requireNoObservedFailures,
          compareRenderedText: args.compareRenderedText,
          compareButtonGeometry: args.compareButtonGeometry});
      const content = formatErrorBoundaryReport(result, args.format);
      if (args['report-dir']) writeReportDirectory(args['report-dir'], result);
      else if (args.out) exclusiveWrite(args.out, content);
      else process.stdout.write(content);
      if (args.strict && !result.ok) process.exitCode = 1;
    }
  } catch {
    // No thrown parser, SDK, Chromium, path or subprocess content is echoed.
    console.error('A2UI private Chromium error-boundary comparison refused; paths and contents omitted');
    process.exitCode = 2;
  }
}
